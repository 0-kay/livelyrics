import { describe, expect, it, vi } from 'vitest';
import type { TranscriptionProvider } from '@livelyrics/shared';
import { buildApp } from '../src/app.js';
import { loadConfig } from '../src/config.js';
import {
  createProviders,
  MockLyricsProvider,
  MockRecognitionProvider,
  MockTranscriptionProvider,
  mockSungWords,
} from '../src/providers/index.js';
import { MOCK_TRACK } from '../src/fixtures/mockSong.js';
import { multipartBody, multipartWithFields } from './helpers.js';

const audio = Buffer.alloc(4096, 7);
const file = { field: 'audio', filename: 'chunk.wav', mime: 'audio/wav', data: audio };
const trackFields = { title: MOCK_TRACK.title, artist: MOCK_TRACK.artist, durationMs: MOCK_TRACK.durationMs };

function fixedTranscript(text: string): TranscriptionProvider {
  return { transcribe: async () => text };
}

async function concertApp(transcription: TranscriptionProvider | null, concertMode = true) {
  return buildApp({
    mode: 'mock',
    concertMode,
    providers: { recognition: new MockRecognitionProvider(), lyrics: new MockLyricsProvider(), transcription },
  });
}

describe('CONCERT_MODE flag', () => {
  it('defaults to off and parses on/off', () => {
    expect(loadConfig({}).concertMode).toBe(false);
    expect(loadConfig({ CONCERT_MODE: 'on' }).concertMode).toBe(true);
    expect(loadConfig({ CONCERT_MODE: 'true' }).concertMode).toBe(true);
    expect(loadConfig({ CONCERT_MODE: 'off' }).concertMode).toBe(false);
    expect(() => loadConfig({ CONCERT_MODE: 'maybe' })).toThrow(/CONCERT_MODE/);
  });

  it('hides /api/transcribe when the flag is off', async () => {
    const app = await concertApp(new MockTranscriptionProvider(), false);
    const res = await app.inject({ method: 'POST', url: '/api/transcribe', ...multipartBody('audio', 'a.wav', 'audio/wav', audio) });
    expect(res.statusCode).toBe(404);
    expect((await app.inject({ method: 'GET', url: '/api/health' })).json().concertMode).toBe(false);
  });

  it('stays off without a transcription provider even when the flag is on', async () => {
    const app = await concertApp(null, true);
    expect((await app.inject({ method: 'GET', url: '/api/health' })).json().concertMode).toBe(false);
    const res = await app.inject({ method: 'POST', url: '/api/transcribe', ...multipartBody('audio', 'a.wav', 'audio/wav', audio) });
    expect(res.statusCode).toBe(404);
  });

  it('reports concertMode in health when on', async () => {
    const app = await concertApp(new MockTranscriptionProvider());
    expect((await app.inject({ method: 'GET', url: '/api/health' })).json()).toEqual({ ok: true, mode: 'mock', concertMode: true });
  });
});

describe('POST /api/transcribe', () => {
  it('returns text only when no track is given', async () => {
    const app = await concertApp(new MockTranscriptionProvider());
    const res = await app.inject({ method: 'POST', url: '/api/transcribe', ...multipartBody('audio', 'a.wav', 'audio/wav', audio) });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.text).toBe('paper lanterns drifting slow');
    expect(body.match).toBeNull();
    expect(typeof body.processingMs).toBe('number');
  });

  it('returns a confident line match near the given position', async () => {
    const app = await concertApp(fixedTranscript('mismatched socks and borrowed'));
    const res = await app.inject({
      method: 'POST',
      url: '/api/transcribe',
      ...multipartWithFields({ ...trackFields, positionMs: 50_000 }, file),
    });
    expect(res.statusCode).toBe(200);
    const { match } = res.json();
    expect(match.confident).toBe(true);
    expect(match.startMs).toBe(56_500);
    expect(match.positionMs).toBeGreaterThan(56_500);
    expect(match.positionMs).toBeLessThan(61_000);
  });

  it('marks a chorus that repeats inside the window as ambiguous', async () => {
    const app = await concertApp(fixedTranscript('paper lanterns drifting slow'));
    const res = await app.inject({
      method: 'POST',
      url: '/api/transcribe',
      ...multipartWithFields({ ...trackFields, positionMs: 110_000 }, file),
    });
    const { match } = res.json();
    expect(match.ambiguous).toBe(true);
    expect(match.confident).toBe(false);
  });

  it('matches on the scaled timeline for a slowed version', async () => {
    const app = await concertApp(fixedTranscript('verse two begins where the hallway bends'));
    const slowed = MOCK_TRACK.durationMs * 1.25;
    const res = await app.inject({
      method: 'POST',
      url: '/api/transcribe',
      ...multipartWithFields({ ...trackFields, durationMs: slowed, positionMs: 65_000 }, file),
    });
    const { match } = res.json();
    expect(match.confident).toBe(true);
    expect(match.startMs).toBe(65_000); // 52s * 1.25
  });

  it('uses the lyrics cache shared with /api/identify', async () => {
    const lyrics = new MockLyricsProvider();
    const spy = vi.spyOn(lyrics, 'getSynced');
    const app = await buildApp({
      mode: 'mock',
      concertMode: true,
      providers: { recognition: new MockRecognitionProvider(20_000), lyrics, transcription: fixedTranscript('counting tiles along the kitchen floor') },
    });
    await app.inject({ method: 'POST', url: '/api/identify', ...multipartBody('audio', 'a.wav', 'audio/wav', audio) });
    const res = await app.inject({ method: 'POST', url: '/api/transcribe', ...multipartWithFields({ ...trackFields, positionMs: 18_000 }, file) });
    expect(res.json().match.startMs).toBe(17_000);
    expect(spy).toHaveBeenCalledTimes(1);
  });

  it('validates input', async () => {
    const app = await concertApp(new MockTranscriptionProvider());
    const notMultipart = await app.inject({ method: 'POST', url: '/api/transcribe', payload: { a: 1 } });
    expect(notMultipart.statusCode).toBe(415);
    const noAudio = await app.inject({
      method: 'POST',
      url: '/api/transcribe',
      ...multipartWithFields(trackFields, { ...file, field: 'other' }),
    });
    expect(noAudio.statusCode).toBe(400);
    const badType = await app.inject({ method: 'POST', url: '/api/transcribe', ...multipartWithFields(trackFields, { ...file, mime: 'text/plain' }) });
    expect(badType.statusCode).toBe(415);
    const badPos = await app.inject({
      method: 'POST',
      url: '/api/transcribe',
      ...multipartWithFields({ ...trackFields, positionMs: 'soon' }, file),
    });
    expect(badPos.statusCode).toBe(400);
  });

  it('returns 502 when the provider fails', async () => {
    const app = await concertApp({ transcribe: async () => Promise.reject(new Error('boom')) });
    const res = await app.inject({ method: 'POST', url: '/api/transcribe', ...multipartBody('audio', 'a.wav', 'audio/wav', audio) });
    expect(res.statusCode).toBe(502);
  });
});

describe('mock transcription in mock mode', () => {
  it('follows the same virtual song as recognition', async () => {
    let now = 0;
    const virtualPlayback = { startedAtMs: 0, rate: 1, startOffsetMs: 58_000, now: () => now };
    const recognition = new MockRecognitionProvider({ virtualPlayback });
    const transcription = new MockTranscriptionProvider({ virtualPlayback });
    now = 1_000;
    const pos = (await recognition.identify(audio, 'audio/wav'))!.playOffsetMs;
    expect(pos).toBe(59_000);
    const text = await transcription.transcribe(audio, 'audio/wav');
    expect(text).toContain('Mismatched');
    expect(text).toBe(mockSungWords(59_000));
  });

  it('is silent between lines', () => {
    expect(mockSungWords(27_000)).toBe('');
    expect(mockSungWords(1_000)).toBe('');
  });

  it('works end to end through createProviders', async () => {
    const providers = createProviders(loadConfig({ PROVIDER_MODE: 'mock', CONCERT_MODE: 'on' }));
    const app = await buildApp({ mode: 'mock', providers, concertMode: true });
    const res = await app.inject({ method: 'POST', url: '/api/transcribe', ...multipartWithFields({ ...trackFields, positionMs: 10_000 }, file) });
    expect(res.statusCode).toBe(200);
    expect(res.json().text).toContain('Test line one');
  });
});
