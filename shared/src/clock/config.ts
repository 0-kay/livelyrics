/**
 * Tuning constants for the adaptive playback clock, rate estimator,
 * drift handling and re-recognition scheduler. Kept in one place so they can
 * be tuned without touching the logic.
 */
export const CLOCK_CONFIG = {
  /** Allowed playback rate range. Estimates outside this are clamped. */
  minRate: 0.7,
  maxRate: 1.4,
  /** Number of most recent samples used by the rolling regression. */
  regressionWindow: 16,
  /** Minimum samples before the regression produces a rate. */
  minSamplesForRate: 3,
  /** Minimum wall-clock span (ms) covered by the samples before trusting a slope. */
  minSpanMsForRate: 6_000,
  /** Samples whose residual exceeds this (ms) are dropped as outliers before refitting. */
  outlierResidualMs: 900,
  /** EMA smoothing factor for the rate (0..1, higher reacts faster). */
  rateEmaAlpha: 0.5,
  /** Disagreement (ms) above which the clock snaps instead of nudging. */
  snapThresholdMs: 1_500,
  /** Disagreement (ms) below which a sample is treated as agreeing with the clock. */
  agreeThresholdMs: 350,
  /** A nudge is spread over at least this long (ms). */
  nudgeMinDurationMs: 1_500,
  /** A nudge never changes the effective rate by more than this fraction. */
  nudgeMaxRateDelta: 0.35,
  /** Fixed acoustic or pipeline latency added to every position (ms). */
  defaultLatencyCompMs: 0,
} as const;

export const SCHEDULER_CONFIG = {
  /** Provider score (0-100) required to count a sample toward lock-on. */
  minLockScore: 50,
  /** Consecutive agreeing samples needed to lock on. */
  samplesToLock: 3,
  /**
   * The rate estimate must cover at least this much wall time (ms) before
   * locking. Must stay below (regressionWindow - 1) * searchIntervalMs or a
   * fast connection could never lock.
   */
  minLockSpanMs: 20_000,
  /** Delay between attempts while searching or confirming (ms). */
  searchIntervalMs: 2_000,
  /** Re-check interval range once locked (ms). A random value in this range is used. */
  lockedMinIntervalMs: 20_000,
  lockedMaxIntervalMs: 30_000,
  /** Delay after a no-match while locked or confirming (ms). */
  retryIntervalMs: 4_000,
  /** Consecutive no-matches after which we drop the lock and start over. */
  maxMisses: 3,
} as const;

/** Duration ratio scaling for slowed or sped versions. */
export const SCALING_CONFIG = {
  /** Only scale when durations differ by more than this fraction. */
  minRatioDelta: 0.03,
  /** Never scale beyond the playback rate limits. */
  minScale: CLOCK_CONFIG.minRate,
  maxScale: CLOCK_CONFIG.maxRate,
} as const;

export type ClockConfig = { -readonly [K in keyof typeof CLOCK_CONFIG]: number };
export type SchedulerConfig = { -readonly [K in keyof typeof SCHEDULER_CONFIG]: number };
