/**
 * Stub OpenClaw gateway server.
 *
 * Mimics the subset of the real OpenClaw HTTP API that Reins and integration
 * tests need to verify agent responsiveness:
 *
 *   GET  /healthz          → { status: 'ok' }
 *   GET  /api/v1/stats     → { totalInputTokens: 0, totalOutputTokens: 0 }
 *   POST /api/v1/chat      → minimal streaming response
 *   *                      → 404
 *
 * Build:   docker build -t reins-stub-openclaw docker/stub-openclaw
 * Run:     docker run -p 18789:18789 reins-stub-openclaw
 */

import http from 'http';

const PORT = parseInt(process.env.PORT ?? '18789', 10);

const ROUTES = {
  'GET /healthz': (_req, res) => {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ status: 'ok', version: '0.0.0-stub' }));
  },

  'GET /api/v1/stats': (_req, res) => {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({
      totalInputTokens: 0,
      totalOutputTokens: 0,
      uptimeSeconds: Math.floor(process.uptime()),
    }));
  },

  'POST /api/v1/chat': (_req, res) => {
    // Minimal SSE response that looks like a real agent reply
    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      Connection: 'keep-alive',
    });
    res.write('data: {"type":"content","text":"Hello from stub agent!"}\n\n');
    res.write('data: {"type":"done"}\n\n');
    res.end();
  },
};

const server = http.createServer((req, res) => {
  const key = `${req.method} ${req.url?.split('?')[0]}`;
  const handler = ROUTES[key];

  if (handler) {
    handler(req, res);
  } else {
    res.writeHead(404, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'Not found', path: req.url }));
  }
});

server.listen(PORT, '0.0.0.0', () => {
  console.log(`[stub-openclaw] Listening on port ${PORT}`);
  console.log('[stub-openclaw] Routes: GET /healthz  GET /api/v1/stats  POST /api/v1/chat');
});

process.on('SIGTERM', () => server.close(() => process.exit(0)));
process.on('SIGINT', () => server.close(() => process.exit(0)));
