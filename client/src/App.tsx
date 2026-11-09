import { useCallback, useEffect, useRef, useState } from 'react';
import { BPM_CHECK_CONFIG, CAPTURE_CONFIG, CONCERT_CONFIG, RHYTHM_CONFIG, TRIGGER_CONFIG } from '@livelyrics/shared';
import { health, identify, transcribe } from './api.js';
import { MicRecorder } from './audio/micRecorder.js';
import { tempoForCrossCheck } from './audio/rhythm.js';
import { clipSecondsFromSearch } from './config.js';
import { ConcertLoop, type ConcertSnapshot } from './sync/concertLoop.js';
import { SyncSession, type SyncSnapshot } from './sync/syncSession.js';
import { reduceDisplay, type DisplaySong } from './ui/displaySong.js';
import { Stage } from './ui/Stage.js';

/** Seconds of audio per recognition. Add ?clip=9 to the URL to compare lengths. */
const CLIP_SECONDS = clipSecondsFromSearch(typeof window === 'undefined' ? '' : window.location.search);
const SETTLE_MS = CLIP_SECONDS * 1000 + TRIGGER_CONFIG.settleMarginMs;
/** Settle time for trigger checks, which send the shorter quick clip. */
const QUICK_SETTLE_MS = Math.min(CLIP_SECONDS, CAPTURE_CONFIG.quickClipSeconds) * 1000 + TRIGGER_CONFIG.settleMarginMs;

/** True when the error means the browser or the user blocked the mic. */
export function isPermissionError(e: unknown): boolean {
  const name = e instanceof Error || (typeof e === 'object' && e !== null) ? String((e as { name?: unknown }).name ?? '') : '';
  const msg = e instanceof Error ? e.message : String(e);
  return name === 'NotAllowedError' || name === 'SecurityError' || /permission|denied|not allowed/i.test(msg);
}

/** Keeps the screen on while listening, where the browser supports it. */
function useWakeLock(on: boolean) {
  useEffect(() => {
    if (!on || typeof navigator === 'undefined' || !('wakeLock' in navigator)) return;
    let lock: WakeLockSentinel | null = null;
    let cancelled = false;
    const acquire = () => {
      navigator.wakeLock
        .request('screen')
        .then((l) => {
          if (cancelled) void l.release();
          else lock = l;
        })
        .catch(() => {});
    };
    const onVisible = () => {
      if (document.visibilityState === 'visible') acquire();
    };
    acquire();
    document.addEventListener('visibilitychange', onVisible);
    return () => {
      cancelled = true;
      document.removeEventListener('visibilitychange', onVisible);
      void lock?.release().catch(() => {});
    };
  }, [on]);
}

export function App() {
  const recorder = useRef(new MicRecorder({ bufferSeconds: CAPTURE_CONFIG.bufferSeconds }));
  const session = useRef<SyncSession | null>(null);
  const concert = useRef<ConcertLoop | null>(null);
  const [snap, setSnap] = useState<SyncSnapshot | null>(null);
  const [concertSnap, setConcertSnap] = useState<ConcertSnapshot | null>(null);
  const [startError, setStartError] = useState<{ denied: boolean; message: string } | null>(null);
  const [mode, setMode] = useState<string>('');
  const [concertAvailable, setConcertAvailable] = useState(false);
  const [concertOn, setConcertOn] = useState(false);
  const [startedAt, setStartedAt] = useState(0);
  const [lastMissAt, setLastMissAt] = useState<number | null>(null);
  const [display, setDisplay] = useState<DisplaySong | null>(null);
  const lastPosRef = useRef<{ key: string; posMs: number } | null>(null);
  const lastRecognitions = useRef(0);

  useEffect(() => {
    health()
      .then((h) => {
        setMode(h.mode);
        setConcertAvailable(Boolean(h.concertMode));
      })
      .catch(() => setMode('offline'));
    const rec = recorder.current;
    return () => {
      concert.current?.stop();
      session.current?.stop();
      void rec.stop();
    };
  }, []);

  // Track the song on screen and empty checks from each session snapshot.
  useEffect(() => {
    const now = performance.now();
    setDisplay((d) =>
      // The rhythm hunch only triggers an early check; the screen changes when the server names a
      // different song (or the song is lost), so it never flips away and back on a false alarm.
      reduceDisplay(d, { running: Boolean(snap?.running), track: snap?.track ?? null, lyrics: snap?.lyrics ?? null }, now, lastPosRef.current),
    );
    if (snap && snap.recognitions > lastRecognitions.current && snap.lastAction === 'miss') setLastMissAt(now);
    lastRecognitions.current = snap?.recognitions ?? 0;
  }, [snap]);

  // Learn the beat grid while a song is on screen; the tracker decides locally when the rhythm says it changed.
  const displayKey = display && display.lostAt === null ? display.key : null;
  useEffect(() => {
    if (displayKey) recorder.current.armRhythm(displayKey);
    else recorder.current.disarmRhythm();
  }, [displayKey]);

  // BPM cross-check: the local tempo pulls a recognition forward when it says the playback rate moved.
  useEffect(() => {
    if (!snap?.running) return;
    const id = setInterval(() => {
      session.current?.checkTempo(tempoForCrossCheck(recorder.current.rhythmSnapshot()));
    }, BPM_CHECK_CONFIG.intervalMs);
    return () => clearInterval(id);
  }, [snap?.running]);

  // Concert loop runs only while listening with the flag available and the toggle on.
  useEffect(() => {
    const s = session.current;
    if (!snap?.running || !s || !concertAvailable || !concertOn) return;
    const rec = recorder.current;
    const loop = new ConcertLoop({
      session: s,
      getClip: () => rec.getClip(CONCERT_CONFIG.chunkSeconds),
      transcribe: (blob, ctx) =>
        transcribe(blob, {
          title: ctx.track.title,
          artist: ctx.track.artist,
          album: ctx.track.album,
          durationMs: ctx.track.durationMs,
          positionMs: ctx.positionMs,
        }),
      onChange: setConcertSnap,
    });
    concert.current = loop;
    loop.start();
    return () => {
      loop.stop();
      concert.current = null;
      setConcertSnap(null);
    };
  }, [snap?.running, concertAvailable, concertOn]);

  const listen = useCallback(async () => {
    setStartError(null);
    try {
      const rec = recorder.current;
      await rec.start();
      const s = new SyncSession({
        getClip: (seconds) => rec.getClip(seconds ?? CLIP_SECONDS),
        bufferedSeconds: () => rec.bufferedSeconds(),
        identify: (blob) => identify(blob),
        onChange: setSnap,
        settleMs: SETTLE_MS,
      });
      session.current = s;
      // Sound returning after a gap usually means a new track: check soon.
      rec.onGapEnd = () => s.recheckSoon(QUICK_SETTLE_MS, true);
      // A different rhythm for 3s straight: move on now, confirm with a check right away.
      rec.onSongChange = () => s.suspectSongChange(RHYTHM_CONFIG.switchAfterMs);
      lastPosRef.current = null;
      setLastMissAt(null);
      setStartedAt(performance.now());
      s.start();
    } catch (e) {
      await recorder.current.stop();
      setStartError({ denied: isPermissionError(e), message: e instanceof Error ? e.message : String(e) });
    }
  }, []);

  const stop = useCallback(async () => {
    session.current?.stop();
    session.current = null;
    await recorder.current.stop();
    setSnap(null);
  }, []);

  const getPositionMs = useCallback(() => session.current?.positionMs() ?? null, []);
  const bufferedSeconds = useCallback(() => recorder.current.bufferedSeconds(), []);
  const getBeat = useCallback((nowMs: number) => recorder.current.beatFrame(nowMs), []);
  const getRhythm = useCallback(() => recorder.current.rhythmSnapshot(), []);
  const running = Boolean(snap?.running);
  useWakeLock(running);

  return (
    <main>
      <Stage
        running={running}
        startError={startError}
        startedAt={startedAt}
        clipSeconds={CLIP_SECONDS}
        bufferedSeconds={bufferedSeconds}
        recognitions={snap?.recognitions ?? 0}
        lastMissAt={lastMissAt}
        syncState={snap?.state ?? 'searching'}
        rate={snap?.rate ?? 1}
        offline={Boolean(snap?.error)}
        display={display}
        getPositionMs={getPositionMs}
        getBeat={getBeat}
        getRhythm={getRhythm}
        lastPosRef={lastPosRef}
        concert={{ available: concertAvailable, on: concertOn, lastText: concertSnap?.running ? concertSnap.lastText : null }}
        demoMode={mode === 'mock'}
        onListen={listen}
        onStop={stop}
        onToggleConcert={() => setConcertOn((v) => !v)}
      />
    </main>
  );
}
