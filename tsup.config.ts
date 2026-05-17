import { defineConfig } from 'tsup';

export default defineConfig({
  entry: ['src/cli.ts', 'src/contextberg.ts'],
  format: ['esm'],
  target: 'node22',
  banner: {
    js: '#!/usr/bin/env node',
  },
});
