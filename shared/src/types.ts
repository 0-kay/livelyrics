/** A track returned by a recognition provider. */
export interface TrackMatch {
  title: string;
  artist: string;
  album?: string;
  durationMs: number;
  /** Position in the track (ms) at the end of the submitted audio clip. */
  playOffsetMs: number;
  isrc?: string;
  /** Provider confidence, 0-100. */
  score: number;
}

export interface LyricLine {
  startMs: number;
  text: string;
}

export interface SyncedLyrics {
  lines: LyricLine[];
  instrumental: boolean;
  /** Duration of the lyrics source track in ms, when the provider knows it. */
  durationMs?: number;
}

export interface LyricsQuery {
  title: string;
  artist: string;
  album?: string;
  durationMs?: number;
}

export interface RecognitionProvider {
  identify(audio: Buffer, mime: string): Promise<TrackMatch | null>;
}

export interface LyricsProvider {
  getSynced(q: LyricsQuery): Promise<SyncedLyrics | null>;
}

export interface TranscriptionProvider {
  transcribe(audio: Buffer, mime: string): Promise<string>;
}

export type ProviderMode = 'mock' | 'real';

/** Response body of POST /api/identify. */
export interface IdentifyResponse {
  match: TrackMatch | null;
  lyrics: SyncedLyrics | null;
  /** Server processing time in ms, useful for latency compensation. */
  processingMs: number;
  /** True when lyrics came from the cache. */
  lyricsCached: boolean;
  /**
   * Factor already applied to lyric timestamps because the matched track and
   * the lyrics source differ in duration (slowed or sped versions). 1 means unscaled.
   */
  lyricsTimeScale: number;
}

export interface HealthResponse {
  ok: true;
  mode: ProviderMode;
}
