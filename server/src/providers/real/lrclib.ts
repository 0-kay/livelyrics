import { parseLrc, type LyricsProvider, type LyricsQuery, type SyncedLyrics } from '@livelyrics/shared';
import { ProviderError, type FetchLike } from './http.js';

export interface LrclibOptions {
  userAgent: string;
  baseUrl?: string;
  fetch?: FetchLike;
  timeoutMs?: number;
}

interface LrclibRecord {
  trackName?: string;
  artistName?: string;
  duration?: number; // seconds
  instrumental?: boolean;
  syncedLyrics?: string | null;
}

/** LRCLIB lyrics API. https://lrclib.net/docs (personal use only, see SPEC.md). */
export class LrclibLyricsProvider implements LyricsProvider {
  private readonly fetch: FetchLike;
  private readonly baseUrl: string;

  constructor(private readonly opts: LrclibOptions) {
    this.fetch = opts.fetch ?? globalThis.fetch;
    this.baseUrl = opts.baseUrl ?? 'https://lrclib.net';
  }

  private async request(path: string, params: Record<string, string | undefined>): Promise<Response> {
    const url = new URL(path, this.baseUrl);
    for (const [k, v] of Object.entries(params)) if (v) url.searchParams.set(k, v);
    return this.fetch(url, {
      headers: { 'User-Agent': this.opts.userAgent, Accept: 'application/json' },
      signal: AbortSignal.timeout(this.opts.timeoutMs ?? 8_000),
    });
  }

  private toResult(rec: LrclibRecord): SyncedLyrics | null {
    const durationMs = rec.duration ? Math.round(rec.duration * 1000) : undefined;
    if (rec.instrumental) return { lines: [], instrumental: true, durationMs };
    if (!rec.syncedLyrics) return null;
    const lines = parseLrc(rec.syncedLyrics).lines;
    if (lines.length === 0) return null;
    return { lines, instrumental: false, durationMs };
  }

  async getSynced(q: LyricsQuery): Promise<SyncedLyrics | null> {
    // 1. Exact signature lookup (needs duration for best results).
    const res = await this.request('/api/get', {
      track_name: q.title,
      artist_name: q.artist,
      album_name: q.album,
      duration: q.durationMs ? String(Math.round(q.durationMs / 1000)) : undefined,
    });
    if (res.ok) {
      const found = this.toResult((await res.json()) as LrclibRecord);
      if (found) return found;
    } else if (res.status !== 404) {
      throw new ProviderError(`LRCLIB HTTP ${res.status}`, 'lrclib', res.status);
    }

    // 2. Fall back to search; pick the synced result closest in duration.
    const sres = await this.request('/api/search', { track_name: q.title, artist_name: q.artist });
    if (!sres.ok) {
      if (sres.status === 404) return null;
      throw new ProviderError(`LRCLIB HTTP ${sres.status}`, 'lrclib', sres.status);
    }
    const records = ((await sres.json()) as LrclibRecord[]).filter((r) => r.syncedLyrics || r.instrumental);
    if (records.length === 0) return null;
    const target = q.durationMs ? q.durationMs / 1000 : undefined;
    if (target !== undefined) {
      records.sort((a, b) => Math.abs((a.duration ?? 0) - target) - Math.abs((b.duration ?? 0) - target));
    }
    for (const r of records) {
      const out = this.toResult(r);
      if (out) return out;
    }
    return null;
  }
}
