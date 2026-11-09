import { describe, expect, it } from 'vitest';
import { CAPTURE_CONFIG } from '@livelyrics/shared';
import { FloatRingBuffer } from '../src/audio/ringBuffer.js';
import { SilenceGapDetector } from '../src/audio/silence.js';
import { clipSecondsFromSearch } from '../src/config.js';
import { downsample, encodeWav } from '../src/audio/wav.js';
import { formatSeconds } from '../src/ui/theme.js';

const f = (...xs: number[]) => Float32Array.from(xs);

describe('FloatRingBuffer', () => {
  it('keeps the most recent samples in order across wraparound', () => {
    const r = new FloatRingBuffer(4);
    r.push(f(1, 2, 3));
    expect([...r.snapshot()]).toEqual([1, 2, 3]);
    expect(r.isFull).toBe(false);
    r.push(f(4, 5));
    expect([...r.snapshot()]).toEqual([2, 3, 4, 5]);
    expect(r.isFull).toBe(true);
    r.push(f(6, 7, 8, 9, 10, 11));
    expect([...r.snapshot()]).toEqual([8, 9, 10, 11]);
    r.clear();
    expect(r.length).toBe(0);
  });

  it('snapshotLast returns only the most recent samples, in order', () => {
    const r = new FloatRingBuffer(5);
    r.push(f(1, 2, 3, 4, 5, 6, 7));
    expect([...r.snapshotLast(3)]).toEqual([5, 6, 7]);
    expect([...r.snapshotLast(99)]).toEqual([3, 4, 5, 6, 7]);
    expect([...r.snapshotLast(0)]).toEqual([]);
  });

  it('rejects bad capacity', () => {
    expect(() => new FloatRingBuffer(0)).toThrow();
  });
});

describe('downsample', () => {
  it('averages bins and returns a copy when no reduction is needed', () => {
    expect([...downsample(f(1, 3, 5, 7), 4, 2)]).toEqual([2, 6]);
    const src = f(1, 2);
    const same = downsample(src, 16000, 16000);
    expect(same).not.toBe(src);
    expect([...same]).toEqual([1, 2]);
  });

  it('handles non-integer ratios', () => {
    const out = downsample(new Float32Array(44100).fill(0.5), 44100, 16000);
    expect(out.length).toBe(16000);
    expect(out.every((x) => Math.abs(x - 0.5) < 1e-6)).toBe(true);
  });
});

describe('encodeWav', () => {
  it('writes a valid 16-bit mono PCM header and clamps samples', () => {
    const buf = encodeWav(f(0, 1, -1, 2), 16000);
    const v = new DataView(buf);
    const tag = (o: number) => String.fromCharCode(...new Uint8Array(buf, o, 4));
    expect(buf.byteLength).toBe(44 + 8);
    expect(tag(0)).toBe('RIFF');
    expect(tag(8)).toBe('WAVE');
    expect(tag(36)).toBe('data');
    expect(v.getUint16(22, true)).toBe(1);
    expect(v.getUint32(24, true)).toBe(16000);
    expect(v.getUint16(34, true)).toBe(16);
    expect([0, 1, 2, 3].map((i) => v.getInt16(44 + i * 2, true))).toEqual([0, 32767, -32768, 32767]);
  });
});

describe('position clock', () => {
  it('formats positions', () => {
    expect(formatSeconds(65.4)).toBe('1:05');
    expect(formatSeconds(-5)).toBe('0:00');
  });
});

describe('SilenceGapDetector', () => {
  const loud = new Float32Array(128).fill(0.2);
  const quiet = new Float32Array(128).fill(0.0001);
  /** Feed frames of 2.7ms each for the given duration; returns true if any push fired. */
  const feed = (d: SilenceGapDetector, frame: Float32Array, startMs: number, durMs: number) => {
    let fired = false;
    for (let t = startMs; t < startMs + durMs; t += 2.7) fired = d.push(frame, t) || fired;
    return fired;
  };

  it('fires once when sound returns after a long enough gap', () => {
    const d = new SilenceGapDetector();
    expect(feed(d, loud, 0, 5_000)).toBe(false);
    expect(feed(d, quiet, 5_000, 2_000)).toBe(false);
    expect(d.push(loud, 7_001)).toBe(true);
    expect(d.push(loud, 7_004)).toBe(false);
  });

  it('ignores short dips and steady sound', () => {
    const d = new SilenceGapDetector();
    feed(d, loud, 0, 5_000);
    feed(d, quiet, 5_000, 600);
    expect(d.push(loud, 5_601)).toBe(false);
    expect(feed(d, loud, 5_700, 10_000)).toBe(false);
  });

  it('does not fire while the gap is still going', () => {
    const d = new SilenceGapDetector();
    feed(d, loud, 0, 5_000);
    expect(feed(d, quiet, 5_000, 10_000)).toBe(false);
  });

  it('still sees a gap when the room noise floor is above the absolute floor', () => {
    const d = new SilenceGapDetector();
    const noise = new Float32Array(128).fill(0.01);
    feed(d, loud, 0, 8_000);
    expect(feed(d, noise, 8_000, 2_000)).toBe(false);
    expect(d.push(loud, 10_001)).toBe(true);
  });
});

describe('clipSecondsFromSearch', () => {
  it('defaults, reads ?clip=N and clamps', () => {
    expect(clipSecondsFromSearch('')).toBe(CAPTURE_CONFIG.clipSeconds);
    expect(clipSecondsFromSearch('?clip=9')).toBe(9);
    expect(clipSecondsFromSearch('?clip=1')).toBe(3);
    expect(clipSecondsFromSearch('?clip=60')).toBe(10);
    expect(clipSecondsFromSearch('?clip=abc')).toBe(CAPTURE_CONFIG.clipSeconds);
  });
});
