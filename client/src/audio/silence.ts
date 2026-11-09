import { TRIGGER_CONFIG } from '@livelyrics/shared';

export interface SilenceGapOptions {
  relativeRms?: number;
  absoluteFloor?: number;
  minGapMs?: number;
}

const rms = (x: Float32Array): number => {
  if (x.length === 0) return 0;
  let sum = 0;
  for (let i = 0; i < x.length; i++) sum += x[i]! * x[i]!;
  return Math.sqrt(sum / x.length);
};

/**
 * Spots a gap in the music (a track ending, a skip, a DJ cut) from the mic
 * frames alone, with no network call. A frame counts as silent when it is far
 * below the recent average level; when sound returns after a long enough
 * silence, `push` returns true once.
 */
export class SilenceGapDetector {
  private readonly relativeRms: number;
  private readonly absoluteFloor: number;
  private readonly minGapMs: number;
  private level = 0;
  private silentSince: number | null = null;

  constructor(opts: SilenceGapOptions = {}) {
    this.relativeRms = opts.relativeRms ?? TRIGGER_CONFIG.silenceRelativeRms;
    this.absoluteFloor = opts.absoluteFloor ?? TRIGGER_CONFIG.silenceAbsoluteFloor;
    this.minGapMs = opts.minGapMs ?? TRIGGER_CONFIG.minGapMs;
  }

  /** Feed one audio frame with its capture time (ms). True when sound returns after a gap. */
  push(frame: Float32Array, nowMs: number): boolean {
    const r = rms(frame);
    // Slow running average of the level; it only follows the signal, it never gates it.
    this.level += (r - this.level) * 0.0005;
    const silent = r < Math.max(this.absoluteFloor, this.level * this.relativeRms);
    if (silent) {
      if (this.silentSince === null) this.silentSince = nowMs;
      return false;
    }
    const gap = this.silentSince === null ? 0 : nowMs - this.silentSince;
    this.silentSince = null;
    return gap >= this.minGapMs;
  }

  reset(): void {
    this.level = 0;
    this.silentSince = null;
  }
}
