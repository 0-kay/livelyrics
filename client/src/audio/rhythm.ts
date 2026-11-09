import { RHYTHM_CONFIG } from '@livelyrics/shared';
import { BeatDetector, type Hop, type Onset } from './beat.js';

export interface TempoEstimate {
  periodMs: number;
  bpm: number;
  /** Autocorrelation peak relative to the signal energy, 0 to 1. */
  confidence: number;
  /** Time of the most recent beat on the estimated grid (ms). */
  lastBeatMs: number;
}

/**
 * Keeps the onset envelope and onset list and estimates tempo and beat phase
 * from them (autocorrelation with a mild preference around 120 BPM, then a
 * comb over the envelope for the phase).
 */
export class RhythmTracker {
  private readonly cap: number;
  private readonly env: Float32Array;
  private n = 0;
  private lastT = 0;
  readonly onsets: Onset[] = [];

  constructor(private readonly hopMs = RHYTHM_CONFIG.hopSeconds * 1000) {
    this.cap = Math.round((RHYTHM_CONFIG.envelopeSeconds * 1000) / hopMs);
    this.env = new Float32Array(this.cap);
  }

  get now(): number {
    return this.lastT;
  }

  pushHop(h: Hop): void {
    this.env[this.n % this.cap] = h.od;
    this.n++;
    this.lastT = h.t;
  }

  pushOnset(o: Onset): void {
    this.onsets.push(o);
    const keep = this.lastT - RHYTHM_CONFIG.envelopeSeconds * 1000;
    while (this.onsets.length && this.onsets[0]!.t < keep) this.onsets.shift();
  }

  recentOnsets(windowMs: number, minStrength = 0): Onset[] {
    const from = this.lastT - windowMs;
    return this.onsets.filter((o) => o.t >= from && o.strength >= minStrength);
  }

  /** Envelope value `back` hops before the newest one. */
  private at(back: number): number {
    if (back < 0 || back >= Math.min(this.n, this.cap)) return 0;
    return this.env[(this.n - 1 - back) % this.cap]!;
  }

  estimate(windowS: number): TempoEstimate | null {
    const C = RHYTHM_CONFIG;
    const W = Math.min(Math.round((windowS * 1000) / this.hopMs), Math.min(this.n, this.cap));
    const minLag = Math.round(60_000 / C.maxBpm / this.hopMs);
    const maxLag = Math.round(60_000 / C.minBpm / this.hopMs);
    if (W < maxLag * 2) return null;
    const x = new Float32Array(W);
    let mean = 0;
    for (let i = 0; i < W; i++) {
      x[i] = this.at(W - 1 - i);
      mean += x[i]!;
    }
    mean /= W;
    let r0 = 0;
    for (let i = 0; i < W; i++) {
      x[i]! -= mean;
      r0 += x[i]! * x[i]!;
    }
    r0 /= W;
    if (r0 <= 1e-9) return null;
    const r = new Float32Array(maxLag + 2);
    for (let l = minLag - 1; l <= maxLag + 1; l++) {
      let s = 0;
      for (let i = 0; i + l < W; i++) s += x[i]! * x[i + l]!;
      r[l] = s / (W - l) / r0;
    }
    const preferLag = 60_000 / C.preferBpm / this.hopMs;
    let best = -1;
    let bestScore = -Infinity;
    for (let l = minLag; l <= maxLag; l++) {
      const w = Math.exp(-0.5 * Math.pow(Math.log2(l / preferLag) / 0.9, 2));
      const sc = r[l]! * w;
      if (sc > bestScore) {
        bestScore = sc;
        best = l;
      }
    }
    if (best < 0 || r[best]! <= 0) return null;
    const y0 = r[best - 1]!;
    const y1 = r[best]!;
    const y2 = r[best + 1]!;
    const den = y0 - 2 * y1 + y2;
    const lag = best + (den < 0 ? Math.max(-0.5, Math.min(0.5, (0.5 * (y0 - y2)) / den)) : 0);

    // Phase: comb over the envelope at the estimated period.
    const beats = Math.floor(W / lag);
    let bestOff = 0;
    let bestComb = -Infinity;
    for (let o = 0; o < Math.ceil(lag); o++) {
      let s = 0;
      for (let k = 0; k < beats; k++) {
        const b = Math.round(o + k * lag);
        s += Math.max(this.at(b - 1), this.at(b), this.at(b + 1));
      }
      if (s > bestComb) {
        bestComb = s;
        bestOff = o;
      }
    }
    const periodMs = lag * this.hopMs;
    return { periodMs, bpm: 60_000 / periodMs, confidence: Math.max(0, Math.min(1, y1)), lastBeatMs: this.lastT - bestOff * this.hopMs };
  }
}

/** Beat times after `fromMs` on a grid. The sequencer the incoming rhythm is compared with. */
export function predictBeats(anchorMs: number, periodMs: number, fromMs: number, count = RHYTHM_CONFIG.predictBeats): number[] {
  const k = Math.floor((fromMs - anchorMs) / periodMs) + 1;
  return Array.from({ length: count }, (_, i) => anchorMs + (k + i) * periodMs);
}

/** Phase of `t` on the grid as a signed fraction of a beat, -0.5 to 0.5. */
export function gridError(t: number, anchorMs: number, periodMs: number): number {
  const ph = (t - anchorMs) / periodMs;
  return ph - Math.round(ph);
}

export type Verdict = 'on' | 'off' | 'neutral';
export type ChangeState = 'idle' | 'learning' | 'tracking' | 'fired';

export interface ChangeSnapshot {
  state: ChangeState;
  /** Reference grid learned for the current song. */
  refBpm: number | null;
  /** Latest tempo heard. */
  bpm: number | null;
  confidence: number;
  verdict: Verdict;
  onGridShare: number;
  /** How long the rhythm has disagreed with the grid (ms). */
  mismatchMs: number;
}

/**
 * Learns the beat grid of the current song once it is matched, predicts the
 * next beats, and compares what comes in. A strong rhythm that disagrees
 * (other tempo, or onsets off the grid) for a sustained `switchAfterMs`
 * means the song changed. No rhythm at all (a breakdown, a quiet bridge) is
 * neutral: it pauses the count but never triggers.
 */
export class SongChangeDetector {
  private state: ChangeState = 'idle';
  private key: string | null = null;
  private learnFrom = 0;
  private period = 0;
  private anchor = 0;
  private lastCheck = 0;
  private bad = 0;
  private snap: ChangeSnapshot = { state: 'idle', refBpm: null, bpm: null, confidence: 0, verdict: 'neutral', onGridShare: 0, mismatchMs: 0 };
  onChange: (() => void) | undefined;

  constructor(private readonly tracker: RhythmTracker) {}

  get snapshot(): ChangeSnapshot {
    return this.snap;
  }

  /** The beat grid, once learned. */
  get grid(): { anchorMs: number; periodMs: number } | null {
    return this.state === 'tracking' ? { anchorMs: this.anchor, periodMs: this.period } : null;
  }

  /** Start (or restart after a fired change) learning for this song. Same key while tracking is a no-op. */
  arm(key: string): void {
    if (this.key === key && (this.state === 'learning' || this.state === 'tracking')) return;
    this.key = key;
    this.state = 'learning';
    this.learnFrom = this.tracker.now;
    this.bad = 0;
    this.publish('neutral', null, 0, 0);
  }

  disarm(): void {
    this.key = null;
    this.state = 'idle';
    this.bad = 0;
    this.publish('neutral', null, 0, 0);
  }

  /** Called on every hop; checks every `checkEveryMs`. */
  tick(): void {
    const C = RHYTHM_CONFIG;
    const now = this.tracker.now;
    if (now - this.lastCheck < C.checkEveryMs) return;
    const dt = this.lastCheck === 0 ? 0 : now - this.lastCheck;
    this.lastCheck = now;
    if (this.state === 'idle' || this.state === 'fired') return;

    if (this.state === 'learning') {
      if (now - this.learnFrom < C.learnSeconds * 1000) return;
      const est = this.tracker.estimate(C.learnSeconds);
      if (est && est.confidence >= C.minConfidence && this.tracker.recentOnsets(C.learnSeconds * 1000, 0.15).length >= C.minOnsets * 2) {
        this.period = est.periodMs;
        this.anchor = est.lastBeatMs;
        this.state = 'tracking';
        this.bad = 0;
      }
      this.publish('neutral', est, 0, 0);
      return;
    }

    // Tracking: compare the recent rhythm with the learned grid.
    const est = this.tracker.estimate(C.checkWindowSeconds);
    const onsets = this.tracker.recentOnsets(C.onsetWindowSeconds * 1000, 0.15);
    const present = !!est && est.confidence >= C.minConfidence && onsets.length >= C.minOnsets;
    let verdict: Verdict = 'neutral';
    let share = 0;
    if (present && est) {
      const ratio = est.periodMs / this.period;
      const mult = [1, 0.5, 2].find((m) => Math.abs(ratio / m - 1) <= C.tempoTolerance);
      let wOn = 0;
      let wAll = 0;
      let err = 0;
      let errW = 0;
      for (const o of onsets) {
        const e = gridError(o.t, this.anchor, this.period);
        // Square the strength so kicks and snares count far more than off-beat hats.
        const w = o.strength * o.strength;
        wAll += w;
        if (Math.abs(e) <= C.gridTolerance) {
          wOn += w;
          err += e * w;
          errW += w;
        }
      }
      share = wAll > 0 ? wOn / wAll : 0;
      // The tempo comb's own phase is a second, sturdier opinion on the grid.
      const combOn = Math.abs(gridError(est.lastBeatMs, this.anchor, this.period)) <= C.gridTolerance;
      verdict = mult !== undefined && (share >= C.minOnGridShare || combOn) ? 'on' : 'off';
      if (verdict === 'on' && mult !== undefined) {
        // Follow slow tempo rides and phase drift (a simple phase-locked loop).
        if (errW > 0) this.anchor += (err / errW) * this.period * 0.3;
        this.period += (est.periodMs / mult - this.period) * 0.1;
      }
    }
    if (verdict === 'on') this.bad = 0;
    else if (verdict === 'off') this.bad += dt;
    this.publish(verdict, est, share, est?.confidence ?? 0);
    if (this.bad >= C.switchAfterMs) {
      this.state = 'fired';
      this.publish(verdict, est, share, est?.confidence ?? 0);
      this.onChange?.();
    }
  }

  private publish(verdict: Verdict, est: TempoEstimate | null, share: number, confidence: number) {
    this.snap = {
      state: this.state,
      refBpm: this.state === 'tracking' || this.state === 'fired' ? 60_000 / this.period : null,
      bpm: est ? est.bpm : null,
      confidence,
      verdict,
      onGridShare: share,
      mismatchMs: this.bad,
    };
  }
}

export type Energy = 'calm' | 'groove' | 'hype';

/** Visual pulses fire this much before a predicted beat (ms). */
export const VISUAL_LEAD_MS = 30;

export interface BeatFrame {
  /** 1 on a beat, decaying to 0 (about 160ms). */
  pulse: number;
  /** Counts beats; use it to cycle colors or mark bars. */
  beatIndex: number;
  /** Loudness 0 to 1. */
  level: number;
  energy: Energy;
  bpm: number | null;
  /** True when pulses come from the predicted grid, false when from raw onsets. */
  onGrid: boolean;
  /** Upcoming predicted beats (ms), empty without a confident tempo. */
  next: number[];
}

/**
 * Everything rhythm on the client: onset detection on mic frames, tempo
 * tracking, the song-change detector, and a per-frame beat readout for the
 * visuals. Pure apart from its inputs, so it runs on synthetic audio in tests.
 */
export class RhythmWatch {
  readonly tracker = new RhythmTracker();
  readonly change = new SongChangeDetector(this.tracker);
  private readonly detector: BeatDetector;
  private est: TempoEstimate | null = null;
  private lastEst = 0;
  private lastOnset: { t: number; s: number; i: number } = { t: -1e9, s: 0, i: 0 };
  /** Loudness averaged over about 1.5s, so the effect pattern does not flicker. */
  private slowLevel = 0;
  private energy: Energy = 'calm';
  private energySince = 0;

  constructor(sampleRate: number) {
    this.detector = new BeatDetector(
      sampleRate,
      (h) => {
        this.tracker.pushHop(h);
        this.change.tick();
        this.slowLevel += (h.level - this.slowLevel) * 0.007;
        this.updateEnergy(h.t);
        if (h.t - this.lastEst >= 500) {
          this.lastEst = h.t;
          const e = this.tracker.estimate(RHYTHM_CONFIG.checkWindowSeconds);
          this.est = e && e.confidence >= RHYTHM_CONFIG.minConfidence ? e : null;
        }
      },
      (o) => {
        this.tracker.pushOnset(o);
        this.lastOnset = { t: o.t, s: o.strength, i: this.lastOnset.i + 1 };
      },
    );
  }

  push(frame: Float32Array, endMs: number): void {
    this.detector.push(frame, endMs);
  }

  /** Effect pattern with hysteresis: a new pattern must hold for 2s before it shows. */
  private updateEnergy(t: number) {
    const lv = this.slowLevel;
    const density = this.tracker.recentOnsets(4000, 0.15).length / 4;
    const want: Energy = lv < 0.15 || density < 0.8 ? 'calm' : lv > 0.45 && density > 2.5 ? 'hype' : 'groove';
    if (want === this.energy) {
      this.energySince = t;
      return;
    }
    if (t - this.energySince >= 2000) {
      this.energy = want;
      this.energySince = t;
    }
  }

  /** Beat readout at wall time `nowMs` (same clock as the frames). */
  frame(nowMs: number): BeatFrame {
    const level = this.detector.level;
    const grid = this.change.grid ?? (this.est ? { anchorMs: this.est.lastBeatMs, periodMs: this.est.periodMs } : null);
    let pulse = 0;
    let beatIndex = 0;
    let next: number[] = [];
    // Without fresh onsets the grid is stale: fall back to raw onsets.
    const fresh = nowMs - (this.tracker.recentOnsets(2000).at(-1)?.t ?? -1e9) < 2000;
    if (grid && fresh) {
      // Fire slightly ahead of the predicted beat to cover render and display latency.
      const k = Math.floor((nowMs + VISUAL_LEAD_MS - grid.anchorMs) / grid.periodMs);
      const last = grid.anchorMs + k * grid.periodMs;
      pulse = Math.exp(-Math.max(0, nowMs - last) / 160);
      beatIndex = k;
      next = predictBeats(grid.anchorMs, grid.periodMs, nowMs);
    } else {
      const dt = nowMs - this.lastOnset.t;
      pulse = dt >= 0 ? Math.exp(-dt / 160) * (0.4 + 0.6 * this.lastOnset.s) : 0;
      beatIndex = this.lastOnset.i;
    }
    const energy = this.energy;
    const bpm = this.change.grid ? 60_000 / this.change.grid.periodMs : this.est?.bpm ?? null;
    return { pulse: level < 0.05 ? 0 : pulse, beatIndex, level, energy, bpm, onGrid: !!grid && fresh, next };
  }
}
