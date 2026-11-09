import { createHmac } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import { AcrCloudRecognitionProvider, LrclibLyricsProvider, WhisperTranscriptionProvider } from '../src/providers/index.js';
import { positionAtClipEnd, wavDurationMs } from '../src/providers/real/acrcloud.js';
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

describe('ACRCloud clip-end position', () => {
  /** Minimal 16-bit mono PCM WAV of the given length. */
  const wav = (ms: number, rate = 16000) => {
    const data = Math.round((ms / 1000) * rate) * 2;
    const b = Buffer.alloc(44 + data);
    b.write('RIFF', 0); b.writeUInt32LE(36 + data, 4); b.write('WAVE', 8);
    b.write('fmt ', 12); b.writeUInt32LE(16, 16); b.writeUInt16LE(1, 20); b.writeUInt16LE(1, 22);
    b.writeUInt32LE(rate, 24); b.writeUInt32LE(rate * 2, 28); b.writeUInt16LE(2, 32); b.writeUInt16LE(16, 34);
    b.write('data', 36); b.writeUInt32LE(data, 40);
    return b;
  };
  it('reads the WAV length', () => {
    expect(wavDurationMs(wav(6000))).toBeCloseTo(6000, 0);
    expect(wavDurationMs(Buffer.from('not a wav'))).toBeNull();
  });
  it('maps the matched span to the clip end', () => {
    // Match ended 280ms before the clip end, at 61.0s in the song: clip end is 61.28s.
    expect(positionAtClipEnd({ play_offset_ms: 60_700, sample_end_time_offset_ms: 5_720, db_end_time_offset_ms: 61_000 }, 6000)).toBe(61_280);
  });
  it('falls back to play_offset_ms when fields are missing or implausible', () => {
    expect(positionAtClipEnd({ play_offset_ms: 42_000 }, 6000)).toBe(42_000);
    expect(positionAtClipEnd({ play_offset_ms: 42_000, sample_end_time_offset_ms: 5000, db_end_time_offset_ms: 90_000 }, 6000)).toBe(42_000);
    expect(positionAtClipEnd({ play_offset_ms: 42_000, sample_end_time_offset_ms: 5000, db_end_time_offset_ms: 41_000 }, null)).toBe(42_000);
  });
  it('is what identify returns for a WAV clip', async () => {
    const p = new AcrCloudRecognitionProvider({
      host: 'h', accessKey: 'k', accessSecret: 's',
      fetch: async () => jsonResponse({ status: { code: 0 }, metadata: { music: [{ title: 'T', artists: [{ name: 'A' }], duration_ms: 200000, play_offset_ms: 60_700, sample_end_time_offset_ms: 5_720, db_end_time_offset_ms: 61_000, score: 90 }] } }),
    });
    expect((await p.identify(wav(6000), 'audio/wav'))!.playOffsetMs).toBe(61_280);
  });
});
