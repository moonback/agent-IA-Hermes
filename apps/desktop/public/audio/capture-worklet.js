/* global registerProcessor, AudioWorkletProcessor, sampleRate */
// Microphone capture: groups the audio thread's 128-sample blocks into 20 ms mono frames and posts
// them to the main thread, which resamples to 16 kHz, runs voice detection and sends PCM16.
// Plain JavaScript in public/: the Tauri CSP (script-src 'self') forbids blob: worklets.
class CaptureProcessor extends AudioWorkletProcessor {
  constructor() {
    super();
    this.size = Math.round(sampleRate / 50);
    this.buf = new Float32Array(this.size);
    this.n = 0;
  }
  process(inputs) {
    const ch = inputs[0] && inputs[0][0];
    if (!ch) return true;
    for (let i = 0; i < ch.length; i++) {
      this.buf[this.n++] = ch[i];
      if (this.n === this.size) {
        this.port.postMessage(this.buf, [this.buf.buffer]);
        this.buf = new Float32Array(this.size);
        this.n = 0;
      }
    }
    return true;
  }
}
registerProcessor('hermes-capture', CaptureProcessor);
