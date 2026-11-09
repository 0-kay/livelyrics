import { describe, expect, it } from 'vitest';
import { SoundSignature } from '../src/audio/signature.js';

const SR = 48_000;

function rng(seed: number) {
  let s = seed >>> 0;
  return () => {
    s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
    return s / 2 ** 32 - 0.5;
  };
}

type Kind = 'drums' | 'drumsBusy' | 'pad' | 'bright' | 'silence';
interface Part {
  kind: Kind;
  seconds: number;
  gain?: number;
}

/** Synthetic songs with different tonal balance. */
function render(parts: Part[], seed = 1): Float32Array {
  const total = parts.reduce((s, p) => s + p.seconds, 0);
  const out = new Float32Array(Math.round(total * SR));
  const rand = rng(seed);
  let off = 0;
  for (const p of parts) {
    const n = Math.round(p.seconds * SR);
    const g = p.gain ?? 1;
    for (let i = 0; i < n; i++) {
      const t = i / SR;
      const beat = t % 0.5;
      let x = 0.005 * rand();
      if (p.kind === 'drums' || p.kind === 'drumsBusy') {
        x += 0.6 * Math.exp(-beat / 0.03) * Math.sin(2 * Math.PI * 60 * beat);
        const hat = (t + 0.25) % 0.5;
        x += (p.kind === 'drumsBusy' ? 0.2 : 0.12) * Math.exp(-hat / 0.006) * rand() * 2;
        x += 0.05 * Math.sin(2 * Math.PI * 110 * t); // bass line
      } else if (p.kind === 'pad') {
        x += 0.15 * Math.sin(2 * Math.PI * 440 * t) + 0.12 * Math.sin(2 * Math.PI * 880 * t) + 0.08 * Math.sin(2 * Math.PI * 1320 * t);
      } else if (p.kind === 'bright') {
        x += 0.3 * Math.exp(-((t + 0.1) % 0.25) / 0.01) * rand() * 2 + 0.06 * Math.sin(2 * Math.PI * 3000 * t);
      } else {
        x = 0.0002 * rand();
      }
      out[off + i] = x * g;
    }
    off += n;
  }
  return out;
}

/** Feed audio, arm at 1s, return when (and with which change point) it fired. */
function run(parts: Part[], seed = 1) {
  const sig = new SoundSignature(SR);
  let fired: { at: number; changeAt: number } | null = null;
  let now = 0;
  sig.onChange = (changeAt) => {
    if (!fired) fired = { at: now, changeAt };
  };
  const audio = render(parts, seed);
  for (let i = 0; i + 128 <= audio.length; i += 128) {
    now = ((i + 128) / SR) * 1000;
    if (Math.abs(now - 1000) < 2) sig.arm('song');
    sig.push(audio.subarray(i, i + 128), now);
  }
  return { fired: fired as { at: number; changeAt: number } | null, sig };
}

describe('SoundSignature', () => {
  it('learns a song and stays quiet while it plays', () => {
    const { fired, sig } = run([{ kind: 'drums', seconds: 40 }]);
    expect(fired).toBeNull();
    expect(sig.snapshot.state).toBe('tracking');
  });

  it('ignores a volume change, a busier chorus and a short silence', () => {
    const { fired } = run([
      { kind: 'drums', seconds: 15 },
      { kind: 'drums', seconds: 8, gain: 0.4 },
      { kind: 'drumsBusy', seconds: 8 },
      { kind: 'silence', seconds: 3 },
      { kind: 'drums', seconds: 10 },
    ]);
    expect(fired).toBeNull();
  });

  for (const next of ['pad', 'bright'] as const) {
    it(`fires within a few seconds when the sound changes to ${next}, pointing near the change`, () => {
      const { fired } = run([
        { kind: 'drums', seconds: 20 },
        { kind: next, seconds: 12 },
      ]);
      expect(fired).not.toBeNull();
      expect(fired!.at - 20_000).toBeLessThanOrEqual(5_000);
      expect(Math.abs(fired!.changeAt - 20_000)).toBeLessThanOrEqual(3_000);
    });
  }

  it('does nothing until armed', () => {
    const sig = new SoundSignature(SR);
    let fired = false;
    sig.onChange = () => (fired = true);
    const audio = render([{ kind: 'drums', seconds: 15 }, { kind: 'pad', seconds: 10 }]);
    for (let i = 0; i + 128 <= audio.length; i += 128) sig.push(audio.subarray(i, i + 128), ((i + 128) / SR) * 1000);
    expect(fired).toBe(false);
  });
});
