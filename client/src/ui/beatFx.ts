import { RHYTHM_CONFIG } from '@livelyrics/shared';
import type { BeatFrame, Energy } from '../audio/rhythm.js';

export interface Light {
  /** Horizontal position as a fraction of the width, 0 to 1. */
  x: number;
  /** Vertical position as a fraction of the height, 0 to 1. */
  y: number;
  color: string;
  opacity: number;
}

export interface BeatFx {
  energy: Energy;
  /** Extra scale for the ambient glows. */
  blobScale: number;
  blobOpacity: number;
  /** Extra scale and lift for the active lyric line. */
  lineScale: number;
  lineLift: number;
  /** Glow radius (px) and strength (0-1) of the active line. */
  glowPx: number;
  glowAlpha: number;
  /** Palette slot ('a' | 'b' | 'c') the active line glow uses this beat. */
  glowSlot: 'a' | 'b' | 'c';
  lights: Light[];
  /** Per-bar scale for the listening equalizer, from real loudness. */
  eq: number[];
  /** 0 to 1, for dots and small accents. */
  pulse: number;
}

/**
 * Keeps big light flashes at or under `maxFlashHz` (WCAG 2.3.1 asks for no
 * more than 3 flashes a second). Beats in between keep the pulse but get no light.
 */
export class FlashLimiter {
  private lastIdx = Number.NaN;
  private lastAt = -1e9;
  private lit = false;

  allow(beatIndex: number, nowMs: number): boolean {
    if (beatIndex !== this.lastIdx) {
      this.lastIdx = beatIndex;
      this.lit = nowMs - this.lastAt >= 1000 / RHYTHM_CONFIG.maxFlashHz;
      if (this.lit) this.lastAt = nowMs;
    }
    return this.lit;
  }
}

const SLOTS = ['a', 'b', 'c'] as const;

const NONE: BeatFx = {
  energy: 'calm', blobScale: 1, blobOpacity: 0, lineScale: 1, lineLift: 0, glowPx: 30, glowAlpha: 0.6, glowSlot: 'a', lights: [], eq: [0.55, 0.55, 0.55, 0.55, 0.55], pulse: 0,
};

/**
 * Picks the effect pattern from the rhythm: calm (quiet or sparse) breathes
 * with the loudness, groove pulses the glows and corner lights per bar, hype
 * adds color cycling on every beat, a sweeping top light and a small bounce
 * of the current line. Reduced motion turns it all off.
 */
export function beatFx(b: BeatFrame | null, pal: { a: string; b: string; c: string }, nowMs: number, limiter: FlashLimiter, reducedMotion: boolean, nowS: number): BeatFx {
  if (!b || reducedMotion) return NONE;
  const p = b.pulse;
  const lv = b.level;
  const eq = [0, 1, 2, 3, 4].map((i) => {
    const wobble = 0.5 + 0.5 * Math.abs(Math.sin(nowS * 7 + i * 1.9));
    return Math.min(1, 0.22 + 0.55 * lv * wobble + 0.35 * p * (i % 2 ? 0.8 : 1));
  });
  if (b.energy === 'calm') {
    return { ...NONE, energy: 'calm', blobScale: 1 + 0.03 * lv, blobOpacity: 0.05 * lv, glowAlpha: 0.6 + 0.15 * p, eq, pulse: p };
  }
  const flash = limiter.allow(b.beatIndex, nowMs) ? p : 0;
  if (b.energy === 'groove') {
    const bar = Math.floor(b.beatIndex / 4);
    const color = pal[SLOTS[((bar % 3) + 3) % 3]!];
    return {
      energy: 'groove', blobScale: 1 + 0.05 * p, blobOpacity: 0.08 * p, lineScale: 1 + 0.015 * p, lineLift: 0, glowPx: 30 + 14 * p, glowAlpha: 0.6 + 0.3 * p,
      glowSlot: 'a', eq, pulse: p,
      lights: [
        { x: 0, y: 1, color, opacity: 0.35 * flash },
        { x: 1, y: 1, color, opacity: 0.35 * flash },
      ],
    };
  }
  const slot = SLOTS[((b.beatIndex % 3) + 3) % 3]!;
  const color = pal[slot];
  const side = ((b.beatIndex % 2) + 2) % 2;
  return {
    energy: 'hype', blobScale: 1 + 0.09 * p, blobOpacity: 0.12 * p, lineScale: 1 + 0.03 * p, lineLift: -3 * p, glowPx: 30 + 24 * p, glowAlpha: 0.65 + 0.35 * p,
    glowSlot: slot, eq, pulse: p,
    lights: [
      { x: 0, y: 1, color, opacity: 0.5 * flash },
      { x: 1, y: 1, color: pal[SLOTS[(SLOTS.indexOf(slot) + 1) % 3]!], opacity: 0.5 * flash },
      { x: side ? 0.8 : 0.2, y: 0, color, opacity: 0.3 * flash },
    ],
  };
}
