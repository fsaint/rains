/**
 * Route-level tests for the MCP OAuth authorization server.
 *
 * `tokens.test.ts` covers the storage layer; nothing exercised the HTTP
 * surface, which is where an OAuth client actually meets us. RFC 6749 §4.1.3
 * requires the token request to be `application/x-www-form-urlencoded`, and
 * the consent page is a plain HTML form — both content types Fastify refuses
 * with a 415 unless a parser is registered.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';

const { mockExecute, mockGetSession, mockRedeemAuthCode, mockRotateRefreshToken } = vi.hoisted(() => ({
  mockExecute: vi.fn(),
  mockGetSession: vi.fn(),
  mockRedeemAuthCode: vi.fn(),
  mockRotateRefreshToken: vi.fn(),
}));

vi.mock('../../db/index.js', () => ({ client: { execute: mockExecute } }));
vi.mock('../../auth/index.js', () => ({ getSession: mockGetSession }));
vi.mock('../../config/index.js', () => ({
  config: { dashboardUrl: 'http://localhost:5173', publicUrl: 'http://localhost:3000' },
}));
vi.mock('./tokens.js', () => ({
  getClient: vi.fn(),
  issueAccessToken: vi.fn(),
  issueAuthCode: vi.fn(),
  issueRefreshToken: vi.fn(),
  redeemAuthCode: mockRedeemAuthCode,
  registerClient: vi.fn(),
  rotateRefreshToken: mockRotateRefreshToken,
  secretMatches: vi.fn(),
  verifyPkce: vi.fn(),
}));

import { registerMcpOAuthRoutes } from './routes.js';

async function buildApp(): Promise<FastifyInstance> {
  const app = Fastify({ logger: false });
  registerMcpOAuthRoutes(app);
  await app.ready();
  return app;
}

const FORM = 'application/x-www-form-urlencoded';

describe('form-encoded requests (RFC 6749 §4.1.3)', () => {
  let app: FastifyInstance;

  beforeEach(async () => {
    vi.clearAllMocks();
    app = await buildApp();
  });

  it('parses a form-encoded token request instead of answering 415', async () => {
    mockRedeemAuthCode.mockResolvedValue(null);
    const res = await app.inject({
      method: 'POST',
      url: '/mcp/oauth/token',
      headers: { 'content-type': FORM },
      payload: new URLSearchParams({
        grant_type: 'authorization_code',
        code: 'nope',
        code_verifier: 'v',
        redirect_uri: 'https://claude.ai/api/mcp/auth_callback',
      }).toString(),
    });
    // The handler ran and rejected the unknown code — not the content type.
    expect(res.statusCode).toBe(400);
    expect(res.json()).toEqual({ error: 'invalid_grant' });
    expect(mockRedeemAuthCode).toHaveBeenCalledWith('nope');
  });

  it('parses a form-encoded refresh request', async () => {
    mockRotateRefreshToken.mockResolvedValue(null);
    const res = await app.inject({
      method: 'POST',
      url: '/mcp/oauth/token',
      headers: { 'content-type': FORM },
      payload: 'grant_type=refresh_token&refresh_token=abc',
    });
    expect(res.statusCode).toBe(400);
    expect(res.json()).toEqual({ error: 'invalid_grant' });
    expect(mockRotateRefreshToken).toHaveBeenCalledWith('abc');
  });

  it('parses the consent form post', async () => {
    mockGetSession.mockReturnValue(null);
    const res = await app.inject({
      method: 'POST',
      url: '/mcp/oauth/authorize',
      headers: { 'content-type': FORM },
      payload: 'client_id=c&redirect_uri=https%3A%2F%2Fx&code_challenge=y',
    });
    // Reached the handler, which wants a session before anything else.
    expect(res.statusCode).toBe(401);
    expect(res.json()).toEqual({ error: 'login_required' });
  });

  it('parses a form-encoded revocation request', async () => {
    mockRotateRefreshToken.mockResolvedValue(null);
    const res = await app.inject({
      method: 'POST',
      url: '/mcp/oauth/revoke',
      headers: { 'content-type': FORM },
      payload: 'token=abc',
    });
    expect(res.statusCode).toBe(200);
    expect(mockRotateRefreshToken).toHaveBeenCalledWith('abc');
  });

  it('still accepts JSON on the token endpoint', async () => {
    mockRotateRefreshToken.mockResolvedValue(null);
    const res = await app.inject({
      method: 'POST',
      url: '/mcp/oauth/token',
      payload: { grant_type: 'refresh_token', refresh_token: 'abc' },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json()).toEqual({ error: 'invalid_grant' });
  });
});
