import { randomBytes, timingSafeEqual } from 'node:crypto';
import { WebSocketServer, type WebSocket } from 'ws';
import { z } from 'zod';
import { voiceErrorMessage, type AudioBridge, type HermesRuntime } from '@hermes/core';
import { rejectUpgrade, type UpgradeHandler } from './http';

const TICKET_TTL_MS = 30_000;
/** 16 kHz PCM16 mono: 64 KiB is two seconds of audio, far above the client's 20–100 ms chunks. */
const MAX_AUDIO_FRAME = 64 * 1024;

const ClientMessage = z.discriminatedUnion('type', [
  z.object({ type: z.literal('text'), text: z.string().min(1).max(2000) }),
  z.object({ type: z.literal('audio_end') }),
  z.object({ type: z.literal('interrupt') }),
  z.object({ type: z.literal('stop') }),
]);

/**
 * Single-use tickets: obtained over authenticated HTTP (Bearer token), then presented once in the
 * WebSocket URL, because a browser WebSocket cannot carry the Authorization header.
 */
export class VoiceTickets {
  private readonly tickets = new Map<string, number>();

  issue(): { ticket: string; expiresInSec: number } {
    const now = Date.now();
    for (const [t, exp] of this.tickets) if (exp < now) this.tickets.delete(t);
    const ticket = randomBytes(32).toString('hex');
    this.tickets.set(ticket, now + TICKET_TTL_MS);
    return { ticket, expiresInSec: TICKET_TTL_MS / 1000 };
  }

  consume(candidate: string | null): boolean {
    if (!candidate) return false;
    const got = Buffer.from(candidate);
    for (const [t, exp] of this.tickets) {
      const want = Buffer.from(t);
      if (got.length === want.length && timingSafeEqual(got, want)) {
        this.tickets.delete(t);
        return exp >= Date.now();
      }
    }
    return false;
  }
}

/**
 * /api/voice/stream: binary frames = microphone PCM 16 kHz 16-bit mono (client → server) and
 * Gemini audio PCM 24 kHz 16-bit mono (server → client); text frames = JSON control/events.
 */
export function voiceStream(rt: HermesRuntime, tickets: VoiceTickets): UpgradeHandler {
  const wss = new WebSocketServer({ noServer: true, maxPayload: MAX_AUDIO_FRAME });
  let active: AudioBridge | null = null;

  return (req, socket, head, url) => {
    if (!tickets.consume(url.searchParams.get('ticket')))
      return rejectUpgrade(socket, 401, 'Ticket vocal absent, expiré ou déjà utilisé');
    if (active) return rejectUpgrade(socket, 409, 'Une session vocale est déjà ouverte');
    wss.handleUpgrade(req, socket, head, (ws: WebSocket) => {
      const sendJson = (e: unknown) => ws.readyState === ws.OPEN && ws.send(JSON.stringify(e));
      const bridge = rt.createVoiceBridge({
        audio: (pcm) => ws.readyState === ws.OPEN && ws.send(pcm, { binary: true }),
        event: (e) => {
          sendJson(e);
          if (e.type === 'closed' && ws.readyState === ws.OPEN) ws.close(1000, 'session terminée');
        },
      });
      active = bridge;
      ws.on('message', (data: Buffer, isBinary: boolean) => {
        if (isBinary) return bridge.pushAudio(data);
        let msg: z.infer<typeof ClientMessage>;
        try {
          msg = ClientMessage.parse(JSON.parse(data.toString('utf8')));
        } catch {
          return sendJson({ type: 'error', code: 'VALIDATION', message: 'Message de contrôle invalide' });
        }
        if (msg.type === 'text') bridge.sendText(msg.text);
        else if (msg.type === 'audio_end') bridge.endAudio();
        else if (msg.type === 'interrupt') bridge.interrupt();
        else bridge.stop('arrêt demandé par l’utilisateur');
      });
      ws.on('close', () => {
        bridge.stop('client déconnecté');
        if (active === bridge) active = null;
      });
      bridge.start().catch((err: unknown) => {
        const e = voiceErrorMessage(err);
        sendJson({ type: 'error', ...e });
        rt.telemetry.record({
          agent: 'voice',
          category: 'voice',
          level: 'warn',
          type: 'voice.session_failed',
          message: `Ouverture de la session vocale impossible : ${e.message}`,
          errorCode: e.code,
        });
        if (active === bridge) active = null;
        ws.close(4001, e.code);
      });
    });
  };
}
