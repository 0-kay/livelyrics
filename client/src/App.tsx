import { useCallback, useEffect, useRef, useState } from 'react';
import type { SyncState } from '@livelyrics/shared';
import { health, identify } from './api.js';
import { MicRecorder } from './audio/micRecorder.js';
import { LyricsPlayer } from './lyrics/LyricsPlayer.js';
import { SyncSession, type SyncSnapshot } from './sync/syncSession.js';

const CLIP_SECONDS = 9;

const STATE_LABEL: Record<SyncState, string> = {
  searching: 'Listening',
  confirming: 'Syncing',
  locked: 'Locked',
  drifting: 'Adjusting',
};

export function App() {
  const recorder = useRef(new MicRecorder({ bufferSeconds: 10 }));
  const session = useRef<SyncSession | null>(null);
  const [snap, setSnap] = useState<SyncSnapshot | null>(null);
  const [startError, setStartError] = useState<string | null>(null);
  const [mode, setMode] = useState<string>('');
  const [buffered, setBuffered] = useState(0);

  useEffect(() => {
    health().then((h) => setMode(h.mode)).catch(() => setMode('offline'));
    const rec = recorder.current;
    return () => {
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
      <header>
        <h1>LiveLyrics</h1>
        {mode && <span className="mode">{mode} mode</span>}
      </header>

      <section className="controls">
        <button onClick={running ? stop : listen}>{running ? 'Stop' : 'Listen'}</button>
        <p className="status" role="status">
          {!running && !startError && 'Tap Listen and hold your device near the music.'}
          {startError && `Could not start the mic: ${startError}`}
          {running && !track && snap?.recognitions === 0 && `Listening ${buffered.toFixed(0)}s of ${CLIP_SECONDS}s`}
          {running && !track && (snap?.recognitions ?? 0) > 0 && 'No match yet. Keep the device near the speaker.'}
          {running && track && `${track.title} by ${track.artist}`}
        </p>
        {running && snap && (
          <p
            className={`sync sync-${snap.state}`}
            aria-live="polite"
            data-action={snap.lastAction ?? ''}
            data-error-ms={Math.round(snap.lastErrorMs)}
            data-recognitions={snap.recognitions}
          >
            <span className="dot" aria-hidden="true" />
            {STATE_LABEL[snap.state]}
            {track && ` · ${snap.rate.toFixed(2)}x`}
            {snap.error && ` · retrying (${snap.error})`}
          </p>
        )}
      </section>

      {track && lyrics && !lyrics.instrumental && <LyricsPlayer lines={lyrics.lines} getPositionMs={getPositionMs} />}
      {track && lyrics?.instrumental && <p className="note">This track is instrumental.</p>}
      {track && !lyrics && <p className="note">No synced lyrics found for this track.</p>}
    </main>
  );
}
