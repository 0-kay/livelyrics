import type { IncomingMessage, ServerResponse } from 'node:http';
import type { FastifyInstance } from 'fastify';
import { buildApp } from './app.js';
import { loadConfig } from './config.js';
import { createProviders } from './providers/index.js';

/** Vercel caps request bodies at 4.5 MB; a 6s clip is about 200 KB. */
const VERCEL_MAX_UPLOAD = 4 * 1024 * 1024;

let appPromise: Promise<FastifyInstance> | null = null;

/** One app per warm function instance; the lyrics cache lives as long as the instance. */
export function getApp(env: NodeJS.ProcessEnv = process.env): Promise<FastifyInstance> {
  if (!appPromise) {
    appPromise = (async () => {
      const config = loadConfig(env);
      const app = await buildApp({
        mode: config.mode,
        providers: createProviders(config),
        maxUploadBytes: VERCEL_MAX_UPLOAD,
        concertMode: config.concertMode,
        accessPassword: config.accessPassword,
        logger: false,
      });
      await app.ready();
      return app;
    })().catch((e) => {
      appPromise = null;
      throw e;
    });
  }
  return appPromise;
}

/**
 * vercel.json rewrites /api/<path> to this one function; Vercel passes <path> as ?__path=.
 * Put the original path back so Fastify routes it (works whether or not the
 * platform already kept the original URL).
 */
export function originalUrl(url: string | undefined): string {
  const u = new URL(url ?? '/', 'http://x');
  const p = u.searchParams.get('__path');
  u.searchParams.delete('__path');
  const path = p !== null && (u.pathname === '/api' || u.pathname === '/api/') ? `/api/${p.replace(/^\/+/, '')}` : u.pathname;
  const q = u.searchParams.toString();
  return q ? `${path}?${q}` : path;
}

/** Vercel serverless entry: hands the Node request to Fastify. */
export default async function handler(req: IncomingMessage, res: ServerResponse): Promise<void> {
  try {
    req.url = originalUrl(req.url);
    const app = await getApp();
    app.server.emit('request', req, res);
  } catch (e) {
    res.statusCode = 500;
    res.setHeader('content-type', 'application/json');
    res.end(JSON.stringify({ error: e instanceof Error ? e.message : String(e) }));
  }
}

/** For tests: forget the cached app. */
export function resetApp(): void {
  appPromise = null;
}
