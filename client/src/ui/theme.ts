/**
 * Design tokens from the LiveLyrics karaoke design (Claude Design handoff,
 * LiveLyrics.dc.html). Colors are oklch so palettes blend evenly.
 */

export interface Palette {
  name: string;
  a: string;
  b: string;
  c: string;
}

export const PALETTES: readonly Palette[] = [
  { name: 'Ultraviolet', a: 'oklch(0.68 0.24 300)', b: 'oklch(0.7 0.23 345)', c: 'oklch(0.62 0.2 265)' },
  { name: 'Lagoon', a: 'oklch(0.78 0.14 200)', b: 'oklch(0.66 0.19 255)', c: 'oklch(0.74 0.15 170)' },
  { name: 'Ember', a: 'oklch(0.74 0.19 45)', b: 'oklch(0.66 0.23 18)', c: 'oklch(0.82 0.15 78)' },
  { name: 'Lime Rave', a: 'oklch(0.87 0.2 128)', b: 'oklch(0.74 0.16 168)', c: 'oklch(0.72 0.19 100)' },
  { name: 'Bubblegum', a: 'oklch(0.77 0.17 350)', b: 'oklch(0.7 0.18 312)', c: 'oklch(0.8 0.12 20)' },
  { name: 'Solar', a: 'oklch(0.87 0.17 92)', b: 'oklch(0.74 0.18 55)', c: 'oklch(0.68 0.21 32)' },
  { name: 'Night', a: 'oklch(0.74 0.15 250)', b: 'oklch(0.66 0.2 290)', c: 'oklch(0.72 0.13 215)' },
];

/** Palette used while listening, before any song is known. */
export const NIGHT = 6;

/** Status colors for the sync pill. */
export const STATUS = {
  listen: 'oklch(0.78 0.13 245)',
  sync: 'oklch(0.85 0.15 85)',
  lock: 'oklch(0.82 0.17 150)',
  drift: 'oklch(0.76 0.17 50)',
} as const;

/** Stable palette per song: a hash of artist and title picks one of the song palettes (never Night). */
export function paletteIndexFor(title: string, artist: string): number {
  const key = `${artist.trim().toLowerCase()}|${title.trim().toLowerCase()}`;
  let h = 2166136261;
  for (let i = 0; i < key.length; i++) {
    h ^= key.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return (h >>> 0) % NIGHT;
}

export interface Sizes {
  tv: boolean;
  pad: number;
  headerTop: number;
  pillH: number;
  pillFont: number;
  pillDot: number;
  smallFont: number;
  titleTop: number;
  titleFont: number;
  artistFont: number;
  vpTop: number;
  vpBottom: number;
  lineFont: number;
  scale: number;
  linePad: number;
  barW: number;
  barH: number;
  barGap: number;
  dot: number;
  dotGap: number;
  dotRow: number;
  capH: number;
  ring: number;
  eqW: number;
  eqH: number;
  eqGap: number;
  listenCopy: number;
  copyMax: number;
  gap: number;
  listenPadB: number;
  copyBlock: number;
  conf: number;
  grav: number;
  idleHead: number;
  idleSub: number;
  listenBtn: number;
  listenFont: number;
  mini: number;
  nextFont: number;
  msgFont: number;
}

/**
 * Phone and TV scales from the design. Top offsets are smaller than the
 * prototype's because the real app has no fake status bar; the safe-area
 * inset is added in CSS.
 */
export const PHONE: Sizes = {
  tv: false, pad: 24, headerTop: 16, pillH: 32, pillFont: 14, pillDot: 8, smallFont: 13, titleTop: 60, titleFont: 21, artistFont: 15,
  vpTop: 126, vpBottom: 128, lineFont: 30, scale: 1.08, linePad: 11, barW: 150, barH: 4, barGap: 12, dot: 13, dotGap: 14, dotRow: 35,
  capH: 16, ring: 216, eqW: 10, eqH: 66, eqGap: 7, listenCopy: 31, copyMax: 330, gap: 34, listenPadB: 110, copyBlock: 92, conf: 250,
  grav: 460, idleHead: 50, idleSub: 18, listenBtn: 178, listenFont: 24, mini: 22, nextFont: 18, msgFont: 36,
};

export const TV: Sizes = {
  tv: true, pad: 96, headerTop: 56, pillH: 44, pillFont: 20, pillDot: 11, smallFont: 19, titleTop: 120, titleFont: 34, artistFont: 22,
  vpTop: 200, vpBottom: 120, lineFont: 60, scale: 1.2, linePad: 16, barW: 420, barH: 6, barGap: 18, dot: 22, dotGap: 22, dotRow: 70,
  capH: 24, ring: 340, eqW: 16, eqH: 110, eqGap: 12, listenCopy: 64, copyMax: 1100, gap: 48, listenPadB: 40, copyBlock: 140, conf: 420,
  grav: 800, idleHead: 120, idleSub: 30, listenBtn: 260, listenFont: 34, mini: 34, nextFont: 30, msgFont: 72,
};

/** TV scale for wide landscape screens (laptop or TV in party mode). */
export function sizesFor(width: number, height: number): Sizes {
  return width >= 1100 && width > height ? TV : PHONE;
}

export interface Theme {
  light: boolean;
  bg: string;
  ink: string;
  chip: string;
  chipStrong: string;
  solid: string;
  track: string;
  blobOp: number;
  vignette: string;
  dotIdle: string;
}

export const DARK: Theme = {
  light: false, bg: '#0E0F14', ink: '#F6F5FA', chip: 'rgba(255,255,255,.09)', chipStrong: 'rgba(255,255,255,.14)',
  solid: 'rgba(28,29,36,.92)', track: 'rgba(255,255,255,.17)', blobOp: 0.42, dotIdle: 'rgba(255,255,255,.28)',
  vignette: 'linear-gradient(180deg, rgba(14,15,20,.85) 0%, rgba(14,15,20,0) 24%, rgba(14,15,20,0) 68%, rgba(14,15,20,.9) 100%)',
};

export const LIGHT: Theme = {
  light: true, bg: '#F4F2F7', ink: '#16141B', chip: 'rgba(22,20,27,.07)', chipStrong: 'rgba(22,20,27,.11)',
  solid: 'rgba(244,242,247,.94)', track: 'rgba(22,20,27,.16)', blobOp: 0.5, dotIdle: 'rgba(22,20,27,.22)',
  vignette: 'linear-gradient(180deg, rgba(244,242,247,.9) 0%, rgba(244,242,247,0) 24%, rgba(244,242,247,0) 70%, rgba(244,242,247,.92) 100%)',
};

export const cl = (x: number) => Math.min(1, Math.max(0, x));
/** Ease out cubic. */
export const ease = (x: number) => 1 - Math.pow(1 - cl(x), 3);
/** Ease out back (small overshoot), for pops. */
export const back = (x: number) => {
  const v = cl(x);
  const c1 = 1.70158;
  const c3 = c1 + 1;
  return 1 + c3 * Math.pow(v - 1, 3) + c1 * Math.pow(v - 1, 2);
};
export const lerp = (a: number, b: number, k: number) => a + (b - a) * k;
export const mix = (c1: string, c2: string, k: number) =>
  k <= 0.001 ? c1 : k >= 0.999 ? c2 : `color-mix(in oklch, ${c2} ${Math.round(k * 100)}%, ${c1})`;
export const alpha = (c: string, a: number) => `color-mix(in oklch, ${c} ${Math.round(a * 100)}%, transparent)`;

export function formatSeconds(s: number): string {
  const v = Math.max(0, Math.floor(s));
  return `${Math.floor(v / 60)}:${String(v % 60).padStart(2, '0')}`;
}

/** "Sped up 1.1×" or "Slowed 0.85×", or null when the rate is close to normal. */
export function speedLabel(rate: number, threshold = 0.04): string | null {
  if (!Number.isFinite(rate) || Math.abs(rate - 1) < threshold) return null;
  const r = Number(rate.toFixed(2));
  return rate > 1 ? `Sped up ${r}×` : `Slowed ${r}×`;
}
