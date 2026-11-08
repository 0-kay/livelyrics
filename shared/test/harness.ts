/**
 * Synthetic test harness for the adaptive clock. Simulates a song playing at a
 * known rate, a recognition provider that reports noisy offsets with variable
 * latency, and the scheduler deciding when to recognize next. No audio, no
 * network, fully deterministic for a given seed.
 */
import {
  AdaptivePlaybackClock,
  RecognitionScheduler,
  sampleFromRecognition,
  type ClockAction,
  type SyncState,
} from '../src/index.js';

/** Small seeded PRNG (mulberry32). */
export function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export function gaussian(rand: () => number): number {
  const u = Math.max(rand(), 1e-12);
  const v = rand();
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
}

export interface SimOptions {
  rate: number;
  seed?: number;
  /** Song position when the simulation starts. */
  startPosMs?: number;
  durationMs?: number;
  /** Standard deviation of provider offset error (ms). */
  noiseMs?: number;
  /** Probability that a result is a wild outlier. */
  outlierProb?: number;
  outlierMagnitudeMs?: number;
  /** Probability that recognition returns no match. */
  missProb?: number;
  /** Response latency range (ms). */
  minLatencyMs?: number;
  maxLatencyMs?: number;
  /** Optional seek: at wall time atMs the song jumps by byMs. */
  seek?: { atMs: number; byMs: number };
  /** Optional rate change: from wall time atMs the song plays at rate. */
  rateChange?: { atMs: number; rate: number };
  /** Evaluation step (ms). */
  evalStepMs?: number;
}

export interface SimEvent {
  wallMs: number;
  action: ClockAction | 'miss';
  state: SyncState;
  errorMs: number;
}

export interface SimResult {
  /** |clock - truth| at each evaluation step, with the wall time. */
  errors: { wallMs: number; errMs: number }[];
  events: SimEvent[];
  finalRate: number;
  recognitions: number;
  lockedAtMs: number | null;
  finalState: SyncState;
}

export function simulate(o: SimOptions): SimResult {
  const rand = rng(o.seed ?? 1);
  const duration = o.durationMs ?? 120_000;
  const start = o.startPosMs ?? 20_000;
  const noise = o.noiseMs ?? 0;
  const step = o.evalStepMs ?? 250;

  // Ground truth song position at wall time t (piecewise linear).
  const truth = (t: number): number => {
    let pos: number;
    if (o.rateChange && t > o.rateChange.atMs) {
      pos = start + o.rateChange.atMs * o.rate + (t - o.rateChange.atMs) * o.rateChange.rate;
    } else {
      pos = start + t * o.rate;
    }
    if (o.seek && t >= o.seek.atMs) pos += o.seek.byMs;
    return pos;
  };

  const clock = new AdaptivePlaybackClock();
  const scheduler = new RecognitionScheduler({ random: rand });
  const events: SimEvent[] = [];
  const errors: { wallMs: number; errMs: number }[] = [];
  let lockedAtMs: number | null = null;
  let recognitions = 0;

  // A recognition sends a clip ending at clipEnd and gets the answer at clipEnd + latency.
  // The rolling mic buffer is already full, so the first clip can be sent at t=0.
  let nextClipEnd = 0;
  let evalAt = 0;
  const minLat = o.minLatencyMs ?? 600;
  const maxLat = o.maxLatencyMs ?? 2_500;

  while (nextClipEnd < duration) {
    const clipEnd = nextClipEnd;
    const responseAt = clipEnd + minLat + (maxLat - minLat) * rand();

    // Evaluate the clock up to the response time.
    for (; evalAt < responseAt && evalAt < duration; evalAt += step) {
      const pos = clock.positionAt(evalAt);
      if (pos !== null) errors.push({ wallMs: evalAt, errMs: Math.abs(pos - truth(evalAt)) });
    }

    recognitions++;
    const miss = rand() < (o.missProb ?? 0);
    let decision;
    if (miss) {
      decision = scheduler.onResult({ matched: false });
      events.push({ wallMs: responseAt, action: 'miss', state: decision.state, errorMs: 0 });
      if (decision.lostLock) clock.reset();
    } else {
      let reported = truth(clipEnd) + gaussian(rand) * noise;
      if (rand() < (o.outlierProb ?? 0)) reported += (rand() < 0.5 ? -1 : 1) * (o.outlierMagnitudeMs ?? 4_000);
      const sample = sampleFromRecognition({
        playOffsetMs: reported,
        clipEndWallMs: clipEnd,
        requestSentWallMs: clipEnd + 20,
        responseWallMs: responseAt,
      });
      const upd = clock.addSample(sample, responseAt);
      decision = scheduler.onResult({ matched: true, score: 90, action: upd.action, rateSpanMs: upd.rateSpanMs });
      events.push({ wallMs: responseAt, action: upd.action, state: decision.state, errorMs: upd.errorMs });
    }
    if (decision.state === 'locked' && lockedAtMs === null) lockedAtMs = responseAt;
    nextClipEnd = responseAt + decision.nextDelayMs;
  }
  for (; evalAt < duration; evalAt += step) {
    const pos = clock.positionAt(evalAt);
    if (pos !== null) errors.push({ wallMs: evalAt, errMs: Math.abs(pos - truth(evalAt)) });
  }

  return { errors, events, finalRate: clock.rate, recognitions, lockedAtMs, finalState: scheduler.state };
}

/** p-th percentile (0..100) of errors at or after fromMs. */
export function percentile(errors: { wallMs: number; errMs: number }[], p: number, fromMs = 0): number {
  const v = errors.filter((e) => e.wallMs >= fromMs).map((e) => e.errMs).sort((a, b) => a - b);
  if (!v.length) return Number.NaN;
  return v[Math.min(v.length - 1, Math.floor((p / 100) * v.length))];
}
