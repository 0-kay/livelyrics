import { useCallback, useEffect, useRef, useState } from 'react';
import type { IdentifyResponse } from '@livelyrics/shared';
import { health, identify } from './api.js';
import { MicRecorder } from './audio/micRecorder.js';
import { FixedClock } from './lyrics/fixedClock.js';
import { LyricsPlayer } from './lyrics/LyricsPlayer.js';

type Status = 'idle' | 'listening' | 'identifying' | 'playing' | 'no-match' | 'error';

const CLIP_SECONDS = 9;

export function App() {
  const recorder = useRef(new MicRecorder({ bufferSeconds: 10 }));
  const [status, setStatus] = useState<Status>('idle');
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<IdentifyResponse | null>(null);
  const [clock, setClock] = useState<FixedClock | null>(null);
  const [mode, setMode] = useState<string>('');
  const [buffered, setBuffered] = useState(0);

  useEffect(() => {
    health().then((h) => setMode(h.mode)).catch(() => setMode('offline'));
    const rec = recorder.current;
    return () => void rec.stop();
  }, []);

  const listen = useCallback(async () => {
    setError(null);
    setResult(null);
    setClock(null);
    try {
      const rec = recorder.current;
      await rec.start();
      setStatus('listening');
      while (rec.bufferedSeconds() < CLIP_SECONDS) {
        setBuffered(rec.bufferedSeconds());
        await new Promise((r) => setTimeout(r, 200));
      }
      const clip = rec.getClip(CLIP_SECONDS);
      if (!clip) throw new Error('Not enough audio captured');
      setStatus('identifying');
      const res = await identify(clip.blob);
      await rec.stop();
      setResult(res);
      if (!res.match) {
        setStatus('no-match');
        return;
      }
      // playOffsetMs refers to the end of the clip, captured at clip.capturedAtMs.
      setClock(new FixedClock(res.match.playOffsetMs, clip.capturedAtMs));
      setStatus('playing');
    } catch (e) {
      await recorder.current.stop();
      setError(e instanceof Error ? e.message : String(e));
      setStatus('error');
    }
  }, []);

  const stop = useCallback(async () => {
    await recorder.current.stop();
    setClock(null);
    setStatus('idle');
  }, []);

  const getPositionMs = useCallback(() => (clock ? clock.positionAt(performance.now()) : 0), [clock]);
  const busy = status === 'listening' || status === 'identifying';

  return (
    <main className="app">
      <header>
        <h1>LiveLyrics</h1>
        {mode && <span className="mode">{mode} mode</span>}
      </header>

      <section className="controls">
        <button onClick={status === 'playing' ? stop : listen} disabled={busy}>
          {status === 'playing' ? 'Stop' : busy ? 'Listening...' : 'Listen'}
        </button>
        <p className="status" role="status">
          {status === 'idle' && 'Tap Listen and hold your device near the music.'}
          {status === 'listening' && `Listening ${buffered.toFixed(0)}s of ${CLIP_SECONDS}s`}
          {status === 'identifying' && 'Identifying the song'}
          {status === 'no-match' && 'No match found. Try again closer to the speaker.'}
          {status === 'error' && `Something went wrong: ${error}`}
          {status === 'playing' && result?.match && `${result.match.title} by ${result.match.artist}`}
        </p>
      </section>

      {status === 'playing' && result?.lyrics && !result.lyrics.instrumental && (
        <LyricsPlayer lines={result.lyrics.lines} getPositionMs={getPositionMs} />
      )}
      {status === 'playing' && result?.lyrics?.instrumental && <p className="note">This track is instrumental.</p>}
      {status === 'playing' && !result?.lyrics && <p className="note">No synced lyrics found for this track.</p>}
    </main>
  );
}
