import { describe, expect, it } from 'vitest';
import { BpmCrossCheck, BPM_CHECK_CONFIG } from '../src/index.js';

/** Feed the check every 500ms from `fromMs` to `toMs`; returns the statuses seen with their times. */
function run(c: BpmCrossCheck, fromMs: number, toMs: number, bpm: (t: number) => number | null, rate: (t: number) => number, locked = true) {
  const out: { t: number; status: string }[] = [];
  for (let t = fromMs; t <= toMs; t += BPM_CHECK_CONFIG.intervalMs) {
    out.push({ t, status: c.update({ nowMs: t, bpm: bpm(t), clockRate: rate(t), locked }).status });
  }
  return out;
}

describe('BpmCrossCheck', () => {
  it('learns the tempo at 1.0x only once the clock is locked', () => {
    const c = new BpmCrossCheck();
    expect(c.update({ nowMs: 0, bpm: 132, clockRate: 1.1, locked: false }).status).toBe('idle');
    expect(c.baseBpm).toBeNull();
    expect(c.update({ nowMs: 500, bpm: 132, clockRate: 1.1, locked: true }).status).toBe('relearned');
    expect(c.baseBpm).toBeCloseTo(120, 6);
  });

  it('agrees on a steady song at any rate and never asks for a recheck', () => {
    for (const rate of [0.8, 0.9, 1, 1.1, 1.25]) {
      const c = new BpmCrossCheck();
      const seen = run(c, 0, 120_000, () => 120 * rate, () => rate);
      expect(seen.filter((s) => s.status === 'recheck')).toHaveLength(0);
      expect(seen.at(-1)!.status).toBe('agree');
    }
  });

  it('tolerates tempo readings with small jitter', () => {
    const c = new BpmCrossCheck();
    const seen = run(c, 0, 60_000, (t) => 120 + 2.5 * Math.sin(t / 700), () => 1);
    expect(seen.filter((s) => s.status === 'recheck')).toHaveLength(0);
  });

  it('asks for a recheck after the hold time when the DJ pitches the track up', () => {
    const c = new BpmCrossCheck();
    // Locked at 1.0x, then the tempo moves to 1.08x at 10s while the clock still says 1.0.
    const seen = run(c, 0, 30_000, (t) => (t < 10_000 ? 120 : 129.6), () => 1);
    const first = seen.find((s) => s.status === 'recheck');
    expect(first).toBeDefined();
    expect(first!.t - 10_000).toBeGreaterThanOrEqual(BPM_CHECK_CONFIG.holdMs - BPM_CHECK_CONFIG.intervalMs);
    expect(first!.t - 10_000).toBeLessThanOrEqual(BPM_CHECK_CONFIG.holdMs + 1_000);
  });

  it('goes quiet once the clock catches up with the new rate', () => {
    const c = new BpmCrossCheck();
    const rate = (t: number) => (t < 16_000 ? 1 : 1.08);
    const seen = run(c, 0, 60_000, (t) => (t < 10_000 ? 120 : 129.6), rate);
    expect(seen.filter((s) => s.status === 'recheck')).toHaveLength(1);
    expect(seen.at(-1)!.status).toBe('agree');
    expect(c.baseBpm).toBeCloseTo(120, 6);
  });

  it('respects the cooldown and relearns after repeated rechecks the clock does not confirm', () => {
    const c = new BpmCrossCheck();
    // The tempo tracker settled on a slightly wrong value; recognition keeps saying 1.0x.
    const seen = run(c, 0, 80_000, (t) => (t < 2_000 ? 120 : 127), () => 1);
    const rechecks = seen.filter((s) => s.status === 'recheck');
    expect(rechecks).toHaveLength(BPM_CHECK_CONFIG.maxRechecks);
    expect(rechecks[1]!.t - rechecks[0]!.t).toBeGreaterThanOrEqual(BPM_CHECK_CONFIG.cooldownMs);
    expect(seen.some((s) => s.status === 'relearned' && s.t > 2_000)).toBe(true);
    expect(c.baseBpm).toBeCloseTo(127, 6);
    expect(seen.at(-1)!.status).toBe('agree');
  });

  it('folds half and double tempo readings', () => {
    const c = new BpmCrossCheck();
    c.update({ nowMs: 0, bpm: 120, clockRate: 1, locked: true });
    expect(c.impliedRate(60, 1)).toBeCloseTo(1, 6);
    expect(c.impliedRate(240, 1)).toBeCloseTo(1, 6);
    const seen = run(c, 500, 40_000, (t) => (Math.floor(t / 2000) % 2 ? 60 : 240), () => 1);
    expect(seen.filter((s) => s.status === 'recheck')).toHaveLength(0);
  });

  it('treats no clear beat as neutral: a breakdown pauses the count, agreement clears it', () => {
    const c = new BpmCrossCheck();
    // 3s off tempo, a 20s breakdown, then back on the learned tempo: no recheck.
    const back = (t: number) => (t < 2_000 ? 120 : t < 5_000 ? 129.6 : t < 25_000 ? null : 120);
    expect(run(c, 0, 60_000, back, () => 1).filter((s) => s.status === 'recheck')).toHaveLength(0);
    // Same, but the off tempo continues after the breakdown: the count resumes and fires soon after.
    const c2 = new BpmCrossCheck();
    const cont = (t: number) => (t < 2_000 ? 120 : t < 5_000 ? 129.6 : t < 25_000 ? null : 129.6);
    const r = run(c2, 0, 60_000, cont, () => 1).find((s) => s.status === 'recheck');
    expect(r).toBeDefined();
    expect(r!.t).toBeGreaterThan(25_000);
    expect(r!.t).toBeLessThanOrEqual(27_000);
  });

  it('ignores disagreements too large for a pitch fader (another song, octave errors)', () => {
    const c = new BpmCrossCheck();
    c.update({ nowMs: 0, bpm: 120, clockRate: 1, locked: true });
    // 175 BPM folds to 0.73x: far more than a DJ pitch change, so the song-change detector's call.
    const seen = run(c, 500, 30_000, () => 175, () => 1);
    expect(seen.filter((s) => s.status === 'recheck')).toHaveLength(0);
  });

  it('forgets the tempo on reset', () => {
    const c = new BpmCrossCheck();
    c.update({ nowMs: 0, bpm: 120, clockRate: 1, locked: true });
    c.reset();
    expect(c.baseBpm).toBeNull();
  });
});
