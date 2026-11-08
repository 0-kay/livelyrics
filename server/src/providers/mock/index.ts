import { createHash } from 'node:crypto';
import {
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
    if (vp) {
      const now = (vp.now ?? Date.now)();
      const pos = (vp.startOffsetMs ?? 10_000) + (now - vp.startedAtMs) * vp.rate;
      return Math.round(((pos % MOCK_TRACK.durationMs) + MOCK_TRACK.durationMs) % MOCK_TRACK.durationMs);
    }
    return 10_000 + (createHash('sha1').update(audio).digest().readUInt32BE(0) % 60_000);
  }
}

export class MockLyricsProvider implements LyricsProvider {
  async getSynced(q: LyricsQuery): Promise<SyncedLyrics | null> {
    const norm = (s: string) => s.trim().toLowerCase();
    if (norm(q.title) !== norm(MOCK_TRACK.title) || norm(q.artist) !== norm(MOCK_TRACK.artist)) {
      return null;
    }
    return { lines: parseLrc(MOCK_LRC).lines, instrumental: false, durationMs: MOCK_TRACK.durationMs };
  }
}

export class MockTranscriptionProvider implements TranscriptionProvider {
  async transcribe(audio: Buffer, _mime: string): Promise<string> {
    return audio.length < MOCK_MIN_AUDIO_BYTES ? '' : MOCK_TRANSCRIPT;
  }
}
