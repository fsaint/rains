import { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import jwt from 'jsonwebtoken';
import { config } from '../config/index.js';

const COOKIE_NAME = 'reins_session';
const TOKEN_EXPIRY = '7d';

interface SessionPayload {
  role: 'admin';
  iat: number;
}

export function signSession(): string {
  return jwt.sign({ role: 'admin' } as SessionPayload, config.sessionSecret, {
    expiresIn: TOKEN_EXPIRY,
  });
}

export function verifySession(token: string): SessionPayload | null {
  try {
    return jwt.verify(token, config.sessionSecret) as SessionPayload;
  } catch {
    return null;
  }
}

/**
 * Register auth routes and hook.
 * - POST /api/auth/login
 * - POST /api/auth/logout
 * - GET  /api/auth/session
 *
 * All /api/* routes (except auth and health) require a valid session cookie.
 * /mcp/* routes are exempt (agents authenticate by agent ID).
 */
export async function registerAuth(app: FastifyInstance) {
  // --- Auth routes (unauthenticated) ---

  app.post('/api/auth/login', async (request, reply) => {
    const body = request.body as { password?: string } | undefined;
    if (!body?.password || body.password !== config.adminPassword) {
      return reply.code(401).send({ error: { code: 'INVALID_PASSWORD', message: 'Invalid password' } });
    }

    const token = signSession();
    reply.setCookie(COOKIE_NAME, token, {
      path: '/',
      httpOnly: true,
      secure: config.nodeEnv === 'production' || config.dashboardUrl.startsWith('https'),
      sameSite: 'lax',
      maxAge: 7 * 24 * 60 * 60, // 7 days in seconds
    });

    return { data: { authenticated: true } };
  });

  app.post('/api/auth/logout', async (_request, reply) => {
    reply.clearCookie(COOKIE_NAME, { path: '/' });
    return { data: { authenticated: false } };
  });

  app.get('/api/auth/session', async (request) => {
    const token = request.cookies[COOKIE_NAME];
    if (!token) return { data: { authenticated: false } };
    const payload = verifySession(token);
    return { data: { authenticated: !!payload } };
  });

  // --- Auth guard on /api/* routes ---

  app.addHook('onRequest', async (request: FastifyRequest, reply: FastifyReply) => {
    const path = request.url.split('?')[0];

    // Skip auth for these paths
    if (
      path === '/api/health' ||
      path.startsWith('/api/auth/') ||
      path.startsWith('/mcp/') ||
      path.startsWith('/api/agents/register') // agent self-registration
    ) {
      return;
    }

    // All other /api/* routes require auth
    if (path.startsWith('/api/')) {
      const token = request.cookies[COOKIE_NAME];
      if (!token || !verifySession(token)) {
        return reply.code(401).send({ error: { code: 'UNAUTHORIZED', message: 'Not authenticated' } });
      }
    }
  });
}
