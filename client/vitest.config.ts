import { fileURLToPath } from 'node:url';
import { defineProject } from 'vitest/config';

export default defineProject({
  resolve: {
    alias: { '@livelyrics/shared': fileURLToPath(new URL('../shared/src/index.ts', import.meta.url)) },
  },
  test: { name: 'client', include: ['test/**/*.test.ts'], environment: 'node' },
});
