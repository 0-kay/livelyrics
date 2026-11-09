import { CLOCK_CONFIG, type ClockConfig } from './config.js';
import { RateEstimator, type ClockSample } from './rateEstimator.js';

/**
 * What the clock did with a sample:
 * - anchor: first sample, clock started
 * - agree: sample matched the clock closely, only refined
 * - nudge: small disagreement, corrected gradually
 * - suspect: large disagreement seen once, held until confirmed
 * - snap: large disagreement confirmed, jumped to the new position
 */
export type ClockAction = 'anchor' | 'agree' | 'nudge' | 'suspect' | 'snap';

export interface ClockUpdate {
  action: ClockAction;
  /** Sample position minus the clock's belief at the sample time (ms). */
  errorMs: number;
  rate: number;
  /** Wall time covered by the samples behind the rate estimate (ms). */
  rateSpanMs: number;
}

export interface RecognitionTiming {
  /** Song position at the end of the clip, from the recognition provider. */
  playOffsetMs: number;
  /** Wall time when the last audio sample of the clip was captured, if known. */
  clipEndWallMs?: number;
  /** Wall time when the request was sent. */
  requestSentWallMs: number;
  /** Wall time when the response arrived. */
  responseWallMs: number;
}

/**
 * Turn a recognition result into a clock sample. playOffsetMs describes the
 * end of the clip, so the sample is placed at the clip end time. When that is
 * unknown we fall back to the send time, which removes the network round trip
 * (responseWallMs - requestSentWallMs) from the estimate.
 */
export function sampleFromRecognition(t: RecognitionTiming): ClockSample & { roundTripMs: number } {
  return {
    wallMs: t.clipEndWallMs ?? t.requestSentWallMs,
    songPosMs: t.playOffsetMs,
    roundTripMs: Math.max(0, t.responseWallMs - t.requestSentWallMs),
  };
}

export interface AdaptiveClockOptions {
  /** Added to every reported position (ms). Positive shows lyrics earlier. */
  latencyCompMs?: number;
  config?: Partial<ClockConfig>;
}

/**
 * Adaptive playback clock:
 *   songPositionMs = anchorOffsetMs + (now - anchorWallMs) * rate + latencyCompMs
 *
 * The clock keeps a "target" line (best belief of the true position) and a
 * displayed position that eases toward it. Small disagreements are nudged out
 * over time so lyrics never jump; large confirmed ones snap.
 */
export class AdaptivePlaybackClock {
  private readonly cfg: ClockConfig;
  private readonly estimator: RateEstimator;
  latencyCompMs: number;

  private anchored = false;
  private anchorOffsetMs = 0;
  private anchorWallMs = 0;
  private currentRate = 1;
  // Easing: displayed = target + residual, residual decays linearly to 0.
  private residualMs = 0;
  private residualStartWallMs = 0;
  private residualDurationMs = 0;
  /** Consecutive large disagreements that agree with each other (a seek in progress, or bad answers). */
  private pendingSnaps: ClockSample[] = [];
  /** Recent answer errors (ms), to spot a held rate that is consistently wrong. */
  private recentErrors: number[] = [];

  constructor(opts: AdaptiveClockOptions = {}) {
    this.cfg = { ...CLOCK_CONFIG, ...opts.config };
    this.latencyCompMs = opts.latencyCompMs ?? this.cfg.defaultLatencyCompMs;
    this.estimator = new RateEstimator({
      window: this.cfg.regressionWindow,
      minSamples: this.cfg.minSamplesForRate,
      minSpanMs: this.cfg.minSpanMsForRate,
      outlierResidualMs: this.cfg.outlierResidualMs,
      emaAlpha: this.cfg.rateEmaAlpha,
      minRate: this.cfg.minRate,
      maxRate: this.cfg.maxRate,
      minRateDeviation: this.cfg.minRateDeviation,
      rateSigmas: this.cfg.rateSigmas,
      holdSigmas: this.cfg.holdSigmas,
    });
  }

  get isAnchored(): boolean {
    return this.anchored;
  }

  get rate(): number {
    return this.currentRate;
  }

  get isNudging(): boolean {
    return this.residualMs !== 0;
  }

  /** Best belief of the true song position at wall time (no easing, no latency comp). */
  targetAt(wallMs: number): number {
    return this.anchorOffsetMs + (wallMs - this.anchorWallMs) * this.currentRate;
  }

  /** Displayed song position at wall time, or null before the first sample. */
  positionAt(nowMs: number): number | null {
    if (!this.anchored) return null;
    return this.targetAt(nowMs) + this.residualAt(nowMs) + this.latencyCompMs;
  }

  private residualAt(nowMs: number): number {
    if (this.residualMs === 0) return 0;
    const t = (nowMs - this.residualStartWallMs) / this.residualDurationMs;
    if (t >= 1) return 0;
    return this.residualMs * (1 - Math.max(0, t));
  }

  private setTarget(offsetMs: number, wallMs: number, rate: number) {
    this.anchorOffsetMs = offsetMs;
    this.anchorWallMs = wallMs;
    this.currentRate = rate;
  }

  /**
   * Feed a sample. nowMs is the current wall time (the sample is usually a few
   * seconds in the past because recognition takes time).
   */
  addSample(sample: ClockSample, nowMs: number): ClockUpdate {
    if (!this.anchored) {
      this.anchored = true;
      this.estimator.add(sample);
      this.setTarget(sample.songPosMs, sample.wallMs, this.estimator.rate ?? 1);
      this.clearResidual();
      return { action: 'anchor', errorMs: 0, rate: this.currentRate, rateSpanMs: 0 };
    }

    const errorMs = sample.songPosMs - this.targetAt(sample.wallMs);

    // Off, but on one straight line with the earlier answers: the song plays at another speed
    // than we assumed (DJ pitch, slowed edit). Adopt that rate now instead of treating it as a seek.
    if (Math.abs(errorMs) > this.cfg.agreeThresholdMs) {
      // Earlier answers held as suspects may have been the new speed showing, so they count too.
      const free = this.estimator.freeFitWith(sample, this.cfg.minSpanMsForRateChange, this.pendingSnaps);
      const slope = free ? Math.min(this.cfg.maxRate, Math.max(this.cfg.minRate, free.slope)) : null;
      if (
        free && slope !== null &&
        free.maxResidualMs <= this.cfg.agreeThresholdMs * 2 &&
        Math.abs(slope - this.currentRate) > Math.max(this.cfg.minRateDeviation, this.cfg.rateSigmas * free.slopeSe)
      ) {
        const held = this.pendingSnaps;
        this.pendingSnaps = [];
        const displayedBefore = this.targetAt(nowMs) + this.residualAt(nowMs);
        for (const h of held) this.estimator.add(h);
        this.estimator.add(sample);
        const rate = this.estimator.adopt(slope);
        this.setTarget(free.slope * sample.wallMs + free.intercept, sample.wallMs, rate);
        const residual = displayedBefore - this.targetAt(nowMs);
        if (Math.abs(residual) > this.cfg.snapThresholdMs) {
          this.clearResidual();
          return { action: 'snap', errorMs, rate, rateSpanMs: this.estimator.spanMs };
        }
        this.startResidual(residual, nowMs, true);
        return { action: 'nudge', errorMs, rate, rateSpanMs: this.estimator.spanMs };
      }
    }

    if (Math.abs(errorMs) > this.cfg.snapThresholdMs) {
      const last = this.pendingSnaps[this.pendingSnaps.length - 1];
      if (last && !this.confirms(last, sample)) this.pendingSnaps = [];
      this.pendingSnaps.push(sample);
      if (this.pendingSnaps.length >= this.cfg.snapConfirmSamples) {
        // Several answers agree with each other but not with us: a real seek or jump.
        const confirmed = this.pendingSnaps;
        this.pendingSnaps = [];
        this.estimator.reset({ keepRate: true });
        let rate = this.currentRate;
        for (const c of confirmed) rate = this.estimator.add(c) ?? rate;
        const anchorPos = this.estimator.medianAnchor(sample.wallMs, rate, this.cfg.anchorSamples) ?? sample.songPosMs;
        this.setTarget(anchorPos, sample.wallMs, rate);
        this.clearResidual();
        return { action: 'snap', errorMs, rate, rateSpanMs: this.estimator.spanMs };
      }
      return { action: 'suspect', errorMs, rate: this.currentRate, rateSpanMs: this.estimator.spanMs };
    }

    this.pendingSnaps = [];
    const displayedBefore = this.targetAt(nowMs) + this.residualAt(nowMs);
    let rate = this.estimator.add(sample) ?? this.currentRate;
    // Several answers in a row off to the same side: the held rate is wrong, refit it now.
    this.recentErrors = [...this.recentErrors, errorMs].slice(-this.cfg.driftSamples);
    const e = this.recentErrors;
    if (
      e.length === this.cfg.driftSamples &&
      (e.every((x) => x > 0) || e.every((x) => x < 0)) &&
      e.reduce((a, x) => a + Math.abs(x), 0) / e.length > this.cfg.driftErrorMs
    ) {
      const slope = this.estimator.freeSlope(this.cfg.minSpanMsForRateChange);
      if (slope !== null && Math.abs(slope - rate) > this.cfg.minRateDeviation) rate = this.estimator.adopt(slope);
      this.recentErrors = [];
    }
    // Place the clock on the median of the recent answers at the held rate: one bad answer cannot move it.
    // A real speed difference is caught above and adopted, so the held rate does not bias this for long.
    const anchorPos = this.estimator.medianAnchor(sample.wallMs, rate, this.cfg.anchorSamples) ?? sample.songPosMs;
    this.setTarget(anchorPos, sample.wallMs, rate);

    const residual = displayedBefore - this.targetAt(nowMs);
    const agree = Math.abs(errorMs) <= this.cfg.agreeThresholdMs;
    this.startResidual(residual, nowMs);
    return { action: agree ? 'agree' : 'nudge', errorMs, rate, rateSpanMs: this.estimator.spanMs };
  }

  /**
   * Force the clock onto an externally verified position (concert mode
   * lyric match). Keeps the current rate, drops older samples that disagree,
   * and jumps without easing. Before the first sample this behaves like addSample.
   */
  reanchor(sample: ClockSample, nowMs: number): ClockUpdate {
    if (!this.anchored) return this.addSample(sample, nowMs);
    const errorMs = sample.songPosMs - this.targetAt(sample.wallMs);
    this.pendingSnaps = [];
    this.estimator.reset({ keepRate: true });
    this.estimator.add(sample);
    this.setTarget(sample.songPosMs, sample.wallMs, this.currentRate);
    this.clearResidual();
    return { action: 'snap', errorMs, rate: this.currentRate, rateSpanMs: this.estimator.spanMs };
  }

  /**
   * True if b is physically consistent with a: the song advanced between them
   * at some rate inside [minRate, maxRate], give or take sample noise.
   */
  private confirms(a: ClockSample, b: ClockSample): boolean {
    const dt = b.wallMs - a.wallMs;
    const advanced = b.songPosMs - a.songPosMs;
    const tol = this.cfg.agreeThresholdMs * 2;
    return advanced >= dt * this.cfg.minRate - tol && advanced <= dt * this.cfg.maxRate + tol;
  }

  /** fast: catch up after adopting a new rate (eased over 1.5-4s, up to 20% speed). */
  private startResidual(residualMs: number, nowMs: number, fast = false) {
    if (Math.abs(residualMs) < 1) {
      this.clearResidual();
      return;
    }
    this.residualMs = residualMs;
    this.residualStartWallMs = nowMs;
    // Tiny differences fade over the longest window (invisible); larger ones at most ~8% speed change,
    // but never take longer than nudgeMaxDurationMs.
    if (fast) {
      this.residualDurationMs = Math.min(4_000, Math.max(1_500, Math.abs(residualMs) / 0.2));
      return;
    }
    const abs = Math.abs(residualMs);
    const maxDelta = abs < this.cfg.smallNudgeMs ? this.cfg.smallNudgeRateDelta : this.cfg.nudgeMaxRateDelta;
    const d = abs < this.cfg.deadbandMs ? this.cfg.nudgeMaxDurationMs : abs / maxDelta;
    this.residualDurationMs = Math.min(this.cfg.nudgeMaxDurationMs, Math.max(this.cfg.nudgeMinDurationMs, d));
  }

  private clearResidual() {
    this.residualMs = 0;
    this.residualDurationMs = 0;
  }

  /** Forget everything (new song). */
  reset(): void {
    this.anchored = false;
    this.currentRate = 1;
    this.pendingSnaps = [];
    this.recentErrors = [];
    this.clearResidual();
    this.estimator.reset();
  }
}
