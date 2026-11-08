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

- `GET /api/health` returns `{ ok, mode }`.
- `POST /api/identify` takes multipart form data with an `audio` file (WAV, webm, ogg, mp4, mpeg; 5 MB max) and returns `{ match, lyrics, lyricsCached, processingMs }`. `match.playOffsetMs` is the song position at the end of the clip. `match` is `null` when nothing was recognized.

`lyricsTimeScale` is the factor already applied to the lyric timestamps when the matched track and the lyrics source differ in duration by more than 3% (slowed or sped versions). It is 1 when no scaling was needed.

Lyrics are cached in memory (LRU, 24h for hits, 1h for misses). `CACHE_BACKEND=redis` is reserved for later and currently falls back to memory.

## How syncing works

All of this lives in `shared/src/clock/` and every tuning constant is in `shared/src/clock/config.ts`.

1. Each recognition result becomes a sample `(wallMs, songPosMs)`, placed at the moment the clip's last audio sample was captured. This removes upload, processing and network time from the estimate.
2. The clock follows `songPositionMs = anchorOffsetMs + (now - anchorWallMs) * rate + latencyCompMs`.
3. `rate` is the slope of a rolling linear regression over the last 16 samples, with outliers (over 900ms off the line) dropped, clamped to 0.7x to 1.4x and smoothed with an EMA.
4. Drift handling: a sample within 350ms agrees; up to 1500ms off is nudged out gradually (the shown position never jumps or runs backwards); more than 1500ms is held as a suspect and only snaps when the next sample confirms it, so one bad result cannot throw the lyrics off.
5. Scheduling: recognize every 2s while searching, lock on after 3 agreeing samples once the rate estimate covers 20s, then re-check every 20 to 30s. A nudge or suspect while locked goes back to fast checks; 3 misses in a row drop the song.

The synthetic harness in `shared/test/harness.ts` simulates playback at 0.8x, 0.9x, 1.0x, 1.1x and 1.25x with jitter, outliers, misses, variable latency, seeks and mid-song speed changes.

## Docker and Cloud Run

`docker build -t livelyrics . && docker run --rm -p 8080:8080 livelyrics` runs the API and the built client in one container (mock mode by default). See `DEPLOY.md` for Cloud Run notes. Nothing is deployed automatically.

## Current limitations

- `latencyCompMs` defaults to 0. Bluetooth speakers or a far away PA may need a positive value; there is no UI for it yet.
- Rate estimation assumes the recognition provider reports offsets on the original track timeline. Concert mode (Milestone 3) handles live performances.
- LRCLIB is for personal use. A public product would need a licensed lyrics provider.
