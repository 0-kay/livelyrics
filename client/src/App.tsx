import { useCallback, useEffect, useRef, useState } from 'react';
import { CONCERT_CONFIG, type SyncState } from '@livelyrics/shared';
import { health, identify, transcribe } from './api.js';
import { MicRecorder } from './audio/micRecorder.js';
import { LyricsPlayer } from './lyrics/LyricsPlayer.js';
import { ConcertLoop, type ConcertSnapshot } from './sync/concertLoop.js';
import { SyncSession, type SyncSnapshot } from './sync/syncSession.js';

const CLIP_SECONDS = 9;

export const STATE_LABEL: Record<SyncState, string> = {
  searching: 'Listening',
  confirming: 'Syncing',
  locked: 'Locked',
  drifting: 'Drifting',
};

export function App() {
  const recorder = useRef(new MicRecorder({ bufferSeconds: 10 }));
  const session = useRef<SyncSession | null>(null);
  const concert = useRef<ConcertLoop | null>(null);
  const [snap, setSnap] = useState<SyncSnapshot | null>(null);
  const [concertSnap, setConcertSnap] = useState<ConcertSnapshot | null>(null);
  const [startError, setStartError] = useState<string | null>(null);
  const [mode, setMode] = useState<string>('');
  const [concertAvailable, setConcertAvailable] = useState(false);
  const [concertOn, setConcertOn] = useState(false);
  const [buffered, setBuffered] = useState(0);

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

  // Show buffer progress until the first clip is ready.
  useEffect(() => {
    if (!snap?.running || snap.recognitions > 0) return;
    const id = setInterval(() => setBuffered(recorder.current.bufferedSeconds()), 200);
    return () => clearInterval(id);
  }, [snap?.running, snap?.recognitions]);

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
        getClip: () => rec.getClip(CLIP_SECONDS),
        identify: (blob) => identify(blob),
        onChange: setSnap,
      });
      session.current = s;
      s.start();
    } catch (e) {
      await recorder.current.stop();
      setStartError(e instanceof Error ? e.message : String(e));
    }
  }, []);

  const stop = useCallback(async () => {
    session.current?.stop();
    session.current = null;
    await recorder.current.stop();
    setSnap(null);
  }, []);

  const getPositionMs = useCallback(() => session.current?.positionMs() ?? 0, []);
  const running = Boolean(snap?.running);
  const track = snap?.track ?? null;
  const lyrics = snap?.lyrics ?? null;

  return (
    <main className="app">
      <header className="topbar">
        <div className="brand">
          <h1>LiveLyrics</h1>
          {mode && <span className="mode">{mode} mode</span>}
        </div>
        <button className="listen" onClick={running ? stop : listen} aria-pressed={running}>
          {running ? 'Stop' : 'Listen'}
        </button>
      </header>

      <section className="controls">
        {running && track ? (
          <div className="track">
            <p className="title">{track.title}</p>
            <p className="artist">{track.artist}</p>
          </div>
        ) : (
          <p className="status" role="status">
            {!running && !startError && 'Tap Listen and hold your device near the music.'}
            {startError && `Could not start the mic: ${startError}`}
            {running && snap?.recognitions === 0 && `Listening ${buffered.toFixed(0)}s of ${CLIP_SECONDS}s`}
            {running && (snap?.recognitions ?? 0) > 0 && 'No match yet. Keep the device near the speaker.'}
          </p>
        )}
        {running && snap && (
          <p
            className={`sync sync-${snap.state}`}
            aria-live="polite"
            data-state={snap.state}
            data-action={snap.lastAction ?? ''}
            data-error-ms={Math.round(snap.lastErrorMs)}
            data-recognitions={snap.recognitions}
          >
            <span className="dot" aria-hidden="true" />
            <span className="label">{STATE_LABEL[snap.state]}</span>
            {track && <span className="rate">{snap.rate.toFixed(2)}x</span>}
            {snap.error && <span className="err">retrying ({snap.error})</span>}
          </p>
        )}
        {concertAvailable && (
          <label className="concert-toggle">
            <input type="checkbox" checked={concertOn} onChange={(e) => setConcertOn(e.target.checked)} />
            Concert mode (experimental)
          </label>
        )}
        {concertSnap?.running && (
          <p className="concert-status" data-action={concertSnap.lastAction ?? ''} data-reanchors={concertSnap.reanchors}>
            {concertSnap.lastText ? `Heard: "${concertSnap.lastText}"` : 'Listening for sung words'}
            {concertSnap.reanchors > 0 && ` · re-anchored ${concertSnap.reanchors}x`}
          </p>
        )}
      </section>

      {track && lyrics && !lyrics.instrumental && <LyricsPlayer lines={lyrics.lines} getPositionMs={getPositionMs} />}
      {track && lyrics?.instrumental && <p className="note">This track is instrumental.</p>}
      {track && !lyrics && <p className="note">No synced lyrics found for this track.</p>}
    </main>
  );
}
