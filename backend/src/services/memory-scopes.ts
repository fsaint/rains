/**
 * Memory Scopes
 *
 * A scope is a hard partition of one user's vault. Every entry belongs to
 * exactly one, and nothing — parents, wikilinks, transclusions, relations —
 * crosses between them. The `default` scope holds everything that predates
 * scopes and cannot be deleted.
 *
 * Scopes are private to their user. There is no cross-user membership, so
 * ownership stays `user_id = ?` plus a scope filter rather than becoming a
 * permission lookup.
 *
 * Two independent gates decide what an agent can reach, and they are not the
 * same thing:
 *
 *   1. The `memory` service instance being enabled on the agent. If it is not,
 *      no memory tool is exposed at all and scopes never come up.
 *   2. Scope grants, below, which narrow *which* scopes an already-enabled
 *      agent can see.
 *
 * This lives outside routes.ts on purpose: that file is ~6,600 lines and cannot
 * be exercised in isolation, and the resolution rules here are exactly the part
 * worth unit-testing.
 */

import { client } from '../db/index.js';
import { nanoid } from 'nanoid';

export interface MemoryScope {
  id: string;
  slug: string;
  name: string;
  description: string | null;
  /** Default *for this caller* — an agent's grant overrides the user's own flag. */
  isDefault: boolean;
  archivedAt: string | null;
}

export interface MemoryContext {
  userId: string;
  /** null for a dashboard session; set when the caller is an agent. */
  agentId: string | null;
  /** Granted, non-archived, default first. */
  scopes: MemoryScope[];
  scopeIds: string[];
  /** Never null — ensureDefaultScope guarantees one exists. */
  defaultScopeId: string;
  /** Gates scope CRUD and root-index edits. */
  isSession: boolean;
}

/** What an agent may reach, and where its writes land by default. */
export interface AgentScopeGrants {
  mode: 'all' | 'restricted';
  scopes: MemoryScope[];
  defaultScopeId: string;
}

function rowToScope(row: Record<string, unknown>): MemoryScope {
  return {
    id: row.id as string,
    slug: row.slug as string,
    name: row.name as string,
    description: (row.description as string | null) ?? null,
    isDefault: Boolean(row.is_default),
    archivedAt: (row.archived_at as string | null) ?? null,
  };
}

const SCOPE_COLUMNS = 'id, slug, name, description, is_default, archived_at';

/**
 * The user's default scope, created if they have none.
 *
 * The boot-time backfill only creates scopes for users who already had memory,
 * so a user who has never written an entry arrives here first. Deriving the id
 * the same way the backfill does keeps the two from ever racing a duplicate in.
 */
export async function ensureDefaultScope(userId: string): Promise<MemoryScope> {
  const existing = await client.execute({
    sql: `SELECT ${SCOPE_COLUMNS} FROM memory_scopes
          WHERE user_id = ? AND is_default LIMIT 1`,
    args: [userId],
  });
  if (existing.rows.length > 0) return rowToScope(existing.rows[0] as Record<string, unknown>);

  await client.execute({
    sql: `INSERT INTO memory_scopes
            (id, user_id, slug, name, description, is_default, is_system, created_at, updated_at)
          VALUES (md5(?), ?, 'default', 'Default', ?, true, true, now(), now())
          ON CONFLICT (user_id, slug) DO NOTHING`,
    args: [
      `memscope:${userId}`,
      userId,
      'Everything that was in your memory before scopes existed.',
    ],
  });

  const created = await client.execute({
    sql: `SELECT ${SCOPE_COLUMNS} FROM memory_scopes
          WHERE user_id = ? AND slug = 'default' LIMIT 1`,
    args: [userId],
  });
  return rowToScope(created.rows[0] as Record<string, unknown>);
}

export async function listUserScopes(
  userId: string,
  opts: { includeArchived?: boolean } = {}
): Promise<MemoryScope[]> {
  const result = await client.execute({
    sql: `SELECT ${SCOPE_COLUMNS} FROM memory_scopes
          WHERE user_id = ?
            ${opts.includeArchived ? '' : 'AND archived_at IS NULL'}
          ORDER BY is_default DESC, name ASC`,
    args: [userId],
  });
  return result.rows.map((r) => rowToScope(r as Record<string, unknown>));
}

/**
 * Resolve what one agent may reach.
 *
 * The join is filtered to the owner's scopes as well as the agent's grants, so
 * a grant pointing at somebody else's scope — however it got written — is inert
 * rather than an escape hatch.
 */
export async function getAgentScopeGrants(
  agentId: string,
  userId: string
): Promise<AgentScopeGrants> {
  const result = await client.execute({
    sql: `SELECT s.id, s.slug, s.name, s.description, s.archived_at,
                 COALESCE(g.is_default, s.is_default) AS is_default,
                 (g.agent_id IS NOT NULL) AS granted,
                 (SELECT COUNT(*) FROM agent_memory_scopes WHERE agent_id = ?) AS grant_count
          FROM memory_scopes s
          LEFT JOIN agent_memory_scopes g ON g.scope_id = s.id AND g.agent_id = ?
          WHERE s.user_id = ? AND s.archived_at IS NULL
          ORDER BY COALESCE(g.is_default, s.is_default) DESC, s.name ASC`,
    args: [agentId, agentId, userId],
  });

  const rows = result.rows as Record<string, unknown>[];
  const grantCount = Number(rows[0]?.grant_count ?? 0);
  const restricted = grantCount > 0;

  const scopes = (restricted ? rows.filter((r) => Boolean(r.granted)) : rows).map(rowToScope);

  return {
    mode: restricted ? 'restricted' : 'all',
    scopes,
    defaultScopeId: scopes.find((s) => s.isDefault)?.id ?? scopes[0]?.id ?? '',
  };
}

/**
 * Replace an agent's grants. `null` clears them, returning the agent to the
 * implicit "every scope its owner has".
 */
export async function setAgentScopeGrants(
  agentId: string,
  userId: string,
  grants: { scopeIds: string[]; defaultScopeId: string } | null
): Promise<void> {
  await client.execute({
    sql: `DELETE FROM agent_memory_scopes WHERE agent_id = ?`,
    args: [agentId],
  });
  if (!grants || grants.scopeIds.length === 0) return;

  // Every id must belong to this owner, so a grant can never point outward.
  const placeholders = grants.scopeIds.map(() => '?').join(', ');
  const owned = await client.execute({
    sql: `SELECT id FROM memory_scopes WHERE user_id = ? AND id IN (${placeholders})`,
    args: [userId, ...grants.scopeIds],
  });
  const ownedIds = new Set(owned.rows.map((r) => r.id as string));

  for (const scopeId of grants.scopeIds) {
    if (!ownedIds.has(scopeId)) continue;
    await client.execute({
      sql: `INSERT INTO agent_memory_scopes (id, agent_id, scope_id, is_default, created_at)
            VALUES (?, ?, ?, ?, now())
            ON CONFLICT (agent_id, scope_id) DO NOTHING`,
      args: [nanoid(), agentId, scopeId, scopeId === grants.defaultScopeId],
    });
  }
}

/**
 * Build the scope context for a request.
 *
 * `resolveAgent` is injected rather than imported because the gateway-token
 * validator lives inside the routes closure. Returns null only when neither
 * auth mode yields a user, which callers turn into a 401.
 */
export async function resolveMemoryContext(
  session: { userId: string } | null,
  resolveAgent: () => Promise<{ agentId: string; userId: string } | null>
): Promise<MemoryContext | null> {
  if (session) {
    const scopes = await listUserScopes(session.userId);
    const effective = scopes.length > 0 ? scopes : [await ensureDefaultScope(session.userId)];
    return {
      userId: session.userId,
      agentId: null,
      scopes: effective,
      scopeIds: effective.map((s) => s.id),
      defaultScopeId: effective.find((s) => s.isDefault)?.id ?? effective[0].id,
      isSession: true,
    };
  }

  const agent = await resolveAgent();
  if (!agent) return null;

  const grants = await getAgentScopeGrants(agent.agentId, agent.userId);
  const effective =
    grants.scopes.length > 0 ? grants.scopes : [await ensureDefaultScope(agent.userId)];

  return {
    userId: agent.userId,
    agentId: agent.agentId,
    scopes: effective,
    scopeIds: effective.map((s) => s.id),
    defaultScopeId:
      effective.find((s) => s.id === grants.defaultScopeId)?.id ??
      effective.find((s) => s.isDefault)?.id ??
      effective[0].id,
    isSession: false,
  };
}

export interface ScopeSelection {
  scopeIds: string[];
}

export interface ScopeRejection {
  status: number;
  body: Record<string, unknown>;
}

export function isRejection(r: ScopeSelection | ScopeRejection): r is ScopeRejection {
  return 'status' in r;
}

/**
 * Turn an optional `scope` argument into the set of scopes a query may touch.
 *
 * Reads with no scope span everything the caller can reach; writes with no
 * scope land in one place. A scope the caller cannot reach is a 403 carrying
 * the list of ones it can — an LLM that gets the valid slugs back can correct
 * itself on the next call instead of failing the task.
 */
export function pickScope(
  ctx: MemoryContext,
  requested: string | null | undefined,
  mode: 'read' | 'write'
): ScopeSelection | ScopeRejection {
  if (requested === undefined || requested === null) {
    return { scopeIds: mode === 'read' ? ctx.scopeIds : [ctx.defaultScopeId] };
  }

  if (typeof requested !== 'string' || requested.trim() === '') {
    return {
      status: 400,
      body: { error: 'scope must be a non-empty slug', code: 'INVALID_SCOPE' },
    };
  }

  const needle = requested.trim().toLowerCase();
  // Slug first — that is what agents are told to pass; id for the dashboard.
  const match =
    ctx.scopes.find((s) => s.slug.toLowerCase() === needle) ??
    ctx.scopes.find((s) => s.id === requested.trim());

  if (!match) {
    const available = ctx.scopes.map((s) => s.slug);
    return {
      status: 403,
      body: {
        error: `Scope "${requested}" is not available. Available: ${available.join(', ')}.`,
        code: 'SCOPE_NOT_GRANTED',
        available_scopes: available,
      },
    };
  }

  return { scopeIds: [match.id] };
}
