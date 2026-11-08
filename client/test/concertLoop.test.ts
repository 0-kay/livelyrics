import { describe, expect, it } from 'vitest';
import type { IdentifyResponse, TrackMatch, TranscribeResponse, TranscriptLineMatch } from '@livelyrics/shared';
import { ConcertLoop, type TranscribeContext } from '../src/sync/concertLoop.js';
import { SyncSession } from '../src/sync/syncSession.js';

const TRACK: TrackMatch = { title: 'Paper Lanterns', artist: 'The Mock Ensemble', durationMs: 180_000, playOffsetMs: 0, score: 100 };

/** One manual timer queue driving both the recognition loop and the concert loop. */
function harness(transcribe: (truePos: number, ctx: TranscribeContext) => TranscribeResponse | Error, opts: { identify?: boolean } = {}) {
  let now = 0;
  const timers: { at: number; fn: () => void }[] = [];
  const truePos = () => 30_000 + now;
  const timerDeps = {
    now: () => now,
    setTimer: (fn: () => void, ms: number) => {
      const t = { at: now + ms, fn };
      timers.push(t);
      return t;
    },
    clearTimer: (h: unknown) => {
      const i = timers.indexOf(h as (typeof timers)[number]);
      if (i >= 0) timers.splice(i, 1);
    },
  };
  const getClip = () => ({ blob: new Blob([new Uint8Array(2048)]), capturedAtMs: now });
  const session = new SyncSession({
    ...timerDeps,
    getClip,
    identify: async (): Promise<IdentifyResponse> => {
      const pos = truePos();
      now += 800;
      if (opts.identify === false) return { match: null, lyrics: null, lyricsCached: false, lyricsTimeScale: 1, processingMs: 1 };
      return {
        match: { ...TRACK, playOffsetMs: pos },
        lyrics: { lines: [{ startMs: 0, text: 'placeholder' }], instrumental: false },
        lyricsCached: false,
        lyricsTimeScale: 1,
        processingMs: 5,
      };
    },
  });
  const contexts: TranscribeContext[] = [];
  const loop = new ConcertLoop({
    ...timerDeps,
    session,
    getClip,
    transcribe: async (_blob, ctx) => {
      contexts.push(ctx);
      const r = transcribe(truePos(), ctx);
      now += 600;
      if (r instanceof Error) throw r;
      return r;
    },
  });
  const runFor = async (ms: number) => {
    const end = now + ms;
    while (true) {
      timers.sort((a, b) => a.at - b.at);
      const t = timers[0];
      if (!t || t.at > end) break;
      timers.shift();
      now = Math.max(now, t.at);
      t.fn();
      await new Promise((r) => setTimeout(r, 0));
    }
    now = end;
  };
  return { session, loop, runFor, contexts, getNow: () => now, truePos };
}

const lineMatch = (positionMs: number, extra: Partial<TranscriptLineMatch> = {}): TranscriptLineMatch => ({
  lineIndex: 3,
  startMs: positionMs - 1_000,
  positionMs,
  score: 0.95,
  ambiguous: false,
  confident: true,
  text: 'placeholder',
  ...extra,
});

describe('ConcertLoop', () => {
  it('skips while no song is known', async () => {
    const h = harness(() => ({ text: '', match: null, processingMs: 1 }), { identify: false });
    h.session.start();
    h.loop.start();
    await h.runFor(20_000);
    expect(h.contexts).toHaveLength(0);
    expect(h.loop.snapshot.lastAction).toBe('skipped');
  });

  it('sends the track and clock position and agrees when the clock is right', async () => {
    const h = harness((pos) => ({ text: 'words', match: lineMatch(pos + 500), processingMs: 1 }));
    h.session.start();
    h.loop.start();
    await h.runFor(30_000);
    expect(h.contexts.length).toBeGreaterThan(2);
    const ctx = h.contexts[h.contexts.length - 1];
    expect(ctx.track.title).toBe('Paper Lanterns');
    expect(ctx.positionMs).toBeGreaterThan(30_000);
    expect(h.loop.snapshot.lastAction).toBe('agree');
    expect(h.loop.snapshot.reanchors).toBe(0);
  });

  it('re-anchors the clock on a confident match that disagrees', async () => {
    const h = harness((pos) => ({ text: 'words', match: lineMatch(pos + 6_000), processingMs: 1 }));
    h.session.start();
    await h.runFor(30_000);
    expect(h.session.snapshot.state).toBe('locked');
    h.loop.start();
    await h.runFor(5_100);
    expect(h.loop.snapshot.lastAction).toBe('reanchor');
    expect(h.loop.snapshot.reanchors).toBe(1);
    expect(h.session.positionMs()! - h.truePos()).toBeGreaterThan(5_000);
    expect(h.session.positionMs()! - h.truePos()).toBeLessThan(7_000);
  });

  it('never moves the clock on ambiguous or weak matches', async () => {
    let n = 0;
    const h = harness((pos) => {
      n++;
      return n % 2
        ? { text: 'chorus', match: lineMatch(pos + 8_000, { ambiguous: true, confident: false }), processingMs: 1 }
        : { text: 'noise', match: lineMatch(pos + 8_000, { score: 0.4, confident: false }), processingMs: 1 };
    });
    h.session.start();
    await h.runFor(30_000);
    h.loop.start();
    await h.runFor(25_000);
    expect(h.loop.snapshot.reanchors).toBe(0);
    expect(Math.abs(h.session.positionMs()! - h.truePos())).toBeLessThan(500);
  });

  it('waits for confirmation before a large jump', async () => {
    const h = harness((pos) => ({ text: 'words', match: lineMatch(pos + 40_000), processingMs: 1 }));
    h.session.start();
    await h.runFor(30_000);
    h.loop.start();
    await h.runFor(5_100);
    expect(h.loop.snapshot.lastAction).toBe('pending');
    await h.runFor(5_700);
    expect(h.loop.snapshot.lastAction).toBe('reanchor');
    expect(h.session.positionMs()! - h.truePos()).toBeGreaterThan(39_000);
  });

  it('survives transcription errors and stops cleanly', async () => {
    const h = harness(() => new Error('Server error 502'));
    h.session.start();
    h.loop.start();
    await h.runFor(20_000);
    expect(h.loop.snapshot.lastAction).toBe('error');
    h.loop.stop();
    const calls = h.contexts.length;
    await h.runFor(20_000);
    expect(h.contexts.length).toBe(calls);
    expect(h.loop.snapshot.running).toBe(false);
  });
});
