import { describe, expect, it } from 'vitest';
import {
  AdaptivePlaybackClock,
  fuzzySubstring,
  matchTranscript,
  normalizeText,
  parseLrc,
  ReanchorPolicy,
  type LineMatch,
} from '../src/index.js';

// Invented placeholder lyrics written for these tests.
const LRC = `[00:00.00]
[00:10.00]Morning trains are humming in the yard
[00:15.00]Pockets full of tickets and a postcard
[00:20.00]
[00:25.00]Orange kites above the river bend
[00:30.00]Tie the string and let it climb again
[00:35.00]Orange kites above the river bend
[00:40.00]Tie the string and let it climb again
[00:45.00]
[01:00.00]Quiet lamps along the second street
[01:05.00]Counting steps in rhythm with our feet
[01:10.00]
[01:30.00]Orange kites above the river bend
[01:35.00]Tie the string and let it climb again
[01:40.00]Last line of the test song
`;
const lines = parseLrc(LRC).lines;

describe('normalizeText', () => {
  it('strips punctuation, accents and case', () => {
    expect(normalizeText("  Café, DON'T   stop!  ")).toBe('cafe dont stop');
    expect(normalizeText('...')).toBe('');
  });
});

describe('fuzzySubstring', () => {
  it('finds an exact substring with score 1 and the right end', () => {
    const r = fuzzySubstring('quick brown', 'the quick brown fox');
    expect(r.score).toBe(1);
    expect(r.end).toBe('the quick brown'.length);
  });

  it('tolerates small transcription errors', () => {
    const r = fuzzySubstring('quik browne', 'the quick brown fox');
    expect(r.score).toBeGreaterThan(0.75);
    expect(r.score).toBeLessThan(1);
  });

  it('scores unrelated text low', () => {
    expect(fuzzySubstring('completely different words', 'the quick brown fox').score).toBeLessThan(0.5);
  });

  it('handles empty input', () => {
    expect(fuzzySubstring('', 'abc').score).toBe(0);
    expect(fuzzySubstring('abc', '').score).toBe(0);
  });
});

describe('matchTranscript', () => {
  it('matches a clean transcript to its line and estimates the position', () => {
    const m = matchTranscript('pockets full of tickets and a postcard', lines, { aroundMs: 14_000 })!;
    expect(m.confident).toBe(true);
    expect(m.text).toContain('Pockets full of tickets');
    expect(m.startMs).toBe(15_000);
    // Ends at the end of the line, which runs until the blank line at 20s.
    expect(m.positionMs).toBeGreaterThan(19_000);
    expect(m.positionMs).toBeLessThanOrEqual(20_000);
  });

  it('places a partial line inside the line', () => {
    const m = matchTranscript('quiet lamps along', lines, { aroundMs: 62_000 })!;
    expect(m.confident).toBe(true);
    expect(m.startMs).toBe(60_000);
    expect(m.positionMs).toBeGreaterThan(60_500);
    expect(m.positionMs).toBeLessThan(63_500);
  });

  it('matches a transcript that spans two lines', () => {
    const m = matchTranscript('in the yard pockets full of tickets', lines, { aroundMs: 12_000 })!;
    expect(m.confident).toBe(true);
    expect(m.startMs).toBe(15_000);
    expect(m.positionMs).toBeGreaterThan(17_000);
    expect(m.positionMs).toBeLessThan(18_500);
  });

  it('survives misheard words', () => {
    const m = matchTranscript('quite lamps along the secant street', lines, { aroundMs: 60_000 })!;
    expect(m.startMs).toBe(60_000);
    expect(m.score).toBeGreaterThan(0.72);
    expect(m.confident).toBe(true);
  });

  it('rejects unrelated speech', () => {
    const m = matchTranscript('thank you so much everybody for coming tonight', lines, { aroundMs: 60_000 });
    expect(m === null || !m.confident).toBe(true);
  });

  it('ignores transcripts that are too short', () => {
    expect(matchTranscript('orange', lines)).toBeNull();
    expect(matchTranscript('', lines)).toBeNull();
  });

  it('flags a repeated line inside the window as ambiguous', () => {
    const m = matchTranscript('orange kites above the river bend', lines, { aroundMs: 30_000 })!;
    expect(m.score).toBe(1);
    expect(m.ambiguous).toBe(true);
    expect(m.confident).toBe(false);
  });

  it('only searches the window around the current position', () => {
    // At 1:20 only the last chorus is in the window (-30s, +45s).
    const m = matchTranscript('orange kites above the river bend', lines, { aroundMs: 80_000 })!;
    expect(m.startMs).toBe(90_000);
    expect(m.confident).toBe(true);
    expect(matchTranscript('morning trains are humming in the yard', lines, { aroundMs: 120_000 })?.confident).toBe(false);
  });

  it('searches the whole song without a position', () => {
    const m = matchTranscript('last line of the test song', lines)!;
    expect(m.startMs).toBe(100_000);
    expect(m.positionMs).toBeLessThanOrEqual(104_000);
  });
});

const match = (positionMs: number, extra: Partial<LineMatch> = {}): LineMatch => ({
  lineIndex: 0,
  startMs: positionMs,
  positionMs,
  score: 0.95,
  ambiguous: false,
  confident: true,
  text: 'x',
  ...extra,
});

describe('ReanchorPolicy', () => {
  it('ignores missing, ambiguous and weak matches', () => {
    const p = new ReanchorPolicy();
    const base = { clockPosMs: 10_000, wallMs: 0, rate: 1 };
    expect(p.decide({ ...base, match: null }).reason).toBe('no-match');
    expect(p.decide({ ...base, match: match(20_000, { ambiguous: true, confident: false }) }).reason).toBe('ambiguous');
    expect(p.decide({ ...base, match: match(20_000, { score: 0.5, confident: false }) }).reason).toBe('low-score');
    expect(p.decide({ ...base, clockPosMs: null, match: match(20_000) }).reason).toBe('no-clock');
  });

  it('agrees when the clock is close enough', () => {
    const p = new ReanchorPolicy();
    expect(p.decide({ match: match(11_500), clockPosMs: 10_000, wallMs: 0, rate: 1 }).action).toBe('agree');
  });

  it('re-anchors a moderate disagreement immediately', () => {
    const p = new ReanchorPolicy();
    const d = p.decide({ match: match(16_000), clockPosMs: 10_000, wallMs: 0, rate: 1 });
    expect(d.action).toBe('reanchor');
    expect(d.errorMs).toBe(6_000);
  });

  it('needs two consistent matches for a large jump', () => {
    const p = new ReanchorPolicy();
    expect(p.decide({ match: match(60_000), clockPosMs: 10_000, wallMs: 0, rate: 1 }).action).toBe('pending');
    // Inconsistent second match: still pending, now against the new one.
    expect(p.decide({ match: match(90_000), clockPosMs: 15_000, wallMs: 5_000, rate: 1 }).action).toBe('pending');
    // Consistent with the previous match five seconds later.
    expect(p.decide({ match: match(95_500), clockPosMs: 20_000, wallMs: 10_000, rate: 1 }).action).toBe('reanchor');
  });

  it('an agreeing match clears a pending jump', () => {
    const p = new ReanchorPolicy();
    p.decide({ match: match(60_000), clockPosMs: 10_000, wallMs: 0, rate: 1 });
    p.decide({ match: match(15_000), clockPosMs: 15_000, wallMs: 5_000, rate: 1 });
    expect(p.decide({ match: match(70_000), clockPosMs: 20_000, wallMs: 10_000, rate: 1 }).action).toBe('pending');
  });
});

describe('AdaptivePlaybackClock.reanchor', () => {
  it('jumps to the new position and keeps the rate', () => {
    const c = new AdaptivePlaybackClock();
    for (let t = 0; t <= 20_000; t += 4_000) c.addSample({ wallMs: t, songPosMs: 5_000 + t * 1.1 }, t + 500);
    const rate = c.rate;
    expect(rate).toBeGreaterThan(1.05);
    const u = c.reanchor({ wallMs: 22_000, songPosMs: 60_000 }, 22_500);
    expect(u.action).toBe('snap');
    expect(c.rate).toBeCloseTo(rate, 5);
    expect(c.positionAt(22_000)).toBeCloseTo(60_000, 0);
    expect(c.positionAt(32_000)!).toBeCloseTo(60_000 + 10_000 * rate, 0);
    // The next normal sample on the new timeline agrees.
    const next = c.addSample({ wallMs: 26_000, songPosMs: 60_000 + 4_000 * 1.1 }, 26_500);
    expect(['agree', 'nudge']).toContain(next.action);
  });

  it('anchors an unanchored clock', () => {
    const c = new AdaptivePlaybackClock();
    expect(c.reanchor({ wallMs: 0, songPosMs: 1_000 }, 0).action).toBe('anchor');
  });
});
