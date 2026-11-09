import type { LyricLine, SyncedLyrics, TrackMatch } from '@livelyrics/shared';
import { prepareLines } from './lyricsLayout.js';
import { NIGHT, paletteIndexFor } from './theme.js';

/** The song the screen shows. It outlives a lost lock so the screen never goes blank. */
export interface DisplaySong {
  key: string;
  title: string;
  artist: string;
  durationMs: number;
  /** Prepared lines, or null for instrumental or missing lyrics. */
  lines: LyricLine[] | null;
  instrumental: boolean;
  noLyrics: boolean;
  /** Palette index for this song and the one it blends from. */
  pal: number;
  fromPal: number;
  /** Wall ms when this song was first matched (drives the reveal). */
  matchedAt: number;
  /** Wall ms when the session lost the song, or null while it is current. */
  lostAt: number | null;
  /** The song before, for the crossfade. */
  prev: { key: string; lines: LyricLine[]; durationMs: number; posMs: number } | null;
  /** The lyrics object these lines came from, to skip re-preparing. */
  source: SyncedLyrics | null;
}

export interface DisplayInput {
  running: boolean;
  track: TrackMatch | null;
  lyrics: SyncedLyrics | null;
}

export const trackKey = (t: { title: string; artist: string }) => `${t.artist.trim().toLowerCase()}|${t.title.trim().toLowerCase()}`;

function lyricFields(lyrics: SyncedLyrics | null) {
  const instrumental = Boolean(lyrics?.instrumental);
  const lines = lyrics && !instrumental && lyrics.lines.length ? prepareLines(lyrics.lines) : null;
  return { lines, instrumental, noLyrics: !instrumental && !lines, source: lyrics };
}

/**
 * Next display song from the latest session snapshot. Keeps the last song
 * (marked lost) when the session drops it, and records the previous song on a
 * change so the old lyrics can fade out while the new ones rise.
 */
export function reduceDisplay(
  d: DisplaySong | null,
  inp: DisplayInput,
  nowMs: number,
  lastPos: { key: string; posMs: number } | null,
): DisplaySong | null {
  if (!inp.running) return null;
  const t = inp.track;
  if (!t) {
    if (d && d.lostAt === null) return { ...d, lostAt: nowMs };
    return d;
  }
  const key = trackKey(t);
  if (d && d.key === key) {
    const lyricsChanged = inp.lyrics !== d.source;
    if (d.lostAt === null && !lyricsChanged) return d;
    return { ...d, lostAt: null, durationMs: t.durationMs, ...(lyricsChanged ? lyricFields(inp.lyrics) : {}) };
  }
  const prev =
    d && d.lines
      ? { key: d.key, lines: d.lines, durationMs: d.durationMs, posMs: lastPos && lastPos.key === d.key ? lastPos.posMs : d.durationMs }
      : null;
  return {
    key,
    title: t.title,
    artist: t.artist,
    durationMs: t.durationMs,
    ...lyricFields(inp.lyrics),
    pal: paletteIndexFor(t.title, t.artist),
    fromPal: d ? d.pal : NIGHT,
    matchedAt: nowMs,
    lostAt: null,
    prev,
  };
}
