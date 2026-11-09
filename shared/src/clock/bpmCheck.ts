import { BPM_CHECK_CONFIG } from './config.js';

export type BpmCheckConfig = { -readonly [K in keyof typeof BPM_CHECK_CONFIG]: number };

export type BpmCheckStatus = 'idle' | 'agree' | 'disagree' | 'recheck' | 'relearned';

export interface BpmCheckInput {
  nowMs: number;
  /** Locally tracked tempo of the song on the mic (BPM), or null when no clear beat. */
  bpm: number | null;
  /** Playback rate the clock is using. */
  clockRate: number;
  /** True when the clock is locked on, so its rate is trusted. */
  locked: boolean;
}

export interface BpmCheckResult {
  status: BpmCheckStatus;
  /** Tempo of the song at 1.0x, learned while locked. */
  baseBpm: number | null;
  /** Playback rate the local tempo implies, or null. */
  impliedRate: number | null;
}

/**
 * Cross-checks the clock rate (from recognition offsets) against the local
 * tempo tracker. While the clock is locked it learns the song's tempo at 1.0x
 * (`bpm / clockRate`). Later, the heard tempo implies a playback rate. When the
 * two disagree for `holdMs` of beat time (a DJ pitched the track since the last check), it
 * asks for an early recognition so the regression catches up in seconds
 * instead of waiting for the 20-30s re-check. It never moves the clock
 * itself: recognition stays the source of truth. If the disagreement survives
 * `maxRechecks` rechecks, the learned tempo is assumed wrong and relearned.
 * Readings without a clear beat pause the count; only an agreeing reading
 * clears it. Half and double tempo readings are folded onto the nearest match.
 */
export class BpmCrossCheck {
  private readonly cfg: BpmCheckConfig;
  private base: number | null = null;
  /** Disagreeing time accumulated since the last agreement (ms). */
  private disagreeMs = 0;
  private lastAt: number | null = null;
  private lastRecheckAt = -Infinity;
  private rechecks = 0;

  constructor(cfg: Partial<BpmCheckConfig> = {}) {
    this.cfg = { ...BPM_CHECK_CONFIG, ...cfg };
  }

  get baseBpm(): number | null {
    return this.base;
  }

  /** Forget the learned tempo (new song, or listening stopped). */
  reset(): void {
    this.base = null;
    this.disagreeMs = 0;
    this.lastAt = null;
    this.lastRecheckAt = -Infinity;
    this.rechecks = 0;
  }

  /** Playback rate implied by `bpm`, folded by 0.5x or 2x toward `near`. */
  impliedRate(bpm: number, near: number): number | null {
    if (this.base === null || !(bpm > 0)) return null;
    const raw = bpm / this.base;
    let best = raw;
    for (const m of [0.5, 2]) {
      const r = raw * m;
      if (Math.abs(Math.log(r / near)) < Math.abs(Math.log(best / near))) best = r;
    }
    return best;
  }

  update(input: BpmCheckInput): BpmCheckResult {
    const { nowMs, bpm, clockRate, locked } = input;
    const C = this.cfg;
    const dt = this.lastAt === null ? 0 : Math.max(0, Math.min(nowMs - this.lastAt, C.maxStepMs));
    this.lastAt = nowMs;
    if (bpm === null || !(bpm > 0) || !(clockRate > 0)) {
      // No clear beat (breakdown, quiet bridge): neutral, the count pauses.
      return this.result('idle', null);
    }
    if (this.base === null) {
      if (locked) {
        this.base = bpm / clockRate;
        return this.result('relearned', clockRate);
      }
      return this.result('idle', null);
    }
    const implied = this.impliedRate(bpm, clockRate)!;
    if (implied < C.minRate || implied > C.maxRate) {
      // Outside any plausible playback rate: not our call.
      return this.result('idle', implied);
    }
    const off = Math.abs(implied / clockRate - 1);
    if (off > C.maxDeviation) {
      return this.result('idle', implied);
    }
    if (off <= C.tolerance) {
      this.disagreeMs = 0;
      this.rechecks = 0;
      return this.result('agree', implied);
    }
    this.disagreeMs += dt;
    if (this.disagreeMs < C.holdMs) return this.result('disagree', implied);
    if (nowMs - this.lastRecheckAt < C.cooldownMs) return this.result('disagree', implied);
    if (this.rechecks >= C.maxRechecks) {
      // Recognition keeps confirming its rate: trust it and relearn the tempo.
      if (locked) {
        this.base = bpm / clockRate;
        this.rechecks = 0;
        this.disagreeMs = 0;
        return this.result('relearned', clockRate);
      }
      return this.result('disagree', implied);
    }
    this.rechecks++;
    this.lastRecheckAt = nowMs;
    this.disagreeMs = 0;
    return this.result('recheck', implied);
  }

  private result(status: BpmCheckStatus, impliedRate: number | null): BpmCheckResult {
    return { status, baseBpm: this.base, impliedRate };
  }
}
