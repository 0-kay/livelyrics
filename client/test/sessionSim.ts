/**
 * Full-session simulator: the real SyncSession (scheduler, clock, triggers)
 * against a fake recognition service, on a simulated clock. Measures what a
 * person notices: time to first lyrics, wobble and backward jumps in the shown
 * position, wrong-line flips, and how long a song change takes to appear.
 *
 * The provider model is an assumption, not a measurement of ACRCloud:
 * - each answer reports the song position at the clip end with Gaussian noise
 *   plus a per-answer bias drawn from biasMs (models where in the clip the
 *   match landed),
 * - a clip is matched to whichever song fills most of it; a near even split
 *   usually misses,
 * - latency, misses and rare wild outliers are random but seeded.
 */
import type { IdentifyResponse, RecognitionScheduler, TrackMatch } from '@livelyrics/shared';
import { SyncSession, type SyncSessionDeps } from '../src/sync/syncSession.js';

export function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const gauss = (r: () => number) => Math.sqrt(-2 * Math.log(Math.max(r(), 1e-12))) * Math.cos(2 * Math.PI * r());

export interface SimSong {
  title: string;
  rate: number;
  /** Song position when it starts playing (ms). */
  startPosMs: number;
  durationMs: number;
}

export interface SessionSimOptions {
  seed?: number;
  songs: SimSong[];
  /** Wall time each song after the first starts (ms), same length as songs minus one. */
  switchAtMs: number[];
  durationMs: number;
  noiseMs?: number;
  biasMs?: [number, number];
  missProb?: number;
  outlierProb?: number;
  latencyMs?: [number, number];
  /** Default clip length when the session does not ask for one (s). */
  clipSeconds?: number;
  /** Simulate the local rhythm detector: suspect a change this long after each switch (ms). */
  rhythmTriggerAfterMs?: number | null;
  scheduler?: RecognitionScheduler;
  deps?: Partial<SyncSessionDeps>;
  /** Lyric line spacing for the wrong-line metric (ms). */
  lineMs?: number;
}

export interface SessionSimResult {
  requests: number;
  requestsPerHour: number;
  firstLyricsMs: number | null;
  firstLockedMs: number | null;
  /** Per switch: ms from the real change until the new song is shown. */
  switchLatencyMs: (number | null)[];
  /** Position error while the right song is shown and settled. */
  errP50: number;
  errP95: number;
  /** Share of 250ms windows where the shown speed is off the true speed by more than 6%. */
  wobbleShare: number;
  /** Times the shown position went backwards. */
  backwardMoves: number;
  /** Times the active lyric line went back to an earlier line. */
  lineReversals: number;
  /** Ms spent showing a song other than the one playing (outside switch transitions). */
  wrongSongMs: number;
  /** (ms since the shown song appeared, abs error ms, shown rate) samples while settled, for diagnostics. */
  trace: { sinceMs: number; errMs: number; rate: number }[];
  /** Recognition calls (time, clip, result), for diagnostics. */
  callLog: string[];
}

const key = (t: { title: string }) => t.title;

export async function simulateSession(o: SessionSimOptions): Promise<SessionSimResult> {
  const rand = rng(o.seed ?? 1);
  const noise = o.noiseMs ?? 150;
  const bias = o.biasMs ?? [0, 0];
  const lat = o.latencyMs ?? [500, 1500];
  const lineMs = o.lineMs ?? 3000;
  let now = 0;
  const timers: { at: number; seq: number; fn: () => void }[] = [];
  let seq = 0;
  const addTimer = (fn: () => void, ms: number) => {
    const t = { at: now + Math.max(0, ms), seq: seq++, fn };
    timers.push(t);
    return t;
  };

  const starts = [0, ...o.switchAtMs];
  const songIndexAt = (t: number) => {
    let i = 0;
    for (let k = 0; k < starts.length; k++) if (t >= starts[k]!) i = k;
    return i;
  };
  const truthPos = (i: number, t: number) => o.songs[i]!.startPosMs + (t - starts[i]!) * o.songs[i]!.rate;

  let requests = 0;
  const callLog: string[] = [];
  const identify = (blob: Blob): Promise<IdentifyResponse> => {
    requests++;
    const clipMs = (blob.size / 1000) * 1000;
    const end = now;
    const begin = end - clipMs;
    const latency = lat[0] + (lat[1] - lat[0]) * rand();
    // Which song fills most of the clip?
    const shares = o.songs.map((_, i) => {
      const s = Math.max(begin, starts[i]!);
      const e = Math.min(end, starts[i + 1] ?? Infinity);
      return Math.max(0, e - s) / clipMs;
    });
    let best = 0;
    for (let i = 1; i < shares.length; i++) if (shares[i]! > shares[best]!) best = i;
    const top = shares[best]!;
    let miss = rand() < (o.missProb ?? 0.05);
    if (top < 0.6 && rand() < 0.6) miss = true;
    let res: IdentifyResponse;
    if (miss) res = { match: null, lyrics: null, processingMs: 5, lyricsCached: false, lyricsTimeScale: 1 };
    else {
      const song = o.songs[best]!;
      let pos = truthPos(best, end) + gauss(rand) * noise + bias[0] + (bias[1] - bias[0]) * rand();
      if (rand() < (o.outlierProb ?? 0.02)) pos += (rand() < 0.5 ? -1 : 1) * 8000;
      const match: TrackMatch = { title: song.title, artist: 'Sim', durationMs: song.durationMs, playOffsetMs: Math.round(pos), score: top > 0.8 ? 95 : 70 };
      const lines = Array.from({ length: Math.ceil(song.durationMs / lineMs) }, (_, k) => ({ startMs: k * lineMs, text: `line ${k}` }));
      res = { match, lyrics: { lines, instrumental: false }, processingMs: 5, lyricsCached: true, lyricsTimeScale: 1 };
    }
    callLog.push(`${Math.round(now)} clip=${clipMs} ${res.match ? 'match' : 'miss'} +${Math.round(latency)}`);
    return new Promise((resolve) => addTimer(() => resolve(res), latency));
  };

  const session = new SyncSession({
    now: () => now,
    setTimer: (fn, ms) => addTimer(fn, ms),
    clearTimer: (h) => {
      const i = timers.indexOf(h as (typeof timers)[number]);
      if (i >= 0) timers.splice(i, 1);
    },
    // Like the mic: no clip until that much audio has been buffered since Listen.
    getClip: (seconds?: number) => {
      const sec = seconds ?? o.clipSeconds ?? 5;
      return now < sec * 1000 ? null : { blob: new Blob([new Uint8Array(Math.round(sec * 1000))]), capturedAtMs: now };
    },
    identify,
    settleMs: (o.clipSeconds ?? 6) * 1000 + 700,
    scheduler: o.scheduler,
    ...o.deps,
  } as SyncSessionDeps);

  // Metrics, sampled every 50ms.
  const STEP = 50;
  let firstLyricsMs: number | null = null;
  let firstLockedMs: number | null = null;
  const switchLatency: (number | null)[] = o.switchAtMs.map(() => null);
  const errs: number[] = [];
  let wobbleWin = 0;
  let wobbleBad = 0;
  let backward = 0;
  let lineRev = 0;
  let wrongMs = 0;
  let prevPos: number | null = null;
  let prevKey: string | null = null;
  let prevLine = -1;
  let winStart: { t: number; pos: number; key: string } | null = null;
  let lastChangeAt = -1e9;
  const trace: { sinceMs: number; errMs: number; rate: number }[] = [];

  const sample = () => {
    const snap = session.snapshot;
    const t = now;
    const playing = songIndexAt(t);
    const shownKey = snap.track ? key(snap.track) : null;
    const pos = session.positionMs();
    if (snap.state === 'locked' && firstLockedMs === null) firstLockedMs = t;
    if (shownKey && firstLyricsMs === null) firstLyricsMs = t;
    o.switchAtMs.forEach((s, i) => {
      if (switchLatency[i] === null && t >= s && shownKey === o.songs[i + 1]!.title) switchLatency[i] = t - s;
    });
    if (shownKey !== prevKey) {
      lastChangeAt = t;
      prevPos = null;
      prevLine = -1;
      winStart = null;
    }
    prevKey = shownKey;
    // Wrong song shown, outside the 12s after each real switch.
    const inTransition = o.switchAtMs.some((s) => t >= s && t < s + 12_000);
    if (shownKey && shownKey !== o.songs[playing]!.title && !inTransition) wrongMs += STEP;
    if (!shownKey || pos === null) return;
    const shownIdx = o.songs.findIndex((s) => s.title === shownKey);
    const settled = t - lastChangeAt > 8000 && shownIdx === playing;
    if (settled) {
      errs.push(Math.abs(pos - truthPos(shownIdx, t)));
      trace.push({ sinceMs: t - lastChangeAt, errMs: Math.abs(pos - truthPos(shownIdx, t)), rate: snap.rate });
    }
    if (prevPos !== null && pos < prevPos - 1) backward++;
    const line = Math.floor(pos / lineMs);
    if (prevLine >= 0 && line < prevLine) lineRev++;
    prevLine = line;
    prevPos = pos;
    if (!winStart) winStart = { t, pos, key: shownKey };
    else if (t - winStart.t >= 250) {
      if (settled && shownIdx >= 0) {
        const v = (pos - winStart.pos) / (t - winStart.t);
        wobbleWin++;
        if (Math.abs(v - o.songs[shownIdx]!.rate) > 0.06 * o.songs[shownIdx]!.rate) wobbleBad++;
      }
      winStart = { t, pos, key: shownKey };
    }
  };
  for (let t = 0; t <= o.durationMs; t += STEP) addTimer(sample, t);
  if (o.rhythmTriggerAfterMs != null) {
    for (const s of o.switchAtMs) addTimer(() => session.suspectSongChange(3000), s + o.rhythmTriggerAfterMs - now);
  }

  session.start();
  while (timers.length) {
    timers.sort((a, b) => a.at - b.at || a.seq - b.seq);
    const t = timers.shift()!;
    if (t.at > o.durationMs) break;
    now = Math.max(now, t.at);
    t.fn();
    // Let promise continuations (identify responses) run before the next timer.
    for (let k = 0; k < 4; k++) await Promise.resolve();
  }
  session.stop();

  errs.sort((a, b) => a - b);
  const pct = (p: number) => (errs.length ? errs[Math.min(errs.length - 1, Math.floor(p * errs.length))]! : Number.NaN);
  return {
    requests,
    requestsPerHour: (requests / o.durationMs) * 3_600_000,
    firstLyricsMs,
    firstLockedMs,
    switchLatencyMs: switchLatency,
    errP50: pct(0.5),
    errP95: pct(0.95),
    wobbleShare: wobbleWin ? wobbleBad / wobbleWin : 0,
    backwardMoves: backward,
    lineReversals: lineRev,
    wrongSongMs: wrongMs,
    trace,
    callLog,
  };
}

/** The standard scenario set used for before and after numbers. */
export const SCENARIOS: Record<string, Omit<SessionSimOptions, 'seed'>> = {
  'party, 1.0x, songs change every ~70s': {
    songs: [
      { title: 'A', rate: 1, startPosMs: 40_000, durationMs: 200_000 },
      { title: 'B', rate: 1, startPosMs: 0, durationMs: 210_000 },
      { title: 'C', rate: 1, startPosMs: 30_000, durationMs: 190_000 },
    ],
    switchAtMs: [75_000, 140_000],
    durationMs: 210_000,
    rhythmTriggerAfterMs: 4000,
  },
  'DJ set, sped up 1.08x, early cuts': {
    songs: [
      { title: 'A', rate: 1.08, startPosMs: 60_000, durationMs: 220_000 },
      { title: 'B', rate: 1.08, startPosMs: 20_000, durationMs: 200_000 },
    ],
    switchAtMs: [80_000],
    durationMs: 170_000,
    rhythmTriggerAfterMs: null,
  },
  'noisy room, more misses and outliers': {
    songs: [
      { title: 'A', rate: 1, startPosMs: 30_000, durationMs: 200_000 },
      { title: 'B', rate: 1, startPosMs: 10_000, durationMs: 200_000 },
    ],
    switchAtMs: [90_000],
    durationMs: 180_000,
    missProb: 0.2,
    outlierProb: 0.06,
    noiseMs: 250,
    rhythmTriggerAfterMs: 4000,
  },
};
