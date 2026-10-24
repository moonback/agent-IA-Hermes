import { useCallback, useEffect, useRef, useState } from 'react';
import { Hand, KeyRound, Mic, MicOff, Send, Square, Volume2 } from 'lucide-react';
import { api } from '../../api';
import { useMediaQuery, useResource } from '../../hooks';
import { useApp } from '../../store';
import type { MissionDetail, Status, VoiceServerEvent, VoiceSettings } from '../../types';
import { VoiceEngine, type MicMode } from '../../voice/engine';
import { MissionCard } from '../cards';
import { Badge, Button, Card, Empty, ErrorBox, Input, cx, type Tone } from '../ui';

interface Line {
  id: number;
  speaker: 'user' | 'agent' | 'system';
  text: string;
  final: boolean;
  tone?: Tone;
}

type Phase = 'idle' | 'connecting' | 'live' | 'reconnecting';

const COMMAND_LABEL = {
  pause: 'Pause',
  resume: 'Reprise',
  cancel: 'Annulation',
  emergency_stop: 'Arrêt d’urgence',
  report: 'Rapport',
} as const;

/** Mic and agent levels drawn as two mirrored bands; animation follows reduced-motion. */
function Waveform({ engine, active }: { engine: VoiceEngine | null; active: boolean }) {
  const canvas = useRef<HTMLCanvasElement>(null);
  const reduced = useMediaQuery('(prefers-reduced-motion: reduce)');
  useEffect(() => {
    const c = canvas.current;
    if (!c || !engine || !active) return;
    const g = c.getContext('2d');
    if (!g) return;
    const mic: number[] = Array(64).fill(0);
    const out: number[] = Array(64).fill(0);
    const style = getComputedStyle(c);
    const micColor = style.getPropertyValue('--hm-accent-fg').trim() || '#4c8dff';
    const outColor = style.getPropertyValue('--hm-accent-2').trim() || '#9b7bff';
    let raf = 0;
    let timer = 0;
    const draw = () => {
      mic.push(Math.min(1, engine.micLevel * 6));
      out.push(Math.min(1, engine.outputLevel() * 6));
      mic.shift();
      out.shift();
      const { width: w, height: h } = c;
      g.clearRect(0, 0, w, h);
      const bw = w / mic.length;
      mic.forEach((v, i) => {
        g.fillStyle = micColor;
        const bh = Math.max(2, v * (h / 2 - 2));
        g.fillRect(i * bw + 1, h / 2 - bh, bw - 2, bh);
        g.fillStyle = outColor;
        const oh = Math.max(2, out[i]! * (h / 2 - 2));
        g.fillRect(i * bw + 1, h / 2, bw - 2, oh);
      });
    };
    if (reduced) timer = window.setInterval(draw, 250);
    else {
      const loop = () => {
        draw();
        raf = requestAnimationFrame(loop);
      };
      raf = requestAnimationFrame(loop);
    }
    return () => {
      cancelAnimationFrame(raf);
      window.clearInterval(timer);
    };
  }, [engine, active, reduced]);
  return (
    <canvas
      ref={canvas}
      width={512}
      height={96}
      className="h-24 w-full rounded-card bg-raised ring-1 ring-line ring-inset"
      role="img"
      aria-label="Activité vocale : votre micro en haut, la voix de HERMES en bas"
    />
  );
}

function VoiceMission({ missionId }: { missionId: string }) {
  const detail = useResource<MissionDetail>(`/api/missions/${missionId}`);
  const navigate = useApp((s) => s.navigate);
  if (detail.error) return <ErrorBox error={detail.error.message} title="Mission indisponible" />;
  if (!detail.data) return null;
  const pending = detail.data.approvals.filter((a) => a.status === 'pending').length;
  return (
    <MissionCard
      mission={detail.data.mission}
      pendingApprovals={pending}
      onOpen={() => navigate('missions', missionId)}
    />
  );
}

export function VoicePanel() {
  const status = useResource<Status>('/api/status', { live: false });
  const settings = useResource<VoiceSettings>('/api/voice/settings', { live: false });
  const navigate = useApp((s) => s.navigate);
  const [phase, setPhase] = useState<Phase>('idle');
  const [engine, setEngine] = useState<VoiceEngine | null>(null);
  const [lines, setLines] = useState<Line[]>([]);
  const [missionId, setMissionId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [local, setLocal] = useState({
    userSpeaking: false,
    agentSpeaking: false,
    micError: null as string | null,
  });
  // The saved default applies until the user switches mode on this page.
  const [modeChoice, setMode] = useState<MicMode | null>(null);
  const mode: MicMode = modeChoice ?? settings.data?.mode ?? 'vad';
  const [text, setText] = useState('');
  const nextId = useRef(0);
  const engineRef = useRef<VoiceEngine | null>(null);
  const transcriptEnd = useRef<HTMLLIElement>(null);

  // Leaving the page ends the conversation and releases the microphone.
  useEffect(() => () => engineRef.current?.stop(), []);
  useEffect(() => {
    // Braces matter: recent Chromium returns a Promise from scrollIntoView, which is not a cleanup.
    void transcriptEnd.current?.scrollIntoView({ block: 'nearest' });
  }, [lines]);

  const push = useCallback(
    (l: Omit<Line, 'id'>) => setLines((ls) => [...ls, { ...l, id: nextId.current++ }].slice(-200)),
    [],
  );

  const onEvent = useCallback(
    (e: VoiceServerEvent) => {
      switch (e.type) {
        case 'ready':
          setPhase('live');
          break;
        case 'state':
          setPhase(e.state === 'reconnecting' ? 'reconnecting' : e.state === 'ready' ? 'live' : (p) => p);
          break;
        case 'transcript':
          setLines((ls) => {
            const i = ls.findLastIndex((l) => l.speaker === e.speaker && !l.final);
            if (i >= 0) return ls.map((l, j) => (j === i ? { ...l, text: e.text, final: e.final } : l));
            return [...ls, { id: nextId.current++, speaker: e.speaker, text: e.text, final: e.final }].slice(
              -200,
            );
          });
          break;
        case 'mission':
          setMissionId(e.missionId);
          break;
        case 'command':
          push({
            speaker: 'system',
            text: `${COMMAND_LABEL[e.command]} : ${e.message}`,
            final: true,
            tone: e.ok ? 'info' : 'warning',
          });
          if (e.missionId) setMissionId(e.missionId);
          break;
        case 'tool':
          if (!e.ok)
            push({
              speaker: 'system',
              text: `${e.name} : ${e.message ?? 'refusé'}`,
              final: true,
              tone: 'warning',
            });
          break;
        case 'mission_update':
          push({ speaker: 'system', text: e.message, final: true, tone: 'neutral' });
          break;
        case 'interrupted':
          push({
            speaker: 'system',
            text: e.by === 'user' ? 'Réponse interrompue.' : 'HERMES vous écoute.',
            final: true,
          });
          break;
        case 'error':
          setError(e.message);
          break;
        case 'closed':
          setPhase('idle');
          engineRef.current = null;
          setEngine(null);
          break;
      }
    },
    [push],
  );

  const start = async () => {
    setError(null);
    setPhase('connecting');
    const s = settings.data;
    const eng = new VoiceEngine({ onEvent, onLocal: setLocal }, mode, s?.vadSensitivity ?? 0.5);
    engineRef.current = eng;
    setEngine(eng);
    try {
      await eng.start();
    } catch (err) {
      eng.stop();
      engineRef.current = null;
      setEngine(null);
      setPhase('idle');
      setError(err instanceof Error ? err.message : String(err));
    }
  };
  const stop = () => {
    engineRef.current?.stop();
    engineRef.current = null;
    setEngine(null);
    setPhase('idle');
  };
  const changeMode = (m: MicMode) => {
    setMode(m);
    engineRef.current?.setMode(m, settings.data?.vadSensitivity ?? 0.5);
    if (settings.data)
      void api('/api/voice/settings', { method: 'PUT', body: { ...settings.data, mode: m } }).catch(
        () => undefined,
      );
  };

  const gemini = status.data?.provider.gemini;
  const live = phase === 'live' || phase === 'reconnecting';
  const stateLabel: [string, Tone] = !live
    ? phase === 'connecting'
      ? ['connexion…', 'info']
      : ['inactif', 'neutral']
    : phase === 'reconnecting'
      ? ['reconnexion…', 'warning']
      : local.agentSpeaking
        ? ['HERMES parle', 'info']
        : local.userSpeaking
          ? ['vous parlez', 'success']
          : ['à l’écoute', 'success'];

  return (
    <div className="grid gap-4 xl:grid-cols-[1fr_22rem]">
      <div className="space-y-4">
        <Card
          live={live && (local.userSpeaking || local.agentSpeaking)}
          title="Conversation vocale"
          icon={<Mic className="size-4" />}
          actions={
            <Badge
              tone={stateLabel[1]}
              icon={live ? <span className="live-dot size-1.5" aria-hidden /> : undefined}
            >
              <span role="status">{stateLabel[0]}</span>
            </Badge>
          }
        >
          {status.data && !gemini?.hasKey && (
            <div className="mb-3 space-y-2">
              <ErrorBox
                title="Clé Gemini manquante"
                error="L’assistant vocal utilise Gemini Live : enregistrez une clé Google dans « Modèles et OpenRouter »."
              />
              <Button icon={<KeyRound className="size-4" />} onClick={() => navigate('models')}>
                Configurer Gemini
              </Button>
            </div>
          )}
          <div className="flex flex-wrap items-center gap-3">
            {!live && phase !== 'connecting' ? (
              <Button
                variant="primary"
                className="px-4 py-2.5"
                icon={<Mic className="size-5" />}
                disabled={!gemini?.hasKey}
                onClick={() => void start()}
              >
                Démarrer la conversation
              </Button>
            ) : (
              <Button
                variant="danger"
                className="px-4 py-2.5"
                icon={<Square className="size-4" />}
                pending={phase === 'connecting'}
                onClick={stop}
              >
                Terminer
              </Button>
            )}
            {live && mode === 'ptt' && (
              <Button
                variant="secondary"
                className={cx('px-4 py-2.5 select-none', local.userSpeaking && 'is-live')}
                icon={<Mic className="size-5" />}
                aria-pressed={local.userSpeaking}
                onPointerDown={() => engine?.setPushToTalk(true)}
                onPointerUp={() => engine?.setPushToTalk(false)}
                onPointerLeave={() => engine?.setPushToTalk(false)}
                onKeyDown={(e) => {
                  if ((e.key === ' ' || e.key === 'Enter') && !e.repeat) {
                    e.preventDefault();
                    engine?.setPushToTalk(true);
                  }
                }}
                onKeyUp={(e) => {
                  if (e.key === ' ' || e.key === 'Enter') engine?.setPushToTalk(false);
                }}
              >
                Maintenir pour parler
              </Button>
            )}
            {live && (
              <Button
                variant="ghost"
                icon={<Hand className="size-4" />}
                disabled={!local.agentSpeaking}
                onClick={() => engine?.interrupt()}
              >
                Interrompre
              </Button>
            )}
            <div
              role="radiogroup"
              aria-label="Mode du micro"
              className="ml-auto flex rounded-control bg-raised p-0.5 ring-1 ring-line ring-inset"
            >
              {(
                [
                  ['vad', 'Mains libres'],
                  ['ptt', 'Appuyer pour parler'],
                ] as const
              ).map(([m, label]) => (
                <button
                  key={m}
                  type="button"
                  role="radio"
                  aria-checked={mode === m}
                  onClick={() => changeMode(m)}
                  className={cx(
                    'press rounded-[8px] px-2.5 py-1 text-xs font-medium',
                    mode === m ? 'bg-accent text-on-accent' : 'text-muted hover:text-fg',
                  )}
                >
                  {label}
                </button>
              ))}
            </div>
          </div>
          <div className="mt-4">
            <Waveform engine={engine} active={live} />
            <p className="mt-1 flex justify-between text-xs text-faint">
              <span className="inline-flex items-center gap-1">
                <Mic className="size-3" aria-hidden /> votre micro{' '}
                {mode === 'vad' ? '(le silence n’est pas envoyé)' : ''}
              </span>
              <span className="inline-flex items-center gap-1">
                <Volume2 className="size-3" aria-hidden /> HERMES
              </span>
            </p>
          </div>
          {local.micError && (
            <div className="mt-3">
              <ErrorBox
                title="Micro indisponible"
                error={`${local.micError}. Vous pouvez écrire vos demandes ci-dessous.`}
              />
            </div>
          )}
          {error && (
            <div className="mt-3">
              <ErrorBox title="Session vocale" error={error} />
            </div>
          )}
        </Card>

        <Card title="Transcription en direct">
          {lines.length === 0 ? (
            <Empty icon={<MicOff className="size-5" />}>
              {live ? 'Parlez : la transcription apparaît ici.' : 'Aucune conversation en cours.'}
            </Empty>
          ) : (
            <ol
              className="max-h-[26rem] space-y-2 overflow-y-auto pr-1"
              aria-live="polite"
              aria-label="Transcription"
            >
              {lines.map((l) =>
                l.speaker === 'system' ? (
                  <li key={l.id} className="flex justify-center">
                    <Badge tone={l.tone ?? 'neutral'}>{l.text}</Badge>
                  </li>
                ) : (
                  <li
                    key={l.id}
                    className={cx('flex', l.speaker === 'user' ? 'justify-end' : 'justify-start')}
                  >
                    <p
                      className={cx(
                        'max-w-[80%] rounded-card px-3 py-2 text-sm ring-1 ring-inset',
                        l.speaker === 'user' ? 'bg-info-soft ring-accent-fg/30' : 'bg-raised ring-line',
                        !l.final && 'italic opacity-75',
                      )}
                    >
                      <span className="mb-0.5 block text-[0.7rem] font-semibold tracking-wide text-faint uppercase">
                        {l.speaker === 'user' ? 'Vous' : 'HERMES'}
                      </span>
                      {l.text}
                    </p>
                  </li>
                ),
              )}
              <li ref={transcriptEnd} aria-hidden className="h-0" />
            </ol>
          )}
          <form
            className="mt-3 flex gap-2"
            onSubmit={(e) => {
              e.preventDefault();
              if (!text.trim() || !engine) return;
              engine.sendText(text.trim());
              setText('');
            }}
          >
            <Input
              aria-label="Écrire à l’assistant vocal"
              placeholder={live ? 'Écrire au lieu de parler…' : 'Démarrez la conversation pour écrire'}
              value={text}
              disabled={!live}
              onChange={(e) => setText(e.target.value)}
            />
            <Button type="submit" icon={<Send className="size-4" />} disabled={!live || !text.trim()}>
              Envoyer
            </Button>
          </form>
        </Card>
      </div>

      <div className="space-y-4">
        <Card title="Mission déclenchée par la voix">
          {missionId ? (
            <VoiceMission missionId={missionId} />
          ) : (
            <Empty>
              Demandez une tâche à voix haute : la mission créée apparaît ici et dans l’historique.
            </Empty>
          )}
        </Card>
        <Card title="Commandes vocales">
          <ul className="space-y-1.5 text-sm">
            {[
              ['« Pause »', 'met en pause la mission courante'],
              ['« Reprends »', 'reprend une mission en pause'],
              ['« Annule »', 'annule la mission courante'],
              ['« Arrêt d’urgence »', 'bloque toute action'],
              ['« Rapport »', 'lit le résultat de la mission'],
            ].map(([cmd, what]) => (
              <li key={cmd} className="flex justify-between gap-3">
                <span className="font-medium">{cmd}</span>
                <span className="text-right text-muted">{what}</span>
              </li>
            ))}
          </ul>
          <p className="mt-3 text-xs text-faint">
            Ces mots, prononcés seuls, sont exécutés immédiatement. Lancer une mission demande une
            confirmation orale ; les approbations d’actions sensibles se font uniquement à l’écran.
          </p>
        </Card>
      </div>
    </div>
  );
}
