import { SERVER_CONFIG, type ProviderMode } from '@livelyrics/shared';

export interface AppConfig {
  mode: ProviderMode;
  port: number;
  cacheBackend: 'memory' | 'redis';
  acrcloud: { host?: string; accessKey?: string; accessSecret?: string };
  lrclibUserAgent: string;
  openaiApiKey?: string;
  /** Max upload size for audio clips in bytes. */
  maxUploadBytes: number;
  /** Mock mode only: playback rate of the virtual fixture song (try 0.8 or 1.25). */
  mockPlaybackRate: number;
  /** Serve the built client from this directory when set (production container). */
  staticDir?: string;
  /** Concert mode feature flag (experimental). Enables POST /api/transcribe. */
  concertMode: boolean;
  /** Password for the browser sign-in prompt; unset means open (fine for localhost). */
  accessPassword?: string;
}

const empty = (v: string | undefined) => (v && v.trim() ? v.trim() : undefined);

export function loadConfig(env: NodeJS.ProcessEnv = process.env): AppConfig {
  const mode = (env.PROVIDER_MODE ?? 'mock').trim();
  if (mode !== 'mock' && mode !== 'real') {
    throw new Error(`PROVIDER_MODE must be "mock" or "real", got "${mode}"`);
  }
  const cacheBackend = (env.CACHE_BACKEND ?? 'memory').trim();
  if (cacheBackend !== 'memory' && cacheBackend !== 'redis') {
    throw new Error(`CACHE_BACKEND must be "memory" or "redis", got "${cacheBackend}"`);
  }
  return {
    mode,
    port: Number(env.PORT ?? 8080),
    cacheBackend,
    acrcloud: {
      host: empty(env.ACRCLOUD_HOST),
      accessKey: empty(env.ACRCLOUD_ACCESS_KEY),
      accessSecret: empty(env.ACRCLOUD_ACCESS_SECRET),
    },
    lrclibUserAgent: empty(env.LRCLIB_USER_AGENT) ?? 'livelyrics/0.1 (https://github.com/0-kay/livelyrics)',
    openaiApiKey: empty(env.OPENAI_API_KEY),
    maxUploadBytes: SERVER_CONFIG.maxUploadBytes,
    mockPlaybackRate: parseRate(env.MOCK_PLAYBACK_RATE),
    staticDir: empty(env.STATIC_DIR),
    concertMode: parseFlag(env.CONCERT_MODE, 'CONCERT_MODE'),
    accessPassword: empty(env.ACCESS_PASSWORD),
  };
}

function parseRate(v: string | undefined): number {
  if (!v || !v.trim()) return 1;
  const r = Number(v);
  if (!Number.isFinite(r) || r < 0.5 || r > 2) {
    throw new Error(`MOCK_PLAYBACK_RATE must be a number between 0.5 and 2, got "${v}"`);
  }
  return r;
}

function parseFlag(v: string | undefined, name: string): boolean {
  const s = (v ?? '').trim().toLowerCase();
  if (s === '' || s === '0' || s === 'false' || s === 'off') return false;
  if (s === '1' || s === 'true' || s === 'on') return true;
  throw new Error(`${name} must be on or off, got "${v}"`);
}
