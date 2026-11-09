import { CLOCK_CONFIG, SCHEDULER_CONFIG, type SchedulerConfig } from './config.js';
import type { ClockAction } from './playbackClock.js';

/**
 * - searching: no song yet (or lock lost), recognize often
 * - confirming: song found, collecting agreeing samples before locking
 * - locked: clock trusted, only re-check every 20-30s
 * - drifting: clock disagreed with a recent sample, recognize often until it settles
 */
export type SyncState = 'searching' | 'confirming' | 'locked' | 'drifting';

export type RecognitionOutcome =
  | { matched: false }
  | {
      matched: true;
      /** Provider score 0-100. */
      score: number;
      /** What the clock did with this sample. */
      action: ClockAction;
      /** True when the matched song differs from the previous one. */
      songChanged?: boolean;
      /** Wall time covered by the clock's rate estimate. Locking waits for minLockSpanMs. */
      rateSpanMs?: number;
      /** How far the answer was from the clock (ms). Small nudges still count as agreeing. */
      errorMs?: number;
    };

export interface SchedulerDecision {
  state: SyncState;
  /** Wait this long before the next recognition attempt. */
  nextDelayMs: number;
  /** True when the caller should drop the current song and clock. */
  lostLock: boolean;
}

/**
 * Decides when to recognize next: fast until the clock locks on, then back
 * off to a random 20-30s re-check. Pure logic, no timers, so it is easy to test.
 */
export class RecognitionScheduler {
  private readonly cfg: SchedulerConfig;
  private readonly random: () => number;
  private _state: SyncState = 'searching';
  private streak = 0;
  private misses = 0;
  /** Wall time covered by the clock's samples for the current song (from the last result). */
  private rateSpanMs = Infinity;

  constructor(opts: { config?: Partial<SchedulerConfig>; random?: () => number } = {}) {
    this.cfg = { ...SCHEDULER_CONFIG, ...opts.config };
    this.random = opts.random ?? Math.random;
  }

  get state(): SyncState {
    return this._state;
  }

  /** Delay before the very first attempt after start. */
  initialDelayMs(): number {
    return 0;
  }

  onResult(r: RecognitionOutcome): SchedulerDecision {
    if (!r.matched) return this.onMiss();
    this.misses = 0;

    if (r.songChanged) {
      this._state = 'confirming';
      this.streak = 0;
    }

    const good = r.score >= this.cfg.minLockScore;
    const small = r.errorMs !== undefined && Math.abs(r.errorMs) <= this.cfg.lockToleranceMs;
    switch (r.action) {
      case 'anchor':
      case 'agree':
        this.streak = good ? this.streak + 1 : 0;
        break;
      case 'nudge':
        if (small) {
          // A small correction is normal recognition noise, not drift.
          this.streak = good ? this.streak + 1 : 0;
          break;
        }
        this.streak = 0;
        if (this._state === 'locked') this._state = 'drifting';
        break;
      case 'suspect':
      case 'snap':
        this.streak = 0;
        this._state = 'drifting';
        break;
    }

    // A weak match while locked is a hint that something changed (new song, noise):
    // go back to fast checks instead of waiting 20-30s.
    if (!good && this._state === 'locked') this._state = 'drifting';

    this.rateSpanMs = r.songChanged ? (r.rateSpanMs ?? 0) : (r.rateSpanMs ?? this.rateSpanMs);
    const rateReady = (r.rateSpanMs ?? Infinity) >= this.cfg.minLockSpanMs;
    if (this.streak >= this.cfg.samplesToLock && rateReady) this._state = 'locked';
    else if (this._state === 'searching') this._state = 'confirming';

    return { state: this._state, nextDelayMs: this.delayFor(this._state), lostLock: false };
  }

  private onMiss(): SchedulerDecision {
    this.misses++;
    this.streak = 0;
    if (this._state === 'searching') {
      return { state: 'searching', nextDelayMs: this.cfg.searchIntervalMs, lostLock: false };
    }
    if (this.misses >= this.cfg.maxMisses) {
      this._state = 'searching';
      this.misses = 0;
      return { state: 'searching', nextDelayMs: this.cfg.searchIntervalMs, lostLock: true };
    }
    // Keep the current song and clock; one quiet clip is not enough to give up.
    if (this._state === 'locked') this._state = 'drifting';
    return { state: this._state, nextDelayMs: this.cfg.retryIntervalMs, lostLock: false };
  }

  private delayFor(state: SyncState): number {
    if (state !== 'locked') return this.cfg.searchIntervalMs;
    // Right after a song is found, keep the fast pace until there is enough data to judge its speed.
    if (this.rateSpanMs < CLOCK_CONFIG.minSpanMsForRate) return this.cfg.searchIntervalMs;
    const { lockedMinIntervalMs: lo, lockedMaxIntervalMs: hi } = this.cfg;
    return Math.round(lo + (hi - lo) * this.random());
  }

  reset(): void {
    this._state = 'searching';
    this.streak = 0;
    this.misses = 0;
    this.rateSpanMs = Infinity;
  }
}
