import { CONCERT_CONFIG, type ConcertConfig } from '../clock/config.js';
import type { LineMatch } from './matcher.js';

export type ReanchorAction = 'ignore' | 'agree' | 'pending' | 'reanchor';

export interface ReanchorDecision {
  action: ReanchorAction;
  /** Why a match was ignored or held. */
  reason?: 'no-match' | 'low-score' | 'ambiguous' | 'no-clock' | 'needs-confirmation';
  /** Match position minus clock position (ms), when both are known. */
  errorMs: number;
}

export interface ReanchorInput {
  match: LineMatch | null;
  /** Clock target position at the end of the transcribed chunk, or null if not anchored. */
  clockPosMs: number | null;
  /** Wall time of the end of the transcribed chunk. */
  wallMs: number;
  /** Current clock rate, used to check that two matches are consistent. */
  rate: number;
}

/**
 * Decides whether a concert mode lyric match should move the clock. Only
 * confident matches count. Small disagreements are left to the recognition
 * loop, large jumps need a second consistent match first.
 */
export class ReanchorPolicy {
  private readonly cfg: ConcertConfig;
  private pending: { positionMs: number; wallMs: number } | null = null;

  constructor(config: Partial<ConcertConfig> = {}) {
    this.cfg = { ...CONCERT_CONFIG, ...config };
  }

  decide({ match, clockPosMs, wallMs, rate }: ReanchorInput): ReanchorDecision {
    if (!match) return { action: 'ignore', reason: 'no-match', errorMs: 0 };
    if (match.ambiguous) return { action: 'ignore', reason: 'ambiguous', errorMs: 0 };
    if (!match.confident) return { action: 'ignore', reason: 'low-score', errorMs: 0 };
    if (clockPosMs === null) return { action: 'ignore', reason: 'no-clock', errorMs: 0 };

    const errorMs = match.positionMs - clockPosMs;
    const abs = Math.abs(errorMs);
    if (abs <= this.cfg.minCorrectionMs) {
      this.pending = null;
      return { action: 'agree', errorMs };
    }
    if (abs > this.cfg.confirmLargeJumpMs) {
      const p = this.pending;
      const consistent =
        p !== null && Math.abs(p.positionMs + (wallMs - p.wallMs) * rate - match.positionMs) <= this.cfg.confirmToleranceMs;
      if (!consistent) {
        this.pending = { positionMs: match.positionMs, wallMs };
        return { action: 'pending', reason: 'needs-confirmation', errorMs };
      }
    }
    this.pending = null;
    return { action: 'reanchor', errorMs };
  }

  reset(): void {
    this.pending = null;
  }
}
