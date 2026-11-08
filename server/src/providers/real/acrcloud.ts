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
  score?: number;
  external_ids?: { isrc?: string };
}

interface AcrResponse {
  status?: { code?: number; msg?: string };
  metadata?: { music?: AcrMusic[] };
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
      playOffsetMs: m.play_offset_ms ?? 0,
      isrc: m.external_ids?.isrc,
      score: m.score ?? 0,
    };
  }
}
