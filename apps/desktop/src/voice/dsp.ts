// Audio processing for the voice panel. Pure functions and small state machines, free of DOM
// globals so they can be unit-tested in Node.

export const MIC_RATE = 16_000;
export const SPEAKER_RATE = 24_000;

/**
 * Streaming resampler (any rate → 16 kHz). Each output sample averages the input samples it
 * covers (a box low-pass filter, enough against aliasing for speech) and keeps the fractional
 * position between calls, so consecutive 20 ms blocks join without clicks.
 */
export class Resampler {
  private readonly ratio: number;
  private pos = 0;
  private carry: Float32Array = new Float32Array(0);

  constructor(
    readonly inRate: number,
    readonly outRate = MIC_RATE,
  ) {
    if (inRate <= 0 || outRate <= 0) throw new Error('fréquence invalide');
    this.ratio = inRate / outRate;
  }

  process(input: Float32Array): Float32Array {
    const buf = new Float32Array(this.carry.length + input.length);
    buf.set(this.carry);
    buf.set(input, this.carry.length);
    const out: number[] = [];
    let pos = this.pos;
    while (pos + this.ratio <= buf.length) {
      const start = Math.floor(pos);
      const end = Math.max(start + 1, Math.floor(pos + this.ratio));
      let sum = 0;
      for (let i = start; i < end; i++) sum += buf[i]!;
      out.push(sum / (end - start));
      pos += this.ratio;
    }
    const keep = Math.floor(pos);
    this.carry = buf.slice(keep);
    this.pos = pos - keep;
    return Float32Array.from(out);
  }
}

export function floatToPcm16(f: Float32Array): Int16Array<ArrayBuffer> {
  const out = new Int16Array(f.length);
  for (let i = 0; i < f.length; i++) {
    const s = Math.max(-1, Math.min(1, f[i]!));
    out[i] = s < 0 ? Math.round(s * 0x8000) : Math.round(s * 0x7fff);
  }
  return out;
}

/** Little-endian PCM16 bytes (as received from the server) → floats in [-1, 1]. */
export function pcm16ToFloat(bytes: ArrayBuffer): Float32Array<ArrayBuffer> {
  const view = new DataView(bytes);
  const n = Math.floor(bytes.byteLength / 2);
  const out = new Float32Array(n);
  for (let i = 0; i < n; i++) out[i] = view.getInt16(i * 2, true) / 0x8000;
  return out;
}

export function rms(f: Float32Array): number {
  if (!f.length) return 0;
  let sum = 0;
  for (let i = 0; i < f.length; i++) sum += f[i]! * f[i]!;
  return Math.sqrt(sum / f.length);
}

export type VadEvent = 'speech_start' | 'speech_end' | null;

/**
 * Energy-based voice activity detection with an adaptive noise floor. Speech starts after a few
 * loud frames, ends after a silence "hangover", and the frames just before the start are kept
 * (pre-roll) so the first syllable is not clipped. Silence is never sent to the server.
 */
export class VoiceActivityDetector {
  private noise = 0.005;
  private loud = 0;
  private quiet = 0;
  speaking = false;
  private readonly preRoll: Int16Array[] = [];

  constructor(
    private readonly opts: {
      /** 0 = only loud speech, 1 = very sensitive. */
      sensitivity?: number;
      frameMs?: number;
      startMs?: number;
      hangoverMs?: number;
      preRollMs?: number;
    } = {},
  ) {}

  private get frameMs() {
    return this.opts.frameMs ?? 20;
  }

  /** Threshold above the noise floor: between ×6 (insensitive) and ×2 (sensitive), never below 0.008. */
  threshold(): number {
    const s = Math.min(1, Math.max(0, this.opts.sensitivity ?? 0.5));
    return Math.max(0.008, this.noise * (6 - 4 * s));
  }

  /**
   * Feeds one frame; returns the event it caused and the frames to send now (pre-roll included
   * at speech start, nothing while silent).
   */
  push(frame: Int16Array, level: number): { event: VadEvent; send: Int16Array[] } {
    const loud = level > this.threshold();
    if (!this.speaking && !loud) this.noise = this.noise * 0.95 + level * 0.05;
    const startFrames = Math.max(1, Math.round((this.opts.startMs ?? 60) / this.frameMs));
    const endFrames = Math.max(1, Math.round((this.opts.hangoverMs ?? 700) / this.frameMs));
    const preFrames = Math.round((this.opts.preRollMs ?? 240) / this.frameMs);

    if (!this.speaking) {
      this.preRoll.push(frame);
      if (this.preRoll.length > preFrames + startFrames) this.preRoll.shift();
      this.loud = loud ? this.loud + 1 : 0;
      if (this.loud >= startFrames) {
        this.speaking = true;
        this.quiet = 0;
        return { event: 'speech_start', send: this.preRoll.splice(0) };
      }
      return { event: null, send: [] };
    }
    this.quiet = loud ? 0 : this.quiet + 1;
    if (this.quiet >= endFrames) {
      this.speaking = false;
      this.loud = 0;
      return { event: 'speech_end', send: [frame] };
    }
    return { event: null, send: [frame] };
  }

  reset(): void {
    this.speaking = false;
    this.loud = 0;
    this.quiet = 0;
    this.preRoll.length = 0;
  }
}
