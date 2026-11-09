import { describe, expect, it } from 'vitest';
import {
  AdaptivePlaybackClock,
  RateEstimator,
  RecognitionScheduler,
  durationScale,
  fitLine,
  robustFit,
  sampleFromRecognition,
  scaleLyrics,
  CLOCK_CONFIG,
  SCHEDULER_CONFIG,
} from '../src/index.js';

const line = (rate: number, offset = 0, start = 1_000_000) => (i: number, stepMs = 3_000) => ({
  wallMs: start + i * stepMs,
  songPosMs: offset + i * stepMs * rate,
});

describe('regression', () => {
  it('fits an exact line, even with large wall times', () => {
    const s = [0, 1, 2, 3].map((i) => line(1.1, 5_000, 9e8)(i));
    const fit = fitLine(s)!;
    expect(fit.slope).toBeCloseTo(1.1, 9);
    expect(fit.slope * s[2].wallMs + fit.intercept).toBeCloseTo(s[2].songPosMs, 3);
  });

  it('returns null for degenerate input', () => {
    expect(fitLine([])).toBeNull();
    expect(fitLine([{ wallMs: 1, songPosMs: 1 }, { wallMs: 1, songPosMs: 2 }])).toBeNull();
  });

  it('drops an outlier and refits', () => {
    const s = [0, 1, 2, 3, 4, 5].map((i) => line(1)(i));
    s[3] = { ...s[3], songPosMs: s[3].songPosMs + 5_000 };
    expect(fitLine(s)!.slope).not.toBeCloseTo(1, 2);
    expect(robustFit(s, 900)!.slope).toBeCloseTo(1, 6);
  });
});

describe('RateEstimator', () => {
  it('waits for enough samples and span', () => {
    const e = new RateEstimator({ minSamples: 3, minSpanMs: 6_000 });
    const l = line(1.2);
    expect(e.add(l(0))).toBeNull();
    expect(e.add(l(1))).toBeNull();
    expect(e.add(l(2))).toBeCloseTo(1.2, 6); // span 6000
  });

  it('clamps to [0.7, 1.4]', () => {
    const fast = new RateEstimator();
    const slow = new RateEstimator();
    for (let i = 0; i < 5; i++) {
      fast.add(line(2)(i));
      slow.add(line(0.3)(i));
    }
    expect(fast.rate).toBe(1.4);
    expect(slow.rate).toBe(0.7);
  });

  it('smooths with an EMA', () => {
    const e = new RateEstimator({ emaAlpha: 0.5, window: 3, minSamples: 3, minSpanMs: 0 });
    const a = line(1.0);
    [0, 1, 2].forEach((i) => e.add(a(i)));
    expect(e.rate).toBeCloseTo(1.0, 6);
    // Window slides onto a 1.2x segment; the EMA only moves part of the way.
    const b = line(1.2, a(2).songPosMs, a(2).wallMs);
    e.add(b(1));
    e.add(b(2));
    const r = e.add(b(3))!;
    expect(r).toBeGreaterThan(1.1);
    expect(r).toBeLessThan(1.2);
  });

  it('reset can keep the rate as a prior', () => {
    const e = new RateEstimator();
    for (let i = 0; i < 5; i++) e.add(line(1.1)(i));
    e.reset({ keepRate: true });
    expect(e.sampleCount).toBe(0);
    expect(e.rate).toBeCloseTo(1.1, 6);
    e.reset();
    expect(e.rate).toBeNull();
  });
});

describe('AdaptivePlaybackClock', () => {
  it('is unanchored until the first sample, then runs at 1x', () => {
    const c = new AdaptivePlaybackClock();
    expect(c.positionAt(0)).toBeNull();
    const u = c.addSample({ wallMs: 1_000, songPosMs: 30_000 }, 2_500);
    expect(u.action).toBe('anchor');
    expect(c.positionAt(2_500)).toBe(31_500);
  });

  it('applies latency compensation', () => {
    const c = new AdaptivePlaybackClock({ latencyCompMs: 120 });
    c.addSample({ wallMs: 0, songPosMs: 10_000 }, 0);
    expect(c.positionAt(1_000)).toBe(11_120);
  });

  it('nudges small disagreements gradually without jumping', () => {
    const c = new AdaptivePlaybackClock();
    c.addSample({ wallMs: 0, songPosMs: 10_000 }, 0);
    const before = c.positionAt(5_000)!;
    // Truth is 800ms ahead of the clock.
    const u = c.addSample({ wallMs: 4_000, songPosMs: 14_800 }, 5_000);
    expect(u.action).toBe('nudge');
    expect(u.errorMs).toBeCloseTo(800, 6);
    expect(c.positionAt(5_000)).toBeCloseTo(before, 6); // continuous
    expect(c.isNudging).toBe(true);
    // Halfway through the ease the correction is partly applied; later it is complete.
    const mid = c.positionAt(5_000 + 1_000)! - (before + 1_000);
    expect(mid).toBeGreaterThan(0);
    expect(mid).toBeLessThan(800);
    // One answer moves the clock to the median of the answers so far (here the mean of the two),
    // so a single noisy answer cannot drag the lyrics all the way.
    expect(c.positionAt(20_000)).toBeCloseTo((14_000 + 14_800) / 2 + 16_000, 0);
  });

  it('ignores a single noisy answer once a few agree (median anchoring)', () => {
    const c = new AdaptivePlaybackClock();
    for (let i = 0; i < 4; i++) c.addSample({ wallMs: i * 4_000, songPosMs: 10_000 + i * 4_000 }, i * 4_000 + 1_000);
    c.addSample({ wallMs: 16_000, songPosMs: 26_000 + 900 }, 17_000); // one answer 900ms off
    expect(c.positionAt(30_000)).toBeCloseTo(10_000 + 30_000, -1);
  });

  it('adopts a steady speed difference instead of snapping back and forth', () => {
    const c = new AdaptivePlaybackClock();
    const actions: string[] = [];
    for (let i = 0; i < 6; i++) actions.push(c.addSample({ wallMs: i * 3_000, songPosMs: 20_000 + i * 3_000 * 1.1 }, i * 3_000 + 1_000).action);
    expect(c.rate).toBeCloseTo(1.1, 3);
    expect(actions.filter((a) => a === 'snap' || a === 'suspect')).toEqual([]);
  });

  it('never moves backwards while nudging toward an earlier position', () => {
    const c = new AdaptivePlaybackClock();
    c.addSample({ wallMs: 0, songPosMs: 10_000 }, 0);
    c.addSample({ wallMs: 4_000, songPosMs: 12_700 }, 5_000); // clock 1300ms ahead
    let prev = c.positionAt(5_000)!;
    for (let t = 5_050; t < 12_000; t += 50) {
      const p = c.positionAt(t)!;
      expect(p).toBeGreaterThan(prev);
      prev = p;
    }
  });

  it('holds a single large disagreement as suspect, then ignores it', () => {
    const c = new AdaptivePlaybackClock();
    c.addSample({ wallMs: 0, songPosMs: 10_000 }, 0);
    expect(c.addSample({ wallMs: 3_000, songPosMs: 17_000 }, 4_000).action).toBe('suspect');
    expect(c.positionAt(4_000)).toBe(14_000); // unchanged
    expect(c.addSample({ wallMs: 6_000, songPosMs: 16_050 }, 7_000).action).toBe('agree');
  });

  it('snaps when three answers confirm a jump, and never on two', () => {
    const c = new AdaptivePlaybackClock();
    c.addSample({ wallMs: 0, songPosMs: 10_000 }, 0);
    expect(c.addSample({ wallMs: 3_000, songPosMs: 60_000 }, 4_000).action).toBe('suspect');
    expect(c.addSample({ wallMs: 6_000, songPosMs: 63_000 }, 7_000).action).toBe('suspect');
    const u = c.addSample({ wallMs: 9_000, songPosMs: 66_000 }, 10_000);
    expect(u.action).toBe('snap');
    expect(c.positionAt(10_000)).toBeCloseTo(67_000, 0);
    expect(c.isNudging).toBe(false);
  });

  it('does not let two agreeing bad answers move the clock', () => {
    const c = new AdaptivePlaybackClock();
    for (let i = 0; i < 3; i++) c.addSample({ wallMs: i * 4_000, songPosMs: 10_000 + i * 4_000 }, i * 4_000 + 500);
    expect(c.addSample({ wallMs: 12_000, songPosMs: 26_000 }, 12_500).action).toBe('suspect');
    expect(c.addSample({ wallMs: 16_000, songPosMs: 30_000 }, 16_500).action).toBe('suspect');
    expect(c.addSample({ wallMs: 20_000, songPosMs: 30_000 }, 20_500).action).toBe('agree');
    expect(c.positionAt(24_000)).toBeCloseTo(34_000, -2);
  });

  it('learns the rate from samples', () => {
    const c = new AdaptivePlaybackClock();
    const l = line(1.25, 20_000, 0);
    for (let i = 0; i < 6; i++) c.addSample(l(i), l(i).wallMs + 1_500);
    expect(c.rate).toBeCloseTo(1.25, 6);
    expect(c.positionAt(30_000)).toBeCloseTo(20_000 + 30_000 * 1.25, 0);
  });

  it('builds samples from recognition timing', () => {
    expect(sampleFromRecognition({ playOffsetMs: 5_000, clipEndWallMs: 100, requestSentWallMs: 150, responseWallMs: 1_150 }))
      .toEqual({ wallMs: 100, songPosMs: 5_000, roundTripMs: 1_000 });
    expect(sampleFromRecognition({ playOffsetMs: 5_000, requestSentWallMs: 150, responseWallMs: 1_150 }).wallMs).toBe(150);
  });
});

describe('tuning constants', () => {
  it('can always reach the lock span inside the regression window', () => {
    expect(SCHEDULER_CONFIG.minLockSpanMs).toBeLessThan((CLOCK_CONFIG.regressionWindow - 1) * SCHEDULER_CONFIG.searchIntervalMs);
    expect(CLOCK_CONFIG.minSpanMsForRateChange).toBeLessThanOrEqual(CLOCK_CONFIG.minSpanMsForRate);
    // The regression window must hold enough steady checks to learn a rate.
    expect((CLOCK_CONFIG.regressionWindow - 1) * SCHEDULER_CONFIG.lockedMaxIntervalMs).toBeGreaterThan(CLOCK_CONFIG.minSpanMsForRate);
    expect(SCHEDULER_CONFIG.lockedMinIntervalMs).toBeLessThanOrEqual(SCHEDULER_CONFIG.lockedMaxIntervalMs);
  });
});

describe('RecognitionScheduler', () => {
  const agree = { matched: true as const, score: 90, action: 'agree' as const, rateSpanMs: CLOCK_CONFIG.minSpanMsForRate };

  it('locks after two agreeing samples, then keeps checking every few seconds', () => {
    const s = new RecognitionScheduler({ random: () => 0.5 });
    expect(s.onResult({ ...agree, action: 'anchor', rateSpanMs: 0 })).toMatchObject({ state: 'confirming', nextDelayMs: SCHEDULER_CONFIG.searchIntervalMs });
    const d = s.onResult(agree);
    expect(d.state).toBe('locked');
    expect(d.nextDelayMs).toBe((SCHEDULER_CONFIG.lockedMinIntervalMs + SCHEDULER_CONFIG.lockedMaxIntervalMs) / 2);
  });

  it('keeps the fast pace after a match until the speed can be judged', () => {
    const s = new RecognitionScheduler({ random: () => 0.5 });
    s.onResult({ ...agree, action: 'anchor', rateSpanMs: 0, songChanged: true });
    const early = s.onResult({ ...agree, rateSpanMs: SCHEDULER_CONFIG.minLockSpanMs });
    expect(early.state).toBe('locked');
    expect(early.nextDelayMs).toBe(SCHEDULER_CONFIG.searchIntervalMs);
    expect(s.onResult({ ...agree, rateSpanMs: CLOCK_CONFIG.minSpanMsForRate }).nextDelayMs).toBeGreaterThanOrEqual(SCHEDULER_CONFIG.lockedMinIntervalMs);
  });

  it('counts a small correction as agreeing, a large one as drift', () => {
    const s = new RecognitionScheduler();
    s.onResult({ ...agree, action: 'anchor', rateSpanMs: 0 });
    expect(s.onResult({ ...agree, action: 'nudge', errorMs: 450 }).state).toBe('locked');
    expect(s.onResult({ ...agree, action: 'nudge', errorMs: 900 }).state).toBe('drifting');
  });

  it('uses the full locked interval range', () => {
    for (const r of [0, 0.999]) {
      const s = new RecognitionScheduler({ random: () => r });
      [1, 2, 3].forEach(() => s.onResult(agree));
      const d = s.onResult(agree).nextDelayMs;
      expect(d).toBeGreaterThanOrEqual(SCHEDULER_CONFIG.lockedMinIntervalMs);
      expect(d).toBeLessThanOrEqual(SCHEDULER_CONFIG.lockedMaxIntervalMs);
    }
  });

  it('does not lock before the rate estimate covers enough time', () => {
    const s = new RecognitionScheduler();
    const span = SCHEDULER_CONFIG.minLockSpanMs;
    for (let i = 0; i < 5; i++) expect(s.onResult({ ...agree, rateSpanMs: span - 1 }).state).toBe('confirming');
    expect(s.onResult({ ...agree, rateSpanMs: span }).state).toBe('locked');
  });

  it('does not count low-score matches toward lock', () => {
    const s = new RecognitionScheduler();
    for (let i = 0; i < 5; i++) expect(s.onResult({ ...agree, score: 20 }).state).toBe('confirming');
  });

  it('goes to drifting on a nudge or suspect while locked', () => {
    const s = new RecognitionScheduler();
    [1, 2, 3].forEach(() => s.onResult(agree));
    expect(s.onResult({ ...agree, action: 'nudge' })).toMatchObject({ state: 'drifting', nextDelayMs: SCHEDULER_CONFIG.searchIntervalMs });
    [1, 2, 3].forEach(() => s.onResult(agree));
    expect(s.state).toBe('locked');
    expect(s.onResult({ ...agree, action: 'suspect' }).state).toBe('drifting');
  });

  it('goes back to fast checks on a weak match while locked', () => {
    const sch = new RecognitionScheduler({ random: () => 0 });
    for (let i = 0; i < 4; i++) sch.onResult({ matched: true, score: 90, action: i === 0 ? 'anchor' : 'agree', rateSpanMs: 30_000 });
    expect(sch.state).toBe('locked');
    const d = sch.onResult({ matched: true, score: 20, action: 'agree', rateSpanMs: 30_000 });
    expect(d.state).toBe('drifting');
    expect(d.nextDelayMs).toBe(SCHEDULER_CONFIG.searchIntervalMs);
  });

  it('drops the lock after repeated misses', () => {
    const s = new RecognitionScheduler();
    [1, 2, 3].forEach(() => s.onResult(agree));
    expect(s.onResult({ matched: false })).toMatchObject({ state: 'drifting', nextDelayMs: SCHEDULER_CONFIG.retryIntervalMs, lostLock: false });
    s.onResult({ matched: false });
    expect(s.onResult({ matched: false })).toMatchObject({ state: 'searching', lostLock: true });
    expect(s.onResult({ matched: false })).toMatchObject({ state: 'searching', nextDelayMs: SCHEDULER_CONFIG.searchIntervalMs, lostLock: false });
  });

  it('restarts confirmation when the song changes', () => {
    const s = new RecognitionScheduler();
    [1, 2, 3].forEach(() => s.onResult(agree));
    expect(s.onResult({ ...agree, action: 'anchor', songChanged: true }).state).toBe('confirming');
  });
});

describe('duration scaling', () => {
  it('scales only for meaningful, plausible differences', () => {
    expect(durationScale(180_000, 180_000)).toBe(1);
    expect(durationScale(182_000, 180_000)).toBe(1); // ~1%, ignore
    expect(durationScale(225_000, 180_000)).toBeCloseTo(1.25, 6); // slowed edit is longer
    expect(durationScale(144_000, 180_000)).toBeCloseTo(0.8, 6); // sped edit is shorter
    expect(durationScale(400_000, 180_000)).toBe(1); // implausible, probably a different cut
    expect(durationScale(undefined, 180_000)).toBe(1);
    expect(durationScale(180_000, undefined)).toBe(1);
    expect(durationScale(0, 180_000)).toBe(1);
  });

  it('scales every timestamp and the duration', () => {
    const l = { lines: [{ startMs: 0, text: 'a' }, { startMs: 10_000, text: 'b' }], instrumental: false, durationMs: 100_000 };
    const s = scaleLyrics(l, 1.25);
    expect(s.lines.map((x) => x.startMs)).toEqual([0, 12_500]);
    expect(s.durationMs).toBe(125_000);
    expect(l.lines[1].startMs).toBe(10_000); // original untouched
    expect(scaleLyrics(l, 1)).toBe(l);
  });
});
