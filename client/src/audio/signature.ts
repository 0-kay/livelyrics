import { SIGNATURE_CONFIG } from '@livelyrics/shared';

export type SignatureState = 'idle' | 'learning' | 'tracking' | 'fired';

export interface SignatureSnapshot {
  state: SignatureState;
  /** Latest windowed distance from the learned balance (in learned spreads). */
  distance: number;
}

/**
 * Sound-signature change detector. Splits the mic signal into four bands with
 * one-pole filters (no FFT), turns each half second into a loudness-free shape
 * (log band energies minus their mean), learns the song's shape and spread,
 * and fires once when the last 3s sit far from it. Volume changes do not
 * count; a different mix of bass, mids and highs does. Neutral on silence.
 */
export class SoundSignature {
  private readonly a: number[];
  private lp: number[];
  private acc = [0, 0, 0, 0];
  private accTotal = 0;
  private n = 0;
  private readonly blockLen: number;
  private samples = 0;
  private t0: number | null = null;
  private state: SignatureState = 'idle';
  private key: string | null = null;
  private learn: number[][] = [];
  private mean: number[] = [];
  private spread: number[] = [];
  private window: number[] = [];
  private distance = 0;
  onChange: ((changeAtMs: number) => void) | undefined;

  constructor(private readonly sampleRate: number) {
    this.a = SIGNATURE_CONFIG.bandEdgesHz.map((f) => 1 - Math.exp((-2 * Math.PI * f) / sampleRate));
    this.lp = this.a.map(() => 0);
    this.blockLen = Math.round((sampleRate * SIGNATURE_CONFIG.blockMs) / 1000);
  }

  get snapshot(): SignatureSnapshot {
    return { state: this.state, distance: this.distance };
  }

  /** Learn this song's sound (again after a fired change). Same key while learning or tracking is a no-op. */
  arm(key: string): void {
    if (this.key === key && (this.state === 'learning' || this.state === 'tracking')) return;
    this.key = key;
    this.state = 'learning';
    this.learn = [];
    this.window = [];
    this.distance = 0;
  }

  disarm(): void {
    this.key = null;
    this.state = 'idle';
    this.window = [];
  }

  push(frame: Float32Array, endMs: number): void {
    if (this.t0 === null) this.t0 = endMs - (frame.length / this.sampleRate) * 1000;
    const [a0, a1, a2] = this.a as [number, number, number];
    let [l0, l1, l2] = this.lp as [number, number, number];
    for (let i = 0; i < frame.length; i++) {
      const x = frame[i]!;
      l0 += a0 * (x - l0);
      l1 += a1 * (x - l1);
      l2 += a2 * (x - l2);
      const b1 = l1 - l0;
      const b2 = l2 - l1;
      const b3 = x - l2;
      this.acc[0]! += l0 * l0;
      this.acc[1]! += b1 * b1;
      this.acc[2]! += b2 * b2;
      this.acc[3]! += b3 * b3;
      this.accTotal += x * x;
      this.n++;
      this.samples++;
      if (this.n >= this.blockLen) {
        this.lp = [l0, l1, l2];
        this.block(this.t0 + (this.samples / this.sampleRate) * 1000);
      }
    }
    this.lp = [l0, l1, l2];
  }

  private block(tMs: number) {
    const C = SIGNATURE_CONFIG;
    const rms = Math.sqrt(this.accTotal / this.n);
    const logs = this.acc.map((e) => Math.log(e / this.n + 1e-12));
    this.acc = [0, 0, 0, 0];
    this.accTotal = 0;
    this.n = 0;
    if (this.state === 'idle' || this.state === 'fired' || rms < C.minRms) return;
    const m = logs.reduce((s, v) => s + v, 0) / logs.length;
    const shape = logs.map((v) => v - m);

    if (this.state === 'learning') {
      this.learn.push(shape);
      if (this.learn.length * C.blockMs >= C.learnSeconds * 1000) {
        const k = this.learn.length;
        this.mean = [0, 1, 2, 3].map((i) => this.learn.reduce((s, v) => s + v[i]!, 0) / k);
        this.spread = [0, 1, 2, 3].map((i) => Math.max(C.spreadFloor, this.learn.reduce((s, v) => s + Math.abs(v[i]! - this.mean[i]!), 0) / k));
        this.state = 'tracking';
      }
      return;
    }

    const d = shape.reduce((s, v, i) => s + Math.abs(v - this.mean[i]!) / this.spread[i]!, 0) / shape.length;
    this.window.push(d);
    if (this.window.length > C.windowBlocks) this.window.shift();
    this.distance = this.window.reduce((s, v) => s + v, 0) / this.window.length;
    if (d < 1.5) for (let i = 0; i < 4; i++) this.mean[i]! += (shape[i]! - this.mean[i]!) * C.adaptRate;
    if (this.window.length === C.windowBlocks && this.distance > C.threshold) {
      this.state = 'fired';
      this.onChange?.(tMs - C.lagMs);
    }
  }
}
