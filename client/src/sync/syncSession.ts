import {
  AdaptivePlaybackClock,
  RecognitionScheduler,
  SCHEDULER_CONFIG,
  sampleFromRecognition,
  type ClockAction,
  type IdentifyResponse,
  type SyncedLyrics,
  type SyncState,
  type TrackMatch,
} from '@livelyrics/shared';

export interface SessionClip {
  blob: Blob;
  /** Wall time (same clock as now()) when the last sample of the clip was captured. */
  capturedAtMs: number;
}

export interface SyncSessionDeps {
  /** Most recent audio clip, or null if the buffer is not full enough yet. */
  getClip: () => SessionClip | null;
  identify: (clip: Blob) => Promise<IdentifyResponse>;
  now?: () => number;
  setTimer?: (fn: () => void, ms: number) => unknown;
  clearTimer?: (handle: unknown) => void;
  onChange?: (s: SyncSnapshot) => void;
  latencyCompMs?: number;
}

export interface SyncSnapshot {
  running: boolean;
  state: SyncState;
  track: TrackMatch | null;
  lyrics: SyncedLyrics | null;
  lyricsTimeScale: number;
  rate: number;
  lastAction: ClockAction | 'miss' | 'error' | null;
  lastErrorMs: number;
  error: string | null;
  recognitions: number;
}

/** Wait this long when the mic buffer is not full yet (ms). */
const BUFFER_WAIT_MS = 300;

const trackKey = (t: TrackMatch) => `${t.artist.trim().toLowerCase()}|${t.title.trim().toLowerCase()}`;

/**
 * Re-recognition loop: grabs a clip from the rolling mic buffer, identifies it,
 * feeds the result into the adaptive clock, and lets the scheduler decide when
 * to try again (fast until locked, then every 20-30s).
 */
export class SyncSession {
  readonly clock: AdaptivePlaybackClock;
  private readonly scheduler = new RecognitionScheduler();
  private readonly now: () => number;
  private readonly setTimer: (fn: () => void, ms: number) => unknown;
  private readonly clearTimer: (handle: unknown) => void;
  private timer: unknown = null;
  private generation = 0;
  private snap: SyncSnapshot = {
    running: false,
    state: 'searching',
    track: null,
    lyrics: null,
    lyricsTimeScale: 1,
    rate: 1,
    lastAction: null,
    lastErrorMs: 0,
    error: null,
    recognitions: 0,
  };

  constructor(private readonly deps: SyncSessionDeps) {
    this.clock = new AdaptivePlaybackClock({ latencyCompMs: deps.latencyCompMs });
    this.now = deps.now ?? (() => performance.now());
    this.setTimer = deps.setTimer ?? ((fn, ms) => setTimeout(fn, ms));
    this.clearTimer = deps.clearTimer ?? ((h) => clearTimeout(h as ReturnType<typeof setTimeout>));
  }

  get snapshot(): SyncSnapshot {
    return this.snap;
  }

  /** Current song position in ms, or null before the first match. */
  positionMs(): number | null {
    return this.clock.positionAt(this.now());
  }

  start(): void {
    if (this.snap.running) return;
    this.generation++;
    this.scheduler.reset();
    this.clock.reset();
    this.update({ running: true, state: 'searching', track: null, lyrics: null, error: null, lastAction: null, recognitions: 0 });
    this.schedule(this.scheduler.initialDelayMs());
  }

  stop(): void {
    this.generation++;
    if (this.timer !== null) this.clearTimer(this.timer);
    this.timer = null;
    this.update({ running: false });
  }

  private schedule(ms: number) {
    const gen = this.generation;
    this.timer = this.setTimer(() => {
      this.timer = null;
      if (gen === this.generation) void this.tick(gen);
    }, ms);
  }

  private async tick(gen: number): Promise<void> {
    const clip = this.deps.getClip();
    if (!clip) {
      this.schedule(BUFFER_WAIT_MS);
      return;
    }
    const sentAt = this.now();
    let res: IdentifyResponse;
    try {
      res = await this.deps.identify(clip.blob);
    } catch (e) {
      if (gen !== this.generation) return;
      // Network or server trouble: keep the clock running and retry later.
      this.update({ error: e instanceof Error ? e.message : String(e), lastAction: 'error' });
      this.schedule(SCHEDULER_CONFIG.retryIntervalMs);
      return;
    }
    if (gen !== this.generation) return;
    const responseAt = this.now();
    const recognitions = this.snap.recognitions + 1;

    if (!res.match) {
      const d = this.scheduler.onResult({ matched: false });
      if (d.lostLock) {
        this.clock.reset();
        this.update({ track: null, lyrics: null, lyricsTimeScale: 1, rate: 1 });
      }
      this.update({ state: d.state, lastAction: 'miss', error: null, recognitions });
      this.schedule(d.nextDelayMs);
      return;
    }

    const songChanged = !this.snap.track || trackKey(this.snap.track) !== trackKey(res.match);
    if (songChanged) this.clock.reset();
    const sample = sampleFromRecognition({
      playOffsetMs: res.match.playOffsetMs,
      clipEndWallMs: clip.capturedAtMs,
      requestSentWallMs: sentAt,
      responseWallMs: responseAt,
    });
    const upd = this.clock.addSample(sample, responseAt);
    const d = this.scheduler.onResult({
      matched: true,
      score: res.match.score,
      action: upd.action,
      songChanged,
      rateSpanMs: upd.rateSpanMs,
    });
    this.update({
      state: d.state,
      track: res.match,
      lyrics: songChanged ? res.lyrics : (this.snap.lyrics ?? res.lyrics),
      lyricsTimeScale: songChanged ? res.lyricsTimeScale : this.snap.lyricsTimeScale,
      rate: upd.rate,
      lastAction: upd.action,
      lastErrorMs: upd.errorMs,
      error: null,
      recognitions,
    });
    this.schedule(d.nextDelayMs);
  }

  private update(p: Partial<SyncSnapshot>) {
    this.snap = { ...this.snap, ...p };
    this.deps.onChange?.(this.snap);
  }
}
