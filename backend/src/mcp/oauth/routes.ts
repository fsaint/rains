/**
 * OAuth 2.1 Authorization Server for the MCP endpoint.
 *
 * The MCP specification models an MCP server as an OAuth 2.1 Resource Server:
 * the client discovers where to authenticate from the protected-resource
 * document, registers itself dynamically, runs authorization-code + PKCE, and
 * presents the resulting bearer token to `/mcp/:agentId`.
 *
 * Two things are deliberately narrow.
 *
 * **A token is scoped to exactly one agent.** The `resource` parameter names
 * the agent's MCP URL and becomes the token's audience. That is what makes
 * "this client reaches the work agent only" true at the protocol level rather
 * than by the client's good behaviour — see docs/MULTI_AGENT_SETUP.md.
 *
 * **Consent reuses the dashboard session.** There is no separate login: an
 * unauthenticated visitor is redirected to the dashboard and comes back. Use
 * `getSession`, never `getUserId` — the latter reads `request.session` and
 * throws outside the session guard, and these routes are outside it.
 */

import type { FastifyInstance } from 'fastify';
import { getSession } from '../../auth/index.js';
import { config } from '../../config/index.js';
import { client } from '../../db/index.js';
import {
  getClient,
  issueAccessToken,
  issueAuthCode,
  issueRefreshToken,
  redeemAuthCode,
  registerClient,
  rotateRefreshToken,
  secretMatches,
  verifyPkce,
} from './tokens.js';

function baseUrl(): string {
  return (config.publicUrl || config.dashboardUrl || '').replace(/\/$/, '');
}

/** The agent an authorization request is for, taken from RFC 8707 `resource`. */
function agentIdFromResource(resource: string | undefined): string | null {
  if (!resource) return null;
  const match = resource.match(/\/mcp\/([A-Za-z0-9_-]+)\/?$/);
  return match ? match[1] : null;
}

function htmlEscape(value: string): string {
  return value.replace(/[&<>"']/g, (c) =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c] as string
  );
}

export function registerMcpOAuthRoutes(app: FastifyInstance): void {
  // RFC 6749 §4.1.3 requires the token request be form-encoded, the consent
  // page is a plain HTML form, and Fastify parses only JSON by default — so
  // without this every real OAuth client got a 415 at the token step. Parsers
  // are keyed by content type, so registering one here changes nothing about
  // how JSON routes elsewhere parse. Values are small strings; cap the body so
  // the one unauthenticated endpoint this adds cannot be used to buffer much.
  if (!app.hasContentTypeParser('application/x-www-form-urlencoded')) {
    app.addContentTypeParser(
      'application/x-www-form-urlencoded',
      { parseAs: 'string', bodyLimit: 64 * 1024 },
      (_request, body, done) => {
        done(null, Object.fromEntries(new URLSearchParams(body as string)));
      }
    );
  }

  // ── Discovery ──────────────────────────────────────────────────────────────

  /**
   * RFC 9728. This is the document a 401 from /mcp/ points at, and what Claude
   * Code and the OpenClaw bridge fetch to learn where to authenticate.
   */
  app.get('/.well-known/oauth-protected-resource', async () => ({
    resource: `${baseUrl()}/mcp`,
    authorization_servers: [baseUrl()],
    bearer_methods_supported: ['header'],
    resource_documentation: `${baseUrl()}/docs/multi-agent-setup`,
  }));

  // Same document, per-agent. RFC 9728 allows the resource path to carry it,
  // and some clients probe the concrete resource URL rather than the root.
  app.get<{ Params: { agentId: string } }>(
    '/.well-known/oauth-protected-resource/mcp/:agentId',
    async (request) => ({
      resource: `${baseUrl()}/mcp/${request.params.agentId}`,
      authorization_servers: [baseUrl()],
      bearer_methods_supported: ['header'],
    })
  );

  /** RFC 8414. */
  app.get('/.well-known/oauth-authorization-server', async () => ({
    issuer: baseUrl(),
    authorization_endpoint: `${baseUrl()}/mcp/oauth/authorize`,
    token_endpoint: `${baseUrl()}/mcp/oauth/token`,
    registration_endpoint: `${baseUrl()}/mcp/oauth/register`,
    revocation_endpoint: `${baseUrl()}/mcp/oauth/revoke`,
    response_types_supported: ['code'],
    grant_types_supported: ['authorization_code', 'refresh_token'],
    // S256 only. OAuth 2.1 drops `plain`, which protects nothing against an
    // intercepted code.
    code_challenge_methods_supported: ['S256'],
    token_endpoint_auth_methods_supported: ['none', 'client_secret_post'],
  }));

  // ── Dynamic client registration (RFC 7591) ────────────────────────────────

  app.post('/mcp/oauth/register', async (request, reply) => {
    const body = (request.body ?? {}) as {
      client_name?: unknown;
      redirect_uris?: unknown;
      token_endpoint_auth_method?: unknown;
    };

    const redirectUris = Array.isArray(body.redirect_uris)
      ? body.redirect_uris.filter((u): u is string => typeof u === 'string')
      : [];
    if (redirectUris.length === 0) {
      return reply.code(400).send({
        error: 'invalid_client_metadata',
        error_description: 'redirect_uris is required',
      });
    }

    const clientName =
      typeof body.client_name === 'string' && body.client_name.trim()
        ? body.client_name.trim()
        : 'MCP client';
    const confidential = body.token_endpoint_auth_method === 'client_secret_post';

    const { clientId, clientSecret } = await registerClient({
      clientName,
      redirectUris,
      confidential,
    });

    return reply.code(201).send({
      client_id: clientId,
      ...(clientSecret ? { client_secret: clientSecret } : {}),
      client_name: clientName,
      redirect_uris: redirectUris,
      grant_types: ['authorization_code', 'refresh_token'],
      response_types: ['code'],
      token_endpoint_auth_method: confidential ? 'client_secret_post' : 'none',
    });
  });

  // ── Authorization + consent ───────────────────────────────────────────────

  app.get('/mcp/oauth/authorize', async (request, reply) => {
    const q = request.query as Record<string, string | undefined>;
    const { client_id, redirect_uri, code_challenge, code_challenge_method, resource } = q;

    if (!client_id || !redirect_uri || !code_challenge) {
      return reply.code(400).type('text/html').send(
        errorPage('Missing client_id, redirect_uri or code_challenge.')
      );
    }
    if (code_challenge_method !== 'S256') {
      return reply.code(400).type('text/html').send(
        errorPage('This server requires PKCE with code_challenge_method=S256.')
      );
    }

    const registered = await getClient(client_id);
    if (!registered) {
      return reply.code(400).type('text/html').send(errorPage('Unknown client_id.'));
    }
    // Exact match, no prefix matching — a loose comparison here is how tokens
    // get redirected to an attacker's URL.
    if (!registered.redirectUris.includes(redirect_uri)) {
      return reply.code(400).type('text/html').send(
        errorPage('redirect_uri does not match this client\'s registration.')
      );
    }

    const agentId = agentIdFromResource(resource);
    if (!agentId) {
      return reply.code(400).type('text/html').send(
        errorPage(
          'Missing or unrecognised `resource`. It must name the agent endpoint this token is for, ' +
            'for example https://app.helm.mom/mcp/&lt;agentId&gt;.'
        )
      );
    }

    // Consent requires a logged-in owner. Bounce through the dashboard and come
    // back to this exact URL.
    const session = getSession(request);
    if (!session) {
      const back = encodeURIComponent(`${baseUrl()}${request.url}`);
      return reply.redirect(`${config.dashboardUrl}/login?next=${back}`);
    }

    const agent = await client.execute({
      sql: `SELECT a.id, a.name, a.user_id FROM agents a WHERE a.id = ? LIMIT 1`,
      args: [agentId],
    });
    const agentRow = agent.rows[0];
    // 404 rather than 403 for an agent this user does not own: an agent id is
    // not an authorization boundary, and confirming existence would leak one.
    if (!agentRow || (agentRow.user_id as string) !== session.userId) {
      return reply.code(404).type('text/html').send(errorPage('Agent not found.'));
    }

    const services = await client.execute({
      sql: `SELECT DISTINCT service_type FROM agent_service_instances
            WHERE agent_id = ? AND enabled = true ORDER BY service_type`,
      args: [agentId],
    });
    const serviceList = services.rows.map((r) => r.service_type as string);

    if (request.method === 'GET') {
      return reply.type('text/html').send(
        consentPage({
          agentName: agentRow.name as string,
          clientName: registered.clientName,
          services: serviceList,
          query: q,
        })
      );
    }
    return reply.code(405).send();
  });

  /** The consent form posts back here. */
  app.post('/mcp/oauth/authorize', async (request, reply) => {
    const body = (request.body ?? {}) as Record<string, string | undefined>;
    const { client_id, redirect_uri, state, code_challenge, resource } = body;

    const session = getSession(request);
    if (!session) return reply.code(401).send({ error: 'login_required' });

    if (!client_id || !redirect_uri || !code_challenge) {
      return reply.code(400).send({ error: 'invalid_request' });
    }

    const registered = await getClient(client_id);
    if (!registered || !registered.redirectUris.includes(redirect_uri)) {
      return reply.code(400).send({ error: 'invalid_request' });
    }

    const agentId = agentIdFromResource(resource);
    if (!agentId) return reply.code(400).send({ error: 'invalid_target' });

    const agent = await client.execute({
      sql: `SELECT id, user_id FROM agents WHERE id = ? LIMIT 1`,
      args: [agentId],
    });
    const agentRow = agent.rows[0];
    if (!agentRow || (agentRow.user_id as string) !== session.userId) {
      return reply.code(404).send({ error: 'not_found' });
    }

    const code = await issueAuthCode({
      clientId: client_id,
      agentId,
      userId: session.userId,
      redirectUri: redirect_uri,
      codeChallenge: code_challenge,
      clientName: registered.clientName,
    });

    const target = new URL(redirect_uri);
    target.searchParams.set('code', code);
    if (state) target.searchParams.set('state', state);
    return reply.redirect(target.toString());
  });

  // ── Token ─────────────────────────────────────────────────────────────────

  app.post('/mcp/oauth/token', async (request, reply) => {
    const body = (request.body ?? {}) as Record<string, string | undefined>;
    const grantType = body.grant_type;

    if (grantType === 'refresh_token') {
      if (!body.refresh_token) return reply.code(400).send({ error: 'invalid_request' });
      const rotated = await rotateRefreshToken(body.refresh_token);
      if (!rotated) return reply.code(400).send({ error: 'invalid_grant' });
      return reply.send({
        access_token: rotated.access.token,
        token_type: 'Bearer',
        refresh_token: rotated.refresh,
        expires_in: expiresIn(rotated.access.expiresAt),
      });
    }

    if (grantType !== 'authorization_code') {
      return reply.code(400).send({ error: 'unsupported_grant_type' });
    }
    if (!body.code || !body.code_verifier || !body.redirect_uri) {
      return reply.code(400).send({ error: 'invalid_request' });
    }

    // Redeeming deletes the code, so a replay past this point finds nothing.
    const claim = await redeemAuthCode(body.code);
    if (!claim) return reply.code(400).send({ error: 'invalid_grant' });

    if (claim.redirectUri !== body.redirect_uri) {
      return reply.code(400).send({ error: 'invalid_grant' });
    }
    if (!verifyPkce(body.code_verifier, claim.codeChallenge)) {
      return reply.code(400).send({ error: 'invalid_grant' });
    }

    const registered = await getClient(claim.clientId);
    if (registered?.clientSecretHash) {
      if (!body.client_secret || !secretMatches(body.client_secret, registered.clientSecretHash)) {
        return reply.code(401).send({ error: 'invalid_client' });
      }
    }

    const access = await issueAccessToken({
      agentId: claim.agentId,
      userId: claim.userId,
      clientId: claim.clientId,
      name: claim.clientName ?? 'MCP client',
    });
    const refresh = await issueRefreshToken({
      accessTokenId: access.id,
      agentId: claim.agentId,
      userId: claim.userId,
      clientId: claim.clientId,
    });

    return reply.send({
      access_token: access.token,
      token_type: 'Bearer',
      refresh_token: refresh,
      expires_in: expiresIn(access.expiresAt),
    });
  });

  // ── Revocation (RFC 7009) ─────────────────────────────────────────────────

  app.post('/mcp/oauth/revoke', async (request, reply) => {
    const body = (request.body ?? {}) as Record<string, string | undefined>;
    if (body.token) {
      // Rotation revokes the paired access token, so this covers both shapes.
      await rotateRefreshToken(body.token).catch(() => null);
    }
    // RFC 7009: always 200, even for an unknown token — the caller learns
    // nothing about whether it existed.
    return reply.send({});
  });
}

function expiresIn(expiresAt: string | null): number | undefined {
  if (!expiresAt) return undefined;
  return Math.max(0, Math.floor((new Date(expiresAt).getTime() - Date.now()) / 1000));
}

function errorPage(message: string): string {
  return page(`<h1>Authorization failed</h1><p>${message}</p>`);
}

function consentPage(opts: {
  agentName: string;
  clientName: string;
  services: string[];
  query: Record<string, string | undefined>;
}): string {
  const hidden = ['client_id', 'redirect_uri', 'state', 'code_challenge', 'resource']
    .map((k) =>
      opts.query[k]
        ? `<input type="hidden" name="${k}" value="${htmlEscape(opts.query[k] as string)}">`
        : ''
    )
    .join('');

  const services = opts.services.length
    ? opts.services.map((s) => `<li>${htmlEscape(s)}</li>`).join('')
    : '<li>No services connected yet</li>';

  return page(`
    <h1>Connect ${htmlEscape(opts.clientName)}</h1>
    <p><strong>${htmlEscape(opts.clientName)}</strong> is asking to act as your agent
       <strong>${htmlEscape(opts.agentName)}</strong>.</p>
    <p>It will be able to use these connected services:</p>
    <ul>${services}</ul>
    <p class="muted">Tools that need approval will still ask you first, on Telegram or in the
       dashboard. This token works only for this one agent, and you can revoke it at any time
       from the agent's page.</p>
    <form method="POST" action="/mcp/oauth/authorize">
      ${hidden}
      <button type="submit">Allow access</button>
    </form>
  `);
}

function page(inner: string): string {
  return `<!doctype html><html><head><meta charset="utf-8">
<title>Helm</title>
<meta name="viewport" content="width=device-width,initial-scale=1">
<style>
  body { font-family: ui-sans-serif, system-ui, sans-serif; background:#0b1020; color:#e8ecf5;
         display:flex; min-height:100vh; align-items:center; justify-content:center; margin:0; padding:24px; }
  .card { max-width: 460px; background:#141a2e; border:1px solid rgba(255,255,255,.1);
          border-radius:14px; padding:28px; }
  h1 { font-size:20px; margin:0 0 14px; }
  p { line-height:1.55; margin:0 0 12px; }
  ul { margin:0 0 16px 18px; padding:0; }
  li { margin:3px 0; }
  .muted { color:#93a0bd; font-size:13px; }
  button { background:#3b82f6; color:#fff; border:0; border-radius:8px;
           padding:11px 18px; font-size:15px; cursor:pointer; width:100%; }
  button:hover { background:#2f6fd8; }
</style></head><body><div class="card">${inner}</div></body></html>`;
}
