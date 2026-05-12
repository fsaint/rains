import { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import jwt from 'jsonwebtoken';
import bcrypt from 'bcryptjs';
import { config } from '../config/index.js';
import { client } from '../db/index.js';
import { nanoid } from 'nanoid';
import { storePendingOAuthFlow, getPendingOAuthFlow, deletePendingOAuthFlow } from '../oauth/pending-flows.js';
import { getPostHog } from '../analytics/posthog.js';

const COOKIE_NAME = 'reins_session';
const TOKEN_EXPIRY = '7d';

export interface SessionPayload {
  userId: string;
  email: string;
  role: 'admin' | 'user';
  iat: number;
}

// Magic link token — time-limited, scoped to a single approval, no password required
export function createMagicLinkToken(userId: string, approvalId: string): string {
  return jwt.sign({ userId, approvalId, type: 'magic_link' }, config.sessionSecret, {
    expiresIn: '24h',
  });
}

interface MagicLinkPayload {
  userId: string;
  approvalId: string;
  type: 'magic_link';
}

export function verifyMagicLinkToken(token: string): MagicLinkPayload | null {
  try {
    const payload = jwt.verify(token, config.sessionSecret) as MagicLinkPayload;
    if (payload.type !== 'magic_link') return null;
    return payload;
  } catch {
    return null;
  }
}

export function signSession(userId: string, email: string, role: 'admin' | 'user'): string {
  return jwt.sign({ userId, email, role } as Omit<SessionPayload, 'iat'>, config.sessionSecret, {
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
 * Extract session from request. Returns null if not authenticated.
 */
export function getSession(request: FastifyRequest): SessionPayload | null {
  const token = request.cookies[COOKIE_NAME];
  if (!token) return null;
  return verifySession(token);
}

/**
 * Register auth routes and hook.
 */
export async function registerAuth(app: FastifyInstance) {
  // --- Auth routes (unauthenticated) ---

  app.post('/api/auth/login', async (request, reply) => {
    const body = request.body as { email?: string; password?: string } | undefined;
    if (!body?.email || !body?.password) {
      return reply.code(400).send({ error: { code: 'VALIDATION_ERROR', message: 'Email and password are required' } });
    }

    const result = await client.execute({
      sql: `SELECT * FROM users WHERE email = ? AND status != 'deleted'`,
      args: [body.email],
    });

    if (result.rows.length === 0) {
      return reply.code(401).send({ error: { code: 'INVALID_CREDENTIALS', message: 'Invalid email or password' } });
    }

    const user = result.rows[0];

    if (user.status === 'suspended') {
      return reply.code(403).send({ error: { code: 'ACCOUNT_SUSPENDED', message: 'Account is suspended' } });
    }

    const passwordValid = await bcrypt.compare(body.password, user.password_hash as string);
    if (!passwordValid) {
      return reply.code(401).send({ error: { code: 'INVALID_CREDENTIALS', message: 'Invalid email or password' } });
    }

    const token = signSession(user.id as string, user.email as string, user.role as 'admin' | 'user');
    reply.setCookie(COOKIE_NAME, token, {
      path: '/',
      httpOnly: true,
      secure: config.nodeEnv === 'production' || config.dashboardUrl.startsWith('https'),
      sameSite: 'lax',
      maxAge: 7 * 24 * 60 * 60,
    });

    getPostHog()?.capture({ distinctId: user.id as string, event: 'user_logged_in', properties: { method: 'password' } });

    return {
      data: {
        authenticated: true,
        user: {
          id: user.id,
          email: user.email,
          name: user.name,
          role: user.role,
        },
      },
    };
  });

  app.post('/api/auth/logout', async (_request, reply) => {
    reply.clearCookie(COOKIE_NAME, { path: '/' });
    return { data: { authenticated: false } };
  });

  app.get('/api/auth/session', async (request) => {
    const session = getSession(request);
    if (!session) return { data: { authenticated: false } };

    // Fetch current user info
    const result = await client.execute({
      sql: `SELECT id, email, name, role, telegram_chat_id, telegram_user_id FROM users WHERE id = ? AND status = 'active'`,
      args: [session.userId],
    });

    if (result.rows.length === 0) {
      return { data: { authenticated: false } };
    }

    const user = result.rows[0];
    return {
      data: {
        authenticated: true,
        user: {
          id: user.id,
          email: user.email,
          name: user.name,
          role: user.role,
          telegramLinked: !!user.telegram_chat_id,
          telegramUserId: user.telegram_user_id ?? undefined,
        },
      },
    };
  });

  // Google SSO — redirect browser to Google
  app.get('/api/auth/google', async (_request, reply) => {
    if (!config.googleClientId || !config.googleLoginRedirectUri) {
      return reply.code(500).send({ error: 'Google login not configured' });
    }
    const state = nanoid(32);
    await storePendingOAuthFlow(state, { service: 'google_login' });
    const params = new URLSearchParams({
      client_id: config.googleClientId,
      redirect_uri: config.googleLoginRedirectUri,
      response_type: 'code',
      scope: 'openid email profile',
      state,
      access_type: 'online',
      prompt: 'select_account',
    });
    return reply.redirect(`https://accounts.google.com/o/oauth2/v2/auth?${params}`);
  });

  // Google SSO callback
  app.get<{ Querystring: { code?: string; state?: string; error?: string } }>(
    '/api/auth/google/callback',
    async (request, reply) => {
      const { code, state, error } = request.query;
      if (error || !code || !state) {
        return reply.redirect(`${config.dashboardUrl}/?login_error=true`);
      }

      const pendingFlow = await getPendingOAuthFlow(state);
      if (!pendingFlow || pendingFlow.service !== 'google_login') {
        return reply.redirect(`${config.dashboardUrl}/?login_error=invalid_state`);
      }
      await deletePendingOAuthFlow(state);

      try {
        const tokenResponse = await fetch('https://oauth2.googleapis.com/token', {
          method: 'POST',
          headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
          body: new URLSearchParams({
            client_id: config.googleClientId!,
            client_secret: config.googleClientSecret!,
            code,
            grant_type: 'authorization_code',
            redirect_uri: config.googleLoginRedirectUri!,
          }),
        });

        if (!tokenResponse.ok) {
          return reply.redirect(`${config.dashboardUrl}/?login_error=token_failed`);
        }

        const tokens = await tokenResponse.json() as { access_token: string };
        const userInfoResponse = await fetch('https://www.googleapis.com/oauth2/v2/userinfo', {
          headers: { Authorization: `Bearer ${tokens.access_token}` },
        });

        if (!userInfoResponse.ok) {
          return reply.redirect(`${config.dashboardUrl}/?login_error=userinfo_failed`);
        }

        const userInfo = await userInfoResponse.json() as { email: string; name?: string };

        const result = await client.execute({
          sql: `SELECT id, email, name, role, status FROM users WHERE email = ? AND status = 'active'`,
          args: [userInfo.email],
        });

        if (result.rows.length === 0) {
          return reply.redirect(`${config.dashboardUrl}/?login_error=not_authorized`);
        }

        const user = result.rows[0];
        const token = signSession(user.id as string, user.email as string, user.role as 'admin' | 'user');
        reply.setCookie(COOKIE_NAME, token, {
          path: '/',
          httpOnly: true,
          secure: config.dashboardUrl.startsWith('https'),
          sameSite: 'lax',
          maxAge: 7 * 24 * 60 * 60,
        });

        getPostHog()?.capture({ distinctId: user.id as string, event: 'user_logged_in', properties: { method: 'google_sso' } });
        return reply.redirect(config.dashboardUrl);
      } catch (err) {
        console.error('[auth/google] callback error:', err);
        return reply.redirect(`${config.dashboardUrl}/?login_error=internal`);
      }
    }
  );

  // Magic link — validates a time-limited token, sets a session cookie, redirects to the approval
  app.get('/api/auth/magic', async (request, reply) => {
    const { t } = request.query as { t?: string };
    if (!t) return reply.code(400).send({ error: 'Missing token' });

    const payload = verifyMagicLinkToken(t);
    if (!payload) {
      // Redirect to login instead of returning JSON so the browser lands somewhere useful
      return reply.redirect(`${config.dashboardUrl}/`);
    }

    // Load the user to build a real session
    const result = await client.execute({
      sql: `SELECT id, email, role FROM users WHERE id = ? AND status = 'active'`,
      args: [payload.userId],
    });
    if (result.rows.length === 0) {
      return reply.redirect(`${config.dashboardUrl}/`);
    }

    const user = result.rows[0];
    const token = signSession(user.id as string, user.email as string, user.role as 'admin' | 'user');
    reply.setCookie(COOKIE_NAME, token, {
      path: '/',
      httpOnly: true,
      secure: config.nodeEnv === 'production' || config.dashboardUrl.startsWith('https'),
      sameSite: 'lax',
      maxAge: 7 * 24 * 60 * 60,
    });

    return reply.redirect(`${config.dashboardUrl}/approvals?id=${payload.approvalId}`);
  });

  // --- Self-service profile ---

  app.patch('/api/auth/profile', async (request, reply) => {
    const session = getSession(request);
    if (!session) return reply.code(401).send({ error: { code: 'UNAUTHORIZED', message: 'Not authenticated' } });

    const body = request.body as { name?: string } | undefined;
    if (!body?.name) {
      return reply.code(400).send({ error: { code: 'VALIDATION_ERROR', message: 'name is required' } });
    }

    await client.execute({
      sql: `UPDATE users SET name = ?, updated_at = ? WHERE id = ?`,
      args: [body.name, new Date().toISOString(), session.userId],
    });

    return { data: { name: body.name } };
  });

  app.post('/api/auth/change-password', async (request, reply) => {
    const session = getSession(request);
    if (!session) return reply.code(401).send({ error: { code: 'UNAUTHORIZED', message: 'Not authenticated' } });

    const body = request.body as { currentPassword?: string; newPassword?: string } | undefined;
    if (!body?.currentPassword || !body?.newPassword) {
      return reply.code(400).send({ error: { code: 'VALIDATION_ERROR', message: 'currentPassword and newPassword are required' } });
    }

    if (body.newPassword.length < 8) {
      return reply.code(400).send({ error: { code: 'VALIDATION_ERROR', message: 'Password must be at least 8 characters' } });
    }

    const result = await client.execute({
      sql: `SELECT password_hash FROM users WHERE id = ?`,
      args: [session.userId],
    });

    if (result.rows.length === 0) {
      return reply.code(404).send({ error: { code: 'NOT_FOUND', message: 'User not found' } });
    }

    const valid = await bcrypt.compare(body.currentPassword, result.rows[0].password_hash as string);
    if (!valid) {
      return reply.code(401).send({ error: { code: 'INVALID_PASSWORD', message: 'Current password is incorrect' } });
    }

    const newHash = await bcrypt.hash(body.newPassword, 10);
    await client.execute({
      sql: `UPDATE users SET password_hash = ?, updated_at = ? WHERE id = ?`,
      args: [newHash, new Date().toISOString(), session.userId],
    });

    return { data: { success: true } };
  });

  // --- Admin user management ---

  app.get('/api/admin/users', async (request, reply) => {
    const session = getSession(request);
    if (!session || session.role !== 'admin') {
      return reply.code(403).send({ error: { code: 'FORBIDDEN', message: 'Admin access required' } });
    }

    const result = await client.execute(
      `SELECT id, email, name, role, status, created_at, updated_at FROM users WHERE status != 'deleted' ORDER BY created_at DESC`
    );

    return { data: result.rows };
  });

  app.post('/api/admin/users', async (request, reply) => {
    const session = getSession(request);
    if (!session || session.role !== 'admin') {
      return reply.code(403).send({ error: { code: 'FORBIDDEN', message: 'Admin access required' } });
    }

    const body = request.body as { email?: string; name?: string; password?: string; role?: string } | undefined;
    if (!body?.email || !body?.name || !body?.password) {
      return reply.code(400).send({ error: { code: 'VALIDATION_ERROR', message: 'email, name, and password are required' } });
    }

    if (body.password.length < 8) {
      return reply.code(400).send({ error: { code: 'VALIDATION_ERROR', message: 'Password must be at least 8 characters' } });
    }

    // Check for duplicate email
    const existing = await client.execute({
      sql: `SELECT id FROM users WHERE email = ?`,
      args: [body.email],
    });
    if (existing.rows.length > 0) {
      return reply.code(409).send({ error: { code: 'DUPLICATE_EMAIL', message: 'A user with this email already exists' } });
    }

    const id = nanoid();
    const now = new Date().toISOString();
    const passwordHash = await bcrypt.hash(body.password, 10);
    const role = body.role === 'admin' ? 'admin' : 'user';

    await client.execute({
      sql: `INSERT INTO users (id, email, name, password_hash, role, status, created_at, updated_at)
            VALUES (?, ?, ?, ?, ?, 'active', ?, ?)`,
      args: [id, body.email, body.name, passwordHash, role, now, now],
    });

    return reply.code(201).send({
      data: { id, email: body.email, name: body.name, role, status: 'active', created_at: now, updated_at: now },
    });
  });

  app.patch<{ Params: { id: string } }>('/api/admin/users/:id', async (request, reply) => {
    const session = getSession(request);
    if (!session || session.role !== 'admin') {
      return reply.code(403).send({ error: { code: 'FORBIDDEN', message: 'Admin access required' } });
    }

    const { id } = request.params;
    const body = request.body as { name?: string; role?: string; status?: string } | undefined;

    const updates: string[] = ['updated_at = ?'];
    const args: (string | null)[] = [new Date().toISOString()];

    if (body?.name) {
      updates.push('name = ?');
      args.push(body.name);
    }
    if (body?.role && ['admin', 'user'].includes(body.role)) {
      updates.push('role = ?');
      args.push(body.role);
    }
    if (body?.status && ['active', 'suspended'].includes(body.status)) {
      updates.push('status = ?');
      args.push(body.status);
    }

    args.push(id);
    await client.execute({
      sql: `UPDATE users SET ${updates.join(', ')} WHERE id = ?`,
      args,
    });

    const result = await client.execute({
      sql: `SELECT id, email, name, role, status, created_at, updated_at FROM users WHERE id = ?`,
      args: [id],
    });

    if (result.rows.length === 0) {
      return reply.code(404).send({ error: { code: 'NOT_FOUND', message: 'User not found' } });
    }

    return { data: result.rows[0] };
  });

  app.delete<{ Params: { id: string } }>('/api/admin/users/:id', async (request, reply) => {
    const session = getSession(request);
    if (!session || session.role !== 'admin') {
      return reply.code(403).send({ error: { code: 'FORBIDDEN', message: 'Admin access required' } });
    }

    const { id } = request.params;

    // Prevent deleting yourself
    if (id === session.userId) {
      return reply.code(400).send({ error: { code: 'CANNOT_DELETE_SELF', message: 'Cannot delete your own account' } });
    }

    await client.execute({
      sql: `UPDATE users SET status = 'deleted', updated_at = ? WHERE id = ?`,
      args: [new Date().toISOString(), id],
    });

    return reply.code(204).send();
  });

  app.post<{ Params: { id: string } }>('/api/admin/users/:id/reset-password', async (request, reply) => {
    const session = getSession(request);
    if (!session || session.role !== 'admin') {
      return reply.code(403).send({ error: { code: 'FORBIDDEN', message: 'Admin access required' } });
    }

    const { id } = request.params;
    const body = request.body as { password?: string } | undefined;

    if (!body?.password || body.password.length < 8) {
      return reply.code(400).send({ error: { code: 'VALIDATION_ERROR', message: 'Password must be at least 8 characters' } });
    }

    const passwordHash = await bcrypt.hash(body.password, 10);
    await client.execute({
      sql: `UPDATE users SET password_hash = ?, updated_at = ? WHERE id = ?`,
      args: [passwordHash, new Date().toISOString(), id],
    });

    return { data: { success: true } };
  });

  // --- Auth guard on /api/* routes ---

  app.addHook('onRequest', async (request: FastifyRequest, reply: FastifyReply) => {
    const path = request.url.split('?')[0];

    // Skip auth for these paths
    if (
      path === '/api/health' ||
      path.startsWith('/api/auth/') ||
      path.startsWith('/mcp/') ||
      path.startsWith('/api/agents/register') || // agent self-registration
      path === '/api/webhooks/telegram' || // Telegram webhook (authenticated via secret_token header)
      path === '/api/webhooks/shared-bot' || // Shared bot relay (authenticated via secret_token header)
      path === '/api/config/public' || // Public config (no secrets)
      path.startsWith('/api/webhooks/agent-bot/') || // Agent bot relay (authenticated via secret_token header)
      path.startsWith('/api/onboarding/') || // Onboarding bot (authenticated via API key)
      path === '/api/agents/create-and-deploy' || // Onboarding bot agent provisioning (authenticated via API key)
      path === '/api/oauth/google/callback' || // Google OAuth callback — state token validated inside handler
      /^\/api\/agents\/[^/]+\/topic-prompts$/.test(path) // Topic prompts (authenticated via x-reins-agent-secret)
    ) {
      return;
    }
    // Magic links bypass auth — token is validated inside the handler

    // All other /api/* routes require auth
    if (path.startsWith('/api/')) {
      const session = getSession(request);
      if (!session) {
        // Allow agent gateway tokens to pass through — route handlers validate them
        if (request.headers['x-reins-agent-secret']) return;
        return reply.code(401).send({ error: { code: 'UNAUTHORIZED', message: 'Not authenticated' } });
      }

      // Attach session to request for downstream use
      (request as any).session = session;
    }
  });
}
