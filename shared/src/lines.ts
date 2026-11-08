import type { LyricLine } from './types.js';

/**
 * Index of the line active at positionMs (last line with startMs <= positionMs),
 * or -1 if positionMs is before the first line. Lines must be sorted by startMs.
 */
export function findLineIndex(lines: readonly LyricLine[], positionMs: number): number {
  let lo = 0;
  let hi = lines.length - 1;
  let ans = -1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (lines[mid].startMs <= positionMs) {
      ans = mid;
      lo = mid + 1;
    } else {
      hi = mid - 1;
    }
  }
  return ans;
}
