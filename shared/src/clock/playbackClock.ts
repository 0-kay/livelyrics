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
  private pendingSnap: ClockSample | null = null;

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

    if (Math.abs(errorMs) > this.cfg.snapThresholdMs) {
      const pending = this.pendingSnap;
      if (pending && this.confirms(pending, sample)) {
        // Two samples agree with each other but not with us: a seek or a big mistake.
        this.pendingSnap = null;
        this.estimator.reset({ keepRate: true });
        this.estimator.add(pending);
        const rate = this.estimator.add(sample) ?? this.currentRate;
        this.setTarget(sample.songPosMs, sample.wallMs, rate);
        this.clearResidual();
        return { action: 'snap', errorMs, rate, rateSpanMs: this.estimator.spanMs };
      }
      this.pendingSnap = sample;
      return { action: 'suspect', errorMs, rate: this.currentRate, rateSpanMs: this.estimator.spanMs };
    }

    this.pendingSnap = null;
    const displayedBefore = this.targetAt(nowMs) + this.residualAt(nowMs);
    const rate = this.estimator.add(sample) ?? this.currentRate;
    // Anchor the new target on the regression line when available (less noisy than one sample).
    const anchorPos = this.estimator.predict(sample.wallMs) ?? sample.songPosMs;
    this.setTarget(anchorPos, sample.wallMs, rate);

    const residual = displayedBefore - this.targetAt(nowMs);
    const agree = Math.abs(errorMs) <= this.cfg.agreeThresholdMs;
    this.startResidual(residual, nowMs);
    return { action: agree ? 'agree' : 'nudge', errorMs, rate, rateSpanMs: this.estimator.spanMs };
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

  private startResidual(residualMs: number, nowMs: number) {
    if (Math.abs(residualMs) < 1) {
      this.clearResidual();
      return;
    }
    this.residualMs = residualMs;
    this.residualStartWallMs = nowMs;
    this.residualDurationMs = Math.max(this.cfg.nudgeMinDurationMs, Math.abs(residualMs) / this.cfg.nudgeMaxRateDelta);
  }

  private clearResidual() {
    this.residualMs = 0;
    this.residualDurationMs = 0;
  }

  /** Forget everything (new song). */
  reset(): void {
    this.anchored = false;
    this.currentRate = 1;
    this.pendingSnap = null;
    this.clearResidual();
    this.estimator.reset();
  }
}
