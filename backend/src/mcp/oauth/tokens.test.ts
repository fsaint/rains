/**
 * MCP token store tests.
 *
 * The properties here are the ones a reimplementation would get wrong: that a
 * revoked or expired token is indistinguishable from an unknown one, that an
 * authorization code cannot be redeemed twice, and that PKCE actually verifies.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createHash, randomBytes } from 'crypto';

vi.mock('../../db/index.js', () => ({
  client: { execute: vi.fn() },
  db: { select: vi.fn(), insert: vi.fn(), update: vi.fn(), delete: vi.fn() },
}));

vi.mock('nanoid', () => ({ nanoid: vi.fn(() => 'generated-id') }));

import { client } from '../../db/index.js';
import {
  issueAccessToken,
  verifyAccessToken,
  revokeAccessToken,
  issueAuthCode,
  redeemAuthCode,
  verifyPkce,
  registerClient,
  secretMatches,
} from './tokens.js';

const rows = (r: Record<string, unknown>[]) => ({ rows: r, rowsAffected: r.length, columns: [] });
const EMPTY = rows([]);

function queue(...results: unknown[]) {
  const mock = vi.mocked(client.execute);
  mock.mockReset();
  for (const r of results) mock.mockResolvedValueOnce(r as never);
  mock.mockResolvedValue(EMPTY as never);
}

const callAt = (n: number) => vi.mocked(client.execute).mock.calls[n][0] as { sql: string; args: unknown[] };

beforeEach(() => {
  vi.clearAllMocks();
});

describe('issueAccessToken', () => {
  it('returns the plaintext once and stores only its hash', async () => {
    queue(EMPTY);

    const issued = await issueAccessToken({ agentId: 'a1', userId: 'u1', name: 'Claude Code' });

    expect(issued.token).toMatch(/^mcp_/);
    const stored = callAt(0).args as string[];
    // The plaintext must appear nowhere in the row.
    expect(stored).not.toContain(issued.token);
    expect(stored).toContain(createHash('sha256').update(issued.token).digest('hex'));
  });

  it('stores a prefix so the UI can name a row without the secret', async () => {
    queue(EMPTY);

    const issued = await issueAccessToken({ agentId: 'a1', userId: 'u1', name: 'x' });

    expect(callAt(0).args).toContain(issued.token.slice(0, 12));
  });

  it('honours a null ttl for a non-expiring token', async () => {
    queue(EMPTY);
    const issued = await issueAccessToken({ agentId: 'a1', userId: 'u1', name: 'x', ttlMs: null });
    expect(issued.expiresAt).toBeNull();
  });
});

describe('verifyAccessToken', () => {
  const live = {
    id: 't1', agent_id: 'a1', user_id: 'u1', client_id: 'c1', name: 'Claude Code',
    expires_at: new Date(Date.now() + 60_000).toISOString(), revoked_at: null,
  };

  it('resolves a live token to its principal', async () => {
    queue(rows([live]));

    const principal = await verifyAccessToken('mcp_abc');

    expect(principal).toMatchObject({ tokenId: 't1', agentId: 'a1', userId: 'u1' });
  });

  it('looks the token up by hash, never by value', async () => {
    queue(rows([live]));

    await verifyAccessToken('mcp_abc');

    const call = callAt(0);
    expect(call.args[0]).toBe(createHash('sha256').update('mcp_abc').digest('hex'));
    expect(call.args).not.toContain('mcp_abc');
  });

  it('stamps last_used_at, which is what the owner reads before closing the old URL', async () => {
    queue(rows([live]), EMPTY);

    await verifyAccessToken('mcp_abc');
    await new Promise((r) => setTimeout(r, 0)); // the stamp is fire-and-forget

    const sqls = vi.mocked(client.execute).mock.calls.map((c) => (c[0] as { sql: string }).sql);
    expect(sqls.some((q) => q.includes('SET last_used_at'))).toBe(true);
  });

  it('rejects a revoked token', async () => {
    queue(rows([{ ...live, revoked_at: new Date().toISOString() }]));
    expect(await verifyAccessToken('mcp_abc')).toBeNull();
  });

  it('rejects an expired token', async () => {
    queue(rows([{ ...live, expires_at: new Date(Date.now() - 1000).toISOString() }]));
    expect(await verifyAccessToken('mcp_abc')).toBeNull();
  });

  it('rejects an unknown token', async () => {
    queue(EMPTY);
    expect(await verifyAccessToken('mcp_nope')).toBeNull();
  });

  it('rejects anything without the prefix without touching the database', async () => {
    queue(EMPTY);
    expect(await verifyAccessToken('not-a-token')).toBeNull();
    expect(vi.mocked(client.execute)).not.toHaveBeenCalled();
  });
});

describe('revokeAccessToken', () => {
  it('is scoped by agent, so one agent cannot revoke another\'s token', async () => {
    queue(rows([]), EMPTY);

    await revokeAccessToken('t1', 'a1');

    expect(callAt(0).args).toEqual(expect.arrayContaining(['t1', 'a1']));
  });

  it('revokes the paired refresh token too', async () => {
    queue({ rows: [], rowsAffected: 1, columns: [] }, EMPTY);

    await revokeAccessToken('t1', 'a1');

    expect(callAt(1).sql).toContain('mcp_refresh_tokens');
  });
});

describe('PKCE', () => {
  it('accepts a verifier whose S256 hash matches the challenge', () => {
    const verifier = randomBytes(32).toString('base64url');
    const challenge = createHash('sha256').update(verifier).digest('base64url');
    expect(verifyPkce(verifier, challenge)).toBe(true);
  });

  it('rejects a mismatched verifier', () => {
    const challenge = createHash('sha256').update('right').digest('base64url');
    expect(verifyPkce('wrong', challenge)).toBe(false);
  });

  it('rejects empty input rather than treating it as a match', () => {
    expect(verifyPkce('', '')).toBe(false);
    expect(verifyPkce('x', '')).toBe(false);
  });
});

describe('authorization codes', () => {
  it('stores only the hash of the code', async () => {
    queue(EMPTY);

    const code = await issueAuthCode({
      clientId: 'c1', agentId: 'a1', userId: 'u1',
      redirectUri: 'http://localhost:9', codeChallenge: 'ch',
    });

    expect(callAt(0).args).not.toContain(code);
    expect(callAt(0).args[0]).toBe(createHash('sha256').update(code).digest('hex'));
  });

  it('deletes on redemption, so a replay finds nothing', async () => {
    // The DELETE ... RETURNING is the lock: two racing redemptions cannot both win.
    queue(rows([{
      client_id: 'c1', agent_id: 'a1', user_id: 'u1', redirect_uri: 'http://localhost:9',
      code_challenge: 'ch', client_name: null,
      expires_at: new Date(Date.now() + 60_000).toISOString(),
    }]));

    const claim = await redeemAuthCode('code');

    expect(claim).toMatchObject({ agentId: 'a1' });
    expect(callAt(0).sql).toContain('DELETE FROM mcp_auth_codes');
    expect(callAt(0).sql).toContain('RETURNING');
  });

  it('refuses an expired code even though the row existed', async () => {
    queue(rows([{
      client_id: 'c1', agent_id: 'a1', user_id: 'u1', redirect_uri: 'http://localhost:9',
      code_challenge: 'ch', client_name: null,
      expires_at: new Date(Date.now() - 1000).toISOString(),
    }]));

    expect(await redeemAuthCode('code')).toBeNull();
  });

  it('returns null for an unknown code', async () => {
    queue(EMPTY);
    expect(await redeemAuthCode('nope')).toBeNull();
  });
});

describe('client registration', () => {
  it('issues a secret only for confidential clients', async () => {
    queue(EMPTY);
    const pub = await registerClient({ clientName: 'x', redirectUris: ['http://a'], confidential: false });
    expect(pub.clientSecret).toBeNull();

    queue(EMPTY);
    const conf = await registerClient({ clientName: 'x', redirectUris: ['http://a'], confidential: true });
    expect(conf.clientSecret).toMatch(/^mcp_/);
  });

  it('stores the secret hashed', async () => {
    queue(EMPTY);
    const { clientSecret } = await registerClient({
      clientName: 'x', redirectUris: ['http://a'], confidential: true,
    });
    expect(callAt(0).args).not.toContain(clientSecret);
    expect(secretMatches(clientSecret as string, callAt(0).args[1] as string)).toBe(true);
  });
});
