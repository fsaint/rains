/**
 * Fastify application factory.
 * Extracted from index.ts so tests can build the app without starting a real
 * server or requiring external services (DB, Fly, Docker, etc.) to be present.
 */
import Fastify, { FastifyInstance } from 'fastify';
import cors from '@fastify/cors';
import cookie from '@fastify/cookie';
import websocket from '@fastify/websocket';
import fastifyStatic from '@fastify/static';
import { resolve } from 'path';
import { apiRoutes } from './api/routes.js';
import { registerAuth } from './auth/index.js';

export async function buildApp(): Promise<FastifyInstance> {
  const app = Fastify({ logger: false });

  await app.register(cors, { origin: true, credentials: true });
  await app.register(cookie);
  await app.register(websocket);

  // Auth routes + per-request session guard
  await registerAuth(app);

  // All API routes
  await app.register(apiRoutes);

  // Serve frontend SPA in production
  if (process.env.NODE_ENV === 'production') {
    await app.register(fastifyStatic, {
      root: resolve(import.meta.dirname, '../../frontend/dist'),
      prefix: '/',
      wildcard: false,
    });
    app.setNotFoundHandler((_req, reply) => {
      reply.sendFile('index.html');
    });
  }

  return app;
}
