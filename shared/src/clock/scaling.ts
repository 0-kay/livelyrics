import type { SyncedLyrics } from '../types.js';
import { SCALING_CONFIG } from './config.js';

/**
 * Factor to multiply lyric timestamps by when the recognized track (for
 * example a slowed or sped edit) has a different duration than the track the
 * lyrics were timed against. Returns 1 when either duration is unknown, the
 * difference is too small to matter, or the ratio is implausible.
 */
export function durationScale(
  matchedDurationMs: number | undefined,
  lyricsDurationMs: number | undefined,
  cfg: { minRatioDelta: number; minScale: number; maxScale: number } = SCALING_CONFIG,
): number {
  if (!matchedDurationMs || !lyricsDurationMs || matchedDurationMs <= 0 || lyricsDurationMs <= 0) return 1;
  const ratio = matchedDurationMs / lyricsDurationMs;
  if (Math.abs(ratio - 1) <= cfg.minRatioDelta) return 1;
  if (ratio < cfg.minScale || ratio > cfg.maxScale) return 1;
  return ratio;
}

/** Return a copy of the lyrics with every timestamp (and the duration) multiplied by scale. */
export function scaleLyrics(lyrics: SyncedLyrics, scale: number): SyncedLyrics {
  if (scale === 1) return lyrics;
  return {
    ...lyrics,
    lines: lyrics.lines.map((l) => ({ ...l, startMs: Math.round(l.startMs * scale) })),
    durationMs: lyrics.durationMs === undefined ? undefined : Math.round(lyrics.durationMs * scale),
  };
}
