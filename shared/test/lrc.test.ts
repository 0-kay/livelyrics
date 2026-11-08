import { describe, expect, it } from 'vitest';
import { formatLrcTime, parseLrc } from '../src/lrc.js';
import { findLineIndex } from '../src/lines.js';

describe('parseLrc', () => {
  it('parses basic lines and metadata', () => {
    const r = parseLrc('[ti:Test]\n[ar:Someone]\n[00:01.50]first\n[00:03.25]second');
    expect(r.meta).toEqual({ ti: 'Test', ar: 'Someone' });
    expect(r.lines).toEqual([
      { startMs: 1500, text: 'first' },
      { startMs: 3250, text: 'second' },
    ]);
  });

  it('expands multiple timestamps on one line and sorts', () => {
    const r = parseLrc('[00:10.00][00:30.00]chorus\n[00:20.00]verse');
    expect(r.lines.map((l) => [l.startMs, l.text])).toEqual([
      [10000, 'chorus'],
      [20000, 'verse'],
      [30000, 'chorus'],
    ]);
  });

  it('applies positive and negative offset tags', () => {
    expect(parseLrc('[offset:500]\n[00:02.00]a').lines[0].startMs).toBe(1500);
    expect(parseLrc('[offset:-500]\n[00:02.00]a').lines[0].startMs).toBe(2500);
    expect(parseLrc('[offset:+250]\n[00:02.00]a').offsetMs).toBe(250);
  });

  it('clamps offsets that would go negative', () => {
    expect(parseLrc('[offset:5000]\n[00:01.00]a').lines[0].startMs).toBe(0);
  });

  it('keeps empty lines by default and can drop them', () => {
    const src = '[00:01.00]a\n[00:02.00]\n[00:03.00]b';
    expect(parseLrc(src).lines).toHaveLength(3);
    expect(parseLrc(src).lines[1]).toEqual({ startMs: 2000, text: '' });
    expect(parseLrc(src, { keepEmpty: false }).lines).toHaveLength(2);
  });

  it('handles fraction precision variants and colon separator', () => {
    const r = parseLrc('[00:01.5]a\n[00:01.05]b\n[00:01.005]c\n[00:02:50]d\n[01:00]e');
    expect(r.lines.map((l) => l.startMs)).toEqual([1005, 1050, 1500, 2500, 60000]);
  });

  it('handles CRLF, blank lines, whitespace and junk lines', () => {
    const r = parseLrc('\r\n  [00:01.00]  hello  \r\n\r\nnot a lyric\r\n[00:02.00]world\r\n');
    expect(r.lines).toEqual([
      { startMs: 1000, text: 'hello' },
      { startMs: 2000, text: 'world' },
    ]);
  });

  it('strips enhanced word-level tags', () => {
    const r = parseLrc('[00:01.00]<00:01.00>one <00:01.50>two');
    expect(r.lines[0].text).toBe('one two');
  });

  it('keeps stable order for identical timestamps', () => {
    const r = parseLrc('[00:01.00]x\n[00:01.00]y');
    expect(r.lines.map((l) => l.text)).toEqual(['x', 'y']);
  });

  it('returns nothing for empty input', () => {
    expect(parseLrc('').lines).toEqual([]);
  });

  it('formats times', () => {
    expect(formatLrcTime(61234)).toBe('[01:01.23]');
  });
});

describe('findLineIndex', () => {
  const lines = [0, 1000, 2000, 2000, 5000].map((startMs, i) => ({ startMs, text: String(i) }));
  it('finds the active line by binary search', () => {
    expect(findLineIndex(lines, -1)).toBe(-1);
    expect(findLineIndex(lines, 0)).toBe(0);
    expect(findLineIndex(lines, 999)).toBe(0);
    expect(findLineIndex(lines, 2000)).toBe(3);
    expect(findLineIndex(lines, 4999)).toBe(3);
    expect(findLineIndex(lines, 99999)).toBe(4);
    expect(findLineIndex([], 10)).toBe(-1);
  });
});
