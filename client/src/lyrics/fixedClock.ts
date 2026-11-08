/**
 * Simple 1x playback clock anchored to one recognition result.
 * Milestone 2 replaces this with the adaptive clock (rate + latency).
 */
export class FixedClock {
  constructor(
    /** Song position (ms) at the anchor moment. */
    readonly anchorOffsetMs: number,
    /** Wall time (performance.now ms) at the anchor moment. */
    readonly anchorWallMs: number,
  ) {}

  positionAt(nowMs: number): number {
    return this.anchorOffsetMs + (nowMs - this.anchorWallMs);
  }
}
