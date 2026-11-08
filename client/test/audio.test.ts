import { describe, expect, it } from 'vitest';
import { FloatRingBuffer } from '../src/audio/ringBuffer.js';
import { downsample, encodeWav } from '../src/audio/wav.js';
import { formatMs } from '../src/lyrics/LyricsPlayer.js';

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

describe('LyricsPlayer helpers', () => {
  it('formats positions', () => {
    expect(formatMs(65_400)).toBe('1:05');
    expect(formatMs(-5)).toBe('0:00');
  });
});
