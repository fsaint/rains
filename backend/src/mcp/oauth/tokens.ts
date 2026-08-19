/**
 * MCP endpoint credentials.
 *
 * The MCP specification makes an MCP server an OAuth 2.1 Resource Server. This
 * module is the store behind that: minting, hashing, verifying and revoking the
 * tokens the endpoint accepts, plus the single-use authorization codes and the
 * refresh tokens that produce them.
 *
 * Two decisions worth knowing before changing anything here.
 *
 * **Tokens are opaque, not JWTs.** Revocation has to be immediate — the whole
 * point of the feature is that an owner can cut off one client — and a signed
 * token cannot be withdrawn before it expires without a revocation list, which
 * is the lookup we would have avoided. `config.sessionSecret` also carries an
 * insecure default (config/index.ts), and signing endpoint credentials with it
 * would turn a weak default into remote access.
 *
 * **Hashed with sha256, not bcrypt.** bcrypt is the repo's only other hash, but
 * it is salted per row, so a token could not be found by its value — verifying
 * one would mean reading every row and comparing each. sha256 lets the hash be
 * a unique index. These are high-entropy random strings, not passwords: the
 * slow-hash argument does not apply.
 */

import { createHash, randomBytes, timingSafeEqual } from 'crypto';
import { nanoid } from 'nanoid';
import { client } from '../../db/index.js';

/** Recognisable in logs and config files, and greppable when one leaks. */
const TOKEN_PREFIX = 'mcp_';
const AUTH_CODE_TTL_MS = 10 * 60 * 1000;
const ACCESS_TOKEN_TTL_MS = 90 * 24 * 60 * 60 * 1000;

export interface McpPrincipal {
  tokenId: string;
  agentId: string;
  userId: string;
  clientId: string | null;
  name: string;
}

export interface IssuedToken {
  /** Returned to the client once. Never stored, never recoverable. */
  token: string;
  id: string;
  expiresAt: string | null;
}

function sha256(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

/** 32 random bytes, url-safe. ~256 bits — brute force is not the threat model. */
function mintSecret(): string {
  return TOKEN_PREFIX + randomBytes(32).toString('base64url');
}

/**
 * Constant-time compare for secrets we hold both sides of (client secrets).
 * Access tokens are found by hash lookup instead, which reveals nothing by timing.
 */
export function secretMatches(provided: string, expectedHash: string): boolean {
  const a = Buffer.from(sha256(provided));
  const b = Buffer.from(expectedHash);
  return a.length === b.length && timingSafeEqual(a, b);
}

// ── Access tokens ────────────────────────────────────────────────────────────

export async function issueAccessToken(opts: {
  agentId: string;
  userId: string;
  clientId?: string | null;
  name: string;
  ttlMs?: number | null;
}): Promise<IssuedToken> {
  const token = mintSecret();
  const id = nanoid();
  const now = new Date();
  const expiresAt =
    opts.ttlMs === null
      ? null
      : new Date(now.getTime() + (opts.ttlMs ?? ACCESS_TOKEN_TTL_MS)).toISOString();

  await client.execute({
    sql: `INSERT INTO mcp_access_tokens
            (id, agent_id, user_id, client_id, name, token_hash, token_prefix, expires_at, created_at)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    args: [
      id,
      opts.agentId,
      opts.userId,
      opts.clientId ?? null,
      opts.name,
      sha256(token),
      token.slice(0, 12),
      expiresAt,
      now.toISOString(),
    ],
  });

  return { token, id, expiresAt };
}

/**
 * Resolve a bearer token to its principal, or null.
 *
 * Returns null for unknown, revoked and expired tokens alike — the caller has
 * no business distinguishing them, and saying which would help an attacker
 * enumerate.
 *
 * `last_used_at` is stamped on every successful verification because it is what
 * the dashboard shows an owner deciding whether closing the old endpoint is
 * safe. It is written fire-and-forget: a failed stamp must never fail a request.
 */
export async function verifyAccessToken(token: string): Promise<McpPrincipal | null> {
  if (!token || !token.startsWith(TOKEN_PREFIX)) return null;

  const result = await client.execute({
    sql: `SELECT id, agent_id, user_id, client_id, name, expires_at, revoked_at
          FROM mcp_access_tokens WHERE token_hash = ? LIMIT 1`,
    args: [sha256(token)],
  });
  const row = result.rows[0];
  if (!row) return null;
  if (row.revoked_at) return null;
  if (row.expires_at && new Date(row.expires_at as string).getTime() < Date.now()) return null;

  void client
    .execute({
      sql: `UPDATE mcp_access_tokens SET last_used_at = ? WHERE id = ?`,
      args: [new Date().toISOString(), row.id as string],
    })
    .catch(() => {});

  return {
    tokenId: row.id as string,
    agentId: row.agent_id as string,
    userId: row.user_id as string,
    clientId: (row.client_id as string | null) ?? null,
    name: row.name as string,
  };
}

export async function listAgentTokens(agentId: string) {
  const result = await client.execute({
    sql: `SELECT id, name, token_prefix, last_used_at, created_at, expires_at
          FROM mcp_access_tokens
          WHERE agent_id = ? AND revoked_at IS NULL
          ORDER BY last_used_at DESC NULLS LAST, created_at DESC`,
    args: [agentId],
  });
  return result.rows.map((r) => ({
    id: r.id as string,
    name: r.name as string,
    tokenPrefix: r.token_prefix as string,
    lastUsedAt: (r.last_used_at as string | null) ?? null,
    createdAt: r.created_at as string,
    expiresAt: (r.expires_at as string | null) ?? null,
  }));
}

/** Scoped by agent so one owner's revoke cannot touch another agent's token. */
export async function revokeAccessToken(tokenId: string, agentId: string): Promise<boolean> {
  const now = new Date().toISOString();
  const result = await client.execute({
    sql: `UPDATE mcp_access_tokens SET revoked_at = ?
          WHERE id = ? AND agent_id = ? AND revoked_at IS NULL`,
    args: [now, tokenId, agentId],
  });
  await client.execute({
    sql: `UPDATE mcp_refresh_tokens SET revoked_at = ? WHERE access_token_id = ? AND revoked_at IS NULL`,
    args: [now, tokenId],
  });
  return (result.rowsAffected ?? 0) > 0;
}

// ── Authorization codes (PKCE) ───────────────────────────────────────────────

/**
 * PKCE S256: the client sends `code_challenge` up front and the matching
 * `code_verifier` at redemption. Only S256 is accepted — `plain` offers no
 * protection against an intercepted code, and OAuth 2.1 drops it.
 */
export function verifyPkce(verifier: string, challenge: string): boolean {
  if (!verifier || !challenge) return false;
  const computed = createHash('sha256').update(verifier).digest('base64url');
  const a = Buffer.from(computed);
  const b = Buffer.from(challenge);
  return a.length === b.length && timingSafeEqual(a, b);
}

export async function issueAuthCode(opts: {
  clientId: string;
  agentId: string;
  userId: string;
  redirectUri: string;
  codeChallenge: string;
  clientName?: string | null;
}): Promise<string> {
  const code = randomBytes(32).toString('base64url');
  await client.execute({
    sql: `INSERT INTO mcp_auth_codes
            (code_hash, client_id, agent_id, user_id, redirect_uri, code_challenge, client_name, expires_at, created_at)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    args: [
      sha256(code),
      opts.clientId,
      opts.agentId,
      opts.userId,
      opts.redirectUri,
      opts.codeChallenge,
      opts.clientName ?? null,
      new Date(Date.now() + AUTH_CODE_TTL_MS).toISOString(),
      new Date().toISOString(),
    ],
  });
  return code;
}

/**
 * Redeem a code. **Deletes it first**, so a replay finds nothing even if two
 * requests race — the delete is the lock. Returns null when the code is
 * unknown, already used, or expired.
 */
export async function redeemAuthCode(code: string): Promise<{
  clientId: string;
  agentId: string;
  userId: string;
  redirectUri: string;
  codeChallenge: string;
  clientName: string | null;
} | null> {
  const hash = sha256(code);
  const result = await client.execute({
    sql: `DELETE FROM mcp_auth_codes WHERE code_hash = ?
          RETURNING client_id, agent_id, user_id, redirect_uri, code_challenge, client_name, expires_at`,
    args: [hash],
  });
  const row = result.rows[0];
  if (!row) return null;
  if (new Date(row.expires_at as string).getTime() < Date.now()) return null;

  return {
    clientId: row.client_id as string,
    agentId: row.agent_id as string,
    userId: row.user_id as string,
    redirectUri: row.redirect_uri as string,
    codeChallenge: row.code_challenge as string,
    clientName: (row.client_name as string | null) ?? null,
  };
}

// ── Refresh tokens ───────────────────────────────────────────────────────────

export async function issueRefreshToken(opts: {
  accessTokenId: string;
  agentId: string;
  userId: string;
  clientId: string | null;
}): Promise<string> {
  const token = mintSecret();
  await client.execute({
    sql: `INSERT INTO mcp_refresh_tokens
            (token_hash, access_token_id, agent_id, user_id, client_id, created_at)
          VALUES (?, ?, ?, ?, ?, ?)`,
    args: [
      sha256(token),
      opts.accessTokenId,
      opts.agentId,
      opts.userId,
      opts.clientId,
      new Date().toISOString(),
    ],
  });
  return token;
}

/**
 * Exchange a refresh token for a new access token, rotating both.
 *
 * The old pair is revoked rather than left alive: a refresh token that keeps
 * working after use is a credential nobody is tracking.
 */
export async function rotateRefreshToken(refreshToken: string): Promise<{
  access: IssuedToken;
  refresh: string;
} | null> {
  const result = await client.execute({
    sql: `SELECT token_hash, access_token_id, agent_id, user_id, client_id, revoked_at
          FROM mcp_refresh_tokens WHERE token_hash = ? LIMIT 1`,
    args: [sha256(refreshToken)],
  });
  const row = result.rows[0];
  if (!row || row.revoked_at) return null;

  const prior = await client.execute({
    sql: `SELECT name FROM mcp_access_tokens WHERE id = ? LIMIT 1`,
    args: [row.access_token_id as string],
  });
  const name = (prior.rows[0]?.name as string | undefined) ?? 'MCP client';

  await revokeAccessToken(row.access_token_id as string, row.agent_id as string);

  const access = await issueAccessToken({
    agentId: row.agent_id as string,
    userId: row.user_id as string,
    clientId: (row.client_id as string | null) ?? null,
    name,
  });
  const refresh = await issueRefreshToken({
    accessTokenId: access.id,
    agentId: row.agent_id as string,
    userId: row.user_id as string,
    clientId: (row.client_id as string | null) ?? null,
  });

  return { access, refresh };
}

// ── Client registration (RFC 7591) ───────────────────────────────────────────

export async function registerClient(opts: {
  clientName: string;
  redirectUris: string[];
  confidential: boolean;
}): Promise<{ clientId: string; clientSecret: string | null }> {
  const clientId = nanoid();
  const clientSecret = opts.confidential ? mintSecret() : null;
  await client.execute({
    sql: `INSERT INTO mcp_oauth_clients (id, client_secret_hash, client_name, redirect_uris, created_at)
          VALUES (?, ?, ?, ?, ?)`,
    args: [
      clientId,
      clientSecret ? sha256(clientSecret) : null,
      opts.clientName,
      JSON.stringify(opts.redirectUris),
      new Date().toISOString(),
    ],
  });
  return { clientId, clientSecret };
}

export async function getClient(clientId: string) {
  const result = await client.execute({
    sql: `SELECT id, client_secret_hash, client_name, redirect_uris FROM mcp_oauth_clients WHERE id = ? LIMIT 1`,
    args: [clientId],
  });
  const row = result.rows[0];
  if (!row) return null;
  let redirectUris: string[] = [];
  try {
    const parsed = JSON.parse((row.redirect_uris as string) ?? '[]');
    if (Array.isArray(parsed)) redirectUris = parsed.filter((u): u is string => typeof u === 'string');
  } catch {
    redirectUris = [];
  }
  return {
    id: row.id as string,
    clientSecretHash: (row.client_secret_hash as string | null) ?? null,
    clientName: row.client_name as string,
    redirectUris,
  };
}
