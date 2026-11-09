import { createHmac } from 'node:crypto';
import type { RecognitionProvider, TrackMatch } from '@livelyrics/shared';
import { audioBlob, extensionFor, ProviderError, type FetchLike } from './http.js';

export interface AcrCloudOptions {
  host: string;
  accessKey: string;
  accessSecret: string;
  fetch?: FetchLike;
  now?: () => number;
  timeoutMs?: number;
}

interface AcrMusic {
  title?: string;
  artists?: { name?: string }[];
  album?: { name?: string };
  duration_ms?: number;
  play_offset_ms?: number;
  sample_begin_time_offset_ms?: number;
  sample_end_time_offset_ms?: number;
  db_begin_time_offset_ms?: number;
  db_end_time_offset_ms?: number;
  score?: number;
  external_ids?: { isrc?: string };
}

interface AcrResponse {
  status?: { code?: number; msg?: string };
  metadata?: { music?: AcrMusic[] };
}

/** Length of a PCM WAV clip in ms from its header, or null for other formats. */
export function wavDurationMs(buf: Buffer): number | null {
  if (buf.length < 44 || buf.toString('ascii', 0, 4) !== 'RIFF' || buf.toString('ascii', 8, 12) !== 'WAVE') return null;
  let off = 12;
  let byteRate = 0;
  while (off + 8 <= buf.length) {
    const id = buf.toString('ascii', off, off + 4);
    const size = buf.readUInt32LE(off + 4);
    if (id === 'fmt ' && off + 16 <= buf.length) byteRate = buf.readUInt32LE(off + 16);
    if (id === 'data') {
      const bytes = Math.min(size, buf.length - off - 8);
      return byteRate > 0 ? (bytes / byteRate) * 1000 : null;
    }
    off += 8 + size + (size % 2);
  }
  return null;
}

/**
 * Song position at the very end of the clip. ACRCloud reports which part of
 * the clip matched (sample_*_time_offset_ms) and where that part sits in the
 * song (db_*_time_offset_ms), so position at clip end = db_end + (clip length
 * - sample_end). This is tighter than play_offset_ms, which does not line up
 * with the clip end exactly. Falls back to play_offset_ms when a field is missing
 * or the numbers do not make sense.
 */
export function positionAtClipEnd(m: AcrMusic, clipMs: number | null): number {
  const play = m.play_offset_ms ?? 0;
  const { sample_end_time_offset_ms: se, db_end_time_offset_ms: de } = m;
  if (clipMs === null || se === undefined || de === undefined || de <= 0 || se <= 0) return play;
  const tail = clipMs - se;
  if (tail < -500 || tail > clipMs) return play;
  const pos = de + Math.max(0, tail);
  // Guard against odd responses: stay within a few seconds of play_offset_ms.
  return Math.abs(pos - play) <= 4_000 ? Math.round(pos) : play;
}

/** ACRCloud "identify" API (v1). https://docs.acrcloud.com/reference/identification-api */
export class AcrCloudRecognitionProvider implements RecognitionProvider {
  private readonly fetch: FetchLike;
  private readonly now: () => number;

  constructor(private readonly opts: AcrCloudOptions) {
    this.fetch = opts.fetch ?? globalThis.fetch;
    this.now = opts.now ?? Date.now;
  }

  static sign(accessKey: string, accessSecret: string, timestamp: string): string {
    const toSign = ['POST', '/v1/identify', accessKey, 'audio', '1', timestamp].join('\n');
    return createHmac('sha1', accessSecret).update(toSign).digest('base64');
  }

  async identify(audio: Buffer, mime: string): Promise<TrackMatch | null> {
    const timestamp = String(Math.floor(this.now() / 1000));
    const form = new FormData();
    form.set('access_key', this.opts.accessKey);
    form.set('data_type', 'audio');
    form.set('signature_version', '1');
    form.set('signature', AcrCloudRecognitionProvider.sign(this.opts.accessKey, this.opts.accessSecret, timestamp));
    form.set('sample_bytes', String(audio.length));
    form.set('timestamp', timestamp);
    form.set('sample', audioBlob(audio, mime), `sample.${extensionFor(mime)}`);

    const res = await this.fetch(`https://${this.opts.host}/v1/identify`, {
      method: 'POST',
      body: form,
      signal: AbortSignal.timeout(this.opts.timeoutMs ?? 10_000),
    });
    if (!res.ok) throw new ProviderError(`ACRCloud HTTP ${res.status}`, 'acrcloud', res.status);
    const body = (await res.json()) as AcrResponse;
    const code = body.status?.code;
    if (code === 1001) return null; // No result
    if (code !== 0) {
      throw new ProviderError(`ACRCloud error ${code}: ${body.status?.msg ?? 'unknown'}`, 'acrcloud');
    }
    const m = body.metadata?.music?.[0];
    if (!m?.title) return null;
    return {
      title: m.title,
      artist: (m.artists ?? []).map((a) => a.name).filter(Boolean).join(', ') || 'Unknown',
      album: m.album?.name,
      durationMs: m.duration_ms ?? 0,
      playOffsetMs: positionAtClipEnd(m, wavDurationMs(audio)),
      isrc: m.external_ids?.isrc,
      score: m.score ?? 0,
    };
  }
}
