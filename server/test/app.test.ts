import { describe, expect, it, vi } from 'vitest';
import type { SyncedLyrics } from '@livelyrics/shared';
import { buildApp, lyricsCacheKey } from '../src/app.js';
import { MemoryLruCache } from '../src/cache.js';
import { loadConfig } from '../src/config.js';
import { createProviders, MockLyricsProvider, MockRecognitionProvider, MockTranscriptionProvider } from '../src/providers/index.js';
import { multipartBody } from './helpers.js';

const audio = Buffer.alloc(4096, 7);

async function mockApp() {
  const providers = createProviders(loadConfig({ PROVIDER_MODE: 'mock' }));
  return { app: await buildApp({ mode: 'mock', providers }), providers };
}

describe('API', () => {
  it('GET /api/health reports mode', async () => {
    const { app } = await mockApp();
    const res = await app.inject({ method: 'GET', url: '/api/health' });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ ok: true, mode: 'mock', concertMode: false });
  });

  it('POST /api/identify returns match plus lyrics in mock mode', async () => {
    const { app } = await mockApp();
    const res = await app.inject({ method: 'POST', url: '/api/identify', ...multipartBody('audio', 'a.wav', 'audio/wav', audio) });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.match.title).toBe('Paper Lanterns');
    expect(body.match.playOffsetMs).toBeGreaterThanOrEqual(10_000);
    expect(body.lyrics.lines.length).toBeGreaterThan(10);
    expect(body.lyricsCached).toBe(false);
    expect(typeof body.processingMs).toBe('number');
  });

  it('is deterministic for identical audio', async () => {
    const app = await buildApp({
      mode: 'mock',
      providers: { recognition: new MockRecognitionProvider(), lyrics: new MockLyricsProvider(), transcription: null },
    });
    const req = () => app.inject({ method: 'POST', url: '/api/identify', ...multipartBody('audio', 'a.webm', 'audio/webm;codecs=opus', audio) });
    const [a, b] = [(await req()).json(), (await req()).json()];
    expect(a.match).toEqual(b.match);
    expect(b.lyricsCached).toBe(true);
  });

  it('caches lyrics so the provider is called once', async () => {
    const lyrics = new MockLyricsProvider();
    const spy = vi.spyOn(lyrics, 'getSynced');
    const app = await buildApp({
      mode: 'mock',
      providers: { recognition: new MockRecognitionProvider(), lyrics, transcription: new MockTranscriptionProvider() },
    });
    for (let i = 0; i < 3; i++) {
      await app.inject({ method: 'POST', url: '/api/identify', ...multipartBody('audio', 'a.wav', 'audio/wav', audio) });
    }
    expect(spy).toHaveBeenCalledTimes(1);
  });

  it('returns null match for tiny clips', async () => {
    const { app } = await mockApp();
    const res = await app.inject({ method: 'POST', url: '/api/identify', ...multipartBody('audio', 'a.wav', 'audio/wav', Buffer.alloc(10)) });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ match: null, lyrics: null });
  });

  it('rejects wrong field, wrong type, non-multipart, and oversize uploads', async () => {
    const { app, providers } = await mockApp();
    expect((await app.inject({ method: 'POST', url: '/api/identify', ...multipartBody('file', 'a.wav', 'audio/wav', audio) })).statusCode).toBe(400);
    expect((await app.inject({ method: 'POST', url: '/api/identify', ...multipartBody('audio', 'a.txt', 'text/plain', audio) })).statusCode).toBe(415);
    expect((await app.inject({ method: 'POST', url: '/api/identify', payload: { a: 1 } })).statusCode).toBe(415);
    const small = await buildApp({ mode: 'mock', providers, maxUploadBytes: 100 });
    expect((await small.inject({ method: 'POST', url: '/api/identify', ...multipartBody('audio', 'a.wav', 'audio/wav', audio) })).statusCode).toBe(413);
  });

  it('maps recognition failures to 502 and survives lyrics failures', async () => {
    const failing = await buildApp({
      mode: 'real',
      providers: {
        recognition: { identify: async () => { throw new Error('boom'); } },
        lyrics: new MockLyricsProvider(),
        transcription: null,
      },
    });
    expect((await failing.inject({ method: 'POST', url: '/api/identify', ...multipartBody('audio', 'a.wav', 'audio/wav', audio) })).statusCode).toBe(502);

    const noLyrics = await buildApp({
      mode: 'real',
      providers: {
        recognition: new MockRecognitionProvider(1000),
        lyrics: { getSynced: async () => { throw new Error('down'); } },
        transcription: null,
      },
    });
    const res = await noLyrics.inject({ method: 'POST', url: '/api/identify', ...multipartBody('audio', 'a.wav', 'audio/wav', audio) });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ match: { playOffsetMs: 1000 }, lyrics: null });
  });
});

describe('cache', () => {
  it('evicts least recently used and expires by TTL', async () => {
    let now = 0;
    const c = new MemoryLruCache<number>(2, 1000, () => now);
    await c.set('a', 1);
    await c.set('b', 2);
    await c.get('a');
    await c.set('c', 3);
    expect(await c.get('b')).toBeUndefined();
    expect(await c.get('a')).toBe(1);
    now = 2000;
    expect(await c.get('a')).toBeUndefined();
  });

  it('can store null as a cached miss', async () => {
    const c = new MemoryLruCache<SyncedLyrics | null>();
    await c.set('x', null);
    expect(await c.get('x')).toBeNull();
  });

  it('builds normalized keys', () => {
    expect(lyricsCacheKey({ title: ' Song  A ', artist: 'BAND', durationMs: 180_400 })).toBe(
      lyricsCacheKey({ title: 'song a', artist: 'band', durationMs: 179_900 }),
    );
  });
});

describe('config and provider selection', () => {
  it('defaults to mock with zero keys', () => {
    const cfg = loadConfig({});
    expect(cfg.mode).toBe('mock');
    expect(createProviders(cfg).recognition).toBeInstanceOf(MockRecognitionProvider);
  });

  it('rejects invalid modes', () => {
    expect(() => loadConfig({ PROVIDER_MODE: 'live' })).toThrow(/PROVIDER_MODE/);
  });

  it('real mode lists missing keys', () => {
    expect(() => createProviders(loadConfig({ PROVIDER_MODE: 'real', ACRCLOUD_HOST: 'h' }))).toThrow(
      /ACRCLOUD_ACCESS_KEY, ACRCLOUD_ACCESS_SECRET/,
    );
  });

  it('real mode builds real providers when keys are set (no network call)', () => {
    const p = createProviders(
      loadConfig({ PROVIDER_MODE: 'real', ACRCLOUD_HOST: 'h', ACRCLOUD_ACCESS_KEY: 'k', ACRCLOUD_ACCESS_SECRET: 's' }),
    );
    expect(p.recognition.constructor.name).toBe('AcrCloudRecognitionProvider');
    expect(p.lyrics.constructor.name).toBe('LrclibLyricsProvider');
    expect(p.transcription).toBeNull();
  });
});

describe('access password', () => {
  const basic = (user: string, pass: string) => 'Basic ' + Buffer.from(`${user}:${pass}`).toString('base64');
  async function locked() {
    const providers = createProviders(loadConfig({ PROVIDER_MODE: 'mock' }));
    return buildApp({ mode: 'mock', providers, accessPassword: 'karaoke night' });
  }
  it('asks for the password on API calls and pages', async () => {
    const app = await locked();
    const res = await app.inject({ method: 'POST', url: '/api/identify', ...multipartBody('audio', 'a.wav', 'audio/wav', audio) });
    expect(res.statusCode).toBe(401);
    expect(res.headers['www-authenticate']).toContain('Basic');
    expect((await app.inject({ method: 'GET', url: '/' })).statusCode).toBe(401);
  });
  it('lets the right password through with any user name, and rejects a wrong one', async () => {
    const app = await locked();
    const body = multipartBody('audio', 'a.wav', 'audio/wav', audio);
    const good = await app.inject({ method: 'POST', url: '/api/identify', payload: body.payload, headers: { ...body.headers, authorization: basic('me', 'karaoke night') } });
    expect(good.statusCode).toBe(200);
    const bad = await app.inject({ method: 'POST', url: '/api/identify', payload: body.payload, headers: { ...body.headers, authorization: basic('me', 'nope') } });
    expect(bad.statusCode).toBe(401);
  });
  it('keeps /api/health open for uptime checks', async () => {
    const app = await locked();
    expect((await app.inject({ method: 'GET', url: '/api/health' })).statusCode).toBe(200);
  });
  it('reads ACCESS_PASSWORD from the environment', () => {
    expect(loadConfig({ ACCESS_PASSWORD: ' secret ' }).accessPassword).toBe('secret');
    expect(loadConfig({}).accessPassword).toBeUndefined();
  });
});
