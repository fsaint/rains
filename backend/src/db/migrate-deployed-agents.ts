import { nanoid } from 'nanoid';

interface Exec {
  execute(q: { sql: string; args: unknown[] } | string): Promise<{ rows: Record<string, unknown>[] }>;
}

/**
 * One-time fold of deployed_agents into agents.
 *
 * Each agent takes gateway_token and allow_unauthenticated from its newest
 * deployment row that is neither destroyed nor errored. Agents with no such
 * row keep the column default (closed) and get a fresh gateway token, so an
 * agent id is never a credential by accident. Idempotent: the copy only
 * touches agents whose gateway_token is still null, and the table check
 * makes the whole thing a no-op once deployed_agents has been dropped.
 */
export async function migrateDeployedAgents(db: Exec): Promise<void> {
  const exists = await db.execute({
    sql: `SELECT to_regclass('public.deployed_agents') IS NOT NULL AS exists`,
    args: [],
  });
  if (exists.rows[0]?.exists === true) {
    await db.execute({
      sql: `UPDATE agents a
            SET gateway_token = d.gateway_token,
                allow_unauthenticated = d.allow_unauthenticated
            FROM (
              SELECT DISTINCT ON (agent_id) agent_id, gateway_token, allow_unauthenticated
              FROM deployed_agents
              WHERE status NOT IN ('destroyed', 'error')
              ORDER BY agent_id, created_at DESC
            ) d
            WHERE d.agent_id = a.id AND a.gateway_token IS NULL`,
      args: [],
    });
  }

  const missing = await db.execute({
    sql: `SELECT id FROM agents WHERE gateway_token IS NULL`,
    args: [],
  });
  for (const row of missing.rows) {
    await db.execute({
      sql: `UPDATE agents SET gateway_token = ? WHERE id = ?`,
      args: [nanoid(32), row.id as string],
    });
  }
}
