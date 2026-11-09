import { describe, expect, it } from 'vitest';
import type { SyncedLyrics, TrackMatch } from '@livelyrics/shared';
import { reduceDisplay } from '../src/ui/displaySong.js';
import { listenCopy, LONG_COPY, MISS_COPY, BUFFER_COPY, SEARCH_COPY } from '../src/ui/listenCopy.js';
import { activeIndex, computeLayer, opacityForDistance, prepareLines, type LayerInput } from '../src/ui/lyricsLayout.js';
import { beatFx, FlashLimiter } from '../src/ui/beatFx.js';
import { NIGHT, PHONE, paletteIndexFor, sizesFor, speedLabel, TV } from '../src/ui/theme.js';

const lines = [
  { startMs: 0, text: '' },
  { startMs: 4000, text: 'Line one' },
  { startMs: 7000, text: 'Line two' },
  { startMs: 10000, text: '' },
  { startMs: 13000, text: 'Line three' },
];

const layerInput = (positionMs: number, extra: Partial<LayerInput> = {}): LayerInput => ({
  lines, durationMs: 20000, positionMs, rate: 1, sizes: PHONE, anchor: 200, reducedMotion: false,
  light: false, accent: 'red', dotIdle: 'grey', nowS: 0, measured: null, ...extra,
});

describe('prepareLines', () => {
  it('adds an intro breather when the first line starts late', () => {
    const out = prepareLines([{ startMs: 5000, text: 'Hi' }]);
    expect(out).toEqual([{ startMs: 0, text: '' }, { startMs: 5000, text: 'Hi' }]);
  });
  it('keeps a song that starts right away as is', () => {
    expect(prepareLines([{ startMs: 500, text: 'Go' }])).toEqual([{ startMs: 500, text: 'Go' }]);
  });
  it('adds a breather before long gaps, 6s ahead of the next line', () => {
    const out = prepareLines([{ startMs: 0, text: 'A' }, { startMs: 30000, text: 'B' }]);
    expect(out.map((l) => l.startMs)).toEqual([0, 24000, 30000]);
    expect(out[1].text).toBe('');
  });
  it('sorts and trims lines', () => {
    const out = prepareLines([{ startMs: 900, text: ' b ' }, { startMs: 100, text: 'a' }]);
    expect(out.map((l) => l.text)).toEqual(['a', 'b']);
  });
});

describe('computeLayer', () => {
  it('finds the active line', () => {
    expect(activeIndex(lines, 0)).toBe(0);
    expect(activeIndex(lines, 7500)).toBe(2);
    expect(activeIndex(lines, 99999)).toBe(4);
  });
  it('fades lines by distance from the active one once the change settles', () => {
    const L = computeLayer(layerInput(8500));
    expect(L.active).toBe(2);
    expect(L.lines[2].opacity).toBeCloseTo(1);
    expect(L.lines[1].opacity).toBeCloseTo(0.35);
    expect(L.lines[3].opacity).toBeCloseTo(opacityForDistance(1));
    expect(L.lines[0].opacity).toBe(0);
    expect(L.lines[2].scale).toBeCloseTo(PHONE.scale);
  });
  it('sweeps the active line from its start to the next line start', () => {
    expect(computeLayer(layerInput(5500)).lines[1].progress).toBeCloseTo(0.5);
    expect(computeLayer(layerInput(5500)).lines[2].progress).toBe(0);
  });
  it('fills the your-turn dots one by one before the next line', () => {
    const filled = (pos: number) => computeLayer(layerInput(pos)).lines[3].dots.filter((d) => d.bg !== 'grey').length;
    expect(filled(10000)).toBe(0);
    expect(filled(10200)).toBe(1);
    expect(filled(11300)).toBe(2);
    expect(filled(12300)).toBe(3);
    expect(computeLayer(layerInput(12500)).lines[3].caption).toBe('Get ready to sing!');
  });
  it('puts the active line center on the anchor using measured boxes', () => {
    const measured = lines.map((_, i) => ({ top: i * 100, h: 80 }));
    const L = computeLayer(layerInput(9000, { measured }));
    expect(L.y).toBeCloseTo(200 - (200 + 40));
  });
  it('drops scaling and eases quickly with reduced motion', () => {
    const L = computeLayer(layerInput(7100, { reducedMotion: true }));
    expect(L.lines.every((l) => l.scale === 1)).toBe(true);
  });
});

describe('listenCopy', () => {
  const base = { clipS: 6, missAgoS: null, checked: false };
  it('fills the ring while the first clip is captured', () => {
    const c = listenCopy({ ...base, elapsedS: 3, bufferedS: 3 });
    expect(c.searching).toBe(false);
    expect(c.fill).toBeCloseTo(0.5);
    expect(c.caption).toBe('Listening · 3s of 6s');
    expect(BUFFER_COPY).toContain(c.copy);
  });
  it('switches to searching copy once checks begin', () => {
    const c = listenCopy({ ...base, elapsedS: 7, bufferedS: 6, checked: true });
    expect(c.searching).toBe(true);
    expect(SEARCH_COPY).toContain(c.copy);
    expect(c.caption).toBe('Matching…');
  });
  it('says not yet right after an empty check', () => {
    const c = listenCopy({ ...base, elapsedS: 9, bufferedS: 6, checked: true, missAgoS: 1 });
    expect(c.copy).toBe(MISS_COPY);
  });
  it('nudges after a long wait', () => {
    const c = listenCopy({ ...base, elapsedS: 16, bufferedS: 6, checked: true });
    expect(LONG_COPY).toContain(c.copy);
  });
  it('keeps copy lines short', () => {
    for (const s of [...BUFFER_COPY, ...SEARCH_COPY, ...LONG_COPY, MISS_COPY]) expect(s.split(' ').length).toBeLessThanOrEqual(7);
  });
});

describe('reduceDisplay', () => {
  const track = (title: string): TrackMatch => ({ title, artist: 'X', durationMs: 60000, playOffsetMs: 0, score: 90 });
  const lyr: SyncedLyrics = { lines: [{ startMs: 0, text: 'la' }], instrumental: false };
  it('is null while not running', () => {
    expect(reduceDisplay(null, { running: false, track: track('A'), lyrics: lyr }, 0, null)).toBeNull();
  });
  it('starts a song from Night and keeps it, marked lost, when the match is dropped', () => {
    const a = reduceDisplay(null, { running: true, track: track('A'), lyrics: lyr }, 100, null)!;
    expect(a.fromPal).toBe(NIGHT);
    expect(a.matchedAt).toBe(100);
    const lost = reduceDisplay(a, { running: true, track: null, lyrics: null }, 500, null)!;
    expect(lost.lostAt).toBe(500);
    expect(lost.lines).toEqual(a.lines);
    const back = reduceDisplay(lost, { running: true, track: track('A'), lyrics: lyr }, 900, null)!;
    expect(back.lostAt).toBeNull();
    expect(back.matchedAt).toBe(100);
  });
  it('records the previous song and palette on a change', () => {
    const a = reduceDisplay(null, { running: true, track: track('A'), lyrics: lyr }, 100, null)!;
    const b = reduceDisplay(a, { running: true, track: track('B'), lyrics: lyr }, 200, { key: a.key, posMs: 4200 })!;
    expect(b.prev?.posMs).toBe(4200);
    expect(b.fromPal).toBe(a.pal);
    expect(b.matchedAt).toBe(200);
  });
  it('shows the next-song state while a change is suspected, and returns if the same song is confirmed', () => {
    const a = reduceDisplay(null, { running: true, track: track('A'), lyrics: lyr }, 100, null)!;
    const sus = reduceDisplay(a, { running: true, track: track('A'), lyrics: lyr, suspected: true }, 400, null)!;
    expect(sus.lostAt).toBe(400);
    const same = reduceDisplay(sus, { running: true, track: track('A'), lyrics: lyr, suspected: false }, 900, null)!;
    expect(same.lostAt).toBeNull();
  });
  it('marks instrumental and missing lyrics', () => {
    expect(reduceDisplay(null, { running: true, track: track('A'), lyrics: { lines: [], instrumental: true } }, 0, null)!.instrumental).toBe(true);
    expect(reduceDisplay(null, { running: true, track: track('A'), lyrics: null }, 0, null)!.noLyrics).toBe(true);
  });
  it('returns the same object when nothing changed', () => {
    const a = reduceDisplay(null, { running: true, track: track('A'), lyrics: lyr }, 100, null)!;
    expect(reduceDisplay(a, { running: true, track: track('A'), lyrics: lyr }, 300, null)).toBe(a);
  });
});

describe('theme helpers', () => {
  it('gives each song a stable song palette, never Night', () => {
    const i = paletteIndexFor('Daisy Bell', 'Harry Dacre');
    expect(paletteIndexFor(' daisy bell ', 'HARRY DACRE')).toBe(i);
    for (const t of ['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h']) expect(paletteIndexFor(t, 'z')).toBeLessThan(NIGHT);
  });
  it('labels speed changes in friendly words', () => {
    expect(speedLabel(1.0)).toBeNull();
    expect(speedLabel(1.02)).toBeNull();
    expect(speedLabel(1.1)).toBe('Sped up 1.1×');
    expect(speedLabel(0.85)).toBe('Slowed 0.85×');
  });
  it('uses the TV scale on wide landscape screens', () => {
    expect(sizesFor(390, 844)).toBe(PHONE);
    expect(sizesFor(1920, 1080)).toBe(TV);
    expect(sizesFor(1024, 1366)).toBe(PHONE);
  });
});

describe('beat effects', () => {
  const pal = { a: 'A', b: 'B', c: 'C' };
  const frame = (energy: 'calm' | 'groove' | 'hype', beatIndex = 0, pulse = 1) => ({ pulse, beatIndex, level: 0.7, energy, bpm: 120, onGrid: true, next: [] });
  it('turns everything off with reduced motion or no mic', () => {
    expect(beatFx(frame('hype'), pal, 0, new FlashLimiter(), true, 0).lights).toEqual([]);
    expect(beatFx(null, pal, 0, new FlashLimiter(), false, 0).lineScale).toBe(1);
  });
  it('picks a pattern by energy', () => {
    const lim = () => new FlashLimiter();
    expect(beatFx(frame('calm'), pal, 0, lim(), false, 0).lights).toHaveLength(0);
    expect(beatFx(frame('groove'), pal, 0, lim(), false, 0).lights).toHaveLength(2);
    const hype = beatFx(frame('hype'), pal, 0, lim(), false, 0);
    expect(hype.lights).toHaveLength(3);
    expect(hype.lineScale).toBeGreaterThan(1);
    expect(hype.lineScale).toBeLessThanOrEqual(1.03);
  });
  it('never flashes lights more than 3 times a second, even at 200 BPM', () => {
    const lim = new FlashLimiter();
    let flashes = 0;
    for (let i = 0; i < 200 * 10 / 60; i++) {
      const t = i * 300;
      if (beatFx(frame('hype', i), pal, t, lim, false, 0).lights[0]!.opacity > 0) flashes++;
    }
    expect(flashes / 10).toBeLessThanOrEqual(3);
    expect(flashes).toBeGreaterThan(10);
  });
});
