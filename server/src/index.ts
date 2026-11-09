import { buildApp } from './app.js';
import { loadConfig } from './config.js';
import { createProviders } from './providers/index.js';

async function main() {
  const config = loadConfig();
  if (config.cacheBackend === 'redis') {
    console.warn('CACHE_BACKEND=redis is not implemented yet; using the in-memory cache.');
  }
  const providers = createProviders(config);
  const app = await buildApp({
    mode: config.mode,
    providers,
    maxUploadBytes: config.maxUploadBytes,
    logger: true,
    staticDir: config.staticDir,
    concertMode: config.concertMode,
    accessPassword: config.accessPassword,
  });
  if (!config.accessPassword && process.env.K_SERVICE) {
    console.warn('ACCESS_PASSWORD is not set: anyone with the link can use this deployment and your ACRCloud quota.');
  }
  if (config.concertMode && !providers.transcription) {
    console.warn('CONCERT_MODE=on but no transcription provider is configured (set OPENAI_API_KEY); concert mode is off.');
  }
  await app.listen({ port: config.port, host: '0.0.0.0' });
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
