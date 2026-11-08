# Progress

## How to use this file (for every overnight run)
1. Read SPEC.md and this file.
2. Do the FIRST unchecked milestone only. Do not skip ahead.
3. Run the tests and the typecheck. Fix failures before moving on.
4. Check off finished items, add short notes under "Run log", commit with a clear message, push.
5. If blocked (missing key, unclear decision), write the blocker under "Blockers" and stop. Do not guess at secrets or create accounts.

## Milestone 1: Scaffold and recognition
- [x] Monorepo layout: `/server`, `/client`, shared types
- [x] Provider interfaces plus Mock and Real implementations (ACRCloud, LRCLIB, Whisper)
- [x] `PROVIDER_MODE` switch, zero-key mock mode works
- [x] Mic capture in client (rolling 8-10s buffer, WAV or webm upload)
- [x] `POST /api/identify` plus lyrics lookup plus cache
- [x] LRC parser with tests (edge cases: multiple timestamps, offsets, empty lines)
- [x] Highlighted-line player on a fixed clock
- [x] Tests green, README with run instructions

## Milestone 2: Adaptive clock
- [x] Playback clock module with latency compensation
- [x] Re-recognition loop (lock-on, then back off to 20-30s)
- [x] Rolling regression rate estimator, clamped and smoothed
- [x] Drift handling (snap vs nudge)
- [x] Duration-ratio timestamp scaling for slowed/sped versions
- [x] Synthetic test harness at 0.8x to 1.25x plus noisy samples
- [x] Dockerfile and Cloud Run deploy notes (do not deploy)

## Milestone 3: Concert mode and polish
- [x] Transcription endpoint plus mock
- [x] Fuzzy line matcher with confidence threshold
- [x] Re-anchor logic behind a feature flag
- [x] UI polish: smooth scroll, large readable lyrics, mobile layout, status indicator (listening, locked, drifting)
- [ ] Optional: BPM cross-check using Essentia.js
- [ ] Final README, known limitations, tuning constants documented in one config file

## Blockers
(none yet)

## Run log
(append one short entry per run: date, what was done, test status)

- 2026-11-08: Milestone 1 complete. npm workspaces (shared, server, client); provider interfaces with Mock plus ACRCloud, LRCLIB and Whisper implementations; PROVIDER_MODE switch (mock by default, real lists missing keys); AudioWorklet mic capture into a 10s ring buffer uploaded as 16 kHz WAV; POST /api/identify with in-memory LRU lyrics cache; LRC parser covering multiple timestamps, offsets, empty lines, enhanced tags; fixed-clock highlighted player; README. Tests: 41 passed (Vitest), typecheck clean, build OK, mock-mode browser smoke test with a fake mic passed. Note: Redis cache backend is stubbed (falls back to memory) until needed.
- 2026-11-08: Milestone 2 complete. Adaptive clock in `shared/src/clock/` (latency-compensated samples at clip capture time, rolling robust regression rate estimator clamped to 0.7-1.4 with EMA, nudge below 1500ms and confirmed snap above it, easing that never jumps or runs backwards); RecognitionScheduler (2s while searching, lock after 3 agreeing samples over a 20s span, then 20-30s re-checks, drop after 3 misses); client SyncSession loop with a status indicator; server applies duration-ratio scaling and returns `lyricsTimeScale`; mock recognition now follows a virtual playback timeline (`MOCK_PLAYBACK_RATE`); server can serve the built client (`STATIC_DIR`, adds @fastify/static); Dockerfile, .dockerignore, DEPLOY.md; all tuning constants in `shared/src/clock/config.ts`. Tests: 89 passed (harness at 0.8x to 1.25x clean and noisy, seeks, mid-song rate change, low latency), typecheck clean, build OK. Browser smoke test with a fake mic at 1.1x locked in about 28s at 1.10x. Docker daemon was not available in the run environment, so the image build was not run; the runtime layout was checked by running the built server from an equivalent folder.
- 2026-11-08: Milestone 3, four of six items done. `POST /api/transcribe` (registered only with `CONCERT_MODE=on` and a transcription provider; health reports `concertMode`) shares the lyrics cache with identify and matches on the scaled timeline; the mock transcription follows the same virtual song as the mock recognition. Fuzzy matcher in `shared/src/concert/matcher.ts` (semi-global edit distance over spans of 1 to 3 lines in a window around the clock, position estimated inside the line, ambiguity check against other places). `ReanchorPolicy` plus `AdaptivePlaybackClock.reanchor` and a client `ConcertLoop` (5s chunks, confident matches only, large jumps need confirmation). UI: toggle for concert mode, eased scroll of the lyrics panel only (retargets on snaps, pauses on manual scroll, respects reduced motion), larger clamp-sized lyrics, full-height mobile layout with safe areas, status pill (Listening, Syncing, Locked, Drifting). Constants in `CONCERT_CONFIG` next to the clock config. Tests: 137 passed, typecheck clean, build OK; mobile browser smoke test in mock mode with a fake mic showed the active line centered and the concert loop agreeing. Next run: optional BPM cross-check (or mark it skipped) and the final README, known limitations and config docs.
