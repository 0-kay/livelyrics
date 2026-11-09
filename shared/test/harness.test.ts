import { describe, expect, it } from 'vitest';
import { percentile, simulate } from './harness.js';

const RATES = [0.8, 0.9, 1.0, 1.1, 1.25];
const SEEDS = [1, 2, 3, 4, 5];

describe('synthetic harness: clean samples', () => {
  for (const rate of RATES) {
    it(`tracks ${rate}x exactly and backs off once locked`, () => {
      const r = simulate({ rate, seed: 7 });
      expect(r.finalRate).toBeCloseTo(rate, 3);
      expect(percentile(r.errors, 95, 30_000)).toBeLessThan(50);
      expect(r.lockedAtMs).not.toBeNull();
      expect(r.lockedAtMs!).toBeLessThan(15_000);
      expect(r.finalState).toBe('locked');
      // 120s of song: fast attempts until locked, then a steady check every 4-5s.
      expect(r.recognitions).toBeLessThan(35);
    });
  }
});

describe('synthetic harness: noisy samples', () => {
  // 150ms jitter, 8% wild outliers of +-4s, 10% no-match, 0.6-2.5s latency.
  const noisy = { noiseMs: 150, outlierProb: 0.08, outlierMagnitudeMs: 4_000, missProb: 0.1 };
  for (const rate of RATES) {
    it(`estimates ${rate}x within 2% and keeps lyrics within 1s`, () => {
      for (const seed of SEEDS) {
        const r = simulate({ rate, seed, ...noisy });
        expect(Math.abs(r.finalRate - rate)).toBeLessThan(0.02);
        // Learning a non-normal speed through a burst of bad answers can take until ~50s on the
        // worst seed (bounded here); after that the lyrics stay tight. This is tighter than the
        // old engine's steady state (which allowed up to 1s) in exchange for a steady speed.
        expect(percentile(r.errors, 95, 30_000)).toBeLessThan(1_100);
        expect(percentile(r.errors, 95, 50_000)).toBeLessThan(450);
        expect(percentile(r.errors, 100, 50_000)).toBeLessThan(600);
        expect(percentile(r.errors, 50, 30_000)).toBeLessThan(200);
        expect(r.lockedAtMs).not.toBeNull();
        expect(r.lockedAtMs!).toBeLessThan(90_000);
        // Once locked, outliers are held as suspects and never cause a position jump on their own.
        // (A catch-up when the true speed is adopted is fine: the rate changes with it.)
        const jumps = r.events.filter((e, i) => {
          if (e.action !== 'snap' || e.wallMs <= r.lockedAtMs!) return false;
          const prevRate = r.events.slice(0, i).reverse().find((p) => p.rate !== undefined)?.rate;
          return prevRate !== undefined && Math.abs((e.rate ?? prevRate) - prevRate) < 0.005;
        });
        expect(jumps).toEqual([]);
      }
    });
  }

  it('rate estimate stays inside the clamp range for extreme input', () => {
    const fast = simulate({ rate: 1.8, seed: 3 });
    const slow = simulate({ rate: 0.5, seed: 3 });
    expect(fast.finalRate).toBeLessThanOrEqual(1.4);
    expect(slow.finalRate).toBeGreaterThanOrEqual(0.7);
  });
});

describe('synthetic harness: drift scenarios', () => {
  it('locks even with near-zero recognition latency', () => {
    for (const rate of RATES) {
      const r = simulate({ rate, seed: 2, minLatencyMs: 5, maxLatencyMs: 30 });
      expect(r.finalState).toBe('locked');
      expect(r.lockedAtMs!).toBeLessThan(30_000);
    }
  });

  it('snaps after a confirmed seek and is accurate right after', () => {
    for (const seed of [1, 2, 3]) {
      const r = simulate({ rate: 1, seed, noiseMs: 150, seek: { atMs: 50_000, byMs: 20_000 } });
      const snap = r.events.find((e) => e.action === 'snap' && e.wallMs > 50_000);
      expect(snap).toBeDefined();
      // The first sample after the seek is only a suspect; the snap comes on confirmation.
      const i = r.events.indexOf(snap!);
      expect(r.events[i - 1].action).toBe('suspect');
      expect(percentile(r.errors, 100, snap!.wallMs + 1_000)).toBeLessThan(500);
    }
  });

  it('follows a DJ speeding up from 1.0x to 1.1x mid-song', () => {
    for (const seed of [1, 2, 3]) {
      const r = simulate({ rate: 1, seed, durationMs: 180_000, noiseMs: 150, rateChange: { atMs: 60_000, rate: 1.1 } });
      expect(Math.abs(r.finalRate - 1.1)).toBeLessThan(0.02);
      expect(percentile(r.errors, 95, 120_000)).toBeLessThan(400);
    }
  });
});
