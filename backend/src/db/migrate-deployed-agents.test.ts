import { describe, it, expect, vi } from 'vitest';
import { migrateDeployedAgents } from './migrate-deployed-agents.js';

function fakeExec(nullTokenIds: string[], tableExists = true) {
  const calls: Array<{ sql: string; args: unknown[] }> = [];
  const execute = vi.fn(async (q: { sql: string; args: unknown[] } | string) => {
    const sql = typeof q === 'string' ? q : q.sql;
    const args = typeof q === 'string' ? [] : q.args;
    calls.push({ sql, args });
    if (sql.includes('to_regclass')) return { rows: [{ exists: tableExists }] };
    if (sql.includes('WHERE gateway_token IS NULL')) return { rows: nullTokenIds.map((id) => ({ id })) };
    return { rows: [] };
  });
  return { execute, calls };
}

describe('migrateDeployedAgents', () => {
  it('copies the newest live deployment row onto each agent, then fills missing tokens', async () => {
    const db = fakeExec(['a-no-row']);
    await migrateDeployedAgents(db);

    const copy = db.calls.find((c) => c.sql.includes('DISTINCT ON (agent_id)'));
    expect(copy, 'expected the fold UPDATE').toBeDefined();
    expect(copy!.sql).toContain("status NOT IN ('destroyed', 'error')");
    expect(copy!.sql).toContain('a.gateway_token IS NULL');

    const fill = db.calls.filter((c) => c.sql.startsWith('UPDATE agents SET gateway_token = ?'));
    expect(fill).toHaveLength(1);
    expect(fill[0].args[1]).toBe('a-no-row');
    expect(String(fill[0].args[0])).toHaveLength(32);
  });

  it('never opens an agent that had no live row: the fill writes only the token', async () => {
    const db = fakeExec(['a-no-row']);
    await migrateDeployedAgents(db);
    const fill = db.calls.find((c) => c.sql.startsWith('UPDATE agents SET gateway_token = ?'));
    expect(fill!.sql).not.toContain('allow_unauthenticated');
  });

  it('skips the copy when deployed_agents is already gone, but still fills tokens', async () => {
    const db = fakeExec(['a-1'], false);
    await migrateDeployedAgents(db);
    expect(db.calls.some((c) => c.sql.includes('DISTINCT ON (agent_id)'))).toBe(false);
    expect(db.calls.some((c) => c.sql.startsWith('UPDATE agents SET gateway_token = ?'))).toBe(true);
  });
});
