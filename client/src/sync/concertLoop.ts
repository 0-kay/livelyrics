import {
  CONCERT_CONFIG,
  ReanchorPolicy,
  type ReanchorAction,
  type TrackMatch,
  type TranscribeResponse,
} from '@livelyrics/shared';
import type { SessionClip, SyncSession } from './syncSession.js';

export interface TranscribeContext {
  track: TrackMatch;
  /** Clock position at the end of the clip (ms). */
  positionMs: number;
}

export interface ConcertLoopDeps {
  session: SyncSession;
  /** Most recent chunk of chunkSeconds, or null if the buffer is not ready. */
  getClip: () => SessionClip | null;
  transcribe: (clip: Blob, ctx: TranscribeContext) => Promise<TranscribeResponse>;
  now?: () => number;
  setTimer?: (fn: () => void, ms: number) => unknown;
  clearTimer?: (handle: unknown) => void;
  onChange?: (s: ConcertSnapshot) => void;
  intervalMs?: number;
}

export interface ConcertSnapshot {
  running: boolean;
  /** Last transcript heard. */
  lastText: string;
  lastScore: number | null;
  lastAction: ReanchorAction | 'error' | 'skipped' | null;
  lastErrorMs: number;
  reanchors: number;
}

/**
 * Concert mode (experimental): every few seconds, transcribe the latest chunk,
 * match it against the lyrics near the clock position on the server, and move
 * the clock only when the ReanchorPolicy accepts the match.
 */
export class ConcertLoop {
  private readonly policy = new ReanchorPolicy();
  private readonly now: () => number;
  private readonly setTimer: (fn: () => void, ms: number) => unknown;
  private readonly clearTimer: (handle: unknown) => void;
  private readonly intervalMs: number;
  private timer: unknown = null;
  private generation = 0;
  private snap: ConcertSnapshot = { running: false, lastText: '', lastScore: null, lastAction: null, lastErrorMs: 0, reanchors: 0 };
  private trackKey: string | null = null;

  constructor(private readonly deps: ConcertLoopDeps) {
    this.now = deps.now ?? (() => performance.now());
    this.setTimer = deps.setTimer ?? ((fn, ms) => setTimeout(fn, ms));
    this.clearTimer = deps.clearTimer ?? ((h) => clearTimeout(h as ReturnType<typeof setTimeout>));
    this.intervalMs = deps.intervalMs ?? CONCERT_CONFIG.intervalMs;
  }

  get snapshot(): ConcertSnapshot {
    return this.snap;
  }

  start(): void {
    if (this.snap.running) return;
    this.generation++;
    this.policy.reset();
    this.trackKey = null;
    this.update({ running: true, lastText: '', lastScore: null, lastAction: null, lastErrorMs: 0, reanchors: 0 });
    this.schedule(this.intervalMs);
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
    const { session } = this.deps;
    const track = session.snapshot.track;
    const lyrics = session.snapshot.lyrics;
    const clip = track && lyrics && !lyrics.instrumental && session.clock.isAnchored ? this.deps.getClip() : null;
    if (!track || !clip) {
      this.update({ lastAction: 'skipped' });
      this.schedule(this.intervalMs);
      return;
    }
    const key = `${track.artist}|${track.title}`;
    if (key !== this.trackKey) {
      this.trackKey = key;
      this.policy.reset();
    }

    const positionMs = session.clock.targetAt(clip.capturedAtMs);
    let res: TranscribeResponse;
    try {
      res = await this.deps.transcribe(clip.blob, { track, positionMs });
    } catch {
      if (gen !== this.generation) return;
      this.update({ lastAction: 'error' });
      this.schedule(this.intervalMs);
      return;
    }
    if (gen !== this.generation) return;
    // The song may have changed or the clock reset while we waited.
    const current = session.snapshot.track;
    if (!current || `${current.artist}|${current.title}` !== key || !session.clock.isAnchored) {
      this.update({ lastAction: 'skipped' });
      this.schedule(this.intervalMs);
      return;
    }

    const d = this.policy.decide({
      match: res.match,
      clockPosMs: session.clock.targetAt(clip.capturedAtMs),
      wallMs: clip.capturedAtMs,
      rate: session.clock.rate,
    });
    let reanchors = this.snap.reanchors;
    if (d.action === 'reanchor' && res.match) {
      session.clock.reanchor({ wallMs: clip.capturedAtMs, songPosMs: res.match.positionMs }, this.now());
      reanchors++;
    }
    this.update({ lastText: res.text, lastScore: res.match?.score ?? null, lastAction: d.action, lastErrorMs: d.errorMs, reanchors });
    this.schedule(this.intervalMs);
  }

  private update(p: Partial<ConcertSnapshot>) {
    this.snap = { ...this.snap, ...p };
    this.deps.onChange?.(this.snap);
  }
}
