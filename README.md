# LiveLyrics

Listens to music through the mic, identifies the song, and shows synced lyrics with the current line highlighted. See `SPEC.md` for the full design and `PROGRESS.md` for status.

## Layout

```
shared/   Types, provider interfaces, LRC parser, line search, adaptive clock (used by both sides)
server/   Fastify API: /api/health, /api/identify (recognition + lyrics + cache + duration scaling)
client/   React + Vite app: mic capture (rolling 10s buffer, 16 kHz WAV upload), re-recognition loop, lyrics player
```

## Requirements

Node 20 or newer (tested on Node 22).

## Run locally (mock mode, no API keys)

```bash
npm install
npm run dev:server      # API on http://localhost:8080 (PROVIDER_MODE defaults to mock)
npm run dev:client      # App on http://localhost:5173, proxies /api to the server
```

Open the app, tap **Listen**, and allow mic access. In mock mode any clip of 1 KB or more matches the built-in fixture song "Paper Lanterns" (invented placeholder text, not a real song), so you can try the full flow without keys. Mic access needs `localhost` or HTTPS.

The mock pretends the fixture song has been playing on a loop since the server started. Set `MOCK_PLAYBACK_RATE` (for example `MOCK_PLAYBACK_RATE=1.25 npm run dev:server`) to watch the app detect a sped up or slowed down track.

## Real providers

Copy `.env.example` to `.env` (never commit it), set `PROVIDER_MODE=real`, and fill in:

| Provider | Purpose | Env vars |
| --- | --- | --- |
| ACRCloud | Song recognition | `ACRCLOUD_HOST`, `ACRCLOUD_ACCESS_KEY`, `ACRCLOUD_ACCESS_SECRET` |
| LRCLIB | Synced lyrics (no key, personal use only) | `LRCLIB_USER_AGENT` |
| OpenAI Whisper | Concert mode transcription (later milestone) | `OPENAI_API_KEY` |

The server reads env vars from the process environment, for example `set -a; source .env; set +a; npm run dev:server`. In real mode the server refuses to start and lists any missing ACRCloud variables.

## Tests and checks

```bash
npm test            # Vitest across shared, server, client. Needs no keys.
npm run typecheck   # tsc --noEmit in every workspace
npm run build       # Builds shared, server (server/dist) and client (client/dist)
```

Real providers are tested against a fake `fetch`, so the suite never touches the network.

## API

- `GET /api/health` returns `{ ok, mode, concertMode }`.
- `POST /api/identify` takes multipart form data with an `audio` file (WAV, webm, ogg, mp4, mpeg; 5 MB max) and returns `{ match, lyrics, lyricsCached, processingMs }`. `match.playOffsetMs` is the song position at the end of the clip. `match` is `null` when nothing was recognized.

`lyricsTimeScale` is the factor already applied to the lyric timestamps when the matched track and the lyrics source differ in duration by more than 3% (slowed or sped versions). It is 1 when no scaling was needed.

- `POST /api/transcribe` (only when `CONCERT_MODE=on` and a transcription provider exists, otherwise 404) takes multipart form data with optional text fields `title`, `artist`, `album`, `durationMs`, `positionMs` followed by an `audio` file. It returns `{ text, match, processingMs }`. With a track, `match` is the best lyric line for the transcript near `positionMs` (`lineIndex`, `startMs`, `positionMs`, `score`, `ambiguous`, `confident`), matched on the same scaled timeline that `/api/identify` returned.

Lyrics are cached in memory (LRU, 24h for hits, 1h for misses). `CACHE_BACKEND=redis` is reserved for later and currently falls back to memory.

## How syncing works

All of this lives in `shared/src/clock/` and every tuning constant is in `shared/src/clock/config.ts`.

1. Each recognition result becomes a sample `(wallMs, songPosMs)`, placed at the moment the clip's last audio sample was captured. This removes upload, processing and network time from the estimate.
2. The clock follows `songPositionMs = anchorOffsetMs + (now - anchorWallMs) * rate + latencyCompMs`.
3. `rate` is the slope of a rolling linear regression over the last 16 samples, with outliers (over 900ms off the line) dropped, clamped to 0.7x to 1.4x and smoothed with an EMA.
4. Drift handling: a sample within 350ms agrees; up to 1500ms off is nudged out gradually (the shown position never jumps or runs backwards); more than 1500ms is held as a suspect and only snaps when the next sample confirms it, so one bad result cannot throw the lyrics off.
5. Scheduling: recognize every 2s while searching, lock on after 3 agreeing samples once the rate estimate covers 20s, then re-check every 20 to 30s. A nudge or suspect while locked goes back to fast checks; 3 misses in a row drop the song.

6. Early re-checks, so a new song or a drift is noticed in seconds instead of up to 30s later (`TRIGGER_CONFIG` in the same config file):
   - **Song end:** the clock knows the matched track's length, so a check is scheduled for the end of the song plus the clip length (so the clip holds only new audio).
   - **Gap in the audio:** `client/src/audio/silence.ts` watches the mic locally (no network). Sound returning after about 1.5s of near-silence triggers a check after the same settle time. The silence level is relative to the recent average, so room noise does not hide a gap.
   - **Weak match while locked:** a score below `minLockScore` puts the scheduler back on fast checks.
7. Clip length: each recognition sends only the most recent `CAPTURE_CONFIG.clipSeconds` (default 6) of the rolling buffer. Add `?clip=9` to the page URL (allowed range 3 to 10) to compare lengths on real songs without a rebuild. Shorter clips upload faster and lock sooner but match less reliably in noise.

The synthetic harness in `shared/test/harness.ts` simulates playback at 0.8x, 0.9x, 1.0x, 1.1x and 1.25x with jitter, outliers, misses, variable latency, seeks and mid-song speed changes.

## Concert mode (experimental)

Set `CONCERT_MODE=on` on the server (real mode also needs `OPENAI_API_KEY`). The client then shows a "Concert mode" toggle. While a song is known, it transcribes the latest 5s every 5s and the server fuzzy-matches the words against lyric spans of one to three lines within 30s before and 45s after the clock position (`shared/src/concert/matcher.ts`, a fuzzy substring edit distance with no extra dependencies). The clock only moves when the match is confident: score at least 0.72, no other place in the window within 0.08 of it, more than 2.5s away from the clock, and for jumps over 15s a second consistent match (`ReanchorPolicy`). In mock mode the transcription mock follows the same virtual song as the recognition mock, so the toggle can be tried without keys.

## Docker and Cloud Run

`docker build -t livelyrics . && docker run --rm -p 8080:8080 livelyrics` runs the API and the built client in one container (mock mode by default). See `DEPLOY.md` for Cloud Run notes. Nothing is deployed automatically.

## Current limitations

- `latencyCompMs` defaults to 0. Bluetooth speakers or a far away PA may need a positive value; there is no UI for it yet.
- Rate estimation assumes the recognition provider reports offsets on the original track timeline. Concert mode can re-anchor live performances, but the regular re-checks may still pull the clock back toward the studio timeline.
- LRCLIB is for personal use. A public product would need a licensed lyrics provider.
