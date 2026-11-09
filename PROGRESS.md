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
- [x] Optional: BPM cross-check using Essentia.js (done with the existing local tempo tracker instead of Essentia.js, to keep dependencies minimal)
- [x] Final README, known limitations, tuning constants documented in one config file

## Blockers
(none yet)

## Run log
(append one short entry per run: date, what was done, test status)

- 2026-11-08: Milestone 1 complete. npm workspaces (shared, server, client); provider interfaces with Mock plus ACRCloud, LRCLIB and Whisper implementations; PROVIDER_MODE switch (mock by default, real lists missing keys); AudioWorklet mic capture into a 10s ring buffer uploaded as 16 kHz WAV; POST /api/identify with in-memory LRU lyrics cache; LRC parser covering multiple timestamps, offsets, empty lines, enhanced tags; fixed-clock highlighted player; README. Tests: 41 passed (Vitest), typecheck clean, build OK, mock-mode browser smoke test with a fake mic passed. Note: Redis cache backend is stubbed (falls back to memory) until needed.
- 2026-11-08: Milestone 2 complete. Adaptive clock in `shared/src/clock/` (latency-compensated samples at clip capture time, rolling robust regression rate estimator clamped to 0.7-1.4 with EMA, nudge below 1500ms and confirmed snap above it, easing that never jumps or runs backwards); RecognitionScheduler (2s while searching, lock after 3 agreeing samples over a 20s span, then 20-30s re-checks, drop after 3 misses); client SyncSession loop with a status indicator; server applies duration-ratio scaling and returns `lyricsTimeScale`; mock recognition now follows a virtual playback timeline (`MOCK_PLAYBACK_RATE`); server can serve the built client (`STATIC_DIR`, adds @fastify/static); Dockerfile, .dockerignore, DEPLOY.md; all tuning constants in `shared/src/clock/config.ts`. Tests: 89 passed (harness at 0.8x to 1.25x clean and noisy, seeks, mid-song rate change, low latency), typecheck clean, build OK. Browser smoke test with a fake mic at 1.1x locked in about 28s at 1.10x. Docker daemon was not available in the run environment, so the image build was not run; the runtime layout was checked by running the built server from an equivalent folder.
- 2026-11-08: Milestone 3, four of six items done. `POST /api/transcribe` (registered only with `CONCERT_MODE=on` and a transcription provider; health reports `concertMode`) shares the lyrics cache with identify and matches on the scaled timeline; the mock transcription follows the same virtual song as the mock recognition. Fuzzy matcher in `shared/src/concert/matcher.ts` (semi-global edit distance over spans of 1 to 3 lines in a window around the clock, position estimated inside the line, ambiguity check against other places). `ReanchorPolicy` plus `AdaptivePlaybackClock.reanchor` and a client `ConcertLoop` (5s chunks, confident matches only, large jumps need confirmation). UI: toggle for concert mode, eased scroll of the lyrics panel only (retargets on snaps, pauses on manual scroll, respects reduced motion), larger clamp-sized lyrics, full-height mobile layout with safe areas, status pill (Listening, Syncing, Locked, Drifting). Constants in `CONCERT_CONFIG` next to the clock config. Tests: 137 passed, typecheck clean, build OK; mobile browser smoke test in mock mode with a fake mic showed the active line centered and the concert loop agreeing. Next run: optional BPM cross-check (or mark it skipped) and the final README, known limitations and config docs.
- 2026-11-08 (manual, after first live test): faster song switching and resync. Clip length is now a setting (`CAPTURE_CONFIG.clipSeconds`, default 6, `?clip=N` URL override); `getClip` now really sends only the last N seconds (before, it sent the whole 10s buffer). New early-check triggers: end of the matched song, a local silence-gap detector (`client/src/audio/silence.ts`), and a weak match while locked. `SyncSession.recheckSoon()` and an injectable scheduler for tests. Tests: 148 passed, typecheck clean, build OK; trigger tests were mutation-checked (each fails when its feature is removed).
- 2026-11-08 (manual): karaoke redesign from the Claude Design handoff. New `client/src/ui/` (Stage, theme tokens and palettes, lyric layout math, listening copy, display-song reducer that keeps the last lyrics on a lost lock); App feeds the real session into it; old LyricsPlayer and scroll helper removed; Geist font; wake lock while listening; party mode. Tests: 164 passed, typecheck clean, build OK; phone and TV screenshots checked in mock mode with a fake mic.
- 2026-11-08 (manual): local beat tracking. Onset detector and tempo and phase tracker on the mic frames (`client/src/audio/beat.ts`, `rhythm.ts`, `RHYTHM_CONFIG`), predicting the next 10 beats; beat-reactive visuals (calm, groove, hype patterns, flash cap 3 per second, real mic loudness in the equalizers); local song-change decision after 3s of sustained rhythm mismatch (`SyncSession.suspectSongChange`, screen moves to next song at once, early recognition confirms). Tests: 185 passed, including synthetic drum tracks (onset timing, 95 to 140 BPM, prediction, switch timing, busy hats, breakdowns, tempo rides) with mutation checks; browser test with a generated drum track as the fake mic switched about 4s after a 120 to 100 BPM change and relearned. The optional BPM item is partly covered: tempo is tracked, but it does not feed the clock rate yet.
- 2026-11-09: Milestone 3 complete, so all milestones are done. BPM cross-check (`shared/src/clock/bpmCheck.ts`, `BPM_CHECK_CONFIG`): learns the song tempo at 1.0x while locked, compares the rate the local tempo implies with the clock rate, and pulls a recognition forward after 4s of beat time over 4% apart (cooldown 10s, relearns after 2 unconfirmed rechecks, half and double tempo folded, breakdowns pause the count, over 16% ignored). It never moves the clock. Wired through `SyncSession.checkTempo` and `tempoForCrossCheck` in the client every 500ms. Essentia.js was not added: the existing tracker already gives tempo, so no new dependency. Moved the remaining sync, cache and upload constants into `shared/src/clock/config.ts` (`CAPTURE_CONFIG.bufferWaitMs`, `RHYTHM_CONFIG.visualLeadMs`, new `SERVER_CONFIG`). Final README: BPM cross-check section, tuning constants table, known limitations. Tests: 209 passed (new unit tests, a synthetic drum pitch ride and breakdown, a session recheck test; mutation-checked), typecheck clean, build OK.
- 2026-11-09 (manual): sync deep dive. Server: clip-end position from ACRCloud alignment fields (db_end + clip tail via WAV length). Clock: 1.0x prior with significance test, steady-difference rate adoption, median anchoring over 7 answers, 150ms deadband and 5-8% capped corrections, three-answer snap confirmation, one-sided-error refit. Scheduler: lock after 2 answers within 600ms, fast checks until speed can be judged, then every 3-3.5s; quick 4s clips for the first and triggered checks; flip-back guard; rhythm hunch only triggers a check. New full-session simulator and benchmark tests. Simulated results vs before: speed wobble 0.7% vs 5.8% (precise offsets) and 5% vs 19% (rough), time to lock ~10-15s vs 28-38s, song switches 4-8s vs 5-28s, never the wrong song; about 1,000 recognitions per hour. Tests: 207 passed, typecheck and build clean, browser check in mock mode (first lyrics 5.2s, in sync ~8s).
- 2026-11-09 (manual): fix slow first match reported on a real phone after the sync overhaul. Cause: fixed 4-5s clips while searching (short clips miss far more on a real mic). Searching clips now grow 4, 6, 8, 10s after each miss (capped by the buffer, and by audio since a lost song); routine clip back to 6s. Simulator models short-clip misses; new 'phone mic in a room' benchmark (first song median 9.6s vs 15.3s with fixed clips, none over 15s vs half). Tests: 224 passed, typecheck and build clean.
- 2026-11-09 (manual): clip strategy redesign agreed with Emmanuel. Clips cut at a boundary (Listen, change point, lost song). Start: quick 4s try, then full 8s as soon as it exists. Local detectors (rhythm, new sound-signature detector, gap, song end) report change points; identification uses only audio since then (4s, then 8s); the screen follows the server. Routine checks 8s every 5-6s; short-clip misses never count toward losing a song; per-length match stats in ?debug=1. Simulator (harsh phone-mic model): first song max 12.75s, switches 90% within 9.5s vs 12s with fixed 5s clips, about 770 requests per hour vs 970-1130. Tests: 233 passed, typecheck and build clean, browser check in mock mode (first lyrics 4.7s).
