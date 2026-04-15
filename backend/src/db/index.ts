import postgres from 'postgres';
import { drizzle } from 'drizzle-orm/postgres-js';
import bcrypt from 'bcryptjs';
import { nanoid } from 'nanoid';
import { config } from '../config/index.js';
import * as schema from './schema.js';

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
  return {
    rows: rows as Record<string, unknown>[],
    columns: rows.length > 0 ? Object.keys(rows[0]) : [],
    rowsAffected: rows.length,
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

  // Add is_manual column for manual agent support
  await sql`
    DO $$ BEGIN
      ALTER TABLE deployed_agents ADD COLUMN IF NOT EXISTS is_manual INTEGER DEFAULT 0;
    EXCEPTION WHEN duplicate_column THEN NULL;
    END $$
  `;

  // Add Telegram notification columns
  await sql`
    DO $$ BEGIN
      ALTER TABLE users ADD COLUMN IF NOT EXISTS telegram_chat_id TEXT;
      ALTER TABLE approvals ADD COLUMN IF NOT EXISTS telegram_chat_id TEXT;
      ALTER TABLE approvals ADD COLUMN IF NOT EXISTS telegram_message_id TEXT;
    EXCEPTION WHEN duplicate_column THEN NULL;
    END $$
  `;

  // Add webhook relay columns for per-agent bot group detection
  await sql`
    DO $$ BEGIN
      ALTER TABLE deployed_agents ADD COLUMN IF NOT EXISTS openclaw_webhook_url TEXT;
      ALTER TABLE deployed_agents ADD COLUMN IF NOT EXISTS webhook_relay_secret TEXT;
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
}

export { schema };
