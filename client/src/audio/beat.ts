import { RHYTHM_CONFIG } from '@livelyrics/shared';

export interface Onset {
  /** Time of the onset (ms, same clock as the frame times). */
  t: number;
  /** 0 to 1. */
  strength: number;
}

export interface Hop {
  t: number;
  /** Onset strength function value for this hop (log energy rise, 0 or more). */
  od: number;
  /** Loudness, 0 to 1, relative to the recent peak. */
  level: number;
}

/**
 * Finds note onsets (kicks, snares, strong attacks) in raw mic frames, with no
 * FFT: a kick band from a one-pole low-pass plus the full band, the rise in
 * log energy per 10ms hop, and an adaptive threshold with peak picking.
 * Frame times come from a sample counter, so postMessage jitter does not move beats.
 */
export class BeatDetector {
  private readonly hopLen: number;
  private readonly lpA: number;
  private lp = 0;
  private acc = 0;
  private accLow = 0;
  private accN = 0;
  private samples = 0;
  private t0: number | null = null;
  private readonly hist: number[] = [];
  private odPrev2 = 0;
  private odPrev = 0;
  private tPrev = 0;
  private mean = 0;
  private dev = 0;
  private hops = 0;
  private lastOnset = -1e9;
  private peak = 1e-4;
  private levelS = 0;

  constructor(
    private readonly sampleRate: number,
    private readonly onHop?: (h: Hop) => void,
    private readonly onOnset?: (o: Onset) => void,
  ) {
    this.hopLen = Math.max(32, Math.round(sampleRate * RHYTHM_CONFIG.hopSeconds));
    this.lpA = 1 - Math.exp((-2 * Math.PI * RHYTHM_CONFIG.kickCutoffHz) / sampleRate);
  }

  get level(): number {
    return this.levelS;
  }

  /** Feed one frame; `endMs` is when its last sample was captured (used only to anchor the sample clock once). */
  push(frame: Float32Array, endMs: number): void {
    if (this.t0 === null) this.t0 = endMs - (frame.length / this.sampleRate) * 1000;
    for (let i = 0; i < frame.length; i++) {
      const x = frame[i]!;
      this.lp += this.lpA * (x - this.lp);
      this.acc += x * x;
      this.accLow += this.lp * this.lp;
      this.accN++;
      this.samples++;
      if (this.accN >= this.hopLen) this.hop();
    }
  }

  private hop() {
    const C = RHYTHM_CONFIG;
    const full = this.acc / this.accN;
    const low = this.accLow / this.accN;
    this.acc = this.accLow = 0;
    this.accN = 0;
    const t = this.t0! + (this.samples / this.sampleRate) * 1000;
    const rms = Math.sqrt(full);

    // Loudness relative to a slowly decaying peak; fast attack, slow release.
    this.peak = Math.max(rms, this.peak * 0.9995, 1e-4);
    const lv = Math.min(1, rms / this.peak);
    this.levelS += (lv - this.levelS) * (lv > this.levelS ? 0.5 : 0.06);

    const L = Math.log(low * 4 + full + 1e-9);
    const base = this.hist.length ? this.hist.reduce((a, b) => a + b, 0) / this.hist.length : L;
    this.hist.push(L);
    if (this.hist.length > 3) this.hist.shift();
    const od = rms < C.silenceRms ? 0 : Math.max(0, L - base);
    this.hops++;
    this.onHop?.({ t, od, level: this.levelS });

    // Peak pick the previous hop: it beat both neighbours and the threshold.
    const thr = this.mean + C.onsetK * this.dev;
    const p = this.odPrev;
    if (this.hops > 50 && p > this.odPrev2 && p >= od && p > thr && p > C.onsetFloor && this.tPrev - this.lastOnset >= C.minOnsetGapMs) {
      this.lastOnset = this.tPrev;
      const strength = Math.min(1, (p - this.mean) / (4 * this.dev + C.onsetFloor));
      this.onOnset?.({ t: this.tPrev, strength });
    }
    // Running statistics over about one second.
    const a = 0.01;
    this.mean += (od - this.mean) * a;
    this.dev += (Math.abs(od - this.mean) - this.dev) * a;
    this.odPrev2 = this.odPrev;
    this.odPrev = od;
    this.tPrev = t;
  }
}
