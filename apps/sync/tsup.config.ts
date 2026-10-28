import { defineConfig } from 'tsup';

// Bundle the workspace packages into the server build so `node dist/main.js`
// needs only the npm dependencies (ws, pg).
export default defineConfig({
  entry: ['src/main.ts'],
  format: ['esm'],
  platform: 'node',
  target: 'node22',
  sourcemap: true,
  clean: true,
  noExternal: ['@tandem/crdt', '@tandem/sync'],
  esbuildOptions(options) {
    options.conditions = ['source'];
  },
});
