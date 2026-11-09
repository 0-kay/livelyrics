/**
 * Full-session benchmarks on the simulator: guards what a person notices
 * (steady speed, no backward jumps, fast song switches, never the wrong song).
 * Set BENCH_OUT=/path/report.json to also write the numbers for every
 * scenario and offset model.
 */
import { writeFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { SCENARIOS, simulateSession, type SessionSimResult } from './sessionSim.js';

const SEEDS = [1, 2, 3];
/** Precise clip-end positions (ACRCloud alignment fields) vs the rougher play_offset_ms. */
const MODELS = {
  precise: { noiseMs: 100, biasMs: [0, 0] as [number, number] },
  rough: { noiseMs: 250, biasMs: [-600, 0] as [number, number] },
};

async function runAll(name: string, model: keyof typeof MODELS) {
  const sc = SCENARIOS[name]!;
  const out: SessionSimResult[] = [];
  for (const seed of SEEDS) out.push(await simulateSession({ ...sc, ...MODELS[model], noiseMs: sc.noiseMs ?? MODELS[model].noiseMs, seed }));
  const mean = (f: (r: SessionSimResult) => number) => out.reduce((a, r) => a + f(r), 0) / out.length;
  const switches = out.flatMap((r) => r.switchLatencyMs);
  return { out, mean, switches };
}

describe('session benchmark', () => {
  it('normal speed party: steady, accurate, quick switches', async () => {
    const { out, mean, switches } = await runAll('party, 1.0x, songs change every ~70s', 'precise');
    expect(mean((r) => r.wobbleShare)).toBeLessThan(0.02);
    expect(mean((r) => r.errP95)).toBeLessThan(200);
    expect(mean((r) => r.firstLockedMs ?? Infinity)).toBeLessThan(15_000);
    expect(switches.every((s) => s !== null && s < 9_000)).toBe(true);
    expect(switches.reduce<number>((a, s) => a + (s ?? 0), 0) / switches.length).toBeLessThan(7_000);
    for (const r of out) {
      expect(r.backwardMoves).toBe(0);
      expect(r.lineReversals).toBe(0);
      expect(r.wrongSongMs).toBe(0);
    }
  }, 60_000);

  it('rough offsets still keep the speed mostly steady', async () => {
    const { mean } = await runAll('party, 1.0x, songs change every ~70s', 'rough');
    expect(mean((r) => r.wobbleShare)).toBeLessThan(0.08);
  }, 60_000);

  it('sped-up DJ set without gaps: switches within seconds, never the wrong song', async () => {
    const { out, switches } = await runAll('DJ set, sped up 1.08x, early cuts', 'precise');
    expect(switches.every((s) => s !== null && s < 10_000)).toBe(true);
    for (const r of out) {
      expect(r.wrongSongMs).toBe(0);
      expect(r.backwardMoves).toBe(0);
      // After the speed is learned (about 15s into each song) the lyrics stay close.
      const late = r.trace.filter((x) => x.sinceMs > 20_000).map((x) => x.errMs);
      expect(Math.max(...late)).toBeLessThan(400);
    }
  }, 60_000);

  it('noisy room with misses and outliers: still steady and switching', async () => {
    const { out, mean, switches } = await runAll('noisy room, more misses and outliers', 'precise');
    expect(mean((r) => r.wobbleShare)).toBeLessThan(0.04);
    expect(switches.every((s) => s !== null && s < 12_000)).toBe(true);
    for (const r of out) expect(r.wrongSongMs).toBe(0);
  }, 60_000);

  it.skipIf(!process.env.BENCH_OUT)('writes the full report', async () => {
    const report: Record<string, unknown> = {};
    for (const name of Object.keys(SCENARIOS)) {
      for (const model of Object.keys(MODELS) as (keyof typeof MODELS)[]) {
        const { mean, switches } = await runAll(name, model);
        report[`${name} | ${model}`] = {
          requestsPerHour: Math.round(mean((r) => r.requestsPerHour)),
          firstLyricsS: +(mean((r) => r.firstLyricsMs ?? NaN) / 1000).toFixed(1),
          firstLockedS: +(mean((r) => r.firstLockedMs ?? NaN) / 1000).toFixed(1),
          switchS: switches.map((s) => (s === null ? 'never' : (s / 1000).toFixed(1))).join(' '),
          errP50ms: Math.round(mean((r) => r.errP50)),
          errP95ms: Math.round(mean((r) => r.errP95)),
          wobblePct: +(mean((r) => r.wobbleShare) * 100).toFixed(1),
          backward: mean((r) => r.backwardMoves),
          wrongSongS: +(mean((r) => r.wrongSongMs) / 1000).toFixed(1),
        };
      }
    }
    writeFileSync(process.env.BENCH_OUT!, JSON.stringify(report, null, 1));
  }, 180_000);
});
