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
  return { slope, intercept, used: n };
}

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
    };
  }

  /** Add a sample and return the updated smoothed rate (null until enough data). */
  add(sample: ClockSample): number | null {
    this.samples.push(sample);
    if (this.samples.length > this.o.window) this.samples.splice(0, this.samples.length - this.o.window);
    const raw = this.rawRate();
    if (raw === null) return this.smoothed;
    this.smoothed = this.smoothed === null ? raw : this.o.emaAlpha * raw + (1 - this.o.emaAlpha) * this.smoothed;
    return this.smoothed;
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
