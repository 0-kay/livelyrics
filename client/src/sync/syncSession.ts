import {
  AdaptivePlaybackClock,
  BpmCrossCheck,
  type BpmCheckStatus,
  RecognitionScheduler,
  SCHEDULER_CONFIG,
  CAPTURE_CONFIG,
  TRIGGER_CONFIG,
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
  /** Most recent `seconds` of audio (default clip length when omitted), or null if not buffered yet. */
  getClip: (seconds?: number) => SessionClip | null;
  identify: (clip: Blob) => Promise<IdentifyResponse>;
  now?: () => number;
  setTimer?: (fn: () => void, ms: number) => unknown;
  clearTimer?: (handle: unknown) => void;
  onChange?: (s: SyncSnapshot) => void;
  latencyCompMs?: number;
  /**
   * How long after a trigger (song end, gap in the audio) to wait before
   * recognizing, so the clip holds only the new audio. Default: clip length
   * plus a small margin.
   */
  settleMs?: number;
  /** Override the recognition scheduler (tests use this to make regular checks rare). */
  scheduler?: RecognitionScheduler;
  /** Clip length for the first check and for checks after a suspected change (s). */
  quickClipSeconds?: number;
  /** Seconds of audio buffered right now, so a searching clip can grow up to it. */
  bufferedSeconds?: () => number;
}

/** Returning to the song we just left within this long needs two answers in a row (ms). */
const FLIP_BACK_GUARD_MS = 20_000;

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
  /**
   * The local rhythm tracker heard a different song. The screen can move on
   * right away; the next recognition confirms (new song) or clears it (same song).
   */
  changeSuspected: boolean;
}

/** Wait this long when the mic buffer is not full yet (ms). */
const BUFFER_WAIT_MS = CAPTURE_CONFIG.bufferWaitMs;

const trackKey = (t: TrackMatch) => `${t.artist.trim().toLowerCase()}|${t.title.trim().toLowerCase()}`;

/**
 * Re-recognition loop: grabs a clip from the rolling mic buffer, identifies it,
 * feeds the result into the adaptive clock, and lets the scheduler decide when
 * to try again (fast until locked, then every 20-30s).
 */
export class SyncSession {
  readonly clock: AdaptivePlaybackClock;
  private readonly scheduler: RecognitionScheduler;
  private readonly now: () => number;
  private readonly setTimer: (fn: () => void, ms: number) => unknown;
  private readonly clearTimer: (handle: unknown) => void;
  private timer: unknown = null;
  private nextAt = 0;
  private inflight = false;
  private soonMs: number | null = null;
  private readonly settleMs: number;
  private readonly quickClipSeconds: number;
  /** Use the short clip for the next check (first check, suspected change). */
  private quickNext = true;
  /** "No match" answers in a row while no song is on; each one grows the next clip. */
  private searchMisses = 0;
  /** When the last song was lost; a searching clip never reaches back before it (old song audio). */
  private lostAtMs: number | null = null;
  /** Song we switched away from, and when, for the flip-back guard. */
  private previous: { key: string; at: number } | null = null;
  private pendingBack: string | null = null;
  private generation = 0;
  private readonly bpmCheck = new BpmCrossCheck();
  private bpmKey: string | null = null;
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
    changeSuspected: false,
  };

  constructor(private readonly deps: SyncSessionDeps) {
    this.scheduler = deps.scheduler ?? new RecognitionScheduler();
    this.clock = new AdaptivePlaybackClock({ latencyCompMs: deps.latencyCompMs });
    this.now = deps.now ?? (() => performance.now());
    this.setTimer = deps.setTimer ?? ((fn, ms) => setTimeout(fn, ms));
    this.clearTimer = deps.clearTimer ?? ((h) => clearTimeout(h as ReturnType<typeof setTimeout>));
    this.settleMs = deps.settleMs ?? CAPTURE_CONFIG.clipSeconds * 1000 + TRIGGER_CONFIG.settleMarginMs;
    this.quickClipSeconds = deps.quickClipSeconds ?? CAPTURE_CONFIG.quickClipSeconds;
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
    this.inflight = false;
    this.soonMs = null;
    this.quickNext = true;
    this.searchMisses = 0;
    this.lostAtMs = null;
    this.previous = null;
    this.pendingBack = null;
    this.scheduler.reset();
    this.clock.reset();
    this.update({ running: true, state: 'searching', track: null, lyrics: null, error: null, lastAction: null, recognitions: 0, changeSuspected: false });
    this.schedule(this.scheduler.initialDelayMs());
  }

  stop(): void {
    this.generation++;
    this.inflight = false;
    this.soonMs = null;
    if (this.timer !== null) this.clearTimer(this.timer);
    this.timer = null;
    this.update({ running: false, changeSuspected: false });
  }

  /**
   * The rhythm on the mic no longer fits the song (decided locally, no
   * network). Flag it for the screen and recognize as soon as the clip holds
   * mostly new audio. `newAudioMs` is how long the new rhythm has already played.
   */
  suspectSongChange(newAudioMs: number = 3_000): void {
    if (!this.snap.running || !this.snap.track || this.snap.changeSuspected) return;
    this.update({ changeSuspected: true });
    // A short clip holds mostly new audio sooner.
    this.quickNext = true;
    const quickSettle = this.quickClipSeconds * 1000 + TRIGGER_CONFIG.settleMarginMs;
    this.recheckSoon(Math.max(TRIGGER_CONFIG.minEndRecheckMs, quickSettle - newAudioMs));
  }

  /**
   * BPM cross-check: feed the locally tracked tempo of the song on the mic
   * (null when there is no clear beat). If it implies a playback rate that
   * disagrees with the clock for a few seconds (a DJ moved the pitch fader),
   * a recognition is pulled forward so the rate catches up. The clock itself
   * only ever moves on recognition results.
   */
  checkTempo(bpm: number | null): BpmCheckStatus {
    const t = this.snap.track;
    if (!this.snap.running || !t || this.snap.changeSuspected) {
      if (!t) {
        this.bpmCheck.reset();
        this.bpmKey = null;
      }
      return 'idle';
    }
    const key = trackKey(t);
    if (key !== this.bpmKey) {
      this.bpmCheck.reset();
      this.bpmKey = key;
    }
    const r = this.bpmCheck.update({ nowMs: this.now(), bpm, clockRate: this.snap.rate, locked: this.snap.state === 'locked' });
    // The new rate has been playing for the hold time already, so any fresh clip shows it.
    if (r.status === 'recheck') this.recheckSoon(TRIGGER_CONFIG.minEndRecheckMs);
    return r.status;
  }

  /**
   * Ask for a recognition sooner than the timer would give one, for example
   * after a gap in the audio. Never delays a check that is already due earlier.
   */
  recheckSoon(ms: number = this.settleMs, quickClip = false): void {
    if (!this.snap.running) return;
    if (quickClip) this.quickNext = true;
    if (this.inflight) {
      this.soonMs = Math.min(this.soonMs ?? Infinity, ms);
      return;
    }
    if (this.timer !== null && this.nextAt - this.now() <= ms) return;
    if (this.timer !== null) this.clearTimer(this.timer);
    this.timer = null;
    this.schedule(ms);
  }

  private schedule(ms: number) {
    const gen = this.generation;
    let wait = ms;
    if (this.soonMs !== null) {
      wait = Math.min(wait, this.soonMs);
      this.soonMs = null;
    }
    this.nextAt = this.now() + wait;
    this.timer = this.setTimer(() => {
      this.timer = null;
      if (gen === this.generation) void this.tick(gen);
    }, wait);
  }

  /** Wall ms until the matched track should end at the current rate, or null if unknown. */
  private msUntilEnd(match: TrackMatch, rate: number): number | null {
    const pos = this.clock.positionAt(this.now());
    if (pos === null || !(match.durationMs > 0)) return null;
    return Math.max(0, (match.durationMs - pos) / Math.max(rate, 0.1));
  }

  /**
   * Clip length for the next check: the short quick clip when asked for; while
   * searching, longer after every miss (up to what is buffered); otherwise the
   * routine length.
   */
  clipSeconds(): number | undefined {
    if (this.quickNext) return this.quickClipSeconds;
    if (this.snap.track) return undefined;
    let want = Math.min(CAPTURE_CONFIG.maxClipSeconds, this.quickClipSeconds + CAPTURE_CONFIG.searchClipStepSeconds * this.searchMisses);
    // After losing a song, only grow over audio heard since then, or the old song is found again.
    if (this.lostAtMs !== null) want = Math.min(want, (this.now() - this.lostAtMs) / 1000);
    const buffered = this.deps.bufferedSeconds?.();
    if (buffered !== undefined) want = Math.min(want, Math.floor(buffered * 10) / 10);
    return Math.max(this.quickClipSeconds, want);
  }

  private async tick(gen: number): Promise<void> {
    const clip = this.deps.getClip(this.clipSeconds());
    if (!clip) {
      this.schedule(BUFFER_WAIT_MS);
      return;
    }
    this.quickNext = false;
    const sentAt = this.now();
    let res: IdentifyResponse;
    this.inflight = true;
    try {
      res = await this.deps.identify(clip.blob);
    } catch (e) {
      if (gen === this.generation) this.inflight = false;
      if (gen !== this.generation) return;
      // Network or server trouble: keep the clock running and retry later.
      this.update({ error: e instanceof Error ? e.message : String(e), lastAction: 'error' });
      this.schedule(SCHEDULER_CONFIG.retryIntervalMs);
      return;
    }
    if (gen !== this.generation) return;
    this.inflight = false;
    const responseAt = this.now();
    const recognitions = this.snap.recognitions + 1;

    if (!res.match) {
      if (!this.snap.track) this.searchMisses++;
      const d = this.scheduler.onResult({ matched: false });
      if (d.lostLock) {
        this.searchMisses = 0;
        this.lostAtMs = responseAt;
        this.clock.reset();
        this.update({ track: null, lyrics: null, lyricsTimeScale: 1, rate: 1, changeSuspected: false });
      }
      this.update({ state: d.state, lastAction: 'miss', error: null, recognitions });
      this.schedule(d.nextDelayMs);
      return;
    }

    this.searchMisses = 0;
    this.lostAtMs = null;
    const newKey = trackKey(res.match);
    const songChanged = !this.snap.track || trackKey(this.snap.track) !== newKey;
    // During a DJ crossfade answers can alternate between two songs. Going back to the song we
    // just left needs a second answer in a row, so the screen does not flip back and forth.
    if (songChanged && this.previous && this.previous.key === newKey && responseAt - this.previous.at < FLIP_BACK_GUARD_MS && this.pendingBack !== newKey) {
      this.pendingBack = newKey;
      this.update({ recognitions, lastAction: 'miss', error: null });
      this.schedule(SCHEDULER_CONFIG.searchIntervalMs);
      return;
    }
    this.pendingBack = null;
    if (songChanged) {
      if (this.snap.track) this.previous = { key: trackKey(this.snap.track), at: responseAt };
      this.clock.reset();
    }
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
      errorMs: upd.errorMs,
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
      changeSuspected: false,
    });
    // The song should be over by now: check again once the buffer holds only
    // new audio, instead of waiting out the 20-30s timer.
    let next = d.nextDelayMs;
    const endIn = this.msUntilEnd(res.match, upd.rate);
    if (endIn !== null) next = Math.min(next, Math.max(endIn + this.settleMs, TRIGGER_CONFIG.minEndRecheckMs));
    this.schedule(next);
  }

  private update(p: Partial<SyncSnapshot>) {
    this.snap = { ...this.snap, ...p };
    this.deps.onChange?.(this.snap);
  }
}
