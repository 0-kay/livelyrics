import { describe, expect, it } from 'vitest';
import { BeatDetector, type Onset } from '../src/audio/beat.js';
import { BpmCrossCheck } from '@livelyrics/shared';
import { gridError, predictBeats, RhythmWatch, tempoForCrossCheck } from '../src/audio/rhythm.js';

const SR = 48_000;

interface Segment {
  fromS: number;
  toS: number;
  bpm: number;
  /** First beat offset (s). */
  phaseS?: number;
  /** Add off-beat hi-hats. */
  hats?: boolean;
  /** No drums at all (a breakdown): a sustained pad only. */
  pad?: boolean;
  /** Hat loudness (default 0.12) and sixteenth-note hats. */
  hatAmp?: number;
  sixteenths?: boolean;
  /** Tempo at the end of the segment, for a gradual ride (BPM). */
  bpmEnd?: number;
}

/** Deterministic pseudo-random noise. */
function rng(seed: number) {
  let s = seed >>> 0;
  return () => {
    s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
    return s / 2 ** 32 - 0.5;
  };
}

/** Synthetic music: kick on every beat, optional hats, low background noise. Returns audio and the true kick times (ms). */
function synth(segments: Segment[], noise = 0.01, seed = 1) {
  const total = Math.max(...segments.map((s) => s.toS));
  const out = new Float32Array(Math.round(total * SR));
  const rand = rng(seed);
  for (let i = 0; i < out.length; i++) out[i] = noise * rand();
  const kicks: number[] = [];
  for (const seg of segments) {
    if (seg.pad) {
      for (let i = Math.round(seg.fromS * SR); i < Math.round(seg.toS * SR); i++) out[i]! += 0.08 * Math.sin((2 * Math.PI * 220 * i) / SR);
      continue;
    }
    let t = seg.fromS + (seg.phaseS ?? 0);
    while (t < seg.toS) {
      kicks.push(t * 1000);
      const at = Math.round(t * SR);
      for (let j = 0; j < SR * 0.12 && at + j < out.length; j++) out[at + j]! += 0.6 * Math.exp(-j / (SR * 0.03)) * Math.sin((2 * Math.PI * 60 * j) / SR);
      const frac = (t - seg.fromS) / (seg.toS - seg.fromS);
      const bpm = seg.bpmEnd ? seg.bpm + (seg.bpmEnd - seg.bpm) * frac : seg.bpm;
      const period = 60 / bpm;
      if (seg.hats) {
        const offs = seg.sixteenths ? [0.25, 0.5, 0.75] : [0.5];
        for (const f of offs) {
          const h = Math.round((t + period * f) * SR);
          for (let j = 0; j < SR * 0.03 && h + j < out.length; j++) out[h + j]! += (seg.hatAmp ?? 0.12) * Math.exp(-j / (SR * 0.006)) * rand() * 2;
        }
      }
      t += period;
    }
  }
  return { audio: out, kicks };
}

/** Feed audio in 128-sample frames; calls `each` every frame with the frame end time (ms). */
function feed(audio: Float32Array, sink: { push: (f: Float32Array, endMs: number) => void }, each?: (tMs: number) => void) {
  for (let i = 0; i + 128 <= audio.length; i += 128) {
    const endMs = ((i + 128) / SR) * 1000;
    sink.push(audio.subarray(i, i + 128), endMs);
    each?.(endMs);
  }
}

describe('BeatDetector', () => {
  it('finds kicks within 30ms and few false onsets', () => {
    const { audio, kicks } = synth([{ fromS: 0, toS: 20, bpm: 120, hats: true }]);
    const found: Onset[] = [];
    const det = new BeatDetector(SR, undefined, (o) => found.push(o));
    feed(audio, det);
    const late = kicks.filter((k) => k > 1000);
    const hit = late.filter((k) => found.some((o) => Math.abs(o.t - k) <= 30)).length;
    expect(hit / late.length).toBeGreaterThan(0.9);
    const strong = found.filter((o) => o.t > 1000 && o.strength >= 0.5);
    // Hats sit half a beat after each kick; both are real onsets.
    const strongFalse = strong.filter((o) => !kicks.some((k) => Math.abs(o.t - k) <= 30 || Math.abs(o.t - k - 250) <= 30)).length;
    expect(strongFalse / Math.max(1, strong.length)).toBeLessThan(0.1);
  });
  it('stays quiet on silence and a sustained pad', () => {
    const found: Onset[] = [];
    const det = new BeatDetector(SR, undefined, (o) => found.push(o));
    feed(synth([{ fromS: 0, toS: 10, bpm: 120, pad: true }], 0.0002).audio, det);
    expect(found.filter((o) => o.t > 1000 && o.strength > 0.15).length).toBeLessThanOrEqual(1);
  });
});

describe('tempo and prediction', () => {
  for (const bpm of [95, 120, 140]) {
    it(`estimates ${bpm} BPM and predicts the next beats`, () => {
      const { audio, kicks } = synth([{ fromS: 0, toS: 16, bpm, hats: true, phaseS: 0.137 }]);
      const w = new RhythmWatch(SR);
      feed(audio.subarray(0, Math.round(10 * SR)), w);
      const est = w.tracker.estimate(6)!;
      expect(est).not.toBeNull();
      expect(Math.abs(est.bpm / bpm - 1)).toBeLessThan(0.02);
      const next = predictBeats(est.lastBeatMs, est.periodMs, 10_000);
      expect(next).toHaveLength(10);
      for (const b of next) {
        const nearest = Math.min(...kicks.map((k) => Math.abs(k - b)));
        expect(nearest).toBeLessThan(45);
      }
    });
  }
  it('measures phase on the grid', () => {
    expect(gridError(1000, 0, 500)).toBeCloseTo(0);
    expect(gridError(1100, 0, 500)).toBeCloseTo(0.2);
    expect(gridError(1400, 0, 500)).toBeCloseTo(-0.2);
  });
});

/** Run a track, arm the detector at `armS`, return when it fired (ms) or null. */
function runChange(segments: Segment[], armS = 2, seed = 1) {
  const { audio } = synth(segments, 0.01, seed);
  const w = new RhythmWatch(SR);
  let firedAt: number | null = null;
  let armed = false;
  w.change.onChange = () => {
    if (firedAt === null) firedAt = w.tracker.now;
  };
  feed(audio, w, (t) => {
    if (!armed && t >= armS * 1000) {
      armed = true;
      w.change.arm('song-a');
    }
  });
  return { firedAt, w };
}

describe('SongChangeDetector', () => {
  it('learns the grid and never switches on a steady song', () => {
    const { firedAt, w } = runChange([{ fromS: 0, toS: 40, bpm: 120, hats: true }]);
    expect(firedAt).toBeNull();
    expect(w.change.snapshot.state).toBe('tracking');
    expect(Math.abs((w.change.snapshot.refBpm ?? 0) - 120)).toBeLessThan(2);
  });
  it('switches about 3s after a new tempo comes in', () => {
    const { firedAt } = runChange([
      { fromS: 0, toS: 20, bpm: 120, hats: true },
      { fromS: 20, toS: 32, bpm: 100, hats: true, phaseS: 0.21 },
    ]);
    expect(firedAt).not.toBeNull();
    expect(firedAt! - 20_000).toBeGreaterThanOrEqual(3_000);
    expect(firedAt! - 20_000).toBeLessThanOrEqual(6_000);
  });
  it('switches when the same tempo comes in off the grid', () => {
    const { firedAt } = runChange([
      { fromS: 0, toS: 20, bpm: 120 },
      { fromS: 20, toS: 32, bpm: 120, phaseS: 0.3 },
    ]);
    expect(firedAt).not.toBeNull();
    expect(firedAt! - 20_000).toBeLessThanOrEqual(6_000);
  });
  it('does not switch on a breakdown with no drums, nor when the beat returns on the grid', () => {
    const { firedAt } = runChange([
      { fromS: 0, toS: 16, bpm: 120, hats: true },
      { fromS: 16, toS: 26, bpm: 120, pad: true },
      { fromS: 26, toS: 40, bpm: 120, hats: true },
    ]);
    expect(firedAt).toBeNull();
  });
  it('does not switch on a busy song with loud off-beat and sixteenth hats', () => {
    const { firedAt, w } = runChange([{ fromS: 0, toS: 40, bpm: 124, hats: true, hatAmp: 0.35, sixteenths: true }]);
    expect(firedAt).toBeNull();
    expect(w.change.snapshot.state).toBe('tracking');
  });
  it('still switches from a busy song to a new tempo', () => {
    const { firedAt } = runChange([
      { fromS: 0, toS: 20, bpm: 124, hats: true, hatAmp: 0.35, sixteenths: true },
      { fromS: 20, toS: 32, bpm: 96, hats: true, phaseS: 0.17 },
    ]);
    expect(firedAt).not.toBeNull();
    expect(firedAt! - 20_000).toBeLessThanOrEqual(6_000);
  });
  it('follows a slow DJ tempo ride without switching', () => {
    const { firedAt } = runChange([{ fromS: 0, toS: 40, bpm: 120, bpmEnd: 126, hats: true }]);
    expect(firedAt).toBeNull();
  });
  it('stays idle until armed', () => {
    const { audio } = synth([{ fromS: 0, toS: 20, bpm: 120 }, { fromS: 20, toS: 30, bpm: 90 }]);
    const w = new RhythmWatch(SR);
    let fired = false;
    w.change.onChange = () => (fired = true);
    feed(audio, w);
    expect(fired).toBe(false);
  });
});

describe('beat frame', () => {
  it('pulses on predicted beats once the grid is learned', () => {
    const { audio, kicks } = synth([{ fromS: 0, toS: 14, bpm: 120, hats: true }]);
    const w = new RhythmWatch(SR);
    feed(audio, w, (t) => {
      if (t >= 1000 && w.change.snapshot.state === 'idle') w.change.arm('x');
    });
    const k = kicks.filter((x) => x < 13_900).at(-1)!;
    const on = w.frame(k + 10);
    const off = w.frame(k + 400);
    expect(on.onGrid).toBe(true);
    expect(on.pulse).toBeGreaterThan(0.8);
    expect(off.pulse).toBeLessThan(0.2);
    expect(on.bpm).toBeGreaterThan(118);
    expect(on.next.length).toBe(10);
  });
});

describe('BPM cross-check on synthetic drums', () => {
  /** Run a track with the clock locked at 1.0x from `lockS`; returns times (ms) the cross-check asked for a recheck. */
  function rechecks(segments: Segment[], lockS = 10) {
    const { audio } = synth(segments);
    const w = new RhythmWatch(SR);
    const check = new BpmCrossCheck();
    const out: number[] = [];
    let armed = false;
    let lastFeed = 0;
    feed(audio, w, (t) => {
      if (!armed && t >= 2_000) {
        armed = true;
        w.change.arm('song-a');
      }
      if (t - lastFeed >= 500) {
        lastFeed = t;
        const r = check.update({ nowMs: t, bpm: tempoForCrossCheck(w.change.snapshot), clockRate: 1, locked: t >= lockS * 1000 });
        if (r.status === 'recheck') out.push(t);
      }
    });
    return out;
  }

  it('never asks for a recheck on a steady song', () => {
    expect(rechecks([{ fromS: 0, toS: 45, bpm: 120, hats: true }])).toHaveLength(0);
  });

  it('asks for a recheck during a slow DJ pitch ride the song-change detector follows', () => {
    // 120 to 130 BPM (about +8%) over 30s, after the tempo was learned at 1.0x.
    const r = rechecks([
      { fromS: 0, toS: 15, bpm: 120, hats: true },
      { fromS: 15, toS: 45, bpm: 120, bpmEnd: 130, hats: true },
    ]);
    expect(r.length).toBeGreaterThan(0);
    expect(r[0]!).toBeGreaterThan(15_000);
  });

  it('stays neutral through a breakdown with no drums', () => {
    const r = rechecks([
      { fromS: 0, toS: 16, bpm: 120, hats: true },
      { fromS: 16, toS: 28, bpm: 120, pad: true },
      { fromS: 28, toS: 45, bpm: 120, hats: true },
    ]);
    expect(r).toHaveLength(0);
  });
});
