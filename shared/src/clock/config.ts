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

/**
 * Mic capture and the cheap triggers that ask for an early recognition
 * (end of the song, a gap in the audio) instead of waiting for the 20-30s timer.
 */
export const CAPTURE_CONFIG = {
  /** Seconds of the most recent audio sent per recognition. Override with ?clip=N in the URL. */
  clipSeconds: 6,
  /** Allowed range for the clip length override. */
  minClipSeconds: 3,
  maxClipSeconds: 10,
  /** Rolling mic buffer length in seconds. Must be at least maxClipSeconds. */
  bufferSeconds: 10,
} as const;

export const TRIGGER_CONFIG = {
  /** A frame is silent when its RMS is below this fraction of the recent average level. */
  silenceRelativeRms: 0.12,
  /** ... and never louder than this absolute RMS, so room noise alone cannot hide a gap. */
  silenceAbsoluteFloor: 0.002,
  /** Silence must last this long (ms) before sound returning counts as a gap end. */
  minGapMs: 1_500,
  /** Extra wait (ms) after a trigger so the clip holds only the new audio. Added to the clip length. */
  settleMarginMs: 700,
  /** Never schedule the end-of-song recheck sooner than this (ms). */
  minEndRecheckMs: 1_500,
} as const;

/** Duration ratio scaling for slowed or sped versions. */
export const SCALING_CONFIG = {
  /** Only scale when durations differ by more than this fraction. */
  minRatioDelta: 0.03,
  /** Never scale beyond the playback rate limits. */
  minScale: CLOCK_CONFIG.minRate,
  maxScale: CLOCK_CONFIG.maxRate,
} as const;

/**
 * Concert mode (experimental): match transcribed sung words against lyric
 * lines near the current position and re-anchor the clock on confident
 * matches only. Off unless the feature flag is enabled.
 */
export const CONCERT_CONFIG = {
  /** Length of each transcribed audio chunk (seconds). */
  chunkSeconds: 5,
  /** Delay between transcription attempts (ms). */
  intervalMs: 5_000,
  /** Search lyric lines this far before and after the current position (ms). */
  windowBeforeMs: 30_000,
  windowAfterMs: 45_000,
  /** Transcripts with fewer normalized words than this are ignored. */
  minWords: 3,
  /** Fuzzy score (0-1) a candidate needs to count as a confident match. */
  minScore: 0.72,
  /**
   * The best candidate must beat the best candidate with different text at a
   * different place by this much (0-1), otherwise the match is ambiguous.
   */
  minMargin: 0.08,
  /** Re-anchor only when the match disagrees with the clock by more than this (ms). */
  minCorrectionMs: 2_500,
  /** Corrections larger than this need two consecutive consistent matches (ms). */
  confirmLargeJumpMs: 15_000,
  /** Two matches confirm each other when their implied positions agree within this (ms). */
  confirmToleranceMs: 3_000,
  /** Assumed duration of the last lyric line when the next start is unknown (ms). */
  lastLineDurationMs: 4_000,
} as const;

export type ConcertConfig = { -readonly [K in keyof typeof CONCERT_CONFIG]: number };

export type ClockConfig ={ -readonly [K in keyof typeof CLOCK_CONFIG]: number };
export type SchedulerConfig = { -readonly [K in keyof typeof SCHEDULER_CONFIG]: number };
