# LiveLyrics: Spec

A web app that listens to music through the mic, identifies the song, finds the current position, and shows synced lyrics that adapt when the playback is sped up, slowed down, or performed live.

## Goals
1. Identify a song from ~8-10s of mic audio and return track metadata plus play offset.
2. Fetch time-synced lyrics (LRC) and highlight the current line in real time.
3. Estimate playback rate (DJ speed changes, slowed/sped edits) and adjust the lyric clock.
4. Concert mode (experimental): match transcribed sung words against lyrics to re-anchor position.

## Non-goals (for now)
- Native mobile apps, accounts, payments, public licensing. LRCLIB is for personal use only. Musixmatch would be required for a public product.

## Stack
- Client: React + TypeScript PWA (Vite), Web Audio API for mic capture.
- Server: Node + TypeScript (Fastify). Deployable to Google Cloud Run.
- Cache: in-memory LRU by default, Redis or Firestore behind an interface.
- Tests: Vitest. Synthetic audio harness for rate estimation.

## Provider interfaces (IMPORTANT: everything external goes behind these)
```ts
interface RecognitionProvider {
  identify(audio: Buffer, mime: string): Promise<{
    title: string; artist: string; album?: string;
    durationMs: number; playOffsetMs: number; isrc?: string; score: number;
  } | null>;
}
interface LyricsProvider {
  getSynced(q: { title: string; artist: string; album?: string; durationMs?: number }):
    Promise<{ lines: { startMs: number; text: string }[]; instrumental: boolean } | null>;
}
interface TranscriptionProvider {
  transcribe(audio: Buffer, mime: string): Promise<string>;
}
```
Each has a Mock implementation (deterministic fixtures) and a Real implementation:
- ACRCloud (recognition), LRCLIB (lyrics), OpenAI Whisper API (transcription).
- Selected by env var `PROVIDER_MODE=mock|real`. Mock mode must work with zero keys.

## Playback clock
```
songPositionMs = anchorOffsetMs + (now - anchorWallMs) * rate + latencyCompMs
```
- Each recognition result adds a sample (wallMs, songPosMs) after subtracting measured round-trip latency.
- `rate` comes from a rolling linear regression over the last N samples, clamped to [0.7, 1.4], smoothed with an EMA.
- Disagreement with the clock > 1500ms: snap and animate scroll. Smaller: nudge gradually.
- Current line found by binary search on `startMs`.
- Once locked on, keep a steady re-check every 3 to 3.5s (changed from 20-30s on 2026-11-09 for faster song switches and a steadier clock; see README, How syncing works).

## Slowed/sped versions
If the matched track duration differs from the LRCLIB entry duration, scale timestamps by `matchedDuration / lyricsDuration`.

## Concert mode
Transcribe 5s chunks, fuzzy-match (rapidfuzz-style, fuse.js acceptable) against lyric lines within a window around the current position, re-anchor on confident matches only. Treat as experimental and keep it behind a feature flag.

## API surface (server)
- `POST /api/identify` (multipart audio) returns match plus lyrics.
- `POST /api/transcribe` (multipart audio) returns text plus best line match.
- `GET /api/health`.

## Testing rules
- Every milestone must have passing tests before commit.
- Rate estimation is verified with synthetic samples at 0.8x, 0.9x, 1.0x, 1.1x, 1.25x and noisy input.
- Never require real API keys to run the test suite.

## Constraints
- Do not commit secrets. Read keys from env only (see .env.example).
- Keep dependencies minimal and common.
- Do not use em dashes in docs or user-facing copy.
