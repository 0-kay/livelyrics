# LiveLyrics

Listens to music through the mic, identifies the song, and shows synced lyrics with the current line highlighted. See `SPEC.md` for the full design and `PROGRESS.md` for status.

## Layout

```
shared/   Types, provider interfaces, LRC parser, line search (used by both sides)
server/   Fastify API: /api/health, /api/identify (recognition + lyrics + cache)
client/   React + Vite app: mic capture (rolling 10s buffer, 16 kHz WAV upload), lyrics player
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

Lyrics are cached in memory (LRU, 24h for hits, 1h for misses). `CACHE_BACKEND=redis` is reserved for later and currently falls back to memory.

## Current limitations

- The player runs on a fixed 1x clock from one recognition result. The adaptive clock (latency compensation, rate estimation, drift handling) is Milestone 2.
- LRCLIB is for personal use. A public product would need a licensed lyrics provider.
