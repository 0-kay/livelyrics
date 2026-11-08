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

/**
 * Deterministic recognition mock. Any clip of at least MOCK_MIN_AUDIO_BYTES
 * matches the fixture song. playOffsetMs is derived from a hash of the audio so
 * repeated identical clips give identical answers, unless a fixed offset is set.
 */
export class MockRecognitionProvider implements RecognitionProvider {
  constructor(private readonly fixedOffsetMs?: number) {}

  async identify(audio: Buffer, _mime: string): Promise<TrackMatch | null> {
    if (audio.length < MOCK_MIN_AUDIO_BYTES) return null;
    const playOffsetMs =
      this.fixedOffsetMs ?? 10_000 + (createHash('sha1').update(audio).digest().readUInt32BE(0) % 60_000);
    return { ...MOCK_TRACK, playOffsetMs };
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
