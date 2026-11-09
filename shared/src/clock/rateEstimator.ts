import { CLOCK_CONFIG } from './config.js';

/** One observation: at wall time wallMs the song was at songPosMs. */
export interface ClockSample {
  wallMs: number;
  songPosMs: number;
}

export interface LinearFit {
  slope: number;
  intercept: number;
  /** Samples used in the final fit (after outlier removal). */
  used: number;
  /** Standard error of the slope (rate units); Infinity when it cannot be estimated. */
  slopeSe: number;
}

/** Ordinary least squares fit of songPosMs against wallMs. Null if degenerate. */
export function fitLine(samples: readonly ClockSample[]): LinearFit | null {
  const n = samples.length;
  if (n < 2) return null;
  // Center on the first sample to keep numbers small (performance.now values can be large).
  const x0 = samples[0].wallMs;
  const y0 = samples[0].songPosMs;
  let sx = 0;
  let sy = 0;
  for (const s of samples) {
    sx += s.wallMs - x0;
    sy += s.songPosMs - y0;
  }
  const mx = sx / n;
  const my = sy / n;
  let sxx = 0;
  let sxy = 0;
  for (const s of samples) {
    const dx = s.wallMs - x0 - mx;
    sxx += dx * dx;
    sxy += dx * (s.songPosMs - y0 - my);
  }
  if (sxx === 0) return null;
  const slope = sxy / sxx;
  const intercept = y0 + my - slope * (x0 + mx);
  let rss = 0;
  for (const s of samples) {
    const r = s.songPosMs - (slope * s.wallMs + intercept);
    rss += r * r;
  }
  // Floor the residual spread so a lucky, perfectly straight handful of samples is not overtrusted.
  const sd = n > 2 ? Math.max(Math.sqrt(rss / (n - 2)), SLOPE_NOISE_FLOOR_MS) : Infinity;
  return { slope, intercept, used: n, slopeSe: sd / Math.sqrt(sxx) };
}

/** Assumed minimum per-sample timing noise when judging a slope (ms). */
export const SLOPE_NOISE_FLOOR_MS = 60;

/** Fit, drop samples with large residuals, refit once. */
export function robustFit(samples: readonly ClockSample[], outlierResidualMs: number, minKeep = 2): LinearFit | null {
  const first = fitLine(samples);
  if (!first) return null;
  const kept = samples.filter(
    (s) => Math.abs(s.songPosMs - (first.slope * s.wallMs + first.intercept)) <= outlierResidualMs,
  );
  if (kept.length === samples.length || kept.length < minKeep) return first;
  return fitLine(kept) ?? first;
}

export const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));

export interface RateEstimatorOptions {
  window?: number;
  minSamples?: number;
  minSpanMs?: number;
  outlierResidualMs?: number;
  emaAlpha?: number;
  minRate?: number;
  maxRate?: number;
  /** A slope must differ from 1.0 by more than this and by rateSigmas standard errors to be believed. */
  minRateDeviation?: number;
  rateSigmas?: number;
  /** An adopted rate is kept while the slope stays within this many standard errors of it. */
  holdSigmas?: number;
}

/**
 * Rolling linear regression over the last N (wall, song) samples. The slope is
 * the playback rate. The raw slope is clamped to [minRate, maxRate] and then
 * smoothed with an exponential moving average.
 */
export class RateEstimator {
  private samples: ClockSample[] = [];
  private smoothed: number | null = null;
  private readonly o: Required<RateEstimatorOptions>;

  constructor(opts: RateEstimatorOptions = {}) {
    this.o = {
      window: opts.window ?? CLOCK_CONFIG.regressionWindow,
      minSamples: opts.minSamples ?? CLOCK_CONFIG.minSamplesForRate,
      minSpanMs: opts.minSpanMs ?? CLOCK_CONFIG.minSpanMsForRate,
      outlierResidualMs: opts.outlierResidualMs ?? CLOCK_CONFIG.outlierResidualMs,
      emaAlpha: opts.emaAlpha ?? CLOCK_CONFIG.rateEmaAlpha,
      minRate: opts.minRate ?? CLOCK_CONFIG.minRate,
      maxRate: opts.maxRate ?? CLOCK_CONFIG.maxRate,
      minRateDeviation: opts.minRateDeviation ?? CLOCK_CONFIG.minRateDeviation,
      rateSigmas: opts.rateSigmas ?? CLOCK_CONFIG.rateSigmas,
      holdSigmas: opts.holdSigmas ?? CLOCK_CONFIG.holdSigmas,
    };
  }

  /**
   * Add a sample and return the updated rate (null until enough data).
   *
   * Music almost always plays at 1.0x, so 1.0 is the default belief: a slope
   * only replaces it when it is clearly different (more than
   * minRateDeviation and rateSigmas standard errors away). An adopted rate is
   * then held until the data clearly disagrees with it. This keeps noisy
   * answers from making the lyrics speed up and slow down.
   */
  add(sample: ClockSample): number | null {
    this.samples.push(sample);
    if (this.samples.length > this.o.window) this.samples.splice(0, this.samples.length - this.o.window);
    const fit = this.fit();
    if (!fit) return this.smoothed;
    const slope = clamp(fit.slope, this.o.minRate, this.o.maxRate);
    const within = (r: number, sigmas: number) => Math.max(this.o.minRateDeviation, sigmas * fit.slopeSe) >= Math.abs(slope - r);
    let target: number;
    if (this.smoothed !== null && within(this.smoothed, this.o.holdSigmas)) {
      // Consistent with what we have. Normal speed stays exactly 1.0 (no wobble); an adopted other
      // speed keeps being refined toward the measured slope, in small steps that shrink as data grows.
      target = this.smoothed === 1 ? 1 : slope;
    }
    else if (within(1, this.o.rateSigmas)) target = 1; // not clearly different from normal speed
    else target = slope;
    this.smoothed = this.smoothed === null ? target : this.o.emaAlpha * target + (1 - this.o.emaAlpha) * this.smoothed;
    if (Math.abs(this.smoothed - target) < 0.0005) this.smoothed = target;
    return this.smoothed;
  }

  /**
   * Fit the window plus `extra` with a free slope. Used to tell a speed
   * difference (all answers sit on one straight line, just not ours) from a
   * seek or a bad answer. Null without at least 3 samples over minSpanMs.
   */
  freeFitWith(extra: ClockSample, minSpanMs: number, pending: readonly ClockSample[] = []): (LinearFit & { maxResidualMs: number }) | null {
    const all = [...this.samples, ...pending, extra];
    if (all.length < 4 || all[all.length - 1]!.wallMs - all[0]!.wallMs < minSpanMs) return null;
    const fit = robustFit(all, this.o.outlierResidualMs, 4);
    // Need at least 4 answers on the line, including the new one.
    if (!fit || !Number.isFinite(fit.slope) || fit.used < 4) return null;
    const resid = (s: ClockSample) => Math.abs(s.songPosMs - (fit.slope * s.wallMs + fit.intercept));
    if (resid(extra) > this.o.outlierResidualMs) return null;
    let maxResidualMs = 0;
    for (const s of all) {
      const r = resid(s);
      if (r <= this.o.outlierResidualMs) maxResidualMs = Math.max(maxResidualMs, r);
    }
    return { ...fit, maxResidualMs };
  }

  /** Robust free slope of the current window (clamped), or null with fewer than 3 samples over minSpanMs. */
  freeSlope(minSpanMs: number): number | null {
    const s = this.samples;
    if (s.length < 3 || s[s.length - 1]!.wallMs - s[0]!.wallMs < minSpanMs) return null;
    const fit = robustFit(s, this.o.outlierResidualMs, 3);
    return fit && Number.isFinite(fit.slope) ? clamp(fit.slope, this.o.minRate, this.o.maxRate) : null;
  }

  /** Move every stored sample by deltaMs (after a seek: the speed evidence stays valid). */
  shift(deltaMs: number): void {
    this.samples = this.samples.map((s) => ({ wallMs: s.wallMs, songPosMs: s.songPosMs + deltaMs }));
  }

  /** Adopt a rate outright (after freeFitWith showed the song plays at another speed). */
  adopt(rate: number): number {
    this.smoothed = clamp(rate, this.o.minRate, this.o.maxRate);
    return this.smoothed;
  }

  /**
   * Song position at wallMs from the median of the recent samples projected
   * forward at `rate`. One noisy answer cannot move it.
   */
  medianAnchor(wallMs: number, rate: number, k = 5): number | null {
    const recent = this.samples.slice(-k);
    if (!recent.length) return null;
    const v = recent.map((s) => s.songPosMs + (wallMs - s.wallMs) * rate).sort((a, b) => a - b);
    const m = v.length >> 1;
    return v.length % 2 ? v[m]! : (v[m - 1]! + v[m]!) / 2;
  }

  private fit(): LinearFit | null {
    const s = this.samples;
    if (s.length < this.o.minSamples) return null;
    if (s[s.length - 1].wallMs - s[0].wallMs < this.o.minSpanMs) return null;
    const fit = robustFit(s, this.o.outlierResidualMs, this.o.minSamples);
    return fit && Number.isFinite(fit.slope) ? fit : null;
  }

  /** Clamped regression slope over the current window, or null if not enough data. */
  rawRate(): number | null {
    const fit = this.fit();
    return fit ? clamp(fit.slope, this.o.minRate, this.o.maxRate) : null;
  }

  /** Song position the regression line predicts at wallMs, or null if not enough data. */
  predict(wallMs: number): number | null {
    const fit = this.fit();
    return fit ? fit.slope * wallMs + fit.intercept : null;
  }

  get rate(): number | null {
    return this.smoothed;
  }

  /** Wall time covered by the current window (ms). */
  get spanMs(): number {
    const s = this.samples;
    return s.length < 2 ? 0 : s[s.length - 1].wallMs - s[0].wallMs;
  }

  get sampleCount(): number {
    return this.samples.length;
  }

  /**
   * Drop all samples, for example after a seek or a new song. With keepRate the
   * smoothed rate survives as the starting point for the next estimates.
   */
  reset(opts: { keepRate?: boolean } = {}): void {
    this.samples = [];
    if (!opts.keepRate) this.smoothed = null;
  }
}
