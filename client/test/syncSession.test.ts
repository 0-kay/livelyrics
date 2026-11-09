import { describe, expect, it } from 'vitest';
import { CAPTURE_CONFIG, RecognitionScheduler, type IdentifyResponse, type TrackMatch } from '@livelyrics/shared';
import { SyncSession, type SyncSnapshot } from '../src/sync/syncSession.js';

const TRACK: TrackMatch = { title: 'Paper Lanterns', artist: 'The Mock Ensemble', durationMs: 180_000, playOffsetMs: 0, score: 100 };

/** Manual timer queue so the loop can be stepped deterministically. */
/** Scheduler whose locked re-checks are 100s apart, so only a trigger can cause an early check. */
const slowScheduler = () => new RecognitionScheduler({ config: { lockedMinIntervalMs: 100_000, lockedMaxIntervalMs: 100_000 } });

function harness(opts: {
  rate?: number;
  latencyMs?: number;
  durationMs?: number;
  /** Holds the first identify call until resolved, to test requests that are in flight. */
  gate?: Promise<void>;
  scheduler?: RecognitionScheduler;
  respond?: (n: number, songPos: number) => IdentifyResponse | Error;
}) {
  let gateUsed = false;
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
    scheduler: opts.scheduler,
    identify: async () => {
      if (opts.gate && !gateUsed) {
        gateUsed = true;
        await opts.gate;
      }
      const songPos = 30_000 + now * rate;
      now += latency;
      const n = calls++;
      const r = opts.respond?.(n, songPos) ?? {
        match: { ...TRACK, durationMs: opts.durationMs ?? TRACK.durationMs, playOffsetMs: songPos },
        lyrics: { lines: [{ startMs: 0, text: 'x' }], instrumental: false },
        lyricsCached: false,
        lyricsTimeScale: 1,
        processingMs: 5,
      };
      if (r instanceof Error) throw r;
      return r;
    },
    onChange: (s) => snaps.push(s),
    // Like the mic: audio accumulates from Listen (the session starts at time 0 here).
    bufferedSeconds: () => Math.min(CAPTURE_CONFIG.bufferSeconds, now / 1000),
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
  it('locks on to a 1.1x track and then keeps a steady check cadence', async () => {
    const h = harness({ rate: 1.1 });
    h.session.start();
    await h.runFor(40_000);
    expect(h.session.snapshot.state).toBe('locked');
    expect(h.session.snapshot.rate).toBeCloseTo(1.1, 3);
    expect(h.session.positionMs()).toBeCloseTo(30_000 + h.getNow() * 1.1, -1);
    const callsAtLock = h.calls();
    await h.runFor(60_000);
    // Locked: one check every 5-6s (plus the 1s simulated latency), so about 9-10 a minute.
    expect(h.calls() - callsAtLock).toBeLessThanOrEqual(12);
    expect(h.calls() - callsAtLock).toBeGreaterThanOrEqual(8);
  });

  it('keeps going through server errors and reports them', async () => {
    const h = harness({ respond: (n) => (n === 1 ? new Error('Server error 502') : undefined!) });
    h.session.start();
    await h.runFor(10_000);
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

  it('recheckSoon pulls the next check forward while locked, and never pushes it back', async () => {
    const h = harness({ scheduler: slowScheduler() });
    h.session.start();
    await h.runFor(40_000);
    expect(h.session.snapshot.state).toBe('locked');
    const before = h.calls();
    await h.runFor(10_000);
    expect(h.calls()).toBe(before); // regular checks are 100s apart, so nothing fires on its own
    h.session.recheckSoon(3_000);
    await h.runFor(4_500);
    expect(h.calls()).toBe(before + 1);
    // A later, longer request must not delay a check that is already due sooner.
    h.session.recheckSoon(2_000);
    h.session.recheckSoon(15_000);
    await h.runFor(3_500);
    expect(h.calls()).toBe(before + 2);
  });

  it('recheckSoon while a request is in flight shortens the next wait', async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const h = harness({ gate });
    h.session.start();
    await h.runFor(4_100); // the first (quick 4s) request is now waiting on the gate
    h.session.recheckSoon(500);
    release();
    await new Promise((r) => setTimeout(r, 0));
    expect(h.calls()).toBe(1);
    // Searching normally waits 2s between attempts; the trigger makes it 0.5s.
    await h.runFor(700);
    expect(h.calls()).toBe(2);
  });

  it('rechecks soon after the matched song should have ended', async () => {
    // Song is 90s long and the clock starts at 30s, so it ends 60s after start at 1x.
    const h = harness({ durationMs: 90_000, scheduler: slowScheduler() });
    h.session.start();
    await h.runFor(50_000);
    expect(h.session.snapshot.state).toBe('locked');
    const before = h.calls();
    // At the end (60s) the session starts looking for the next song from that moment, so the
    // first check goes out once 4s of new audio exist (64s). Regular checks are 100s apart.
    await h.runFor(12_000);
    expect(h.calls()).toBe(before);
    await h.runFor(3_000);
    expect(h.calls()).toBe(before + 1);
  });

  it('switches to a new song when a recheck returns a different track', async () => {
    const other: TrackMatch = { title: 'Other Song', artist: 'Someone', durationMs: 200_000, playOffsetMs: 12_000, score: 100 };
    let switched = false;
    const h = harness({
      respond: (n, songPos) =>
        switched
          ? { match: { ...other, playOffsetMs: 12_000 + n }, lyrics: { lines: [{ startMs: 0, text: 'new' }], instrumental: false }, lyricsCached: false, lyricsTimeScale: 1, processingMs: 5 }
          : (undefined as unknown as IdentifyResponse),
    });
    h.session.start();
    await h.runFor(45_000);
    expect(h.session.snapshot.track?.title).toBe('Paper Lanterns');
    switched = true;
    h.session.recheckSoon(2_000);
    await h.runFor(5_000);
    expect(h.session.snapshot.track?.title).toBe('Other Song');
    expect(h.session.snapshot.lyrics?.lines[0]?.text).toBe('new');
    expect(h.session.snapshot.state).not.toBe('locked');
  });

  it('a detected change checks as soon as 4s of audio since the change point exist', async () => {
    const h = harness({ scheduler: slowScheduler() });
    h.session.start();
    await h.runFor(40_000);
    expect(h.session.snapshot.state).toBe('locked');
    const before = h.calls();
    // The new song began 3s ago: a quick 4s clip of it exists in about 1s (not 100s).
    h.session.changeDetected(h.getNow() - 3_000);
    expect(h.session.snapshot.changeSuspected).toBe(true);
    await h.runFor(800);
    expect(h.calls()).toBe(before);
    await h.runFor(500);
    expect(h.calls()).toBe(before + 1);
    // Same song came back: the flag clears.
    expect(h.session.snapshot.changeSuspected).toBe(false);
    expect(h.session.snapshot.track?.title).toBe('Paper Lanterns');
  });

  it('ignores a suspected change before any song is matched', () => {
    const h = harness({});
    h.session.start();
    h.session.suspectSongChange();
    expect(h.session.snapshot.changeSuspected).toBe(false);
  });

  it('checkTempo pulls a recognition forward when the local tempo says the rate changed', async () => {
    const h = harness({ scheduler: slowScheduler() });
    h.session.start();
    // Before any match the cross-check does nothing.
    expect(h.session.checkTempo(120)).toBe('idle');
    await h.runFor(40_000);
    expect(h.session.snapshot.state).toBe('locked');
    expect(h.session.checkTempo(120)).toBe('relearned');
    const before = h.calls();
    // Same tempo for 20s: no extra checks (regular ones are 100s apart).
    for (let i = 0; i < 40; i++) {
      await h.runFor(500);
      h.session.checkTempo(120);
    }
    expect(h.calls()).toBe(before);
    // Tempo up 8% while the clock still says 1.0x: a check comes within the hold time plus 1.5s.
    const statuses: string[] = [];
    for (let i = 0; i < 14; i++) {
      await h.runFor(500);
      statuses.push(h.session.checkTempo(129.6));
    }
    expect(statuses).toContain('recheck');
    await h.runFor(2_000);
    expect(h.calls()).toBeGreaterThan(before);
  });

  it('checkTempo stays quiet while a song change is suspected', async () => {
    const h = harness({ scheduler: slowScheduler() });
    h.session.start();
    await h.runFor(40_000);
    h.session.checkTempo(120);
    h.session.suspectSongChange(3_000);
    expect(h.session.checkTempo(150)).toBe('idle');
  });

  it('finds the first song with a quick 4s try, then a full 8s clip as soon as it exists', async () => {
    const sizes: number[] = [];
    const h = harness({ respond: (n) => ({ match: null, lyrics: null, processingMs: 1, lyricsCached: false, lyricsTimeScale: 1 }) });
    const orig = (h.session as unknown as { deps: { getClip: (s: number) => unknown } }).deps.getClip;
    (h.session as unknown as { deps: { getClip: (s: number) => unknown } }).deps.getClip = (sec: number) => {
      sizes.push(sec);
      return orig(sec);
    };
    h.session.start();
    await h.runFor(4_100);
    expect(sizes).toEqual([CAPTURE_CONFIG.quickClipSeconds]);
    await h.runFor(4_100); // 8.2s since Listen: the long clip went out at 8s, not later
    expect(sizes[1]).toBe(CAPTURE_CONFIG.longClipSeconds);
    await h.runFor(6_000);
    expect(sizes.slice(2).every((s) => s >= CAPTURE_CONFIG.longClipSeconds)).toBe(true);
  });

  it('cuts clips at the change point, so a new-song clip never holds the old song', async () => {
    const h = harness({ scheduler: slowScheduler() });
    h.session.start();
    await h.runFor(40_000);
    const sent: { at: number; sec: number }[] = [];
    const deps = (h.session as unknown as { deps: { getClip: (s: number) => unknown } }).deps;
    const orig = deps.getClip;
    deps.getClip = (sec: number) => {
      sent.push({ at: h.getNow(), sec });
      return orig(sec);
    };
    const at = h.getNow();
    h.session.changeDetected(at);
    await h.runFor(2_000);
    expect(h.session.planClip()).toMatchObject({ waitMs: expect.any(Number) }); // only 2s since the change
    await h.runFor(12_000);
    expect(sent.length).toBeGreaterThan(0);
    for (const c of sent) expect(c.sec).toBeLessThanOrEqual((c.at - at) / 1000 + 1e-6);
    expect(sent[0]!.sec).toBe(CAPTURE_CONFIG.quickClipSeconds);
  });

  it('routine checks send the routine length while a song is on', async () => {
    const h = harness({ scheduler: slowScheduler() });
    h.session.start();
    await h.runFor(40_000);
    expect(h.session.clipSeconds()).toBe(CAPTURE_CONFIG.clipSeconds);
  });

  it('misses on short clips never lose the song; misses on long clips do', async () => {
    let missing = false;
    const h = harness({
      respond: () => (missing ? { match: null, lyrics: null, processingMs: 1, lyricsCached: false, lyricsTimeScale: 1 } : (undefined as unknown as IdentifyResponse)),
    });
    h.session.start();
    await h.runFor(40_000);
    expect(h.session.snapshot.track).not.toBeNull();
    missing = true;
    // Short-clip misses (quick tries after detected changes far apart) keep the song.
    for (let i = 0; i < 4; i++) {
      h.session.changeDetected(h.getNow());
      await h.runFor(4_500);
      await h.runFor(10_000);
    }
    const stats = h.session.snapshot.clipStats;
    expect(stats[CAPTURE_CONFIG.quickClipSeconds]?.sent ?? 0).toBeGreaterThan(0);
    // Long-clip misses in a row drop it.
    await h.runFor(30_000);
    expect(h.session.snapshot.track).toBeNull();
  });

  it('counts sent and matched clips per length', async () => {
    const h = harness({});
    h.session.start();
    await h.runFor(20_000);
    const st = h.session.snapshot.clipStats;
    const total = Object.values(st).reduce((a, x) => a + x.sent, 0);
    expect(total).toBe(h.calls());
    expect(st[CAPTURE_CONFIG.quickClipSeconds]).toEqual({ sent: 1, matched: 1 });
  });
});
