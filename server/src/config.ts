import type { ProviderMode } from '@livelyrics/shared';

export interface AppConfig {
  mode: ProviderMode;
  port: number;
  cacheBackend: 'memory' | 'redis';
  acrcloud: { host?: string; accessKey?: string; accessSecret?: string };
  lrclibUserAgent: string;
  openaiApiKey?: string;
  /** Max upload size for audio clips in bytes. */
  maxUploadBytes: number;
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
    maxUploadBytes: 5 * 1024 * 1024,
  };
}
