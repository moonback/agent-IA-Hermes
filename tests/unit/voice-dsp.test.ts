import { describe, expect, it } from 'vitest';
import {
  Resampler,
  VoiceActivityDetector,
  floatToPcm16,
  pcm16ToFloat,
  rms,
} from '../../apps/desktop/src/voice/dsp';

const sine = (rate: number, hz: number, ms: number, amp = 0.5, phase = 0) =>
  Float32Array.from(
    { length: Math.round((rate * ms) / 1000) },
    (_, i) => amp * Math.sin((2 * Math.PI * hz * (i + phase)) / rate),
  );

/** Dominant frequency by zero crossings. */
const freqOf = (f: Float32Array, rate: number) => {
  let crossings = 0;
  for (let i = 1; i < f.length; i++) if (f[i - 1]! < 0 && f[i]! >= 0) crossings++;
  return (crossings * rate) / f.length;
};

describe('rééchantillonnage vers 16 kHz', () => {
  it('48 kHz → 16 kHz : bonne longueur et fréquence conservée, blocs successifs sans perte', () => {
    const r = new Resampler(48_000);
    let total = 0;
    const out: number[] = [];
    for (let b = 0; b < 50; b++) {
      const block = sine(48_000, 440, 20, 0.5, b * 960);
      const o = r.process(block);
      total += o.length;
      out.push(...o);
    }
    expect(total).toBeGreaterThanOrEqual(15_990);
    expect(total).toBeLessThanOrEqual(16_000);
    expect(freqOf(Float32Array.from(out), 16_000)).toBeCloseTo(440, -1);
  });
  it('44,1 kHz (rapport non entier) et refus d’une fréquence nulle', () => {
    const r = new Resampler(44_100);
    const o = r.process(sine(44_100, 300, 1000));
    expect(Math.abs(o.length - 16_000)).toBeLessThanOrEqual(1);
    expect(freqOf(o, 16_000)).toBeCloseTo(300, -1);
    expect(() => new Resampler(0)).toThrow();
  });
});

describe('conversion PCM 16 bits', () => {
  it('écrête et convertit dans les deux sens', () => {
    const pcm = floatToPcm16(Float32Array.from([0, 1, -1, 2, -2, 0.5]));
    expect([...pcm]).toEqual([0, 32767, -32768, 32767, -32768, 16384]);
    const back = pcm16ToFloat(pcm.buffer as ArrayBuffer);
    expect(back[1]).toBeCloseTo(1, 3);
    expect(back[2]).toBe(-1);
    expect(rms(Float32Array.from([0.5, -0.5]))).toBeCloseTo(0.5);
    expect(rms(new Float32Array(0))).toBe(0);
  });
});

describe('détection d’activité vocale', () => {
  const frame = new Int16Array(320);
  it('ne transmet pas le silence, démarre avec le pré-roll et s’arrête après le délai de grâce', () => {
    const vad = new VoiceActivityDetector({ sensitivity: 0.5, startMs: 60, hangoverMs: 200, preRollMs: 100 });
    for (let i = 0; i < 50; i++) expect(vad.push(frame, 0.003)).toEqual({ event: null, send: [] });
    expect(vad.push(frame, 0.2).event).toBeNull();
    expect(vad.push(frame, 0.2).event).toBeNull();
    const r = vad.push(frame, 0.2);
    expect(r.event).toBe('speech_start');
    expect(r.send.length).toBe(8); // 5 pre-roll frames + 3 loud frames
    for (let i = 0; i < 9; i++) expect(vad.push(frame, 0.002).event).toBeNull();
    expect(vad.push(frame, 0.002).event).toBe('speech_end');
    expect(vad.speaking).toBe(false);
  });
  it('s’adapte au bruit de fond et la sensibilité règle le seuil', () => {
    const noisy = new VoiceActivityDetector({ sensitivity: 0.5 });
    for (let i = 0; i < 200; i++) noisy.push(frame, 0.02);
    expect(noisy.threshold()).toBeGreaterThan(0.06);
    expect(noisy.speaking).toBe(false);
    const sensitive = new VoiceActivityDetector({ sensitivity: 1 });
    const strict = new VoiceActivityDetector({ sensitivity: 0 });
    for (const v of [sensitive, strict]) for (let i = 0; i < 100; i++) v.push(frame, 0.01);
    expect(sensitive.threshold()).toBeLessThan(strict.threshold());
  });
});
