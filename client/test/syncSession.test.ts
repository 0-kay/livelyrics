import { describe, expect, it } from 'vitest';
import type { IdentifyResponse, TrackMatch } from '@livelyrics/shared';
import { SyncSession, type SyncSnapshot } from '../src/sync/syncSession.js';

const TRACK: TrackMatch = { title: 'Paper Lanterns', artist: 'The Mock Ensemble', durationMs: 180_000, playOffsetMs: 0, score: 100 };

/** Manual timer queue so the loop can be stepped deterministically. */
function harness(opts: { rate?: number; latencyMs?: number; respond?: (n: number, songPos: number) => IdentifyResponse | Error }) {
  let now = 0;
  const timers: { at: number; fn: () => void }[] = [];
  const rate = opts.rate ?? 1;
  const latency = opts.latencyMs ?? 1_000;
  let calls = 0;
  const snaps: SyncSnapshot[] = [];
  const session = new SyncSession({
    now: () => now,
    setTimer: (fn, ms) => {
      const t = { at: now + ms, fn };
      timers.push(t);
      return t;
    },
    clearTimer: (h) => {
      const i = timers.indexOf(h as (typeof timers)[number]);
      if (i >= 0) timers.splice(i, 1);
    },
    getClip: () => ({ blob: new Blob([new Uint8Array(2048)]), capturedAtMs: now }),
    identify: async () => {
      const songPos = 30_000 + now * rate;
      now += latency;
      const n = calls++;
      const r = opts.respond?.(n, songPos) ?? {
        match: { ...TRACK, playOffsetMs: songPos },
        lyrics: { lines: [{ startMs: 0, text: 'x' }], instrumental: false },
        lyricsCached: false,
        lyricsTimeScale: 1,
        processingMs: 5,
      };
      if (r instanceof Error) throw r;
      return r;
    },
    onChange: (s) => snaps.push(s),
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
  return { session, runFor, snaps, getNow: () => now, calls: () => calls, pending: () => timers.length };
}

describe('SyncSession', () => {
  it('locks on to a 1.1x track and then backs off', async () => {
    const h = harness({ rate: 1.1 });
    h.session.start();
    await h.runFor(40_000);
    expect(h.session.snapshot.state).toBe('locked');
    expect(h.session.snapshot.rate).toBeCloseTo(1.1, 3);
    expect(h.session.positionMs()).toBeCloseTo(30_000 + h.getNow() * 1.1, -1);
    const callsAtLock = h.calls();
    await h.runFor(60_000);
    // Locked: at most one re-check every 20-30s.
    expect(h.calls() - callsAtLock).toBeLessThanOrEqual(3);
    expect(h.calls() - callsAtLock).toBeGreaterThanOrEqual(2);
  });

  it('keeps going through server errors and reports them', async () => {
    const h = harness({ respond: (n) => (n === 1 ? new Error('Server error 502') : undefined!) });
    h.session.start();
    await h.runFor(5_000);
    expect(h.snaps.some((s) => s.lastAction === 'error' && s.error === 'Server error 502')).toBe(true);
    await h.runFor(20_000);
    expect(h.session.snapshot.error).toBeNull();
    expect(h.session.snapshot.track?.title).toBe('Paper Lanterns');
  });

  it('drops the song after repeated no-match results', async () => {
    const none: IdentifyResponse = { match: null, lyrics: null, lyricsCached: false, lyricsTimeScale: 1, processingMs: 1 };
    const h = harness({ respond: (n) => (n < 2 ? undefined! : none) });
    h.session.start();
    await h.runFor(60_000);
    expect(h.session.snapshot.track).toBeNull();
    expect(h.session.snapshot.state).toBe('searching');
    expect(h.session.positionMs()).toBeNull();
  });

  it('stop cancels the loop', async () => {
    const h = harness({});
    h.session.start();
    await h.runFor(3_000);
    h.session.stop();
    const calls = h.calls();
    await h.runFor(60_000);
    expect(h.calls()).toBe(calls);
    expect(h.session.snapshot.running).toBe(false);
  });
});
