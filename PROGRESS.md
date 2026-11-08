# Progress

## How to use this file (for every overnight run)
1. Read SPEC.md and this file.
2. Do the FIRST unchecked milestone only. Do not skip ahead.
3. Run the tests and the typecheck. Fix failures before moving on.
4. Check off finished items, add short notes under "Run log", commit with a clear message, push.
5. If blocked (missing key, unclear decision), write the blocker under "Blockers" and stop. Do not guess at secrets or create accounts.

## Milestone 1: Scaffold and recognition
- [ ] Monorepo layout: `/server`, `/client`, shared types
- [ ] Provider interfaces plus Mock and Real implementations (ACRCloud, LRCLIB, Whisper)
- [ ] `PROVIDER_MODE` switch, zero-key mock mode works
- [ ] Mic capture in client (rolling 8-10s buffer, WAV or webm upload)
- [ ] `POST /api/identify` plus lyrics lookup plus cache
- [ ] LRC parser with tests (edge cases: multiple timestamps, offsets, empty lines)
- [ ] Highlighted-line player on a fixed clock
- [ ] Tests green, README with run instructions

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
