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
  /** The most recent `seconds` of audio, or null if that much is not buffered yet. */
  getClip: (seconds: number) => SessionClip | null;
  identify: (clip: Blob) => Promise<IdentifyResponse>;
  now?: () => number;
  setTimer?: (fn: () => void, ms: number) => unknown;
  clearTimer?: (handle: unknown) => void;
  onChange?: (s: SyncSnapshot) => void;
  latencyCompMs?: number;
  /** Override the recognition scheduler (tests use this to make regular checks rare). */
  scheduler?: RecognitionScheduler;
  /** Seconds of audio buffered right now; clips never ask for more. Omit to assume enough. */
  bufferedSeconds?: () => number;
  /** Routine clip length while a song is on (s). Default CAPTURE_CONFIG.clipSeconds (the ?clip= override). */
  routineClipSeconds?: number;
  /** Quick and long clip lengths for finding a song (s). Defaults from CAPTURE_CONFIG. */
  quickClipSeconds?: number;
  longClipSeconds?: number;
}

/** Returning to the song we just left within this long needs two answers in a row (ms). */
const FLIP_BACK_GUARD_MS = 20_000;
/** Two change reports this close together are the same change (ms). */
const SAME_CHANGE_MS = 6_000;

export interface ClipStat {
  sent: number;
  matched: number;
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
  /**
   * A local detector (rhythm, sound signature, gap, song end) reported a
   * change and the session is identifying audio since that point. The screen
   * does not change on this alone; it follows the server's answer.
   */
  changeSuspected: boolean;
  /** Recognitions sent and matched per clip length (whole seconds), for tuning. */
  clipStats: Record<number, ClipStat>;
}

/** Wait this long when the mic buffer is not full yet (ms). */
const BUFFER_WAIT_MS = CAPTURE_CONFIG.bufferWaitMs;

const trackKey = (t: TrackMatch) => `${t.artist.trim().toLowerCase()}|${t.title.trim().toLowerCase()}`;

/**
 * Re-recognition loop: cuts a clip from the rolling mic buffer, identifies it,
 * feeds the result into the adaptive clock, and lets the scheduler decide when
 * to try again.
 *
 * Clips: every clip is cut from audio after a boundary (Listen, a detected
 * change point, a lost song), so a clip meant to find a new song never holds
 * the old one. Finding a song sends a quick clip once, then long clips; while
 * a song is on, routine checks send the routine length. A miss on a short clip
 * is weak evidence and never counts toward losing the song.
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
  private generation = 0;
  private readonly routineSec: number;
  private readonly quickSec: number;
  private readonly longSec: number;
  /** Audio before this wall time is not used for the current job. -Infinity: all buffered audio. */
  private boundaryMs = -Infinity;
  /** Tries since the boundary while finding a song (the first one may be quick). */
  private findTries = 0;
  /** Change point being identified, or null. */
  private changeAt: number | null = null;
  /** Predicted end of the current song (wall ms), or null. */
  private endAt: number | null = null;
  /** Song we switched away from, and when, for the flip-back guard. */
  private previous: { key: string; at: number } | null = null;
  private pendingBack: string | null = null;
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
    clipStats: {},
  };

  constructor(private readonly deps: SyncSessionDeps) {
    this.scheduler = deps.scheduler ?? new RecognitionScheduler();
    this.clock = new AdaptivePlaybackClock({ latencyCompMs: deps.latencyCompMs });
    this.now = deps.now ?? (() => performance.now());
    this.setTimer = deps.setTimer ?? ((fn, ms) => setTimeout(fn, ms));
    this.clearTimer = deps.clearTimer ?? ((h) => clearTimeout(h as ReturnType<typeof setTimeout>));
    this.routineSec = deps.routineClipSeconds ?? CAPTURE_CONFIG.clipSeconds;
    this.quickSec = deps.quickClipSeconds ?? CAPTURE_CONFIG.quickClipSeconds;
    this.longSec = deps.longClipSeconds ?? CAPTURE_CONFIG.longClipSeconds;
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
    this.boundaryMs = this.deps.bufferedSeconds ? -Infinity : this.now();
    this.findTries = 0;
    this.changeAt = null;
    this.endAt = null;
    this.previous = null;
    this.pendingBack = null;
    this.scheduler.reset();
    this.clock.reset();
    this.update({ running: true, state: 'searching', track: null, lyrics: null, error: null, lastAction: null, recognitions: 0, changeSuspected: false, clipStats: {} });
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
   * A local detector (rhythm, sound signature, gap in the audio, song end)
   * says a new song may have started at `atMs` (wall time, same clock as now).
   * Identify audio from that point only: a quick clip as soon as it exists,
   * then long clips. The screen keeps the current song until a check names
   * another one, so a false alarm costs a request and nothing visible.
   */
  changeDetected(atMs: number): void {
    if (!this.snap.running) return;
    const at = Math.min(atMs, this.now());
    if (this.changeAt !== null && Math.abs(at - this.changeAt) < SAME_CHANGE_MS) {
      // Another detector saw the same change: trust the later estimate (surely new audio).
      this.boundaryMs = Math.max(this.boundaryMs, at);
      return;
    }
    if (!this.snap.track && at <= this.boundaryMs) return; // already searching over newer audio
    this.changeAt = at;
    this.boundaryMs = at;
    this.findTries = 0;
    if (this.snap.track) this.update({ changeSuspected: true });
    this.recheckSoon(Math.max(0, at + this.quickSec * 1000 - this.now()));
  }

  /** Same as changeDetected, given how long the new audio has already played (ms). */
  suspectSongChange(newAudioMs: number = 3_000): void {
    if (!this.snap.track) return;
    this.changeDetected(this.now() - newAudioMs);
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
   * Ask for a recognition sooner than the timer would give one. Never delays a
   * check that is already due earlier.
   */
  recheckSoon(ms: number): void {
    if (!this.snap.running) return;
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

  /** True while looking for a song: nothing on, or a change point is being identified. */
  private get finding(): boolean {
    return !this.snap.track || this.changeAt !== null;
  }

  /**
   * Length of the next clip, or how long to wait until enough audio after the
   * boundary exists. Finding: quick once, then long (up to what is there,
   * at most maxClipSeconds). Routine: the routine length, cut at the boundary.
   */
  planClip(): { seconds: number } | { waitMs: number } {
    const since = (this.now() - this.boundaryMs) / 1000;
    const buffered = this.deps.bufferedSeconds?.() ?? Infinity;
    const avail = Math.floor(Math.min(since, buffered) * 10) / 10;
    let need: number;
    let seconds: number;
    if (this.finding) {
      // Skip the quick try when a long clip is already available.
      const quick = this.findTries === 0 && avail < this.longSec;
      need = quick ? this.quickSec : this.longSec;
      seconds = quick ? this.quickSec : Math.min(CAPTURE_CONFIG.maxClipSeconds, Math.max(this.longSec, avail));
    } else {
      need = this.quickSec;
      seconds = Math.min(this.routineSec, avail);
    }
    if (avail + 1e-6 < need) {
      const shortBy = need - Math.min(since, buffered);
      return { waitMs: Math.max(BUFFER_WAIT_MS, Math.ceil(shortBy * 1000) + 50) };
    }
    return { seconds: Math.min(seconds, avail) };
  }

  /** Back-compat for tests: the next clip length, or undefined while waiting. */
  clipSeconds(): number | undefined {
    const p = this.planClip();
    return 'seconds' in p ? p.seconds : undefined;
  }

  private async tick(gen: number): Promise<void> {
    const t = this.now();
    // The song should be over: identify audio from its predicted end.
    if (this.endAt !== null && t >= this.endAt - 50 && this.changeAt === null && this.snap.track) {
      const at = this.endAt;
      this.endAt = null;
      this.changeAt = at;
      this.boundaryMs = Math.max(this.boundaryMs, at);
      this.findTries = 0;
    }
    // A change-point search that found nothing stops being special (its boundary stays).
    if (this.changeAt !== null && t - this.changeAt > TRIGGER_CONFIG.changeSearchMs) {
      this.changeAt = null;
      if (this.snap.changeSuspected) this.update({ changeSuspected: false });
    }

    const plan = this.planClip();
    if ('waitMs' in plan) {
      this.schedule(plan.waitMs);
      return;
    }
    const clip = this.deps.getClip(plan.seconds);
    if (!clip) {
      this.schedule(BUFFER_WAIT_MS);
      return;
    }
    const clipSec = plan.seconds;
    const wasFinding = this.finding;
    if (wasFinding) this.findTries++;
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
    const statKey = Math.round(clipSec);
    const prevStat = this.snap.clipStats[statKey] ?? { sent: 0, matched: 0 };
    const clipStats = { ...this.snap.clipStats, [statKey]: { sent: prevStat.sent + 1, matched: prevStat.matched + (res.match ? 1 : 0) } };

    if (!res.match) {
      const weak = clipSec < CAPTURE_CONFIG.weakMissBelowSeconds;
      const d = this.scheduler.onResult({ matched: false, weak });
      if (d.lostLock) {
        // Several long clips in a row found nothing: the song is gone. Look again from recent audio.
        this.clock.reset();
        this.changeAt = null;
        this.endAt = null;
        this.boundaryMs = Math.max(this.boundaryMs, responseAt - (this.longSec - this.quickSec) * 1000);
        this.findTries = 0;
        this.update({ track: null, lyrics: null, lyricsTimeScale: 1, rate: 1, changeSuspected: false });
      }
      this.update({ state: d.state, lastAction: 'miss', error: null, recognitions, clipStats });
      this.schedule(d.nextDelayMs);
      return;
    }

    const newKey = trackKey(res.match);
    const songChanged = !this.snap.track || trackKey(this.snap.track) !== newKey;
    // During a DJ crossfade answers can alternate between two songs. Going back to the song we
    // just left needs a second answer in a row, so the screen does not flip back and forth.
    if (songChanged && this.previous && this.previous.key === newKey && responseAt - this.previous.at < FLIP_BACK_GUARD_MS && this.pendingBack !== newKey) {
      this.pendingBack = newKey;
      this.update({ recognitions, lastAction: 'miss', error: null, clipStats });
      this.schedule(SCHEDULER_CONFIG.searchIntervalMs);
      return;
    }
    this.pendingBack = null;
    if (songChanged) {
      if (this.snap.track) {
        this.previous = { key: trackKey(this.snap.track), at: responseAt };
        // Found by a routine check (no change point): the new song started somewhere in that clip.
        if (this.changeAt === null) this.boundaryMs = Math.max(this.boundaryMs, clip.capturedAtMs - (clipSec * 1000) / 2);
      }
      this.clock.reset();
    } else if (this.changeAt !== null) {
      // False alarm: still the same song, so all buffered audio is usable again.
      this.boundaryMs = -Infinity;
    }
    this.changeAt = null;
    this.findTries = 0;

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
      clipStats,
    });
    // Know when the song should end, so the next song is looked for from that moment.
    let next = d.nextDelayMs;
    const endIn = this.msUntilEnd(res.match, upd.rate);
    this.endAt = endIn === null ? null : responseAt + endIn;
    if (endIn !== null) next = Math.min(next, Math.max(endIn, TRIGGER_CONFIG.minEndRecheckMs));
    this.schedule(next);
  }

  private update(p: Partial<SyncSnapshot>) {
    this.snap = { ...this.snap, ...p };
    this.deps.onChange?.(this.snap);
  }
}
