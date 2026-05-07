import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PORT_FILE = path.join(__dirname, 'node_modules', '.cache', 'agent-history-port');
const PORT_FALLBACK = 3847;

/**
 * Read the API port the dev server is currently bound to. We re-read on every
 * request so that restarting `dev:server` (which may bind to 3848/3849 if 3847
 * is busy) doesn't require restarting Vite — the next API call picks up the
 * new port automatically.
 */
function readApiPort(): number {
  try {
    const raw = fs.readFileSync(PORT_FILE, 'utf-8').trim();
    const n = Number(raw);
    return Number.isInteger(n) && n > 0 ? n : PORT_FALLBACK;
  } catch {
    return PORT_FALLBACK;
  }
}

export default defineConfig({
  root: 'src/web',
  plugins: [
    react(),
    tailwindcss(),
    {
      // Custom proxy: vanilla `server.proxy` resolves `target` once at config
      // load and won't follow port-file updates. This middleware reads the
      // port file per request so dev:server restarts on a different port are
      // transparent to the running Vite instance.
      name: 'agent-history:dynamic-api-proxy',
      configureServer(server) {
        server.middlewares.use('/api', (req, res) => {
          const port = readApiPort();
          const proxyReq = http.request(
            {
              host: '127.0.0.1',
              port,
              path: '/api' + (req.url ?? ''),
              method: req.method,
              headers: req.headers,
            },
            (proxyRes) => {
              res.writeHead(proxyRes.statusCode ?? 502, proxyRes.headers);
              proxyRes.pipe(res);
            },
          );
          proxyReq.on('error', (err) => {
            res.writeHead(502, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({
              error: `API server not reachable on 127.0.0.1:${port}`,
              hint: 'Start `npm run dev:server` in another terminal — it writes the live port to node_modules/.cache/agent-history-port.',
              cause: err.message,
            }));
          });
          req.pipe(proxyReq);
        });
      },
    },
  ],
  build: {
    outDir: path.resolve(__dirname, 'dist/web'),
    emptyOutDir: true,
  },
  resolve: {
    alias: { '@': path.resolve(__dirname, 'src/web/src') },
  },
});
