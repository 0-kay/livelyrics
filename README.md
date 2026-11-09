# LiveLyrics

Listens to music through the mic, identifies the song, and shows synced lyrics with the current line highlighted. See `SPEC.md` for the full design and `PROGRESS.md` for status.

## Layout

```
shared/   Types, provider interfaces, LRC parser, line search, adaptive clock (used by both sides)
server/   Fastify API: /api/health, /api/identify (recognition + lyrics + cache + duration scaling), /api/transcribe (concert mode)
client/   React + Vite app: mic capture (rolling 10s buffer, 16 kHz WAV upload), re-recognition loop, beat tracking, karaoke screen (client/src/ui)
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
| OpenAI Whisper | Concert mode transcription (only with `CONCERT_MODE=on`) | `OPENAI_API_KEY` |

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

Lyrics are cached in memory (LRU, 500 entries, 24h for hits, 1h for misses; `SERVER_CONFIG`). `CACHE_BACKEND=redis` is reserved for later and currently falls back to memory.

## How syncing works

All of this lives in `shared/src/clock/` and every tuning constant is in `shared/src/clock/config.ts` (see [Tuning constants](#tuning-constants)).

1. Each recognition result becomes a sample `(wallMs, songPosMs)`, placed at the moment the clip's last audio sample was captured. The server computes the song position at the clip end from ACRCloud's alignment fields (`db_end_time_offset_ms` plus the part of the clip after `sample_end_time_offset_ms`, using the WAV length), which is tighter than `play_offset_ms`; it falls back to `play_offset_ms` when the fields are missing.
2. The clock follows `songPositionMs = anchorOffsetMs + (now - anchorWallMs) * rate + latencyCompMs`.
3. Speed: 1.0x is assumed until the data clearly shows otherwise (the slope differs by more than 1.2% and 2.5 standard errors), so normal songs never wobble. A steady difference (all answers on one straight line, just not ours) is adopted at once; an adopted speed is refined in small steps, and three answers in a row off to the same side refit it.
4. Position: the clock sits on the median of the last 7 answers, so one bad answer cannot move it. Differences under 150ms fade out invisibly; larger ones ease in at no more than 5 to 8% speed change over 3 to 8s, and the shown position never runs backwards. A jump (seek, wrong answer) needs three answers that agree with each other before the lyrics move.
5. Scheduling: check every 1.5s while searching, lock after 2 answers within 600ms, keep the fast pace until about 8s of data can judge the speed, then check every 3 to 3.5s. Each check also watches for a new song, so a change shows in about 4 to 8s even with no gap between songs. Going back to the song just left needs two answers in a row (no flip-flopping in DJ crossfades). 3 misses in a row drop the song.
6. Early checks (`TRIGGER_CONFIG`): end of the matched song, a gap in the audio (`client/src/audio/silence.ts`), a weak match, and the local rhythm tracker. Trigger checks and the very first check send a shorter 4s clip, which holds new audio sooner. The rhythm tracker only asks for an early check; the screen changes when the server names a different song.
7. Clip length: the first check sends a quick 4s clip. While searching, every "no match" grows the next clip by 2s (6, 8, then 10s, the whole buffer), because short clips miss much more often through a phone or laptop mic in a room; after a song is lost the clip only grows over audio heard since then, so the old song is not found again. Routine checks while a song is on send `CAPTURE_CONFIG.clipSeconds` (default 6); add `?clip=N` (3 to 10) to try other lengths.
8. Cost: about 900 to 1,100 recognitions per hour of listening at the default pace (was a few hundred). `lockedMinIntervalMs` and `lockedMaxIntervalMs` in `SCHEDULER_CONFIG` set the pace; 6 to 7s roughly halves the requests and adds about 2s to song switches.
9. Benchmarks: `client/test/sessionSim.ts` runs the real session against a simulated recognizer (noise, latency, misses, outliers, song changes) and `client/test/sessionBench.test.ts` guards steadiness, accuracy and switch time. `BENCH_OUT=report.json npx vitest run client/test/sessionBench.test.ts` writes the numbers.

The synthetic harness in `shared/test/harness.ts` simulates playback at 0.8x, 0.9x, 1.0x, 1.1x and 1.25x with jitter, outliers, misses, variable latency, seeks and mid-song speed changes.

## The karaoke screen

The UI in `client/src/ui/` follows the Claude Design handoff (`LiveLyrics.dc.html`). `Stage.tsx` draws every state from the live session: idle, mic blocked, listening (ring fills while the first clip is captured, then a scanning sweep and rotating copy, with a nudge after 15s), the match reveal with confetti, lyrics with a sweep bar under the current line, your-turn dots on blank rows, the next-song hand-off, instrumental and no-lyrics screens. The motion math is pure and tested (`lyricsLayout.ts`, `listenCopy.ts`, `displaySong.ts`); tokens and palettes are in `theme.ts`.

- Each song gets one of six palettes from a hash of its title and artist, and the background blends to it over about 1 second. Listening uses the Night palette.
- When the session drops a song, the last lyrics stay on screen, dimmed, under "Ooh, next song? I'm on it!" until the next match. The new lyrics rise in while the old ones fade up.
- Long gaps (12s or more) and intros get a blank row so the dot countdown always has a place.
- Wide landscape screens (1100px or wider) switch to the TV scale. The screen button turns on party mode: full screen, and the controls hide after 3 seconds without interaction.
- Dark theme by default; add `?theme=light` for the light theme. Reduced motion follows the system setting. The screen stays awake while listening where the browser supports it.

## Beat tracking and the local song-change decision

`client/src/audio/beat.ts` and `rhythm.ts` listen to the same mic frames, on the device, with no network. Constants are in `RHYTHM_CONFIG` (`shared/src/clock/config.ts`).

- **Onsets:** a kick band (150 Hz low-pass) plus the full band, the rise in log energy per 10ms hop, and an adaptive threshold. On synthetic drums, onsets land within about 3ms of the true hit.
- **Tempo and phase:** autocorrelation of the onset envelope (60 to 180 BPM, gently preferring 120) and a comb for the beat phase, then the next 10 beats are predicted from that grid.
- **Visuals:** the screen pulses on the predicted beats (30ms early to cover screen latency) and falls back to raw onsets when no tempo is clear. The pattern follows the music over about 1.5s with 2s of hysteresis: calm breathes with the loudness, groove pulses the glows and corner lights per bar, hype cycles colors every beat with a sweeping top light and a small bounce of the current line. Big light flashes are capped at 3 per second (photosensitivity), and reduced motion turns effects off. The listening ring and instrumental bars now follow the real mic loudness.
- **Song change:** once a song is matched, the tracker learns its beat grid (6s) and checks the incoming rhythm 4 times a second. When a strong rhythm disagrees (another tempo, or hits off the grid, with half and double tempo allowed) for 3s straight, it decides the song changed: the screen goes to "next song" at once and a recognition is sent as soon as the clip holds mostly new audio. If the server says it is the same song, the screen returns and the tracker relearns. No rhythm at all (a breakdown, a quiet bridge) is neutral and never triggers. Slow tempo rides are followed by a small phase-locked loop.
- **Limits:** naming the new song still needs one recognition. A perfectly beatmatched DJ transition (same tempo and phase) looks like the same song to rhythm alone; those changes still come from the song-end, silence-gap and regular checks.
- Add `?debug=1` to the URL to see tempo, the learned grid, the on-grid share and the mismatch timer live.

## BPM cross-check

`shared/src/clock/bpmCheck.ts` (`BPM_CHECK_CONFIG`) compares the clock rate with the rate the local tempo implies. It uses the tempo tracker above instead of Essentia.js, so it adds no dependency and no extra audio processing.

- While the clock is locked, it learns the song's tempo at 1.0x (heard BPM divided by the clock rate).
- Twice a second the client feeds it the learned grid's tempo (`tempoForCrossCheck`), which follows slow DJ pitch rides through the phase-locked loop. The implied rate is that tempo divided by the learned one, with half and double tempo folded.
- When the implied rate and the clock rate differ by more than 4% for 4s of beat time, it asks for a recognition 1.5s later. Without it, a slow pitch ride is noticed at the next regular check (every 3 to 3.5s), so it mainly helps when checks are slowed down to save requests. At most one recheck per 10s.
- It never moves the clock: recognition offsets stay the source of truth. If two rechecks in a row do not confirm the new rate, the learned tempo is assumed wrong and relearned.
- No clear beat (a breakdown) pauses the count, and differences above 16% are ignored as tempo errors or another song (the song-change detector handles those).

## Concert mode (experimental)

Set `CONCERT_MODE=on` on the server (real mode also needs `OPENAI_API_KEY`). The client then shows a small LIVE toggle next to Stop, and a quiet caption with the words it just heard. While a song is known, it transcribes the latest 5s every 5s and the server fuzzy-matches the words against lyric spans of one to three lines within 30s before and 45s after the clock position (`shared/src/concert/matcher.ts`, a fuzzy substring edit distance with no extra dependencies). The clock only moves when the match is confident: score at least 0.72, no other place in the window within 0.08 of it, more than 2.5s away from the clock, and for jumps over 15s a second consistent match (`ReanchorPolicy`). In mock mode the transcription mock follows the same virtual song as the recognition mock, so the toggle can be tried without keys.

## Deploying

See `DEPLOY.md`: Vercel (import the repo, add the keys and an `ACCESS_PASSWORD`) or Cloud Run (`scripts/deploy-cloudrun.sh`). Set `ACCESS_PASSWORD` on any deployed copy so only you can use it.

## Docker and Cloud Run

`docker build -t livelyrics . && docker run --rm -p 8080:8080 livelyrics` runs the API and the built client in one container (mock mode by default). See `DEPLOY.md` for Cloud Run notes. Nothing is deployed automatically.

## Tuning constants

Every value that changes sync behavior lives in one file, `shared/src/clock/config.ts`, used by both the server and the client. Each constant has a comment there; the groups are:

| Group | Controls |
| --- | --- |
| `CLOCK_CONFIG` | Rate range (0.7x to 1.4x), 1.0x prior and significance test, regression window, outlier cut, median anchoring, snap confirmation, deadband and correction speed limits, default latency compensation |
| `SCHEDULER_CONFIG` | Lock-on rules, search and locked re-check intervals, retry delay, misses before dropping a song |
| `CAPTURE_CONFIG` | Clip length (and the `?clip=` range), rolling buffer length, wait while the buffer fills |
| `TRIGGER_CONFIG` | Silence-gap detector, settle margin after a trigger, earliest song-end recheck |
| `SCALING_CONFIG` | When to apply duration-ratio scaling and its limits |
| `CONCERT_CONFIG` | Transcription chunk length and interval, search window, fuzzy score and margin, re-anchor and confirmation rules |
| `RHYTHM_CONFIG` | Onset detector, tempo range, grid learning and checking, song-change timing, beat prediction, flash cap, visual lead |
| `BPM_CHECK_CONFIG` | Tolerance, hold time, cooldown and recheck count for the BPM cross-check |
| `SERVER_CONFIG` | Lyrics cache size and lifetimes, upload size limit |

Purely visual timing (copy rotation, gap rows, palettes) stays next to the UI code in `client/src/ui/` because it does not affect sync.

## Known limitations

- **Latency:** `latencyCompMs` defaults to 0. Bluetooth speakers or a far away PA may need a positive value; there is no UI for it yet.
- **Studio timeline:** rate estimation assumes the recognition provider reports offsets on the original track timeline. Concert mode can re-anchor live performances, but the regular re-checks may still pull the clock back toward the studio timeline.
- **Recognition is needed to name a song:** the local rhythm can only say that something changed. A perfectly beatmatched DJ transition (same tempo and phase) looks like the same song to rhythm alone.
- **BPM cross-check only speeds up rechecks:** it never sets the rate, so a pitch change on a track with no clear beat is still found by the regular checks every 3 to 3.5s. Sudden pitch jumps over 4% are first caught by the song-change detector, which also triggers a recognition.
- **Concert mode is experimental:** it needs a transcription provider (Whisper in real mode), costs one transcription per 5s, and sung words are hard to transcribe over a loud band.
- **Cache:** lyrics are cached in memory per server instance. `CACHE_BACKEND=redis` is reserved and falls back to memory.
- **Mic access** needs HTTPS or `localhost`, and some mobile browsers pause the mic when the screen locks.
- **Lyrics licensing:** LRCLIB is for personal use. A public product would need a licensed lyrics provider (for example Musixmatch).
