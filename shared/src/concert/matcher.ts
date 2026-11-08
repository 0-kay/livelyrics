import { CONCERT_CONFIG, type ConcertConfig } from '../clock/config.js';
import type { LyricLine, TranscriptLineMatch } from '../types.js';

/** Lowercase, strip accents and punctuation, collapse whitespace. */
export function normalizeText(s: string): string {
  return s
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/['’`]/g, '')
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .trim();
}

export function wordCount(normalized: string): number {
  return normalized ? normalized.split(' ').length : 0;
}

/**
 * Fuzzy substring alignment (semi-global edit distance): the whole needle is
 * aligned against the best matching substring of the haystack. Returns a
 * similarity score in 0..1 (1 - distance / needle length) and the index in
 * the haystack just after the aligned substring.
 */
export function fuzzySubstring(needle: string, haystack: string): { score: number; end: number } {
  const n = needle.length;
  const m = haystack.length;
  if (n === 0) return { score: 0, end: 0 };
  if (m === 0) return { score: 0, end: 0 };
  // prev[j]: distance aligning needle[0..i) ending at haystack position j. Free start in haystack.
  let prev = new Array<number>(m + 1).fill(0);
  let cur = new Array<number>(m + 1).fill(0);
  for (let i = 1; i <= n; i++) {
    cur[0] = i;
    const c = needle.charCodeAt(i - 1);
    for (let j = 1; j <= m; j++) {
      const sub = prev[j - 1] + (c === haystack.charCodeAt(j - 1) ? 0 : 1);
      const del = prev[j] + 1;
      const ins = cur[j - 1] + 1;
      cur[j] = sub < del ? (sub < ins ? sub : ins) : del < ins ? del : ins;
    }
    [prev, cur] = [cur, prev];
  }
  let best = Infinity;
  let end = 0;
  for (let j = 0; j <= m; j++) {
    // Ties go to the later end so a match covering more of the line wins.
    if (prev[j] <= best) {
      best = prev[j];
      end = j;
    }
  }
  return { score: Math.max(0, 1 - best / n), end };
}

/** Where a transcript sits in the lyrics. Only confident matches may re-anchor. */
export type LineMatch = TranscriptLineMatch;

export interface MatchOptions {
  /** Current clock position. When set, only lines near it are searched. */
  aroundMs?: number | null;
  config?: Partial<ConcertConfig>;
}

interface Candidate {
  score: number;
  positionMs: number;
  lineIndex: number;
  text: string;
}

/**
 * Find where a transcript of sung words sits in the lyrics. Candidates are
 * spans of one to three consecutive non-empty lines inside the search window.
 */
export function matchTranscript(transcript: string, lines: readonly LyricLine[], opts: MatchOptions = {}): LineMatch | null {
  const cfg: ConcertConfig = { ...CONCERT_CONFIG, ...opts.config };
  const needle = normalizeText(transcript);
  if (wordCount(needle) < cfg.minWords) return null;

  const around = opts.aroundMs ?? null;
  const lo = around === null ? -Infinity : around - cfg.windowBeforeMs;
  const hi = around === null ? Infinity : around + cfg.windowAfterMs;
  const usable: number[] = [];
  for (let i = 0; i < lines.length; i++) {
    if (lines[i].startMs >= lo && lines[i].startMs <= hi && normalizeText(lines[i].text)) usable.push(i);
  }
  if (usable.length === 0) return null;

  const lineEnd = (i: number) => (i + 1 < lines.length ? lines[i + 1].startMs : lines[i].startMs + cfg.lastLineDurationMs);

  const candidates: Candidate[] = [];
  for (let a = 0; a < usable.length; a++) {
    for (let len = 1; len <= 3 && a + len <= usable.length; len++) {
      const idx = usable.slice(a, a + len);
      // Only join lines that follow each other directly (ignoring blank lines).
      if (len > 1 && idx[len - 1] - idx[len - 2] > 2) break;
      const parts = idx.map((i) => normalizeText(lines[i].text));
      const joined = parts.join(' ');
      const { score, end } = fuzzySubstring(needle, joined);
      // Map the end of the alignment back to a line and a fraction of it.
      let offset = 0;
      let k = 0;
      while (k < parts.length - 1 && end > offset + parts[k].length) {
        offset += parts[k].length + 1;
        k++;
      }
      const li = idx[k];
      const frac = Math.min(1, Math.max(0, (end - offset) / Math.max(1, parts[k].length)));
      const positionMs = lines[li].startMs + frac * (lineEnd(li) - lines[li].startMs);
      candidates.push({ score, positionMs, lineIndex: li, text: idx.map((i) => lines[i].text).join(' / ') });
    }
  }

  candidates.sort((x, y) => y.score - x.score || x.text.length - y.text.length);
  const best = candidates[0];
  const rival = candidates.find((c) => Math.abs(c.positionMs - best.positionMs) > cfg.confirmToleranceMs);
  const ambiguous = rival !== undefined && best.score - rival.score < cfg.minMargin;
  return {
    lineIndex: best.lineIndex,
    startMs: lines[best.lineIndex].startMs,
    positionMs: Math.round(best.positionMs),
    score: Math.round(best.score * 1000) / 1000,
    ambiguous,
    confident: !ambiguous && best.score >= cfg.minScore,
    text: best.text,
  };
}
