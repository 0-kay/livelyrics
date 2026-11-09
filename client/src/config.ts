import { CAPTURE_CONFIG } from '@livelyrics/shared';

/**
 * Clip length in seconds for each recognition. Uses CAPTURE_CONFIG.clipSeconds
 * unless the page URL has ?clip=N (clamped to the allowed range), so different
 * lengths can be compared on real songs without a rebuild.
 */
export function clipSecondsFromSearch(search: string): number {
  const raw = new URLSearchParams(search).get('clip');
  const n = raw === null ? NaN : Number(raw);
  if (!Number.isFinite(n)) return CAPTURE_CONFIG.clipSeconds;
  return Math.min(CAPTURE_CONFIG.maxClipSeconds, Math.max(CAPTURE_CONFIG.minClipSeconds, n));
}
