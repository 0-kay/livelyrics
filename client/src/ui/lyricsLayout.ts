import type { LyricLine } from '@livelyrics/shared';
import { alpha, cl, ease, lerp, mix, type Sizes } from './theme.js';

/** Gaps between sung lines at least this long get a "breather" row with the dot countdown (ms). */
export const LONG_GAP_MS = 12_000;
/** The synthetic breather row starts this long before the next line (ms). */
export const BREATHER_LEAD_MS = 6_000;
/** An intro longer than this gets a leading breather row (ms). */
export const INTRO_MS = 1_500;

/**
 * Lyrics as the player shows them: sorted, with a blank row for the intro and
 * for long instrumental gaps so the your-turn countdown always has a place.
 * Blank rows already in the lyrics are kept as they are.
 */
export function prepareLines(lines: readonly LyricLine[]): LyricLine[] {
  const sorted = [...lines].sort((a, b) => a.startMs - b.startMs);
  const out: LyricLine[] = [];
  if (sorted.length === 0 || sorted[0].startMs > INTRO_MS) out.push({ startMs: 0, text: '' });
  sorted.forEach((l, i) => {
    out.push({ startMs: l.startMs, text: l.text.trim() });
    const next = sorted[i + 1];
    if (next && l.text.trim() && next.text.trim() && next.startMs - l.startMs >= LONG_GAP_MS) {
      out.push({ startMs: next.startMs - BREATHER_LEAD_MS, text: '' });
    }
  });
  return out;
}

export interface MeasuredLine {
  top: number;
  h: number;
}

export interface LayerLine {
  key: string;
  text: string;
  blank: boolean;
  active: boolean;
  opacity: number;
  scale: number;
  /** Progress of the line sweep bar, 0 to 1 (active line only). */
  progress: number;
  barOpacity: number;
  glow: string;
  dots: { bg: string; opacity: number; scale: number; shadow: string }[];
  caption: string;
  captionOpacity: number;
}

export interface Layer {
  lines: LayerLine[];
  /** translateY of the line list so the active line sits at the anchor. */
  y: number;
  active: number;
  activeText: string;
  prevText: string;
}

export interface LayerInput {
  lines: readonly LyricLine[];
  durationMs: number;
  positionMs: number;
  rate: number;
  sizes: Sizes;
  anchor: number;
  reducedMotion: boolean;
  light: boolean;
  accent: string;
  dotIdle: string;
  /** Wall time in seconds, for idle breathing of the dots. */
  nowS: number;
  /** Measured line boxes, or null before layout (an estimate is used). */
  measured: readonly MeasuredLine[] | null;
}

/** Target opacity by distance from the active line (d = index - active). */
export function opacityForDistance(d: number): number {
  if (d < -1) return 0;
  if (d === -1) return 0.35;
  if (d === 0) return 1;
  if (d === 1) return 0.62;
  if (d === 2) return 0.48;
  if (d === 3) return 0.36;
  return 0;
}

/** Index of the line playing at posS (seconds); 0 before the first line. */
export function activeIndex(lines: readonly LyricLine[], posMs: number): number {
  let a = 0;
  for (let i = 0; i < lines.length; i++) if (lines[i].startMs <= posMs) a = i;
  return a;
}

/**
 * Everything the lyric list needs for one frame: per-line opacity, scale and
 * sweep, the dot countdown on blank rows, and the list offset. Pure, so the
 * motion can be unit tested. Ported from the design prototype.
 */
export function computeLayer(inp: LayerInput): Layer {
  const L = inp.lines;
  const S = inp.sizes;
  const rm = inp.reducedMotion;
  const pos = inp.positionMs / 1000;
  const dur = Math.max(inp.durationMs / 1000, L.length ? L[L.length - 1].startMs / 1000 + 4 : 4);
  const a = activeIndex(L, inp.positionMs);
  const st = (L[a]?.startMs ?? 0) / 1000;
  const nx = a + 1 < L.length ? L[a + 1].startMs / 1000 : dur;
  const span = Math.max(0.001, nx - st);
  const prog = cl((pos - st) / span);
  const rate = inp.rate > 0 ? inp.rate : 1;
  const age = (pos - st) / rate;
  const kL = rm ? cl(age / 0.2) : ease(age / 0.28);
  const kS = rm ? 1 : ease(age / 0.45);
  const estLine = S.lineFont * 1.16 * 1.5 + S.linePad * 2 + S.barH + S.barGap;
  const center = (i: number) => {
    const m = inp.measured?.[i];
    return m ? m.top + m.h / 2 : i * estLine + estLine / 2;
  };
  const y = inp.anchor - lerp(center(Math.max(0, a - 1)), center(a), a === 0 ? 1 : kS);
  const remaining = nx - pos;
  const per = Math.min(1, span / 3);
  const glowC = alpha(inp.accent, 0.6);

  const lines: LayerLine[] = L.map((line, i) => {
    const d = i - a;
    const active = d === 0;
    const blank = line.text === '';
    const opacity = lerp(opacityForDistance(d + 1), opacityForDistance(d), kL);
    const scale = rm ? 1 : lerp(d + 1 === 0 ? S.scale : 1, active ? S.scale : 1, kL);
    let dots: LayerLine['dots'] = [];
    let caption = '';
    let captionOpacity = 0;
    if (blank) {
      dots = [0, 1, 2].map((k) => {
        const f = active ? cl(((3 - k) * per - remaining) / 0.18) : 0;
        const bump = active && !rm ? Math.sin(Math.PI * cl(((3 - k) * per - remaining) / 0.32)) : 0;
        const breathe = rm ? 0.5 : 0.42 + 0.18 * Math.sin(inp.nowS * 3 + k * 0.9);
        return {
          bg: f > 0 ? mix(inp.dotIdle, inp.accent, f) : inp.dotIdle,
          opacity: f > 0 ? 1 : breathe,
          scale: 1 + 0.35 * bump,
          shadow: f > 0.5 && !inp.light ? `0 0 14px ${glowC}` : 'none',
        };
      });
      if (active) {
        caption = remaining <= 3 * per + 0.2 ? 'Get ready to sing!' : 'Breather…';
        captionOpacity = 0.8;
      }
    }
    return {
      key: `${line.startMs}-${i}`,
      text: line.text,
      blank,
      active,
      opacity,
      scale,
      progress: active ? prog : 0,
      barOpacity: active ? kL : 0,
      glow: active && !inp.light ? `0 0 30px ${glowC}` : 'none',
      dots,
      caption,
      captionOpacity,
    };
  });
  return { lines, y, active: a, activeText: L[a]?.text ?? '', prevText: a > 0 ? L[a - 1].text : '' };
}
