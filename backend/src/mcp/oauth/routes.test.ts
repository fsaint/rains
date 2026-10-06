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

/**
 * The root endpoint is a resource in its own right: `resource` names /mcp
 * with no agent id, and the grant that comes back names no agent either.
 *
 * The failure to guard against is a root `resource` being read as an
 * unparseable one, or worse as an agent id — either would mint a credential
 * whose reach nobody chose.
 */
describe('authorizing the root endpoint', () => {
  let app: FastifyInstance;
  const BASE = 'http://localhost:3000';

  beforeEach(async () => {
    vi.clearAllMocks();
    const { getClient, issueAuthCode } = await import('./tokens.js');
    vi.mocked(getClient).mockResolvedValue({
      clientId: 'c1',
      clientName: 'Claude',
      redirectUris: ['https://claude.ai/cb'],
      clientSecretHash: null,
    } as never);
    vi.mocked(issueAuthCode).mockResolvedValue('the-code');
    mockGetSession.mockReturnValue({ userId: 'user-1', email: 'a@b.c', role: 'user', iat: 0 });
    mockExecute.mockResolvedValue({ rows: [{ n: 2 }], rowsAffected: 1, columns: [] });
    app = await buildApp();
  });

  const consent = (resource: string) =>
    app.inject({
      method: 'GET',
      url:
        `/mcp/oauth/authorize?client_id=c1&redirect_uri=${encodeURIComponent('https://claude.ai/cb')}` +
        `&code_challenge=abc&code_challenge_method=S256&resource=${encodeURIComponent(resource)}`,
    });

  it('shows a consent page naming the listing, not an agent', async () => {
    const res = await consent(`${BASE}/mcp`);

    expect(res.statusCode).toBe(200);
    expect(res.body).toMatch(/see the list of/i);
    expect(res.body).toMatch(/your 2 agents/);
  });

  /** A reader must not assume this grants what connecting an agent grants. */
  it('says on the consent page what the token cannot do', async () => {
    const res = await consent(`${BASE}/mcp`);

    expect(res.body).toMatch(/cannot read your email/i);
    expect(res.body).toMatch(/act as any\s+agent/i);
  });

  it('counts a single agent in the singular', async () => {
    mockExecute.mockResolvedValue({ rows: [{ n: 1 }], rowsAffected: 1, columns: [] });

    expect((await consent(`${BASE}/mcp`)).body).toMatch(/your 1 agent\b/);
  });

  it('accepts the trailing-slash spelling of the root resource', async () => {
    expect((await consent(`${BASE}/mcp/`)).statusCode).toBe(200);
  });

  it('issues a grant that names no agent', async () => {
    const { issueAuthCode } = await import('./tokens.js');

    const res = await app.inject({
      method: 'POST',
      url: '/mcp/oauth/authorize',
      headers: { 'content-type': FORM },
      payload: new URLSearchParams({
        client_id: 'c1',
        redirect_uri: 'https://claude.ai/cb',
        code_challenge: 'abc',
        resource: `${BASE}/mcp`,
      }).toString(),
    });

    expect(res.statusCode).toBe(302);
    expect(vi.mocked(issueAuthCode).mock.calls[0][0]).toMatchObject({
      agentId: null,
      userId: 'user-1',
    });
  });

  /** An agent resource must still mint an agent-scoped grant. */
  it('still names the agent when the resource is an agent endpoint', async () => {
    const { issueAuthCode } = await import('./tokens.js');
    mockExecute.mockResolvedValue({
      rows: [{ id: 'agent-work', user_id: 'user-1' }], rowsAffected: 1, columns: [],
    });

    await app.inject({
      method: 'POST',
      url: '/mcp/oauth/authorize',
      headers: { 'content-type': FORM },
      payload: new URLSearchParams({
        client_id: 'c1',
        redirect_uri: 'https://claude.ai/cb',
        code_challenge: 'abc',
        resource: `${BASE}/mcp/agent-work`,
      }).toString(),
    });

    expect(vi.mocked(issueAuthCode).mock.calls[0][0]).toMatchObject({ agentId: 'agent-work' });
  });

  it('refuses a resource that names neither', async () => {
    const res = await consent('https://elsewhere.example/thing');

    expect(res.statusCode).toBe(400);
    expect(res.body).toMatch(/unrecognised/i);
  });

  it('publishes a protected-resource document for the root endpoint', async () => {
    const res = await app.inject({ method: 'GET', url: '/.well-known/oauth-protected-resource/mcp' });

    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({
      resource: `${BASE}/mcp`,
      authorization_servers: [BASE],
    });
  });
});
