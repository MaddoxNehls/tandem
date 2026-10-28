import react from '@vitejs/plugin-react';
import { defaultClientConditions, defineConfig } from 'vite';
import { VitePWA } from 'vite-plugin-pwa';

const SYNC = process.env.TANDEM_SYNC_URL ?? 'http://127.0.0.1:8790';

export default defineConfig({
  resolve: { conditions: ['source', ...defaultClientConditions] },
  server: {
    port: 5190,
    strictPort: true,
    proxy: {
      '/api': SYNC,
      '/sync': { target: SYNC.replace(/^http/, 'ws'), ws: true },
    },
  },
  build: { target: 'es2022', sourcemap: true },
  worker: { format: 'es' },
  // transformers.js ships prebuilt bundles; don't let the dev optimizer touch them.
  optimizeDeps: { exclude: ['@huggingface/transformers'] },
  plugins: [
    react(),
    VitePWA({
      registerType: 'autoUpdate',
      injectRegister: false,
      includeAssets: ['icon.svg'],
      manifest: {
        name: 'Tandem',
        short_name: 'Tandem',
        description: 'Local-first notes you can write together, online or off.',
        theme_color: '#E4E8E1',
        background_color: '#E4E8E1',
        display: 'standalone',
        start_url: '/',
        icons: [{ src: 'icon.svg', sizes: 'any', type: 'image/svg+xml', purpose: 'any' }],
      },
      workbox: {
        globPatterns: ['**/*.{js,css,html,svg,woff2}'],
        navigateFallback: '/index.html',
        navigateFallbackDenylist: [/^\/api\//, /^\/sync/],
        maximumFileSizeToCacheInBytes: 4 * 1024 * 1024,
        // The search model and ONNX runtime are fetched on first use and
        // then served from cache, so semantic search works offline too.
        runtimeCaching: [
          {
            urlPattern: ({ url }) =>
              url.hostname === 'cdn.jsdelivr.net' || url.hostname === 'huggingface.co' || url.hostname.endsWith('.hf.co'),
            handler: 'CacheFirst',
            options: {
              cacheName: 'tandem-model',
              expiration: { maxEntries: 40 },
              cacheableResponse: { statuses: [0, 200] },
            },
          },
        ],
      },
    }),
  ],
});
