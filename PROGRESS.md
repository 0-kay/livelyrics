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
- [ ] Playback clock module with latency compensation
- [ ] Re-recognition loop (lock-on, then back off to 20-30s)
- [ ] Rolling regression rate estimator, clamped and smoothed
- [ ] Drift handling (snap vs nudge)
- [ ] Duration-ratio timestamp scaling for slowed/sped versions
- [ ] Synthetic test harness at 0.8x to 1.25x plus noisy samples
- [ ] Dockerfile and Cloud Run deploy notes (do not deploy)

## Milestone 3: Concert mode and polish
- [ ] Transcription endpoint plus mock
- [ ] Fuzzy line matcher with confidence threshold
- [ ] Re-anchor logic behind a feature flag
- [ ] UI polish: smooth scroll, large readable lyrics, mobile layout, status indicator (listening, locked, drifting)
- [ ] Optional: BPM cross-check using Essentia.js
- [ ] Final README, known limitations, tuning constants documented in one config file

## Blockers
(none yet)

## Run log
(append one short entry per run: date, what was done, test status)

- 2026-11-08: Milestone 1 complete. npm workspaces (shared, server, client); provider interfaces with Mock plus ACRCloud, LRCLIB and Whisper implementations; PROVIDER_MODE switch (mock by default, real lists missing keys); AudioWorklet mic capture into a 10s ring buffer uploaded as 16 kHz WAV; POST /api/identify with in-memory LRU lyrics cache; LRC parser covering multiple timestamps, offsets, empty lines, enhanced tags; fixed-clock highlighted player; README. Tests: 41 passed (Vitest), typecheck clean, build OK, mock-mode browser smoke test with a fake mic passed. Note: Redis cache backend is stubbed (falls back to memory) until needed.
