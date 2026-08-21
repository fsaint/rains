import postgres from 'postgres';
import { drizzle } from 'drizzle-orm/postgres-js';
import bcrypt from 'bcryptjs';
import { nanoid } from 'nanoid';
import { readdir, readFile } from 'fs/promises';
import { join, dirname, basename } from 'path';
import { fileURLToPath } from 'url';
import { config } from '../config/index.js';
import * as schema from './schema.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const TEMPLATES_DIR = join(__dirname, '..', '..', '..', 'templates', 'initial-prompts');
const SKILLS_TEMPLATES_DIR = join(__dirname, '..', '..', '..', 'templates', 'skills');

const DATABASE_URL = config.databaseUrl;

// Create postgres.js connection (exported for transaction use)
export const sql = postgres(DATABASE_URL);

// Create Drizzle ORM instance
export const db = drizzle(sql, { schema });

// ============================================================================
// Compatibility layer: wraps postgres.js to match the @libsql/client API
// so existing code using client.execute() doesn't need to change.
// ============================================================================

interface LibSQLResult {
  rows: Record<string, unknown>[];
  columns: string[];
  rowsAffected: number;
  lastInsertRowid: bigint;
}

function toResult(rows: postgres.Row[]): LibSQLResult {
  // postgres.js attaches a `count` property (number of affected rows) to the
  // result array for INSERT/UPDATE/DELETE statements. For SELECT the count
  // equals rows.length, so using it is safe in all cases.
  const rowsAffected = typeof (rows as any).count === 'number'
    ? (rows as any).count
    : rows.length;
  return {
    rows: rows as Record<string, unknown>[],
    columns: rows.length > 0 ? Object.keys(rows[0]) : [],
    rowsAffected,
    lastInsertRowid: rows.length > 0 && 'id' in rows[0] && typeof rows[0].id === 'number' ? BigInt(rows[0].id) : 0n,
  };
}

/**
 * Compatibility client that matches the @libsql/client execute() API.
 * Accepts either a raw SQL string or { sql, args } object.
 */
export const client = {
  async execute(
    input: string | { sql: string; args: unknown[] }
  ): Promise<LibSQLResult> {
    if (typeof input === 'string') {
      const rows = await sql.unsafe(input);
      return toResult(rows as postgres.Row[]);
    }

    // Replace ? placeholders with $1, $2, ... for postgres
    let idx = 0;
    const pgSql = input.sql.replace(/\?/g, () => `$${++idx}`);
    const rows = await sql.unsafe(pgSql, input.args as any[]);
    return toResult(rows as postgres.Row[]);
  },
};

// Initialize database tables
export async function initializeDatabase() {
  // Users table
  await sql`
    CREATE TABLE IF NOT EXISTS users (
      id TEXT PRIMARY KEY,
      email TEXT NOT NULL UNIQUE,
      name TEXT NOT NULL,
      password_hash TEXT NOT NULL,
      role TEXT DEFAULT 'user' NOT NULL,
      status TEXT DEFAULT 'active' NOT NULL,
      created_at TEXT DEFAULT now() NOT NULL,
      updated_at TEXT DEFAULT now() NOT NULL
    )
  `;

  await sql`
    CREATE TABLE IF NOT EXISTS agents (
      id TEXT PRIMARY KEY,
      user_id TEXT,
      name TEXT NOT NULL,
      description TEXT,
      policy_id TEXT,
      status TEXT DEFAULT 'pending' NOT NULL,
      created_at TEXT DEFAULT now() NOT NULL,
      updated_at TEXT DEFAULT now() NOT NULL
    )
  `;

  // Add user_id column if missing (migration from pre-users schema)
  await sql`
    DO $$ BEGIN
      ALTER TABLE agents ADD COLUMN IF NOT EXISTS user_id TEXT;
    EXCEPTION WHEN duplicate_column THEN NULL;
    END $$
  `;

  await sql`
    CREATE TABLE IF NOT EXISTS agent_credentials (
      agent_id TEXT NOT NULL,
      credential_id TEXT NOT NULL,
      PRIMARY KEY (agent_id, credential_id)
    )
  `;

  await sql`
    CREATE TABLE IF NOT EXISTS policies (
      id TEXT PRIMARY KEY,
      version TEXT NOT NULL,
      name TEXT NOT NULL,
      yaml TEXT NOT NULL,
      created_at TEXT DEFAULT now() NOT NULL,
      updated_at TEXT DEFAULT now() NOT NULL
    )
  `;

  await sql`
    CREATE TABLE IF NOT EXISTS credentials (
      id TEXT PRIMARY KEY,
      user_id TEXT,
      service_id TEXT NOT NULL,
      type TEXT NOT NULL,
      encrypted_data TEXT NOT NULL,
      iv TEXT NOT NULL,
      auth_tag TEXT NOT NULL,
      expires_at TEXT,
      account_email TEXT,
      account_name TEXT,
      granted_services TEXT,
      created_at TEXT DEFAULT now() NOT NULL,
      updated_at TEXT DEFAULT now() NOT NULL
    )
  `;

  // Add columns if missing (migration)
  await sql`
    DO $$ BEGIN
      ALTER TABLE credentials ADD COLUMN IF NOT EXISTS user_id TEXT;
      ALTER TABLE credentials ADD COLUMN IF NOT EXISTS account_email TEXT;
      ALTER TABLE credentials ADD COLUMN IF NOT EXISTS account_name TEXT;
      ALTER TABLE credentials ADD COLUMN IF NOT EXISTS granted_services TEXT;
    EXCEPTION WHEN duplicate_column THEN NULL;
    END $$
  `;

  await sql`
    CREATE TABLE IF NOT EXISTS audit_log (
      id SERIAL PRIMARY KEY,
      timestamp TEXT DEFAULT now() NOT NULL,
      event_type TEXT NOT NULL,
      user_id TEXT,
      agent_id TEXT,
      tool TEXT,
      arguments_json TEXT,
      result TEXT,
      duration_ms INTEGER,
      metadata_json TEXT
    )
  `;

  await sql`CREATE INDEX IF NOT EXISTS idx_audit_timestamp ON audit_log(timestamp)`;
  await sql`CREATE INDEX IF NOT EXISTS idx_audit_agent ON audit_log(agent_id)`;

  await sql`
    DO $$ BEGIN
      ALTER TABLE audit_log ADD COLUMN IF NOT EXISTS user_id TEXT;
    EXCEPTION WHEN duplicate_column THEN NULL;
    END $$
  `;

  await sql`
    CREATE TABLE IF NOT EXISTS approvals (
      id TEXT PRIMARY KEY,
      agent_id TEXT NOT NULL,
      tool TEXT NOT NULL,
      arguments_json TEXT,
      context TEXT,
      status TEXT DEFAULT 'pending' NOT NULL,
      requested_at TEXT DEFAULT now() NOT NULL,
      expires_at TEXT NOT NULL,
      resolved_at TEXT,
      resolved_by TEXT,
      resolution_comment TEXT
    )
  `;

  await sql`CREATE INDEX IF NOT EXISTS idx_approvals_status ON approvals(status)`;
  await sql`CREATE INDEX IF NOT EXISTS idx_approvals_agent ON approvals(agent_id)`;

  // Add email_last_sent_at for 24-hour re-send throttle on reauth approvals (migration)
  await sql`
    DO $$ BEGIN
      ALTER TABLE approvals ADD COLUMN IF NOT EXISTS email_last_sent_at TEXT;
    EXCEPTION WHEN duplicate_column THEN NULL;
    END $$
  `;

  await sql`
    CREATE TABLE IF NOT EXISTS spend_records (
      id SERIAL PRIMARY KEY,
      agent_id TEXT NOT NULL,
      service_id TEXT NOT NULL,
      amount REAL NOT NULL,
      currency TEXT DEFAULT 'USD' NOT NULL,
      recorded_at TEXT DEFAULT now() NOT NULL
    )
  `;

  await sql`CREATE INDEX IF NOT EXISTS idx_spend_agent_date ON spend_records(agent_id, recorded_at)`;

  // Spend cap columns on spend_records (migration)
  await sql`
    DO $$ BEGIN
      ALTER TABLE spend_records ADD COLUMN IF NOT EXISTS input_tokens INTEGER DEFAULT 0;
      ALTER TABLE spend_records ADD COLUMN IF NOT EXISTS output_tokens INTEGER DEFAULT 0;
      ALTER TABLE spend_records ADD COLUMN IF NOT EXISTS billing_period TEXT;
    EXCEPTION WHEN duplicate_column THEN NULL;
    END $$
  `;

  // NOTE: the spend-cap columns on deployed_agents used to be added here, but
  // that table is not created until further down. See below, after its CREATE.

  await sql`
    CREATE TABLE IF NOT EXISTS mcp_servers (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      transport TEXT NOT NULL,
      config_json TEXT NOT NULL,
      health_status TEXT DEFAULT 'unknown' NOT NULL,
      last_health_check TEXT,
      created_at TEXT DEFAULT now() NOT NULL,
      updated_at TEXT DEFAULT now() NOT NULL
    )
  `;

  await sql`
    CREATE TABLE IF NOT EXISTS device_tokens (
      id TEXT PRIMARY KEY,
      device_id TEXT NOT NULL UNIQUE,
      token TEXT NOT NULL,
      platform TEXT NOT NULL,
      user_id TEXT,
      created_at TEXT DEFAULT now() NOT NULL,
      updated_at TEXT DEFAULT now() NOT NULL
    )
  `;

  await sql`
    CREATE TABLE IF NOT EXISTS agent_service_access (
      id TEXT PRIMARY KEY,
      agent_id TEXT NOT NULL,
      service_type TEXT NOT NULL,
      enabled BOOLEAN DEFAULT false NOT NULL,
      credential_id TEXT,
      created_at TEXT DEFAULT now() NOT NULL,
      updated_at TEXT DEFAULT now() NOT NULL,
      UNIQUE(agent_id, service_type)
    )
  `;

  await sql`CREATE INDEX IF NOT EXISTS idx_agent_service_agent ON agent_service_access(agent_id)`;

  await sql`
    CREATE TABLE IF NOT EXISTS agent_service_credentials (
      id TEXT PRIMARY KEY,
      agent_id TEXT NOT NULL,
      service_type TEXT NOT NULL,
      credential_id TEXT NOT NULL,
      is_default BOOLEAN DEFAULT false NOT NULL,
      created_at TEXT DEFAULT now() NOT NULL,
      UNIQUE(agent_id, service_type, credential_id)
    )
  `;

  await sql`CREATE INDEX IF NOT EXISTS idx_asc_agent_service ON agent_service_credentials(agent_id, service_type)`;

  await sql`
    CREATE TABLE IF NOT EXISTS agent_tool_permissions (
      id TEXT PRIMARY KEY,
      agent_id TEXT NOT NULL,
      service_type TEXT NOT NULL,
      tool_name TEXT NOT NULL,
      permission TEXT NOT NULL,
      instance_id TEXT,
      created_at TEXT DEFAULT now() NOT NULL,
      updated_at TEXT DEFAULT now() NOT NULL,
      UNIQUE(agent_id, service_type, tool_name)
    )
  `;

  await sql`CREATE INDEX IF NOT EXISTS idx_agent_tool_perm ON agent_tool_permissions(agent_id, service_type)`;

  await sql`
    DO $$ BEGIN
      ALTER TABLE agent_tool_permissions ADD COLUMN IF NOT EXISTS instance_id TEXT;
    EXCEPTION WHEN duplicate_column THEN NULL;
    END $$
  `;

  await sql`
    CREATE TABLE IF NOT EXISTS agent_service_instances (
      id TEXT PRIMARY KEY,
      agent_id TEXT NOT NULL,
      service_type TEXT NOT NULL,
      label TEXT,
      credential_id TEXT,
      enabled BOOLEAN DEFAULT true NOT NULL,
      is_default BOOLEAN DEFAULT false NOT NULL,
      created_at TEXT DEFAULT now() NOT NULL,
      updated_at TEXT DEFAULT now() NOT NULL
    )
  `;

  await sql`CREATE INDEX IF NOT EXISTS idx_asi_agent ON agent_service_instances(agent_id)`;
  await sql`CREATE INDEX IF NOT EXISTS idx_asi_agent_service ON agent_service_instances(agent_id, service_type)`;

  // Backfill agent_service_credentials from agent_service_access
  {
    const existing = await sql`SELECT COUNT(*) as count FROM agent_service_credentials`;
    const existingCount = Number(existing[0]?.count ?? 0);
    if (existingCount === 0) {
      const accessRows = await sql`
        SELECT id, agent_id, service_type, credential_id FROM agent_service_access WHERE credential_id IS NOT NULL
      `;
      for (const row of accessRows) {
        const id = `asc_${row.agent_id}_${row.service_type}_${row.credential_id}`;
        await sql`
          INSERT INTO agent_service_credentials (id, agent_id, service_type, credential_id, is_default, created_at)
          VALUES (${id}, ${row.agent_id}, ${row.service_type}, ${row.credential_id}, true, now())
          ON CONFLICT DO NOTHING
        `;
      }
      if (accessRows.length > 0) {
        console.log(`Backfilled ${accessRows.length} agent_service_credentials from agent_service_access`);
      }
    }
  }

  // Backfill agent_service_instances from agent_service_credentials and agent_service_access
  {
    const instanceCount = await sql`SELECT COUNT(*) as count FROM agent_service_instances`;
    const count = Number(instanceCount[0]?.count ?? 0);
    if (count === 0) {
      const credRows = await sql`
        SELECT asc2.agent_id, asc2.service_type, asc2.credential_id, asc2.is_default,
               asa.enabled
        FROM agent_service_credentials asc2
        LEFT JOIN agent_service_access asa ON asa.agent_id = asc2.agent_id AND asa.service_type = asc2.service_type
      `;
      const seenAgentService = new Set<string>();
      for (const row of credRows) {
        const agentId = row.agent_id as string;
        const serviceType = row.service_type as string;
        const credentialId = row.credential_id as string;
        const isDefault = row.is_default as boolean;
        const enabled = row.enabled ?? false;
        const id = nanoid();
        await sql`
          INSERT INTO agent_service_instances (id, agent_id, service_type, credential_id, enabled, is_default, created_at, updated_at)
          VALUES (${id}, ${agentId}, ${serviceType}, ${credentialId}, ${enabled}, ${isDefault}, now(), now())
          ON CONFLICT DO NOTHING
        `;
        seenAgentService.add(`${agentId}:${serviceType}`);
        if (isDefault) {
          await sql`
            UPDATE agent_tool_permissions SET instance_id = ${id}
            WHERE agent_id = ${agentId} AND service_type = ${serviceType} AND instance_id IS NULL
          `;
        }
      }

      const accessRows = await sql`
        SELECT id, agent_id, service_type, credential_id, enabled FROM agent_service_access
      `;
      for (const row of accessRows) {
        const agentId = row.agent_id as string;
        const serviceType = row.service_type as string;
        const key = `${agentId}:${serviceType}`;
        if (seenAgentService.has(key)) continue;
        if (!row.enabled) continue;
        const id = nanoid();
        await sql`
          INSERT INTO agent_service_instances (id, agent_id, service_type, credential_id, enabled, is_default, created_at, updated_at)
          VALUES (${id}, ${agentId}, ${serviceType}, ${row.credential_id}, ${row.enabled}, true, now(), now())
          ON CONFLICT DO NOTHING
        `;
        await sql`
          UPDATE agent_tool_permissions SET instance_id = ${id}
          WHERE agent_id = ${agentId} AND service_type = ${serviceType} AND instance_id IS NULL
        `;
      }

      const newCount = await sql`SELECT COUNT(*) as count FROM agent_service_instances`;
      const created = Number(newCount[0]?.count ?? 0);
      if (created > 0) {
        console.log(`Backfilled ${created} agent_service_instances from existing data`);
      }
    }
  }

  // Backfill memory service for existing agents
  {
    const agentsWithoutMemory = await sql`
      SELECT id FROM agents
      WHERE NOT EXISTS (
        SELECT 1 FROM agent_service_instances
        WHERE agent_service_instances.agent_id = agents.id
          AND agent_service_instances.service_type = 'memory'
      )
    `;
    let backfilledCount = 0;
    for (const row of agentsWithoutMemory) {
      const agentId = row.id as string;
      const id = nanoid();
      const now = new Date().toISOString();
      try {
        await sql`
          INSERT INTO agent_service_instances (id, agent_id, service_type, label, credential_id, enabled, is_default, created_at, updated_at)
          VALUES (${id}, ${agentId}, 'memory', null, null, true, true, ${now}, ${now})
          ON CONFLICT DO NOTHING
        `;
        await sql`
          INSERT INTO agent_service_access (id, agent_id, service_type, enabled, created_at, updated_at)
          VALUES (${nanoid()}, ${agentId}, 'memory', true, ${now}, ${now})
          ON CONFLICT (agent_id, service_type) DO UPDATE SET enabled = true, updated_at = ${now}
        `;
        backfilledCount++;
      } catch {
        // Non-fatal — log and continue
        console.warn(`[backfill] failed to enable memory for agent ${agentId}`);
      }
    }
    if (backfilledCount > 0) {
      console.log(`Backfilled memory service for ${backfilledCount} existing agents`);
    }
  }

  await sql`
    CREATE TABLE IF NOT EXISTS pending_agent_registrations (
      id TEXT PRIMARY KEY,
      user_id TEXT,
      name TEXT NOT NULL,
      description TEXT,
      claim_code TEXT NOT NULL UNIQUE,
      expires_at TEXT NOT NULL,
      created_at TEXT DEFAULT now() NOT NULL
    )
  `;

  await sql`
    DO $$ BEGIN
      ALTER TABLE pending_agent_registrations ADD COLUMN IF NOT EXISTS user_id TEXT;
    EXCEPTION WHEN duplicate_column THEN NULL;
    END $$
  `;

  await sql`CREATE INDEX IF NOT EXISTS idx_pending_claim_code ON pending_agent_registrations(claim_code)`;

  // ========================================================================
  // Deployed agents table (Fly.io/Docker provisioning)
  // ========================================================================

  await sql`
    CREATE TABLE IF NOT EXISTS deployed_agents (
      id TEXT PRIMARY KEY,
      agent_id TEXT NOT NULL REFERENCES agents(id),
      fly_app_name TEXT,
      fly_machine_id TEXT,
      status TEXT DEFAULT 'pending' NOT NULL,
      management_url TEXT,
      telegram_token TEXT,
      telegram_user_id TEXT,
      soul_md TEXT,
      model_provider TEXT DEFAULT 'anthropic',
      model_name TEXT DEFAULT 'claude-sonnet-4-5',
      region TEXT DEFAULT 'iad',
      gateway_token TEXT NOT NULL,
      created_at TEXT DEFAULT now() NOT NULL,
      updated_at TEXT DEFAULT now() NOT NULL
    )
  `;

  await sql`CREATE INDEX IF NOT EXISTS idx_deployed_agent ON deployed_agents(agent_id)`;

  // Add new columns for agent creation flow (migration)
  await sql`
    DO $$ BEGIN
      ALTER TABLE deployed_agents ADD COLUMN IF NOT EXISTS openai_api_key TEXT;
      ALTER TABLE deployed_agents ADD COLUMN IF NOT EXISTS telegram_groups_json TEXT;
      ALTER TABLE deployed_agents ADD COLUMN IF NOT EXISTS model_credentials TEXT;
      ALTER TABLE deployed_agents ADD COLUMN IF NOT EXISTS mcp_config_json TEXT;
    EXCEPTION WHEN duplicate_column THEN NULL;
    END $$
  `;

  // Spend cap config on deployed_agents (migration).
  // This has to run after the CREATE TABLE above. It used to sit next to the
  // spend_records migration ~250 lines earlier, which worked on any database
  // that already had the table and raised undefined_table on a fresh one —
  // an error the duplicate_column handler does not catch, so initialisation
  // died and the server never opened its port.
  await sql`
    DO $$ BEGIN
      ALTER TABLE deployed_agents ADD COLUMN IF NOT EXISTS spend_limit_dollars REAL;
      ALTER TABLE deployed_agents ADD COLUMN IF NOT EXISTS spend_limit_tokens INTEGER;
      ALTER TABLE deployed_agents ADD COLUMN IF NOT EXISTS spend_soft_stopped INTEGER DEFAULT 0;
      ALTER TABLE deployed_agents ADD COLUMN IF NOT EXISTS spend_alerted_80 INTEGER DEFAULT 0;
    EXCEPTION WHEN duplicate_column THEN NULL;
    END $$
  `;

  // Add is_manual column for manual agent support
  await sql`
    DO $$ BEGIN
      ALTER TABLE deployed_agents ADD COLUMN IF NOT EXISTS is_manual INTEGER DEFAULT 0;
    EXCEPTION WHEN duplicate_column THEN NULL;
    END $$
  `;

  // Add initial_prompt and has_onboarded for first-run setup
  await sql`
    DO $$ BEGIN
      ALTER TABLE deployed_agents ADD COLUMN IF NOT EXISTS initial_prompt TEXT;
      ALTER TABLE deployed_agents ADD COLUMN IF NOT EXISTS has_onboarded INTEGER DEFAULT 0;
    EXCEPTION WHEN duplicate_column THEN NULL;
    END $$
  `;

  // Add Telegram notification columns
  await sql`
    DO $$ BEGIN
      ALTER TABLE users ADD COLUMN IF NOT EXISTS telegram_chat_id TEXT;
      ALTER TABLE users ADD COLUMN IF NOT EXISTS telegram_user_id TEXT;
      ALTER TABLE approvals ADD COLUMN IF NOT EXISTS telegram_chat_id TEXT;
      ALTER TABLE approvals ADD COLUMN IF NOT EXISTS telegram_message_id TEXT;
    EXCEPTION WHEN duplicate_column THEN NULL;
    END $$
  `;

  // Add result_json for async deferred tool execution results
  await sql`
    DO $$ BEGIN
      ALTER TABLE approvals ADD COLUMN IF NOT EXISTS result_json TEXT;
    EXCEPTION WHEN duplicate_column THEN NULL;
    END $$
  `;

  // Add correction/retry columns — a human can send an approval back to the agent
  // with free-text feedback; the agent revises and resubmits as a linked revision.
  await sql`
    DO $$ BEGIN
      ALTER TABLE approvals ADD COLUMN IF NOT EXISTS parent_approval_id TEXT;
      ALTER TABLE approvals ADD COLUMN IF NOT EXISTS revision INTEGER DEFAULT 0;
      ALTER TABLE approvals ADD COLUMN IF NOT EXISTS telegram_prompt_message_id TEXT;
    EXCEPTION WHEN duplicate_column THEN NULL;
    END $$
  `;

  // Chain lookup: submit() finds an unclaimed changes_requested parent by agent+tool
  await sql`
    CREATE INDEX IF NOT EXISTS idx_approvals_parent ON approvals(parent_approval_id)
  `;

  // Add webhook relay columns for per-agent bot group detection
  await sql`
    DO $$ BEGIN
      ALTER TABLE deployed_agents ADD COLUMN IF NOT EXISTS openclaw_webhook_url TEXT;
      ALTER TABLE deployed_agents ADD COLUMN IF NOT EXISTS webhook_relay_secret TEXT;
    EXCEPTION WHEN duplicate_column THEN NULL;
    END $$
  `;

  // Add runtime column for agent runtime selection (openclaw or hermes)
  await sql`
    DO $$ BEGIN
      ALTER TABLE deployed_agents ADD COLUMN IF NOT EXISTS runtime TEXT DEFAULT 'openclaw';
    EXCEPTION WHEN duplicate_column THEN NULL;
    END $$
  `;

  // The MCP server name baked into this machine's MCP_CONFIG at deploy time.
  //
  // The agent's client derives its tool prefix from that value, so it is the
  // only correct source for tool names rendered into text the agent reads —
  // MCP_SERVER_NAME here moves ahead of it the moment the backend deploys.
  // Existing rows predate the helm rename, hence the 'reins' default.
  await sql`
    DO $$ BEGIN
      ALTER TABLE deployed_agents ADD COLUMN IF NOT EXISTS mcp_server_name TEXT DEFAULT 'reins';
    EXCEPTION WHEN duplicate_column THEN NULL;
    END $$
  `;

  // Add is_shared_bot column for shared platform bot routing
  await sql`
    DO $$ BEGIN
      ALTER TABLE deployed_agents ADD COLUMN IF NOT EXISTS is_shared_bot INTEGER DEFAULT 0;
    EXCEPTION WHEN duplicate_column THEN NULL;
    END $$
  `;

  // Add telegram_bot_username for display in the dashboard
  await sql`
    DO $$ BEGIN
      ALTER TABLE deployed_agents ADD COLUMN IF NOT EXISTS telegram_bot_username TEXT;
    EXCEPTION WHEN duplicate_column THEN NULL;
    END $$
  `;

  // Add fly_volume_id for per-agent persistent state (Fly volumes)
  await sql`
    DO $$ BEGIN
      ALTER TABLE deployed_agents ADD COLUMN IF NOT EXISTS fly_volume_id TEXT;
    EXCEPTION WHEN duplicate_column THEN NULL;
    END $$
  `;

  // Add path_rules column for Drive path-based permissions
  await sql`
    DO $$ BEGIN
      ALTER TABLE agent_service_access ADD COLUMN IF NOT EXISTS path_rules TEXT;
    EXCEPTION WHEN duplicate_column THEN NULL;
    END $$
  `;

  // Create telegram_link_codes table
  await sql`
    CREATE TABLE IF NOT EXISTS telegram_link_codes (
      code TEXT PRIMARY KEY,
      user_id TEXT NOT NULL,
      expires_at TEXT NOT NULL,
      created_at TEXT NOT NULL
    )
  `;

  // Pending OAuth flows — DB-backed to survive multi-machine & restarts
  await sql`
    CREATE TABLE IF NOT EXISTS pending_oauth_flows (
      state TEXT PRIMARY KEY,
      service TEXT NOT NULL,
      user_id TEXT,
      granted_services TEXT,
      reconnect_credential_id TEXT,
      reauth_approval_id TEXT,
      telegram_user_id BIGINT,
      initiated_at TIMESTAMPTZ NOT NULL,
      expires_at TIMESTAMPTZ NOT NULL
    )
  `;
  await sql`CREATE INDEX IF NOT EXISTS idx_pending_oauth_expires ON pending_oauth_flows(expires_at)`;

  // ========================================================================
  // MCP endpoint authentication — OAuth 2.1, per the MCP specification
  //
  // The endpoint accepts a Bearer token; a request without one is still served
  // while deployed_agents.allow_unauthenticated is true, which is the default
  // and is only ever cleared by the agent's owner. Nothing here changes how an
  // existing agent behaves.
  //
  // Tokens are stored as sha256 so a stolen database yields nothing usable.
  // bcrypt — the repo's only other hash — is salted per row and so cannot be
  // looked up by value, which would mean scanning every row on every request.
  // ========================================================================

  await sql`
    CREATE TABLE IF NOT EXISTS mcp_oauth_clients (
      id TEXT PRIMARY KEY,
      client_secret_hash TEXT,
      client_name TEXT NOT NULL,
      redirect_uris TEXT NOT NULL,
      created_at TEXT DEFAULT now() NOT NULL
    )
  `;

  await sql`
    CREATE TABLE IF NOT EXISTS mcp_access_tokens (
      id TEXT PRIMARY KEY,
      agent_id TEXT NOT NULL,
      user_id TEXT NOT NULL,
      client_id TEXT,
      name TEXT NOT NULL,
      token_hash TEXT NOT NULL,
      token_prefix TEXT NOT NULL,
      expires_at TEXT,
      last_used_at TEXT,
      revoked_at TEXT,
      created_at TEXT DEFAULT now() NOT NULL
    )
  `;
  await sql`CREATE UNIQUE INDEX IF NOT EXISTS idx_mcp_tokens_hash ON mcp_access_tokens(token_hash)`;
  await sql`CREATE INDEX IF NOT EXISTS idx_mcp_tokens_agent ON mcp_access_tokens(agent_id) WHERE revoked_at IS NULL`;

  // Single-use and short-lived, modelled on pending_oauth_flows above:
  // redeeming deletes the row, so a replayed code finds nothing.
  await sql`
    CREATE TABLE IF NOT EXISTS mcp_auth_codes (
      code_hash TEXT PRIMARY KEY,
      client_id TEXT NOT NULL,
      agent_id TEXT NOT NULL,
      user_id TEXT NOT NULL,
      redirect_uri TEXT NOT NULL,
      code_challenge TEXT NOT NULL,
      client_name TEXT,
      expires_at TEXT NOT NULL,
      created_at TEXT DEFAULT now() NOT NULL
    )
  `;
  await sql`CREATE INDEX IF NOT EXISTS idx_mcp_auth_codes_expires ON mcp_auth_codes(expires_at)`;

  await sql`
    CREATE TABLE IF NOT EXISTS mcp_refresh_tokens (
      token_hash TEXT PRIMARY KEY,
      access_token_id TEXT NOT NULL,
      agent_id TEXT NOT NULL,
      user_id TEXT NOT NULL,
      client_id TEXT,
      revoked_at TEXT,
      created_at TEXT DEFAULT now() NOT NULL
    )
  `;
  await sql`CREATE INDEX IF NOT EXISTS idx_mcp_refresh_access ON mcp_refresh_tokens(access_token_id)`;

  // Defaults true: every existing agent keeps working untouched. Only the
  // owner clears it, from the dashboard, once their clients are migrated.
  await sql`
    DO $$ BEGIN
      ALTER TABLE deployed_agents ADD COLUMN IF NOT EXISTS allow_unauthenticated BOOLEAN DEFAULT true NOT NULL;
    EXCEPTION WHEN duplicate_column THEN NULL; END $$
  `;
  // Migrate existing columns to correct types for Postgres (was designed for SQLite)
  await sql`ALTER TABLE pending_oauth_flows ALTER COLUMN telegram_user_id TYPE BIGINT`;
  await sql`ALTER TABLE pending_oauth_flows ALTER COLUMN initiated_at TYPE TIMESTAMPTZ USING initiated_at::TIMESTAMPTZ`;
  await sql`ALTER TABLE pending_oauth_flows ALTER COLUMN expires_at TYPE TIMESTAMPTZ USING expires_at::TIMESTAMPTZ`;

  // initial_prompt_templates table
  await sql`
    CREATE TABLE IF NOT EXISTS initial_prompt_templates (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      content TEXT NOT NULL,
      created_at TEXT NOT NULL DEFAULT (now()),
      updated_at TEXT NOT NULL DEFAULT (now())
    )
  `;

  // ========================================================================
  // Memory system tables
  // ========================================================================

  // Scopes partition a user's vault. Every entry belongs to exactly one; the
  // `default` scope (is_system) holds everything that predates scopes and can
  // never be deleted. Created before memory_entries because entries reference it.
  await sql`
    CREATE TABLE IF NOT EXISTS memory_scopes (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL,
      slug TEXT NOT NULL,
      name TEXT NOT NULL,
      description TEXT,
      root_entry_id TEXT,
      is_default BOOLEAN DEFAULT false NOT NULL,
      is_system BOOLEAN DEFAULT false NOT NULL,
      created_by_agent_id TEXT,
      archived_at TEXT,
      created_at TEXT DEFAULT now() NOT NULL,
      updated_at TEXT DEFAULT now() NOT NULL
    )
  `;

  await sql`CREATE UNIQUE INDEX IF NOT EXISTS idx_memory_scopes_user_slug ON memory_scopes(user_id, slug)`;
  // One default per user, enforced by the database rather than by care.
  await sql`CREATE UNIQUE INDEX IF NOT EXISTS idx_memory_scopes_user_default ON memory_scopes(user_id) WHERE is_default`;
  // FK target for the composite (scope_id, user_id) reference below.
  await sql`CREATE UNIQUE INDEX IF NOT EXISTS idx_memory_scopes_id_user ON memory_scopes(id, user_id)`;
  await sql`CREATE INDEX IF NOT EXISTS idx_memory_scopes_user ON memory_scopes(user_id)`;

  await sql`
    CREATE TABLE IF NOT EXISTS memory_entries (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL,
      type TEXT NOT NULL DEFAULT 'note',
      title TEXT NOT NULL,
      content TEXT,
      search_vector TSVECTOR,
      is_deleted BOOLEAN DEFAULT false NOT NULL,
      created_at TEXT DEFAULT now() NOT NULL,
      updated_at TEXT DEFAULT now() NOT NULL
    )
  `;

  // scope_id lands nullable: there is no static DEFAULT available because the
  // value is per-user. It is backfilled below and made NOT NULL in a later
  // deploy, once every write path is proven to set it — doing it now would turn
  // a missing-column bug into a 500 on user writes instead of a repairable NULL.
  await sql`
    DO $$ BEGIN
      ALTER TABLE memory_entries ADD COLUMN IF NOT EXISTS scope_id TEXT;
    EXCEPTION WHEN duplicate_column THEN NULL; END $$
  `;

  await sql`CREATE EXTENSION IF NOT EXISTS pg_trgm`;
  await sql`CREATE INDEX IF NOT EXISTS idx_memory_entries_user ON memory_entries(user_id)`;
  await sql`CREATE INDEX IF NOT EXISTS idx_memory_entries_user_type ON memory_entries(user_id, type)`;
  await sql`CREATE INDEX IF NOT EXISTS idx_memory_entries_user_deleted ON memory_entries(user_id, is_deleted)`;
  // scope_id functionally determines user_id, so scope leads every lookup.
  await sql`CREATE INDEX IF NOT EXISTS idx_memory_entries_scope ON memory_entries(scope_id)`;
  await sql`CREATE INDEX IF NOT EXISTS idx_memory_entries_scope_type ON memory_entries(scope_id, type)`;
  await sql`CREATE INDEX IF NOT EXISTS idx_memory_entries_scope_deleted ON memory_entries(scope_id, is_deleted)`;
  await sql`CREATE INDEX IF NOT EXISTS idx_memory_entries_scope_title ON memory_entries(scope_id, type, title) WHERE is_deleted = false`;
  // FK target for the composite (entry, scope) references on branches and links.
  await sql`CREATE UNIQUE INDEX IF NOT EXISTS idx_memory_entries_id_scope ON memory_entries(id, scope_id)`;
  await sql`CREATE INDEX IF NOT EXISTS idx_memory_entries_search ON memory_entries USING GIN(search_vector)`;
  await sql`CREATE INDEX IF NOT EXISTS idx_memory_entries_title_trgm ON memory_entries USING GIN(title gin_trgm_ops) WHERE is_deleted = false`;

  // Trigger to keep search_vector in sync with title + content
  await sql`
    CREATE OR REPLACE FUNCTION memory_entries_search_vector_update() RETURNS trigger AS $$
    BEGIN
      NEW.search_vector := to_tsvector('english',
        coalesce(NEW.title, '') || ' ' || coalesce(NEW.content, '')
      );
      RETURN NEW;
    END;
    $$ LANGUAGE plpgsql
  `;

  await sql`
    DROP TRIGGER IF EXISTS memory_entries_search_vector_trigger ON memory_entries
  `;
  await sql`
    CREATE TRIGGER memory_entries_search_vector_trigger
    BEFORE INSERT OR UPDATE ON memory_entries
    FOR EACH ROW EXECUTE FUNCTION memory_entries_search_vector_update()
  `;

  await sql`
    CREATE TABLE IF NOT EXISTS memory_branches (
      id TEXT PRIMARY KEY,
      entry_id TEXT NOT NULL REFERENCES memory_entries(id),
      parent_entry_id TEXT REFERENCES memory_entries(id),
      position INTEGER DEFAULT 0 NOT NULL,
      is_expanded BOOLEAN DEFAULT false NOT NULL
    )
  `;

  await sql`CREATE INDEX IF NOT EXISTS idx_memory_branches_entry ON memory_branches(entry_id)`;
  await sql`CREATE INDEX IF NOT EXISTS idx_memory_branches_parent ON memory_branches(parent_entry_id)`;

  await sql`
    CREATE TABLE IF NOT EXISTS memory_attributes (
      id TEXT PRIMARY KEY,
      entry_id TEXT NOT NULL REFERENCES memory_entries(id),
      type TEXT NOT NULL,
      name TEXT NOT NULL,
      value TEXT NOT NULL,
      position INTEGER DEFAULT 0 NOT NULL,
      is_deleted BOOLEAN DEFAULT false NOT NULL,
      created_at TEXT DEFAULT now() NOT NULL
    )
  `;

  await sql`CREATE INDEX IF NOT EXISTS idx_memory_attrs_entry ON memory_attributes(entry_id, type)`;
  await sql`CREATE INDEX IF NOT EXISTS idx_memory_attrs_relation ON memory_attributes(type, value) WHERE type = 'relation'`;

  await sql`
    CREATE TABLE IF NOT EXISTS memory_links (
      source_id TEXT NOT NULL REFERENCES memory_entries(id),
      target_id TEXT NOT NULL REFERENCES memory_entries(id),
      context TEXT,
      PRIMARY KEY (source_id, target_id)
    )
  `;

  await sql`CREATE INDEX IF NOT EXISTS idx_memory_links_target ON memory_links(target_id)`;

  await sql`
    CREATE TABLE IF NOT EXISTS memory_tags (
      entry_id TEXT NOT NULL REFERENCES memory_entries(id) ON DELETE CASCADE,
      tag TEXT NOT NULL,
      created_at TEXT NOT NULL DEFAULT (now()),
      PRIMARY KEY (entry_id, tag)
    )
  `;
  await sql`CREATE INDEX IF NOT EXISTS idx_memory_tags_tag ON memory_tags(tag)`;
  await sql`CREATE INDEX IF NOT EXISTS idx_memory_tags_entry ON memory_tags(entry_id)`;

  // Per-agent scope grants. Zero rows for an agent means every scope its owner
  // has — grants are an opt-in narrowing, so no existing agent loses access and
  // there is no creation-path hook to forget. (bfce9eb is the cautionary tale:
  // it dropped enableDefaultServices from two of three creation paths unnoticed.)
  await sql`
    CREATE TABLE IF NOT EXISTS agent_memory_scopes (
      id TEXT PRIMARY KEY,
      agent_id TEXT NOT NULL,
      scope_id TEXT NOT NULL REFERENCES memory_scopes(id) ON DELETE CASCADE,
      is_default BOOLEAN DEFAULT false NOT NULL,
      created_at TEXT DEFAULT now() NOT NULL
    )
  `;
  await sql`CREATE UNIQUE INDEX IF NOT EXISTS idx_agent_memory_scopes_pair ON agent_memory_scopes(agent_id, scope_id)`;
  await sql`CREATE UNIQUE INDEX IF NOT EXISTS idx_agent_memory_scopes_default ON agent_memory_scopes(agent_id) WHERE is_default`;
  await sql`CREATE INDEX IF NOT EXISTS idx_agent_memory_scopes_scope ON agent_memory_scopes(scope_id)`;

  // Branches and links carry scope_id so composite FKs can make cross-scope
  // parenting and cross-scope wikilinks structurally impossible rather than
  // merely policed. Attributes cannot: a relation's target lives in a
  // polymorphic `value TEXT` that no FK can reference — enforced in the route.
  await sql`
    DO $$ BEGIN
      ALTER TABLE memory_branches ADD COLUMN IF NOT EXISTS scope_id TEXT;
      ALTER TABLE memory_links ADD COLUMN IF NOT EXISTS scope_id TEXT;
    EXCEPTION WHEN duplicate_column THEN NULL; END $$
  `;

  // ── Scope backfill ──────────────────────────────────────────────────────────
  //
  // Idempotent, and kept permanently in the boot path as self-repair: any row
  // that somehow lands without a scope is adopted on the next start.

  // 1. A default scope for every user that has any memory at all. The id is
  //    derived rather than random so a concurrent boot cannot race a second row
  //    in before the unique index takes hold, and so fixtures can predict it.
  await sql`
    INSERT INTO memory_scopes (id, user_id, slug, name, description, is_default, is_system, created_at, updated_at)
    SELECT md5('memscope:' || e.user_id), e.user_id, 'default', 'Default',
           'Everything that was in your memory before scopes existed.',
           true, true, now()::text, now()::text
    FROM (SELECT DISTINCT user_id FROM memory_entries) e
    ON CONFLICT (user_id, slug) DO NOTHING
  `;

  // Users with no entries get a scope lazily on first API touch instead, which
  // keeps this block O(memory rows) rather than O(users).

  // 2. Assign every unscoped entry to its owner's default scope.
  await sql`
    UPDATE memory_entries e SET scope_id = s.id
    FROM memory_scopes s
    WHERE e.scope_id IS NULL AND s.user_id = e.user_id AND s.is_default
  `;

  // 3. Adopt the user's existing root as the default scope's root: the
  //    parentless index entry, falling back to the earliest one. Replaces
  //    ensureMemoryRoot's old `type='index' LIMIT 1` guess, which was
  //    non-deterministic once an agent created a second index entry — something
  //    MEMORY_POLICY.md explicitly sanctions as a hierarchical hub.
  await sql`
    UPDATE memory_scopes s SET root_entry_id = r.id
    FROM (
      SELECT DISTINCT ON (e.user_id) e.user_id, e.id
      FROM memory_entries e
      LEFT JOIN memory_branches b ON b.entry_id = e.id
      WHERE e.type = 'index' AND e.is_deleted = false
      ORDER BY e.user_id, (b.parent_entry_id IS NULL) DESC, e.created_at ASC
    ) r
    WHERE s.root_entry_id IS NULL AND s.user_id = r.user_id AND s.is_default
  `;

  // 4. Propagate scope to the child tables.
  await sql`
    UPDATE memory_branches b SET scope_id = e.scope_id
    FROM memory_entries e WHERE b.entry_id = e.id AND b.scope_id IS NULL
  `;
  await sql`
    UPDATE memory_links l SET scope_id = e.scope_id
    FROM memory_entries e WHERE l.source_id = e.id AND l.scope_id IS NULL
  `;

  // Post-backfill every user has exactly one scope, so there is nothing to
  // purge yet — but this must precede the composite FK, and it runs on every
  // boot, so it also cleans up after any future bug that produces one.
  await sql`
    DELETE FROM memory_links l USING memory_entries t
    WHERE l.target_id = t.id AND t.scope_id IS DISTINCT FROM l.scope_id
  `;

  await sql`CREATE INDEX IF NOT EXISTS idx_memory_branches_scope ON memory_branches(scope_id)`;
  await sql`CREATE INDEX IF NOT EXISTS idx_memory_links_scope ON memory_links(scope_id)`;

  // The root FK is added after memory_entries exists — the two tables reference
  // each other, so it cannot be part of either CREATE TABLE.
  await sql`
    DO $$ BEGIN
      ALTER TABLE memory_scopes
        ADD CONSTRAINT memory_scopes_root_fk
        FOREIGN KEY (root_entry_id) REFERENCES memory_entries(id);
    EXCEPTION WHEN duplicate_object THEN NULL; END $$
  `;

  // ── Scope constraints ───────────────────────────────────────────────────────
  //
  // Applied only once every write path sets scope_id, which is why they trail
  // the backfill rather than sitting with the column definitions.

  // Each is attempted independently and logged rather than swallowed in SQL: if
  // one cannot apply — a straggler NULL, a legacy cross-scope row — boot must
  // still succeed, but the reason has to be visible or the partition is only
  // half-enforced and nobody knows which half.
  const scopeConstraints: Array<[string, string]> = [
    ['memory_entries.scope_id NOT NULL',
     `ALTER TABLE memory_entries ALTER COLUMN scope_id SET NOT NULL`],
    // The composite (scope_id, user_id) key makes the denormalised user_id
    // impossible to desynchronise from the scope's owner. Without it, a bug
    // writing the wrong user_id yields an entry visible to nobody — undetectable.
    ['memory_entries_scope_user_fk',
     `ALTER TABLE memory_entries ADD CONSTRAINT memory_entries_scope_user_fk
        FOREIGN KEY (scope_id, user_id) REFERENCES memory_scopes(id, user_id)`],
    // The highest-leverage part of the feature: after these, no application-layer
    // mistake can produce a cross-scope tree edge or wikilink. Root entries have
    // parent_entry_id IS NULL and pass under the default MATCH SIMPLE, which
    // skips the check when any column of the key is NULL.
    ['memory_branches_entry_scope_fk',
     `ALTER TABLE memory_branches ADD CONSTRAINT memory_branches_entry_scope_fk
        FOREIGN KEY (entry_id, scope_id) REFERENCES memory_entries(id, scope_id)`],
    ['memory_branches_parent_scope_fk',
     `ALTER TABLE memory_branches ADD CONSTRAINT memory_branches_parent_scope_fk
        FOREIGN KEY (parent_entry_id, scope_id) REFERENCES memory_entries(id, scope_id)`],
    ['memory_links_source_scope_fk',
     `ALTER TABLE memory_links ADD CONSTRAINT memory_links_source_scope_fk
        FOREIGN KEY (source_id, scope_id) REFERENCES memory_entries(id, scope_id)`],
    ['memory_links_target_scope_fk',
     `ALTER TABLE memory_links ADD CONSTRAINT memory_links_target_scope_fk
        FOREIGN KEY (target_id, scope_id) REFERENCES memory_entries(id, scope_id)`],
  ];

  for (const [label, statement] of scopeConstraints) {
    try {
      await sql.unsafe(statement);
    } catch (err) {
      const code = (err as { code?: string })?.code;
      // 42710 duplicate_object, 42P07 duplicate_table — already applied.
      if (code === '42710' || code === '42P07') continue;
      console.warn(
        `[memory-scopes] could not apply ${label}: ${err instanceof Error ? err.message : err}`
      );
    }
  }

  // Superseded by their (scope_id, …) equivalents; scope_id determines user_id.
  await sql`DROP INDEX IF EXISTS idx_memory_entries_user_type`;
  await sql`DROP INDEX IF EXISTS idx_memory_entries_user_deleted`;

  // ========================================================================
  // Skills — reusable task playbooks served to agents over MCP on demand.
  // user_id IS NULL marks a system skill; there is deliberately no is_system
  // column, so the two can never disagree.
  // ========================================================================

  await sql`
    CREATE TABLE IF NOT EXISTS skills (
      id TEXT PRIMARY KEY,
      user_id TEXT,
      slug TEXT NOT NULL,
      name TEXT NOT NULL,
      description TEXT NOT NULL,
      body TEXT NOT NULL,
      required_services TEXT NOT NULL DEFAULT '[]',
      auto_assign BOOLEAN DEFAULT false NOT NULL,
      enabled BOOLEAN DEFAULT true NOT NULL,
      version TEXT,
      source TEXT NOT NULL DEFAULT 'admin',
      created_at TEXT DEFAULT now() NOT NULL,
      updated_at TEXT DEFAULT now() NOT NULL
    )
  `;

  // Version the installer stamps from the source SKILL.md frontmatter, compared
  // against templates/skill-versions.json to tell an agent its skills are stale.
  // Null means unversioned, which is never reported as an update.
  await sql`
    DO $$ BEGIN
      ALTER TABLE skills ADD COLUMN IF NOT EXISTS version TEXT;
    EXCEPTION WHEN duplicate_column THEN NULL;
    END $$
  `;

  // Provenance of a system skill's *current content*, so a deploy can tell an
  // untouched template row from one an admin has since edited. Only meaningful
  // when user_id IS NULL; user skills carry the 'admin' default and nothing
  // reads it.
  //
  //   'template' — last written by seedSystemSkills() from templates/skills/
  //   'admin'    — last written by a human or an agent through the API
  //
  // Added nullable, backfilled, then constrained — deliberately three steps. A
  // single `ADD COLUMN source TEXT NOT NULL DEFAULT 'admin'` would stamp every
  // existing template-seeded row 'admin' and freeze the whole fleet against
  // future template updates, and it would do it silently: the symptom is a fix
  // to a stock skill not arriving, a deploy later.
  await sql`
    DO $$ BEGIN
      ALTER TABLE skills ADD COLUMN IF NOT EXISTS source TEXT;
    EXCEPTION WHEN duplicate_column THEN NULL;
    END $$
  `;
  // One-shot: guarded on IS NULL, so it is a no-op on every subsequent boot.
  // Every pre-existing system row is claimed by the template, which is the
  // truthful description of the status quo — before this column the seeder
  // overwrote all of them on every boot regardless. An admin-created system
  // skill with no templates/skills/<slug>/ directory is labelled 'template'
  // too, but the seeder never visits a slug it has no directory for, so
  // nothing follows from it. Same for BOOT_SKILL_SLUG ('helm-boot'), which
  // has no template directory either.
  await sql`UPDATE skills SET source = 'template' WHERE source IS NULL AND user_id IS NULL`;
  await sql`UPDATE skills SET source = 'admin' WHERE source IS NULL`;
  await sql`ALTER TABLE skills ALTER COLUMN source SET DEFAULT 'admin'`;
  await sql`ALTER TABLE skills ALTER COLUMN source SET NOT NULL`;

  await sql`CREATE INDEX IF NOT EXISTS idx_skills_user ON skills(user_id)`;
  // Slugs are unique within a scope: once globally for system skills, once
  // per owner for user skills.
  await sql`CREATE UNIQUE INDEX IF NOT EXISTS idx_skills_slug_system ON skills(slug) WHERE user_id IS NULL`;
  await sql`CREATE UNIQUE INDEX IF NOT EXISTS idx_skills_slug_user ON skills(user_id, slug) WHERE user_id IS NOT NULL`;

  await sql`
    CREATE TABLE IF NOT EXISTS agent_skills (
      agent_id TEXT NOT NULL,
      skill_id TEXT NOT NULL REFERENCES skills(id) ON DELETE CASCADE,
      created_at TEXT DEFAULT now() NOT NULL,
      PRIMARY KEY (agent_id, skill_id)
    )
  `;

  await sql`CREATE INDEX IF NOT EXISTS idx_agent_skills_skill ON agent_skills(skill_id)`;

  // Give every existing agent the 'skills' service instance. tools/list is
  // computed live per request, so this exposes skills_list/skills_get to
  // already-deployed agents without a redeploy.
  await sql`
    INSERT INTO agent_service_instances (id, agent_id, service_type, enabled, is_default, created_at, updated_at)
    SELECT gen_random_uuid()::text, a.id, 'skills', true, true, now(), now()
    FROM agents a
    WHERE NOT EXISTS (
      SELECT 1 FROM agent_service_instances i
      WHERE i.agent_id = a.id AND i.service_type = 'skills'
    )
  `;

  // Stripe subscriptions table
  await sql`
    CREATE TABLE IF NOT EXISTS subscriptions (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL UNIQUE,
      stripe_customer_id TEXT NOT NULL,
      stripe_subscription_id TEXT,
      plan TEXT NOT NULL DEFAULT 'byok',
      status TEXT NOT NULL DEFAULT 'active',
      current_period_end TEXT,
      grace_until TEXT,
      created_at TEXT DEFAULT now() NOT NULL,
      updated_at TEXT DEFAULT now() NOT NULL
    )
  `;

  await sql`CREATE INDEX IF NOT EXISTS idx_subscriptions_user ON subscriptions(user_id)`;

  // Agent model configs table — per-agent model routing
  await sql`
    CREATE TABLE IF NOT EXISTS agent_model_configs (
      id TEXT PRIMARY KEY,
      agent_id TEXT NOT NULL,
      provider TEXT NOT NULL,
      model_name TEXT NOT NULL,
      role TEXT NOT NULL,
      api_key_encrypted TEXT NOT NULL,
      created_at TEXT DEFAULT now() NOT NULL,
      updated_at TEXT DEFAULT now() NOT NULL,
      UNIQUE(agent_id, role)
    )
  `;
  await sql`CREATE INDEX IF NOT EXISTS idx_agent_model_configs_agent ON agent_model_configs(agent_id)`;

  // Agent uploads — short-lived blobs an agent POSTs from its own container so
  // it can attach a file it generated without the bytes passing through the
  // model's context. Postgres rather than a volume or memory: there is no Fly
  // volume on agenthelm-core, CI redeploys on every push to main, and an upload
  // must outlive the 1-hour approval window because a deferred gmail_create_draft
  // resolves its reference at approval time, not call time.
  await sql`
    CREATE TABLE IF NOT EXISTS agent_uploads (
      id TEXT PRIMARY KEY,
      agent_id TEXT NOT NULL,
      user_id TEXT,
      filename TEXT NOT NULL,
      mime_type TEXT NOT NULL,
      size_bytes INTEGER NOT NULL,
      sha256 TEXT NOT NULL,
      data BYTEA NOT NULL,
      created_at TEXT DEFAULT now() NOT NULL,
      expires_at TEXT NOT NULL
    )
  `;
  await sql`CREATE INDEX IF NOT EXISTS idx_agent_uploads_agent ON agent_uploads(agent_id)`;
  await sql`CREATE INDEX IF NOT EXISTS idx_agent_uploads_expires ON agent_uploads(expires_at)`;

  // Seed: create admin user if no users exist
  const userCount = await sql`SELECT COUNT(*) as count FROM users`;
  const count = Number(userCount[0]?.count ?? 0);
  if (count === 0) {
    const adminEmail = config.adminEmail || 'admin@reins.local';
    const adminPassword = config.adminPassword;
    const passwordHash = await bcrypt.hash(adminPassword, 10);
    const adminId = nanoid();
    const now = new Date().toISOString();

    await sql`
      INSERT INTO users (id, email, name, password_hash, role, status, created_at, updated_at)
      VALUES (${adminId}, ${adminEmail}, 'Admin', ${passwordHash}, 'admin', 'active', ${now}, ${now})
    `;

    // Assign existing agents and credentials to the admin user
    await sql`UPDATE agents SET user_id = ${adminId} WHERE user_id IS NULL`;
    await sql`UPDATE credentials SET user_id = ${adminId} WHERE user_id IS NULL`;

    console.log(`Created admin user: ${adminEmail}`);
  }

  // Seed initial prompt templates from files
  try {
    await seedInitialPromptTemplates();
  } catch (err) {
    console.warn('[db] Could not seed initial prompt templates:', err);
  }

  // Seed system skills from files
  try {
    await seedSystemSkills();
  } catch (err) {
    console.warn('[db] Could not seed system skills:', err);
  }
}

/**
 * Minimal YAML frontmatter parser for SKILL.md files.
 *
 * Handles only what the skill format needs: scalar values plus inline
 * (`[a, b]`) and block (`- a`) sequences. Pulling in a YAML dependency for
 * four keys isn't worth it.
 */
function parseSkillFrontmatter(raw: string): { meta: Record<string, string | string[]>; body: string } {
  const match = raw.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/);
  if (!match) return { meta: {}, body: raw.trim() };

  const meta: Record<string, string | string[]> = {};
  const lines = match[1].split(/\r?\n/);

  for (let i = 0; i < lines.length; i++) {
    const kv = lines[i].match(/^([A-Za-z_][\w-]*):\s*(.*)$/);
    if (!kv) continue;
    const key = kv[1];
    const value = kv[2].trim();

    if (value === '') {
      // Block sequence: consume the following "- item" lines.
      const items: string[] = [];
      while (i + 1 < lines.length) {
        const item = lines[i + 1].match(/^\s*-\s+(.*)$/);
        if (!item) break;
        items.push(item[1].trim().replace(/^["']|["']$/g, ''));
        i++;
      }
      meta[key] = items;
    } else if (value.startsWith('[') && value.endsWith(']')) {
      meta[key] = value
        .slice(1, -1)
        .split(',')
        .map((s) => s.trim().replace(/^["']|["']$/g, ''))
        .filter(Boolean);
    } else {
      meta[key] = value.replace(/^["']|["']$/g, '');
    }
  }

  return { meta, body: match[2].trim() };
}

/**
 * Upsert platform skills from templates/skills/<slug>/SKILL.md.
 *
 * System skills are version-controlled files rather than dashboard rows, so
 * they ship with a deploy and stay reviewable. Mirrors
 * seedInitialPromptTemplates() — id equals the slug so re-seeding updates in
 * place rather than duplicating.
 */
async function seedSystemSkills() {
  let entries: string[];
  try {
    entries = await readdir(SKILLS_TEMPLATES_DIR);
  } catch {
    // Templates directory not present (e.g. stripped Docker build)
    return;
  }

  let seeded = 0;
  const skipped: string[] = [];
  for (const slug of entries) {
    let raw: string;
    try {
      raw = await readFile(join(SKILLS_TEMPLATES_DIR, slug, 'SKILL.md'), 'utf-8');
    } catch {
      continue; // not a skill directory
    }

    const { meta, body } = parseSkillFrontmatter(raw);
    const name = typeof meta.name === 'string' && meta.name ? meta.name : slug;
    const description = typeof meta.description === 'string' ? meta.description : '';
    const requires = Array.isArray(meta.requires) ? meta.requires : [];
    const autoAssign = meta.autoAssign === 'true' || meta.auto_assign === 'true';
    const version = typeof meta.version === 'string' && meta.version ? meta.version : null;

    // The WHERE on the conflict action is the whole point: an admin edit sets
    // source to 'admin', and from then on the template no longer wins. Rows
    // still marked 'template' keep receiving updates, so a fix to a stock skill
    // still reaches every account that has not customised it.
    //
    // `skills.user_id IS NULL` is belt-and-braces. A system row's id equals its
    // slug and a user skill's id is a nanoid, so the two cannot collide today —
    // but the guard means a future id scheme cannot quietly turn this upsert
    // into an overwrite of somebody's private skill.
    const result = await sql`
      INSERT INTO skills (id, user_id, slug, name, description, body, required_services, auto_assign, version, source, created_at, updated_at)
      VALUES (${slug}, NULL, ${slug}, ${name}, ${description}, ${body}, ${JSON.stringify(requires)}, ${autoAssign}, ${version}, 'template', now(), now())
      ON CONFLICT (id) DO UPDATE SET
        name = ${name},
        description = ${description},
        body = ${body},
        required_services = ${JSON.stringify(requires)},
        auto_assign = ${autoAssign},
        version = ${version},
        source = 'template',
        updated_at = now()
      WHERE skills.user_id IS NULL AND skills.source = 'template'
      RETURNING id
    `;
    // A conflicting row whose WHERE is false raises no error and returns no
    // row. That empty result is the only signal the skip happened, so it has to
    // be read here — silence would recreate the footgun this column removes.
    if (result.length === 0) skipped.push(slug);
    else seeded++;
  }

  if (seeded > 0) console.log(`Seeded ${seeded} system skill(s)`);
  if (skipped.length > 0) {
    console.log(
      `[skills] Skipped ${skipped.length} admin-edited system skill(s): ${skipped.join(', ')}. ` +
      `Their source is 'admin', so templates/skills/ no longer overwrites them. ` +
      `Delete the row in the dashboard to take the template version again.`
    );
  }
}

async function seedInitialPromptTemplates() {
  let files: string[];
  try {
    files = await readdir(TEMPLATES_DIR);
  } catch {
    // Templates directory not present (e.g. stripped Docker build)
    return;
  }

  for (const file of files) {
    if (!file.endsWith('.md')) continue;
    const id = basename(file, '.md');
    const name = id
      .split('-')
      .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
      .join(' ')
      .replace('And', '&');
    const content = await readFile(join(TEMPLATES_DIR, file), 'utf-8');
    await sql`
      INSERT INTO initial_prompt_templates (id, name, content, created_at, updated_at)
      VALUES (${id}, ${name}, ${content}, now(), now())
      ON CONFLICT (id) DO UPDATE SET name = ${name}, content = ${content}, updated_at = now()
    `;
  }
}

export { schema };
