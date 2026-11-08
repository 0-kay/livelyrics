import { createHash } from 'node:crypto';
import {
  findLineIndex,
  parseLrc,
  type LyricsProvider,
  type LyricsQuery,
  type RecognitionProvider,
  type SyncedLyrics,
  type TrackMatch,
  type TranscriptionProvider,
} from '@livelyrics/shared';
import { MOCK_LRC, MOCK_TRACK, MOCK_TRANSCRIPT } from '../../fixtures/mockSong.js';

/** Clips shorter than this are treated as "no match" by the mock. */
export const MOCK_MIN_AUDIO_BYTES = 1024;

export interface MockVirtualPlayback {
  /** Wall time (ms, same clock as now()) when the virtual song was at startOffsetMs. */
  startedAtMs: number;
  /** Playback rate of the virtual song. 1 is normal speed. */
  rate: number;
  /** Song position at startedAtMs. Default 10000. */
  startOffsetMs?: number;
  now?: () => number;
}

export interface MockRecognitionOptions {
  /** Always return this offset. */
  fixedOffsetMs?: number;
  /**
   * Pretend the fixture song is playing on a loop at a given rate, so repeated
   * recognitions return consistent, advancing offsets (used by mock mode).
   */
  virtualPlayback?: MockVirtualPlayback;
}

/**
 * Deterministic recognition mock. Any clip of at least MOCK_MIN_AUDIO_BYTES
 * matches the fixture song. By default playOffsetMs is derived from a hash of
 * the audio so identical clips give identical answers. A fixed offset or a
 * virtual playback timeline can be configured instead.
 */
export class MockRecognitionProvider implements RecognitionProvider {
  private readonly opts: MockRecognitionOptions;

  constructor(opts: number | MockRecognitionOptions = {}) {
    this.opts = typeof opts === 'number' ? { fixedOffsetMs: opts } : opts;
  }

  async identify(audio: Buffer, _mime: string): Promise<TrackMatch | null> {
    if (audio.length < MOCK_MIN_AUDIO_BYTES) return null;
    return { ...MOCK_TRACK, playOffsetMs: this.offsetFor(audio) };
  }

  private offsetFor(audio: Buffer): number {
    const { fixedOffsetMs, virtualPlayback: vp } = this.opts;
    if (fixedOffsetMs !== undefined) return fixedOffsetMs;
    if (vp) return virtualPositionMs(vp);
    return 10_000 + (createHash('sha1').update(audio).digest().readUInt32BE(0) % 60_000);
  }
}

/** Current position of the virtual fixture song, wrapped to the track length. */
export function virtualPositionMs(vp: MockVirtualPlayback): number {
  const now = (vp.now ?? Date.now)();
  const pos = (vp.startOffsetMs ?? 10_000) + (now - vp.startedAtMs) * vp.rate;
  return Math.round(((pos % MOCK_TRACK.durationMs) + MOCK_TRACK.durationMs) % MOCK_TRACK.durationMs);
}

/**
 * Words of the fixture lyrics "sung" in the last chunk ending at positionMs:
 * the tail of the previous line (if it started recently) plus the part of the
 * current line sung so far. Empty during gaps between lines.
 */
export function mockSungWords(positionMs: number, chunkMs = 5_000): string {
  const lines = MOCK_LINES;
  const i = findLineIndex(lines, positionMs);
  if (i < 0 || !lines[i].text) return '';
  const nextStart = i + 1 < lines.length ? lines[i + 1].startMs : lines[i].startMs + 4_000;
  const frac = Math.min(1, (positionMs - lines[i].startMs) / Math.max(1, nextStart - lines[i].startMs));
  const words = lines[i].text.split(/\s+/);
  const current = words.slice(0, Math.max(1, Math.ceil(words.length * frac)));
  const prev = i > 0 ? lines[i - 1] : null;
  const prevWords = prev && prev.text && prev.startMs >= positionMs - chunkMs * 2 ? prev.text.split(/\s+/).slice(-3) : [];
  return [...prevWords, ...current].join(' ');
}

const MOCK_LINES = parseLrc(MOCK_LRC).lines;

export class MockLyricsProvider implements LyricsProvider {
  async getSynced(q: LyricsQuery): Promise<SyncedLyrics | null> {
    const norm = (s: string) => s.trim().toLowerCase();
    if (norm(q.title) !== norm(MOCK_TRACK.title) || norm(q.artist) !== norm(MOCK_TRACK.artist)) {
      return null;
    }
    return { lines: parseLrc(MOCK_LRC).lines, instrumental: false, durationMs: MOCK_TRACK.durationMs };
  }
}

export interface MockTranscriptionOptions {
  /** Follow the virtual song and return the fixture words sung most recently. */
  virtualPlayback?: MockVirtualPlayback;
}

/**
 * Deterministic transcription mock. Returns MOCK_TRANSCRIPT, or with a
 * virtual playback timeline, the fixture words at the current virtual position.
 */
export class MockTranscriptionProvider implements TranscriptionProvider {
  constructor(private readonly opts: MockTranscriptionOptions = {}) {}

  async transcribe(audio: Buffer, _mime: string): Promise<string> {
    if (audio.length < MOCK_MIN_AUDIO_BYTES) return '';
    const vp = this.opts.virtualPlayback;
    return vp ? mockSungWords(virtualPositionMs(vp)) : MOCK_TRANSCRIPT;
  }
}
