import multipart from '@fastify/multipart';
import fastifyStatic from '@fastify/static';
import { timingSafeEqual } from 'node:crypto';
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import Fastify, { type FastifyInstance } from 'fastify';
import {
  SERVER_CONFIG,
  durationScale,
  matchTranscript,
  type LyricsQuery,
  type TranscribeResponse,
  scaleLyrics,
  type HealthResponse,
  type IdentifyResponse,
  type ProviderMode,
  type SyncedLyrics,
  type TrackMatch,
} from '@livelyrics/shared';
import { MemoryLruCache, type Cache } from './cache.js';
import type { Providers } from './providers/index.js';

export interface AppDeps {
  mode: ProviderMode;
  providers: Providers;
  /** Lyrics cache. `null` values record "no lyrics found" to avoid refetching. */
  lyricsCache?: Cache<SyncedLyrics | null>;
  maxUploadBytes?: number;
  logger?: boolean;
  /** Serve a built client (index.html plus assets) from this directory. */
  staticDir?: string;
  /** Concert mode feature flag. POST /api/transcribe exists only when on and a transcription provider is set. */
  concertMode?: boolean;
  /**
   * When set, every page and API call (except /api/health) needs this
   * password through the browser's sign-in prompt (HTTP Basic, any user name).
   * Keeps a deployed copy personal.
   */
  accessPassword?: string;
}

/** True when the Authorization header carries the password (Basic auth, user name ignored). */
export function passwordMatches(header: string | undefined, password: string): boolean {
  if (!header || !header.startsWith('Basic ')) return false;
  let decoded: string;
  try {
    decoded = Buffer.from(header.slice(6).trim(), 'base64').toString('utf8');
  } catch {
    return false;
  }
  const given = Buffer.from(decoded.slice(decoded.indexOf(':') + 1));
  const want = Buffer.from(password);
  return given.length === want.length && timingSafeEqual(given, want);
}

const ALLOWED_MIME = /^(audio\/(wav|x-wav|wave|webm|ogg|mp4|mpeg|aac|x-m4a)|video\/webm)(;.*)?$/i;

export function lyricsCacheKey(m: Pick<TrackMatch, 'title' | 'artist' | 'durationMs'>): string {
  const norm = (s: string) => s.trim().toLowerCase().replace(/\s+/g, ' ');
  // Bucket duration to 2s so tiny provider differences share an entry.
  return `${norm(m.artist)}|${norm(m.title)}|${Math.round(m.durationMs / 2000)}`;
}

export async function buildApp(deps: AppDeps): Promise<FastifyInstance> {
  const maxUploadBytes = deps.maxUploadBytes ?? SERVER_CONFIG.maxUploadBytes;
  const lyricsCache = deps.lyricsCache ?? new MemoryLruCache<SyncedLyrics | null>();
  const app = Fastify({ logger: deps.logger ?? false });

  const concertMode = Boolean(deps.concertMode && deps.providers.transcription);
  if (deps.accessPassword) {
    const password = deps.accessPassword;
    app.addHook('onRequest', async (req, reply) => {
      if (req.url === '/api/health' || passwordMatches(req.headers.authorization, password)) return;
      return reply.code(401).header('WWW-Authenticate', 'Basic realm="LiveLyrics", charset="UTF-8"').send({ error: 'Password required' });
    });
  }
  await app.register(multipart, { limits: { fileSize: maxUploadBytes, files: 1, fields: 10, fieldSize: 1024 } });

  app.get('/api/health', async (): Promise<HealthResponse> => ({ ok: true, mode: deps.mode, concertMode }));

  /** Cached lyrics lookup. Returns unscaled lyrics plus whether they came from the cache. */
  async function lookupLyrics(q: LyricsQuery & { durationMs: number }, log: FastifyInstance['log']) {
    const key = lyricsCacheKey(q);
    const cached = await lyricsCache.get(key);
    if (cached !== undefined) return { lyrics: cached, cached: true };
    try {
      const lyrics = await deps.providers.lyrics.getSynced({
        title: q.title,
        artist: q.artist,
        album: q.album,
        durationMs: q.durationMs || undefined,
      });
      // Cache misses for a shorter time so newly added lyrics show up.
      await lyricsCache.set(key, lyrics, lyrics ? undefined : SERVER_CONFIG.cacheMissTtlMs);
      return { lyrics, cached: false };
    } catch (err) {
      log.warn({ err }, 'lyrics lookup failed');
      return { lyrics: null, cached: false };
    }
  }

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
      const r = await lookupLyrics(match, req.log);
      lyrics = r.lyrics;
      lyricsCached = r.cached;
    }

    // The cache keeps unscaled lyrics; scale per response to the matched track's timeline.
    const lyricsTimeScale = match && lyrics ? durationScale(match.durationMs, lyrics.durationMs) : 1;
    if (lyrics) lyrics = scaleLyrics(lyrics, lyricsTimeScale);

    const body: IdentifyResponse = {
      match,
      lyrics,
      lyricsCached,
      lyricsTimeScale,
      processingMs: Date.now() - started,
    };
    return body;
  });

  if (concertMode) {
    const transcription = deps.providers.transcription!;
    app.post('/api/transcribe', async (req, reply) => {
      const started = Date.now();
      if (!req.isMultipart()) return reply.code(415).send({ error: 'Expected multipart/form-data with an "audio" file' });

      const fields: Record<string, string> = {};
      let audio: Buffer | null = null;
      let mime = '';
      try {
        for await (const part of req.parts()) {
          if (part.type === 'field') {
            fields[part.fieldname] = String(part.value);
          } else if (part.fieldname === 'audio') {
            mime = part.mimetype;
            if (!ALLOWED_MIME.test(mime)) return reply.code(415).send({ error: `Unsupported audio type: ${mime}` });
            audio = await part.toBuffer();
          } else {
            await part.toBuffer();
          }
        }
      } catch {
        return reply.code(413).send({ error: `Audio exceeds ${maxUploadBytes} bytes` });
      }
      if (!audio) return reply.code(400).send({ error: 'Missing "audio" file field' });
      if (audio.length === 0) return reply.code(400).send({ error: 'Empty audio file' });

      const num = (v: string | undefined) => (v !== undefined && v.trim() !== '' && Number.isFinite(Number(v)) ? Number(v) : undefined);
      const durationMs = num(fields.durationMs);
      const positionMs = num(fields.positionMs);
      if (fields.durationMs !== undefined && durationMs === undefined) return reply.code(400).send({ error: 'durationMs must be a number' });
      if (fields.positionMs !== undefined && positionMs === undefined) return reply.code(400).send({ error: 'positionMs must be a number' });

      let text: string;
      try {
        text = await transcription.transcribe(audio, mime);
      } catch (err) {
        req.log.error({ err }, 'transcription failed');
        return reply.code(502).send({ error: 'Transcription provider failed' });
      }

      let match: TranscribeResponse['match'] = null;
      const title = fields.title?.trim();
      const artist = fields.artist?.trim();
      if (text && title && artist) {
        const { lyrics } = await lookupLyrics({ title, artist, album: fields.album?.trim() || undefined, durationMs: durationMs ?? 0 }, req.log);
        if (lyrics && !lyrics.instrumental) {
          // Match against the same timeline /api/identify returned to the client.
          const scaled = durationMs ? scaleLyrics(lyrics, durationScale(durationMs, lyrics.durationMs)) : lyrics;
          match = matchTranscript(text, scaled.lines, { aroundMs: positionMs ?? null });
        }
      }
      const body: TranscribeResponse = { text, match, processingMs: Date.now() - started };
      return body;
    });
  }

  if (deps.staticDir) {
    const root = resolve(deps.staticDir);
    if (!existsSync(resolve(root, 'index.html'))) throw new Error(`STATIC_DIR has no index.html: ${root}`);
    await app.register(fastifyStatic, { root, wildcard: false });
    // Single page app: unknown non-API GETs get index.html.
    app.setNotFoundHandler((req, reply) => {
      if (req.method === 'GET' && !req.url.startsWith('/api/')) return reply.sendFile('index.html');
      return reply.code(404).send({ error: 'Not found' });
    });
  }

  return app;
}
