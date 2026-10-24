import { openVoiceSocket } from '../api';
import type { VoiceServerEvent } from '../types';
import { Resampler, SPEAKER_RATE, VoiceActivityDetector, floatToPcm16, pcm16ToFloat, rms } from './dsp';

export type MicMode = 'vad' | 'ptt';

export interface EngineCallbacks {
  onEvent: (e: VoiceServerEvent) => void;
  /** Local state the server cannot know: microphone and playback activity. */
  onLocal: (s: { userSpeaking: boolean; agentSpeaking: boolean; micError: string | null }) => void;
}

/**
 * Browser side of a voice conversation:
 * microphone → AudioWorklet (20 ms frames) → 16 kHz PCM16 → VAD or push-to-talk → WebSocket;
 * WebSocket PCM16 24 kHz → gapless AudioBuffer playback. Speaking over the agent stops its
 * playback at once and tells the server (barge-in).
 */
export class VoiceEngine {
  private ws: WebSocket | null = null;
  private stream: MediaStream | null = null;
  private micCtx: AudioContext | null = null;
  private outCtx: AudioContext | null = null;
  private analyser: AnalyserNode | null = null;
  private resampler: Resampler | null = null;
  private vad: VoiceActivityDetector;
  private readonly sources = new Set<AudioBufferSourceNode>();
  private nextTime = 0;
  private stopped = false;
  private pttDown = false;
  private userSpeaking = false;
  private micError: string | null = null;
  micLevel = 0;

  constructor(
    private readonly cb: EngineCallbacks,
    private mode: MicMode,
    private sensitivity: number,
  ) {
    this.vad = new VoiceActivityDetector({ sensitivity });
  }

  /** Opens the server session, then the microphone. Without a microphone, text still works. */
  async start(): Promise<void> {
    this.stopped = false;
    const ws = await openVoiceSocket();
    this.ws = ws;
    await new Promise<void>((resolve, reject) => {
      ws.onopen = () => resolve();
      ws.onerror = () => reject(new Error('Connexion vocale refusée par le service local'));
    });
    ws.onmessage = (ev) => {
      if (ev.data instanceof ArrayBuffer) return this.play(ev.data);
      let e: VoiceServerEvent;
      try {
        e = JSON.parse(String(ev.data)) as VoiceServerEvent;
      } catch {
        return;
      }
      if (e.type === 'interrupted') this.stopPlayback();
      this.cb.onEvent(e);
    };
    ws.onclose = (ev) => {
      if (!this.stopped) this.cb.onEvent({ type: 'closed', reason: ev.reason || 'connexion fermée' });
      this.teardownAudio();
    };
    this.outCtx = new AudioContext({ latencyHint: 'interactive' });
    this.analyser = this.outCtx.createAnalyser();
    this.analyser.fftSize = 512;
    this.analyser.connect(this.outCtx.destination);
    try {
      await this.startMic();
    } catch (err) {
      this.micError = err instanceof Error ? err.message : String(err);
      this.emitLocal();
    }
  }

  private async startMic() {
    if (!navigator.mediaDevices?.getUserMedia) throw new Error('Microphone non pris en charge');
    this.stream = await navigator.mediaDevices.getUserMedia({
      audio: { channelCount: 1, echoCancellation: true, noiseSuppression: true, autoGainControl: true },
    });
    const ctx = new AudioContext({ latencyHint: 'interactive' });
    this.micCtx = ctx;
    await ctx.audioWorklet.addModule('/audio/capture-worklet.js');
    const node = new AudioWorkletNode(ctx, 'hermes-capture');
    const mute = ctx.createGain();
    mute.gain.value = 0;
    // Connected to a silent output so the browser keeps pulling the worklet.
    ctx.createMediaStreamSource(this.stream).connect(node).connect(mute).connect(ctx.destination);
    this.resampler = new Resampler(ctx.sampleRate);
    node.port.onmessage = (ev: MessageEvent<Float32Array>) => this.onFrame(ev.data);
  }

  private onFrame(frame: Float32Array) {
    if (!this.resampler || this.ws?.readyState !== WebSocket.OPEN) return;
    this.micLevel = rms(frame);
    const pcm = floatToPcm16(this.resampler.process(frame));
    if (this.mode === 'ptt') {
      if (this.pttDown) this.send(pcm);
      return;
    }
    const r = this.vad.push(pcm, this.micLevel);
    if (r.event === 'speech_start') {
      this.bargeIn();
      this.setUserSpeaking(true);
    }
    for (const f of r.send) this.send(f);
    if (r.event === 'speech_end') {
      this.ws.send(JSON.stringify({ type: 'audio_end' }));
      this.setUserSpeaking(false);
    }
  }

  private send(pcm: Int16Array) {
    if (pcm.length && this.ws?.readyState === WebSocket.OPEN) this.ws.send(pcm.buffer as ArrayBuffer);
  }

  private setUserSpeaking(on: boolean) {
    this.userSpeaking = on;
    this.emitLocal();
  }

  private emitLocal() {
    this.cb.onLocal({
      userSpeaking: this.userSpeaking,
      agentSpeaking: this.sources.size > 0,
      micError: this.micError,
    });
  }

  /** Push-to-talk: audio flows only while held; releasing ends the utterance. */
  setPushToTalk(down: boolean): void {
    if (this.mode !== 'ptt' || down === this.pttDown) return;
    this.pttDown = down;
    if (down) this.bargeIn();
    else if (this.ws?.readyState === WebSocket.OPEN) this.ws.send(JSON.stringify({ type: 'audio_end' }));
    this.setUserSpeaking(down);
  }

  setMode(mode: MicMode, sensitivity = this.sensitivity): void {
    this.mode = mode;
    this.sensitivity = sensitivity;
    this.vad = new VoiceActivityDetector({ sensitivity });
    this.pttDown = false;
    this.setUserSpeaking(false);
  }

  private bargeIn() {
    if (!this.sources.size) return;
    this.stopPlayback();
    this.interruptServer();
  }

  /** Explicit "stop talking" from the user. */
  interrupt(): void {
    this.stopPlayback();
    this.interruptServer();
  }

  private interruptServer() {
    if (this.ws?.readyState === WebSocket.OPEN) this.ws.send(JSON.stringify({ type: 'interrupt' }));
  }

  sendText(text: string): void {
    if (this.ws?.readyState === WebSocket.OPEN) this.ws.send(JSON.stringify({ type: 'text', text }));
  }

  private play(bytes: ArrayBuffer) {
    const ctx = this.outCtx;
    if (!ctx || !this.analyser || !bytes.byteLength) return;
    // Raw PCM is not a file format decodeAudioData understands: the buffer is built directly.
    const samples = pcm16ToFloat(bytes);
    const buffer = ctx.createBuffer(1, samples.length, SPEAKER_RATE);
    buffer.copyToChannel(samples, 0);
    const src = ctx.createBufferSource();
    src.buffer = buffer;
    src.connect(this.analyser);
    const at = Math.max(this.nextTime, ctx.currentTime + 0.05);
    src.start(at);
    this.nextTime = at + buffer.duration;
    this.sources.add(src);
    src.onended = () => {
      this.sources.delete(src);
      if (!this.sources.size) this.emitLocal();
    };
    if (this.sources.size === 1) this.emitLocal();
  }

  private stopPlayback() {
    for (const s of this.sources) {
      s.onended = null;
      try {
        s.stop();
      } catch {
        /* already stopped */
      }
    }
    this.sources.clear();
    this.nextTime = 0;
    this.emitLocal();
  }

  /** RMS of what is currently being played. */
  outputLevel(): number {
    if (!this.analyser || !this.sources.size) return 0;
    const data = new Float32Array(this.analyser.fftSize);
    this.analyser.getFloatTimeDomainData(data);
    return rms(data);
  }

  private teardownAudio() {
    this.stopPlayback();
    for (const t of this.stream?.getTracks() ?? []) t.stop();
    this.stream = null;
    void this.micCtx?.close().catch(() => undefined);
    void this.outCtx?.close().catch(() => undefined);
    this.micCtx = null;
    this.outCtx = null;
    this.analyser = null;
    this.resampler = null;
    this.vad.reset();
  }

  stop(): void {
    this.stopped = true;
    if (this.ws?.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify({ type: 'stop' }));
      this.ws.close(1000, 'fin');
    }
    this.ws = null;
    this.teardownAudio();
  }
}
