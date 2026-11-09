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
  minSpanMsForRate: 8_000,
  /** Shorter span allowed when every answer sits on one line at another speed (ms). */
  minSpanMsForRateChange: 6_000,
  /** Samples whose residual exceeds this (ms) are dropped as outliers before refitting. */
  outlierResidualMs: 900,
  /** EMA smoothing factor for the rate (0..1, higher reacts faster). */
  rateEmaAlpha: 0.4,
  /**
   * 1.0x is assumed until a measured rate differs from it by more than this
   * and by rateSigmas standard errors. An adopted rate is held the same way.
   */
  minRateDeviation: 0.012,
  rateSigmas: 2.5,
  holdSigmas: 1.5,
  /** This many answers in a row off to the same side, by more than driftErrorMs on average, refit the rate. */
  driftSamples: 3,
  driftErrorMs: 250,
  /** Recent samples whose median places the clock (robust to a single bad answer). */
  anchorSamples: 7,
  /** Disagreement (ms) above which the clock snaps instead of nudging. */
  snapThresholdMs: 1_500,
  /**
   * A snap needs this many consecutive answers that disagree with the clock
   * but agree with each other, so a pair of bad answers cannot move the lyrics.
   */
  snapConfirmSamples: 3,
  /** Disagreement (ms) below which a sample is treated as agreeing with the clock. */
  agreeThresholdMs: 350,
  /** A correction is spread over at least this long (ms). */
  nudgeMinDurationMs: 3_000,
  /** ... and at most this long, so larger errors are fixed within seconds (ms). */
  nudgeMaxDurationMs: 8_000,
  /** A correction changes the shown speed by at most this fraction (barely visible). */
  nudgeMaxRateDelta: 0.08,
  /** ... and small corrections (under smallNudgeMs) by at most this. */
  smallNudgeRateDelta: 0.05,
  smallNudgeMs: 400,
  /** Corrections smaller than this fade over the longest window, below what anyone can see (ms). */
  deadbandMs: 150,
  /** Fixed acoustic or pipeline latency added to every position (ms). */
  defaultLatencyCompMs: 0,
} as const;

export const SCHEDULER_CONFIG = {
  /** Provider score (0-100) required to count a sample toward lock-on. */
  minLockScore: 50,
  /** Consecutive agreeing samples needed to lock on. */
  samplesToLock: 2,
  /**
   * An answer within this of the clock counts as agreeing for lock-on, and a
   * correction this small does not count as drifting (ms). Recognition answers
   * are rarely more precise than a few hundred ms.
   */
  lockToleranceMs: 600,
  /**
   * The agreeing samples must cover at least this much wall time (ms) before
   * locking, so two answers from nearly the same audio do not lock on their own.
   * 1.0x is assumed until proven otherwise, so this no longer waits for a rate.
   */
  minLockSpanMs: 2_000,
  /** Delay between attempts while searching or confirming (ms). */
  searchIntervalMs: 1_500,
  /**
   * Re-check interval range once locked (ms). Checking every few seconds keeps
   * the position steady and notices a new song within seconds. Each check is
   * one recognition request: about 800 per hour of listening at 4-5s.
   */
  lockedMinIntervalMs: 3_000,
  lockedMaxIntervalMs: 3_500,
  /** Delay after a no-match while locked or confirming (ms). */
  retryIntervalMs: 2_000,
  /** Consecutive no-matches after which we drop the lock and start over. */
  maxMisses: 3,
} as const;

/**
 * Mic capture and the cheap triggers that ask for an early recognition
 * (end of the song, a gap in the audio) instead of waiting for the 20-30s timer.
 */
export const CAPTURE_CONFIG = {
  /**
   * Seconds of the most recent audio sent per routine check while a song is on.
   * Override with ?clip=N in the URL. Shorter clips miss more often on a real mic.
   */
  clipSeconds: 6,
  /**
   * Shorter clip for the very first check (lyrics sooner) and for checks
   * triggered by a suspected song change (the clip is mostly new audio sooner).
   */
  quickClipSeconds: 4,
  /**
   * While searching, each "no match" grows the next clip by this many seconds,
   * up to maxClipSeconds (or what is buffered): 4s, then 6, 8, 10. A first try
   * on a short clip is fast when it works; longer clips match far more reliably
   * through a phone or laptop mic in a room.
   */
  searchClipStepSeconds: 2,
  /** Allowed range for the clip length override. */
  minClipSeconds: 3,
  maxClipSeconds: 10,
  /** Rolling mic buffer length in seconds. Must be at least maxClipSeconds. */
  bufferSeconds: 10,
  /** Wait this long before trying again when the mic buffer is not full yet (ms). */
  bufferWaitMs: 300,
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

/**
 * Local beat tracking on the mic audio (client/src/audio/beat.ts and rhythm.ts).
 * Drives beat-reactive visuals and the local "the song changed" decision.
 */
export const RHYTHM_CONFIG = {
  /** Analysis hop (seconds). */
  hopSeconds: 0.01,
  /** Low-pass cutoff for the kick band (Hz). */
  kickCutoffHz: 150,
  /** Minimum time between two onsets (ms). */
  minOnsetGapMs: 120,
  /** Onset threshold: running mean plus this many mean deviations. */
  onsetK: 1.5,
  /** Onset strength must also beat this absolute floor (log energy units). */
  onsetFloor: 0.3,
  /** Hops quieter than this RMS never produce onsets (silence). */
  silenceRms: 0.0005,
  /** Onset envelope kept for tempo estimates (seconds). */
  envelopeSeconds: 8,
  /** Tempo search range and preferred tempo (BPM). */
  minBpm: 60,
  maxBpm: 180,
  preferBpm: 120,
  /** Autocorrelation peak needed to trust a tempo (0-1). */
  minConfidence: 0.25,
  /** Window used to learn the song's beat grid after a match (seconds). */
  learnSeconds: 6,
  /** Window for tempo checks while tracking (seconds). */
  checkWindowSeconds: 4,
  /** Onsets from this recent window are compared with the predicted beats (seconds). */
  onsetWindowSeconds: 2,
  /** Tempo still matches within this ratio (also at half or double tempo). */
  tempoTolerance: 0.04,
  /** An onset is on the grid within this fraction of a beat. */
  gridTolerance: 0.12,
  /** Strength-weighted share of onsets that must land on the grid. */
  minOnGridShare: 0.4,
  /** Onsets needed in the recent window before a verdict is made. */
  minOnsets: 3,
  /** How often the grid is checked (ms). */
  checkEveryMs: 250,
  /** Sustained mismatch before deciding the song changed (ms). */
  switchAfterMs: 3_000,
  /** Beats predicted ahead (the sequencer). */
  predictBeats: 10,
  /** Large light flashes never exceed this rate (photosensitivity). */
  maxFlashHz: 3,
  /** Visual pulses fire this much before a predicted beat, to cover screen latency (ms). */
  visualLeadMs: 30,
} as const;

/**
 * BPM cross-check (shared/src/clock/bpmCheck.ts): compares the clock rate with
 * the playback rate implied by the local tempo tracker and asks for an early
 * recognition when they disagree. Never moves the clock on its own.
 */
export const BPM_CHECK_CONFIG = {
  /** Relative disagreement between the implied rate and the clock rate that counts as a mismatch. */
  tolerance: 0.04,
  /** The mismatch must add up to this long, counting only readings with a clear beat, before a recheck (ms). */
  holdMs: 4_000,
  /** At most one recheck per this interval (ms). */
  cooldownMs: 10_000,
  /** Rechecks in one disagreement before the learned tempo is relearned from the clock. */
  maxRechecks: 2,
  /**
   * Disagreements larger than this are ignored: more likely a tempo octave
   * error or another song (the song-change detector handles that) than a DJ pitch fader.
   */
  maxDeviation: 0.16,
  /** Implied rates outside this range are ignored too. */
  minRate: CLOCK_CONFIG.minRate,
  maxRate: CLOCK_CONFIG.maxRate,
  /** A gap between two readings counts for at most this long (ms), so a stalled tab cannot fire at once. */
  maxStepMs: 1_000,
  /** How often the client feeds the cross-check (ms). */
  intervalMs: 500,
} as const;

/** Server side: lyrics cache and upload limits (server/src/app.ts, cache.ts). */
export const SERVER_CONFIG = {
  /** Lyrics cache size (entries) before the least recently used is evicted. */
  cacheMaxEntries: 500,
  /** How long found lyrics stay cached (ms). */
  cacheHitTtlMs: 24 * 60 * 60 * 1000,
  /** How long a "no lyrics found" result stays cached (ms), so a later upload to LRCLIB is picked up. */
  cacheMissTtlMs: 60 * 60 * 1000,
  /** Largest accepted audio upload (bytes). Vercel caps request bodies lower, see server/src/vercel.ts. */
  maxUploadBytes: 5 * 1024 * 1024,
} as const;
