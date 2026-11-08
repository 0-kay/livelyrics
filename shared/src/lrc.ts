import type { LyricLine } from './types.js';

export interface ParsedLrc {
  lines: LyricLine[];
  /** Metadata tags such as ti, ar, al, length. */
  meta: Record<string, string>;
  /** Global offset in ms from the [offset:] tag. Already applied to lines. */
  offsetMs: number;
}

export interface ParseLrcOptions {
  /** Keep lines with empty text (instrumental gaps). Default true. */
  keepEmpty?: boolean;
}

const TIME_TAG = /\[(\d{1,3}):(\d{1,2})(?:[.:](\d{1,3}))?\]/g;
const META_TAG = /^\[([a-zA-Z#]+):([^\]]*)\]\s*$/;

function fractionToMs(frac: string | undefined): number {
  if (!frac) return 0;
  // "5" -> 500ms, "05" -> 50ms, "005" -> 5ms
  return Math.round(Number(`0.${frac}`) * 1000);
}

/**
 * Parse LRC text into time-sorted lines.
 * Handles multiple timestamps per line, the [offset:] tag (positive means
 * lyrics appear earlier, per the LRC convention), metadata tags, CRLF input,
 * and empty lines.
 */
export function parseLrc(input: string, options: ParseLrcOptions = {}): ParsedLrc {
  const keepEmpty = options.keepEmpty ?? true;
  const meta: Record<string, string> = {};
  const raw: LyricLine[] = [];

  for (const rawLine of input.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line) continue;

    TIME_TAG.lastIndex = 0;
    const stamps: number[] = [];
    let lastEnd = 0;
    let m: RegExpExecArray | null;
    // Timestamps must be a contiguous prefix: "[00:01.00][00:20.00]text".
    while ((m = TIME_TAG.exec(line)) !== null) {
      if (m.index !== lastEnd) break;
      const min = Number(m[1]);
      const sec = Number(m[2]);
      stamps.push(min * 60_000 + sec * 1000 + fractionToMs(m[3]));
      lastEnd = TIME_TAG.lastIndex;
    }

    if (stamps.length === 0) {
      const mm = META_TAG.exec(line);
      if (mm) meta[mm[1].toLowerCase()] = mm[2].trim();
      continue;
    }

    // Strip inline word-level tags like <00:01.20> (enhanced LRC).
    const text = line.slice(lastEnd).replace(/<\d{1,3}:\d{1,2}(?:[.:]\d{1,3})?>/g, '').trim();
    if (!text && !keepEmpty) continue;
    for (const startMs of stamps) raw.push({ startMs, text });
  }

  const offsetMs = Number.parseInt(meta.offset ?? '0', 10) || 0;
  const lines = raw
    .map((l, i) => ({ ...l, i, startMs: Math.max(0, l.startMs - offsetMs) }))
    .sort((a, b) => a.startMs - b.startMs || a.i - b.i)
    .map(({ startMs, text }) => ({ startMs, text }));

  return { lines, meta, offsetMs };
}

/** Serialize lines back to LRC (used for fixtures and debugging). */
export function formatLrcTime(ms: number): string {
  const total = Math.max(0, Math.round(ms / 10));
  const min = Math.floor(total / 6000);
  const sec = Math.floor((total % 6000) / 100);
  const cs = total % 100;
  return `[${String(min).padStart(2, '0')}:${String(sec).padStart(2, '0')}.${String(cs).padStart(2, '0')}]`;
}
