import { createHmac } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import { AcrCloudRecognitionProvider, LrclibLyricsProvider, WhisperTranscriptionProvider } from '../src/providers/index.js';
import { jsonResponse } from './helpers.js';

const audio = Buffer.from('fake-audio-bytes');

describe('AcrCloudRecognitionProvider (fake fetch)', () => {
  it('signs the request and maps the first music result', async () => {
    const fetch = vi.fn(async (_url: string | URL, _init?: RequestInit) =>
      jsonResponse({
        status: { code: 0, msg: 'Success' },
        metadata: {
          music: [
            {
              title: 'T', artists: [{ name: 'A' }, { name: 'B' }], album: { name: 'Al' },
              duration_ms: 200000, play_offset_ms: 42000, score: 95, external_ids: { isrc: 'ISRC1' },
            },
          ],
        },
      }),
    );
    const p = new AcrCloudRecognitionProvider({ host: 'example.test', accessKey: 'key', accessSecret: 'secret', fetch, now: () => 1_700_000_000_000 });
    const m = await p.identify(audio, 'audio/wav');
    expect(m).toEqual({ title: 'T', artist: 'A, B', album: 'Al', durationMs: 200000, playOffsetMs: 42000, isrc: 'ISRC1', score: 95 });

    const [url, init] = fetch.mock.calls[0];
    expect(String(url)).toBe('https://example.test/v1/identify');
    const form = init!.body as FormData;
    const expectedSig = createHmac('sha1', 'secret')
      .update(['POST', '/v1/identify', 'key', 'audio', '1', '1700000000'].join('\n'))
      .digest('base64');
    expect(form.get('signature')).toBe(expectedSig);
    expect(form.get('sample_bytes')).toBe(String(audio.length));
    expect((form.get('sample') as File).name).toBe('sample.wav');
  });

  it('returns null on no-result code 1001 and throws on other errors', async () => {
    const none = new AcrCloudRecognitionProvider({ host: 'h', accessKey: 'k', accessSecret: 's', fetch: async () => jsonResponse({ status: { code: 1001 } }) });
    expect(await none.identify(audio, 'audio/wav')).toBeNull();
    const bad = new AcrCloudRecognitionProvider({ host: 'h', accessKey: 'k', accessSecret: 's', fetch: async () => jsonResponse({ status: { code: 3001, msg: 'Missing/Invalid Access Key' } }) });
    await expect(bad.identify(audio, 'audio/wav')).rejects.toThrow(/3001/);
    const http = new AcrCloudRecognitionProvider({ host: 'h', accessKey: 'k', accessSecret: 's', fetch: async () => jsonResponse({}, 500) });
    await expect(http.identify(audio, 'audio/wav')).rejects.toThrow(/HTTP 500/);
  });
});

describe('LrclibLyricsProvider (fake fetch)', () => {
  const synced = '[00:01.00]one\n[00:02.00]two';

  it('uses /api/get with duration in seconds and a user agent', async () => {
    const fetch = vi.fn(async (_url: string | URL, _init?: RequestInit) => jsonResponse({ syncedLyrics: synced, duration: 180.5 }));
    const p = new LrclibLyricsProvider({ userAgent: 'ua-test', fetch });
    const r = await p.getSynced({ title: 'T', artist: 'A', album: 'Al', durationMs: 180_400 });
    expect(r).toEqual({ lines: [{ startMs: 1000, text: 'one' }, { startMs: 2000, text: 'two' }], instrumental: false, durationMs: 180_500 });
    const url = new URL(String(fetch.mock.calls[0][0]));
    expect(url.pathname).toBe('/api/get');
    expect(url.searchParams.get('duration')).toBe('180');
    expect((fetch.mock.calls[0][1]!.headers as Record<string, string>)['User-Agent']).toBe('ua-test');
  });

  it('falls back to search on 404 and picks the closest duration', async () => {
    const fetch = vi.fn(async (url: string | URL) => {
      if (new URL(String(url)).pathname === '/api/get') return jsonResponse({ code: 404 }, 404);
      return jsonResponse([
        { duration: 300, syncedLyrics: '[00:01.00]far' },
        { duration: 181, syncedLyrics: '[00:01.00]close' },
        { duration: 180, syncedLyrics: null },
      ]);
    });
    const p = new LrclibLyricsProvider({ userAgent: 'ua', fetch });
    const r = await p.getSynced({ title: 'T', artist: 'A', durationMs: 180_000 });
    expect(r?.lines[0].text).toBe('close');
  });

  it('reports instrumental tracks and returns null when nothing synced exists', async () => {
    const inst = new LrclibLyricsProvider({ userAgent: 'ua', fetch: async () => jsonResponse({ instrumental: true, duration: 100 }) });
    expect(await inst.getSynced({ title: 'T', artist: 'A' })).toEqual({ lines: [], instrumental: true, durationMs: 100_000 });
    const none = new LrclibLyricsProvider({
      userAgent: 'ua',
      fetch: async (url) => (new URL(String(url)).pathname === '/api/get' ? jsonResponse({}, 404) : jsonResponse([])),
    });
    expect(await none.getSynced({ title: 'T', artist: 'A' })).toBeNull();
  });

  it('throws on server errors', async () => {
    const p = new LrclibLyricsProvider({ userAgent: 'ua', fetch: async () => jsonResponse({}, 503) });
    await expect(p.getSynced({ title: 'T', artist: 'A' })).rejects.toThrow(/503/);
  });
});

describe('WhisperTranscriptionProvider (fake fetch)', () => {
  it('posts the file with bearer auth and returns trimmed text', async () => {
    const fetch = vi.fn(async (_url: string | URL, _init?: RequestInit) => jsonResponse({ text: '  hello there ' }));
    const p = new WhisperTranscriptionProvider({ apiKey: 'sk-test', fetch });
    expect(await p.transcribe(audio, 'audio/webm')).toBe('hello there');
    const [url, init] = fetch.mock.calls[0];
    expect(String(url)).toBe('https://api.openai.com/v1/audio/transcriptions');
    expect((init!.headers as Record<string, string>).Authorization).toBe('Bearer sk-test');
    expect(((init!.body as FormData).get('file') as File).name).toBe('chunk.webm');
  });

  it('throws on HTTP errors', async () => {
    const p = new WhisperTranscriptionProvider({ apiKey: 'k', fetch: async () => jsonResponse({}, 401) });
    await expect(p.transcribe(audio, 'audio/wav')).rejects.toThrow(/401/);
  });
});
