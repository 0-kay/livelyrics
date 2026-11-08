import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { buildApp } from '../src/app.js';
import { loadConfig } from '../src/config.js';
import { MockLyricsProvider, MockRecognitionProvider } from '../src/providers/index.js';
import { MOCK_TRACK } from '../src/fixtures/mockSong.js';
import { multipartBody } from './helpers.js';

const audio = Buffer.alloc(4096, 7);
const post = (app: Awaited<ReturnType<typeof buildApp>>) =>
  app.inject({ method: 'POST', url: '/api/identify', ...multipartBody('audio', 'a.wav', 'audio/wav', audio) });

describe('duration-ratio scaling in /api/identify', () => {
  it('scales lyric timestamps when the matched track is a slowed version', async () => {
    const slowed = { identify: async () => ({ ...MOCK_TRACK, durationMs: MOCK_TRACK.durationMs * 1.25, playOffsetMs: 5_000 }) };
    const app = await buildApp({ mode: 'mock', providers: { recognition: slowed, lyrics: new MockLyricsProvider(), transcription: null } });
    const body = (await post(app)).json();
    expect(body.lyricsTimeScale).toBeCloseTo(1.25, 6);
    const plain = (await new MockLyricsProvider().getSynced(MOCK_TRACK))!;
    expect(body.lyrics.lines[1].startMs).toBe(Math.round(plain.lines[1].startMs * 1.25));
    expect(body.lyrics.durationMs).toBe(MOCK_TRACK.durationMs * 1.25);
  });

  it('leaves lyrics unscaled when durations match, including cached responses', async () => {
    const app = await buildApp({
      mode: 'mock',
      providers: { recognition: new MockRecognitionProvider(1_000), lyrics: new MockLyricsProvider(), transcription: null },
    });
    const a = (await post(app)).json();
    const b = (await post(app)).json();
    expect(a.lyricsTimeScale).toBe(1);
    expect(b.lyricsCached).toBe(true);
    expect(b.lyrics).toEqual(a.lyrics);
  });
});

describe('mock virtual playback', () => {
  it('advances offsets at the configured rate and wraps at the end', async () => {
    let now = 1_000;
    const p = new MockRecognitionProvider({ virtualPlayback: { startedAtMs: 1_000, rate: 1.25, now: () => now } });
    expect((await p.identify(audio, 'audio/wav'))!.playOffsetMs).toBe(10_000);
    now += 8_000;
    expect((await p.identify(audio, 'audio/wav'))!.playOffsetMs).toBe(20_000);
    now = 1_000 + (MOCK_TRACK.durationMs - 10_000) / 1.25 + 4_000;
    expect((await p.identify(audio, 'audio/wav'))!.playOffsetMs).toBe(5_000);
  });

  it('reads MOCK_PLAYBACK_RATE and validates it', () => {
    expect(loadConfig({}).mockPlaybackRate).toBe(1);
    expect(loadConfig({ MOCK_PLAYBACK_RATE: '0.8' }).mockPlaybackRate).toBe(0.8);
    expect(() => loadConfig({ MOCK_PLAYBACK_RATE: 'fast' })).toThrow(/MOCK_PLAYBACK_RATE/);
    expect(() => loadConfig({ MOCK_PLAYBACK_RATE: '3' })).toThrow(/MOCK_PLAYBACK_RATE/);
  });
});

describe('static client serving', () => {
  it('serves index.html, assets and an SPA fallback, but 404s unknown API routes', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'livelyrics-static-'));
    writeFileSync(join(dir, 'index.html'), '<!doctype html><title>LiveLyrics</title>');
    writeFileSync(join(dir, 'app.js'), 'console.log(1)');
    const app = await buildApp({
      mode: 'mock',
      providers: { recognition: new MockRecognitionProvider(), lyrics: new MockLyricsProvider(), transcription: null },
      staticDir: dir,
    });
    expect((await app.inject({ method: 'GET', url: '/' })).body).toContain('LiveLyrics');
    expect((await app.inject({ method: 'GET', url: '/app.js' })).body).toContain('console.log');
    expect((await app.inject({ method: 'GET', url: '/some/route' })).body).toContain('LiveLyrics');
    expect((await app.inject({ method: 'GET', url: '/api/nope' })).statusCode).toBe(404);
    expect((await app.inject({ method: 'GET', url: '/api/health' })).json().ok).toBe(true);
  });

  it('refuses a directory without index.html', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'livelyrics-empty-'));
    await expect(
      buildApp({ mode: 'mock', providers: { recognition: new MockRecognitionProvider(), lyrics: new MockLyricsProvider(), transcription: null }, staticDir: dir }),
    ).rejects.toThrow(/index.html/);
  });
});
