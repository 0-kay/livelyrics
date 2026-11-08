import multipart from '@fastify/multipart';
import Fastify, { type FastifyInstance } from 'fastify';
import type { HealthResponse, IdentifyResponse, ProviderMode, SyncedLyrics, TrackMatch } from '@livelyrics/shared';
import { MemoryLruCache, type Cache } from './cache.js';
import type { Providers } from './providers/index.js';

export interface AppDeps {
  mode: ProviderMode;
  providers: Providers;
  /** Lyrics cache. `null` values record "no lyrics found" to avoid refetching. */
  lyricsCache?: Cache<SyncedLyrics | null>;
  maxUploadBytes?: number;
  logger?: boolean;
}

const ALLOWED_MIME = /^(audio\/(wav|x-wav|wave|webm|ogg|mp4|mpeg|aac|x-m4a)|video\/webm)(;.*)?$/i;

export function lyricsCacheKey(m: Pick<TrackMatch, 'title' | 'artist' | 'durationMs'>): string {
  const norm = (s: string) => s.trim().toLowerCase().replace(/\s+/g, ' ');
  // Bucket duration to 2s so tiny provider differences share an entry.
  return `${norm(m.artist)}|${norm(m.title)}|${Math.round(m.durationMs / 2000)}`;
}

export async function buildApp(deps: AppDeps): Promise<FastifyInstance> {
  const maxUploadBytes = deps.maxUploadBytes ?? 5 * 1024 * 1024;
  const lyricsCache = deps.lyricsCache ?? new MemoryLruCache<SyncedLyrics | null>();
  const app = Fastify({ logger: deps.logger ?? false });

  await app.register(multipart, { limits: { fileSize: maxUploadBytes, files: 1, fields: 5 } });

  app.get('/api/health', async (): Promise<HealthResponse> => ({ ok: true, mode: deps.mode }));

  app.post('/api/identify', async (req, reply) => {
    const started = Date.now();
    if (!req.isMultipart()) return reply.code(415).send({ error: 'Expected multipart/form-data with an "audio" file' });

    const file = await req.file();
    if (!file || file.fieldname !== 'audio') {
      return reply.code(400).send({ error: 'Missing "audio" file field' });
    }
    if (!ALLOWED_MIME.test(file.mimetype)) {
      return reply.code(415).send({ error: `Unsupported audio type: ${file.mimetype}` });
    }
    let audio: Buffer;
    try {
      audio = await file.toBuffer();
    } catch {
      return reply.code(413).send({ error: `Audio exceeds ${maxUploadBytes} bytes` });
    }
    if (audio.length === 0) return reply.code(400).send({ error: 'Empty audio file' });

    let match: TrackMatch | null;
    try {
      match = await deps.providers.recognition.identify(audio, file.mimetype);
    } catch (err) {
      req.log.error({ err }, 'recognition failed');
      return reply.code(502).send({ error: 'Recognition provider failed' });
    }

    let lyrics: SyncedLyrics | null = null;
    let lyricsCached = false;
    if (match) {
      const key = lyricsCacheKey(match);
      const cached = await lyricsCache.get(key);
      if (cached !== undefined) {
        lyrics = cached;
        lyricsCached = true;
      } else {
        try {
          lyrics = await deps.providers.lyrics.getSynced({
            title: match.title,
            artist: match.artist,
            album: match.album,
            durationMs: match.durationMs || undefined,
          });
          // Cache misses for a shorter time so newly added lyrics show up.
          await lyricsCache.set(key, lyrics, lyrics ? undefined : 60 * 60 * 1000);
        } catch (err) {
          req.log.warn({ err }, 'lyrics lookup failed');
          lyrics = null;
        }
      }
    }

    const body: IdentifyResponse = { match, lyrics, lyricsCached, processingMs: Date.now() - started };
    return body;
  });

  return app;
}
