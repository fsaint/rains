/**
 * Verifies the body-limit arrangement for the agent-upload route.
 *
 * The load-bearing property is that raising the limit for /api/agent-uploads
 * does NOT raise it for anything else. backend/src/app.ts constructs Fastify
 * with no bodyLimit, so the 1 MiB default governs every other route —
 * including POST /mcp/:agentId, which is exempt from the auth guard, and
 * POST /api/auth/login. A global bump would turn those into a memory-exhaustion
 * lever against a 512 MB single-machine VM holding all decrypted OAuth tokens.
 *
 * This test exercises real Fastify rather than a mock, because the interaction
 * between a route-level bodyLimit and a scoped addContentTypeParser is exactly
 * the kind of thing that silently does not work.
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';

const ROUTE_LIMIT = 25 * 1024 * 1024;
const FASTIFY_DEFAULT_LIMIT = 1024 * 1024;

let app: FastifyInstance;

beforeAll(async () => {
  // Mirrors backend/src/app.ts: no global bodyLimit override.
  app = Fastify({ logger: false });

  app.addContentTypeParser(
    'application/octet-stream',
    { parseAs: 'buffer' },
    (_request, body, done) => {
      done(null, body);
    }
  );

  app.post('/api/agent-uploads', { bodyLimit: ROUTE_LIMIT }, async (request, reply) =>
    reply.status(201).send({ size: (request.body as Buffer).length })
  );

  // Stand-in for every other route, e.g. POST /mcp/:agentId.
  app.post('/api/other', async (_request, reply) => reply.send({ ok: true }));

  await app.ready();
});

afterAll(async () => {
  await app.close();
});

describe('agent-upload body limits', () => {
  it('accepts an octet-stream body far above the global default', async () => {
    const size = 4 * 1024 * 1024; // 4 MB — well past the 1 MiB default
    const response = await app.inject({
      method: 'POST',
      url: '/api/agent-uploads',
      headers: { 'content-type': 'application/octet-stream' },
      payload: Buffer.alloc(size),
    });

    expect(response.statusCode).toBe(201);
    expect(response.json()).toEqual({ size });
  });

  it('still rejects a body over the route limit', async () => {
    const response = await app.inject({
      method: 'POST',
      url: '/api/agent-uploads',
      headers: { 'content-type': 'application/octet-stream' },
      payload: Buffer.alloc(ROUTE_LIMIT + 1024),
    });

    expect(response.statusCode).toBe(413);
  });

  // The whole point of using a route-level limit rather than a global one.
  it('leaves every other route on the 1 MiB default', async () => {
    const response = await app.inject({
      method: 'POST',
      url: '/api/other',
      headers: { 'content-type': 'application/json' },
      payload: JSON.stringify({ blob: 'x'.repeat(FASTIFY_DEFAULT_LIMIT + 1024) }),
    });

    expect(response.statusCode).toBe(413);
  });

  it('keeps other routes working under the default limit', async () => {
    const response = await app.inject({
      method: 'POST',
      url: '/api/other',
      headers: { 'content-type': 'application/json' },
      payload: JSON.stringify({ small: true }),
    });

    expect(response.statusCode).toBe(200);
  });

  it('does not change how other routes parse JSON', async () => {
    // Registering the octet-stream parser must not disturb the JSON parser.
    const response = await app.inject({
      method: 'POST',
      url: '/api/other',
      headers: { 'content-type': 'application/json' },
      payload: '{"valid":true}',
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ ok: true });
  });
});
