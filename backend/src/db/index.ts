import { createClient } from '@libsql/client';
import { drizzle } from 'drizzle-orm/libsql';
import bcrypt from 'bcryptjs';
import { nanoid } from 'nanoid';
import { config } from '../config/index.js';
import * as schema from './schema.js';
import { mkdirSync, existsSync } from 'fs';
import { dirname } from 'path';

// Ensure data directory exists
const dbDir = dirname(config.dbPath);
if (!existsSync(dbDir)) {
  mkdirSync(dbDir, { recursive: true });
}

// Create libsql client
const client = createClient({
  url: `file:${config.dbPath}`,
});

// Create Drizzle ORM instance
export const db = drizzle(client, { schema });

// Initialize database tables
export async function initializeDatabase() {
  // Users table
  await client.execute(`
    CREATE TABLE IF NOT EXISTS users (
      id TEXT PRIMARY KEY,
      email TEXT NOT NULL UNIQUE,
      name TEXT NOT NULL,
      password_hash TEXT NOT NULL,
      role TEXT DEFAULT 'user' NOT NULL,
      status TEXT DEFAULT 'active' NOT NULL,
      created_at TEXT DEFAULT CURRENT_TIMESTAMP NOT NULL,
      updated_at TEXT DEFAULT CURRENT_TIMESTAMP NOT NULL
    );
  `);

  await client.execute(`
    -- Agents table
    CREATE TABLE IF NOT EXISTS agents (
      id TEXT PRIMARY KEY,
      user_id TEXT,
      name TEXT NOT NULL,
      description TEXT,
      policy_id TEXT,
      status TEXT DEFAULT 'pending' NOT NULL,
      created_at TEXT DEFAULT CURRENT_TIMESTAMP NOT NULL,
      updated_at TEXT DEFAULT CURRENT_TIMESTAMP NOT NULL
    );
  `);

  // Migrate: add user_id to agents if not present
  const agentCols = await client.execute(`PRAGMA table_info(agents)`);
  const agentColNames = agentCols.rows.map((r) => r.name as string);
  if (!agentColNames.includes('user_id')) {
    await client.execute(`ALTER TABLE agents ADD COLUMN user_id TEXT`);
  }

  await client.execute(`
    -- Agent credentials junction table
    CREATE TABLE IF NOT EXISTS agent_credentials (
      agent_id TEXT NOT NULL,
      credential_id TEXT NOT NULL,
      PRIMARY KEY (agent_id, credential_id)
    );
  `);

  await client.execute(`
    -- Policies table
    CREATE TABLE IF NOT EXISTS policies (
      id TEXT PRIMARY KEY,
      version TEXT NOT NULL,
      name TEXT NOT NULL,
      yaml TEXT NOT NULL,
      created_at TEXT DEFAULT CURRENT_TIMESTAMP NOT NULL,
      updated_at TEXT DEFAULT CURRENT_TIMESTAMP NOT NULL
    );
  `);

  await client.execute(`
    -- Credentials table (encrypted)
    CREATE TABLE IF NOT EXISTS credentials (
      id TEXT PRIMARY KEY,
      user_id TEXT,
      service_id TEXT NOT NULL,
      type TEXT NOT NULL,
      encrypted_data BLOB NOT NULL,
      iv BLOB NOT NULL,
      auth_tag BLOB NOT NULL,
      expires_at TEXT,
      account_email TEXT,
      account_name TEXT,
      created_at TEXT DEFAULT CURRENT_TIMESTAMP NOT NULL,
      updated_at TEXT DEFAULT CURRENT_TIMESTAMP NOT NULL
    );
  `);

  // Migrate: add account columns if table predates them
  const credCols = await client.execute(`PRAGMA table_info(credentials)`);
  const credColNames = credCols.rows.map((r) => r.name as string);
  if (!credColNames.includes('account_email')) {
    await client.execute(`ALTER TABLE credentials ADD COLUMN account_email TEXT`);
  }
  if (!credColNames.includes('account_name')) {
    await client.execute(`ALTER TABLE credentials ADD COLUMN account_name TEXT`);
  }
  if (!credColNames.includes('user_id')) {
    await client.execute(`ALTER TABLE credentials ADD COLUMN user_id TEXT`);
  }
  if (!credColNames.includes('granted_services')) {
    await client.execute(`ALTER TABLE credentials ADD COLUMN granted_services TEXT`);
  }

  await client.execute(`
    -- Audit log table (append-only)
    CREATE TABLE IF NOT EXISTS audit_log (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      timestamp TEXT DEFAULT CURRENT_TIMESTAMP NOT NULL,
      event_type TEXT NOT NULL,
      user_id TEXT,
      agent_id TEXT,
      tool TEXT,
      arguments_json TEXT,
      result TEXT,
      duration_ms INTEGER,
      metadata_json TEXT
    );
  `);

  await client.execute(`CREATE INDEX IF NOT EXISTS idx_audit_timestamp ON audit_log(timestamp);`);
  await client.execute(`CREATE INDEX IF NOT EXISTS idx_audit_agent ON audit_log(agent_id);`);

  // Migrate: add user_id to audit_log if not present
  const auditCols = await client.execute(`PRAGMA table_info(audit_log)`);
  const auditColNames = auditCols.rows.map((r) => r.name as string);
  if (!auditColNames.includes('user_id')) {
    await client.execute(`ALTER TABLE audit_log ADD COLUMN user_id TEXT`);
  }

  await client.execute(`
    -- Approval queue table
    CREATE TABLE IF NOT EXISTS approvals (
      id TEXT PRIMARY KEY,
      agent_id TEXT NOT NULL,
      tool TEXT NOT NULL,
      arguments_json TEXT,
      context TEXT,
      status TEXT DEFAULT 'pending' NOT NULL,
      requested_at TEXT DEFAULT CURRENT_TIMESTAMP NOT NULL,
      expires_at TEXT NOT NULL,
      resolved_at TEXT,
      resolved_by TEXT,
      resolution_comment TEXT
    );
  `);

  await client.execute(`CREATE INDEX IF NOT EXISTS idx_approvals_status ON approvals(status);`);
  await client.execute(`CREATE INDEX IF NOT EXISTS idx_approvals_agent ON approvals(agent_id);`);

  await client.execute(`
    -- Spend records table
    CREATE TABLE IF NOT EXISTS spend_records (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      agent_id TEXT NOT NULL,
      service_id TEXT NOT NULL,
      amount REAL NOT NULL,
      currency TEXT DEFAULT 'USD' NOT NULL,
      recorded_at TEXT DEFAULT CURRENT_TIMESTAMP NOT NULL
    );
  `);

  await client.execute(`CREATE INDEX IF NOT EXISTS idx_spend_agent_date ON spend_records(agent_id, recorded_at);`);

  await client.execute(`
    -- MCP Servers table
    CREATE TABLE IF NOT EXISTS mcp_servers (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      transport TEXT NOT NULL,
      config_json TEXT NOT NULL,
      health_status TEXT DEFAULT 'unknown' NOT NULL,
      last_health_check TEXT,
      created_at TEXT DEFAULT CURRENT_TIMESTAMP NOT NULL,
      updated_at TEXT DEFAULT CURRENT_TIMESTAMP NOT NULL
    );
  `);

  await client.execute(`
    -- Device tokens table for push notifications
    CREATE TABLE IF NOT EXISTS device_tokens (
      id TEXT PRIMARY KEY,
      device_id TEXT NOT NULL UNIQUE,
      token TEXT NOT NULL,
      platform TEXT NOT NULL,
      user_id TEXT,
      created_at TEXT DEFAULT CURRENT_TIMESTAMP NOT NULL,
      updated_at TEXT DEFAULT CURRENT_TIMESTAMP NOT NULL
    );
  `);

  await client.execute(`
    -- Agent service access - controls which services each agent can access
    CREATE TABLE IF NOT EXISTS agent_service_access (
      id TEXT PRIMARY KEY,
      agent_id TEXT NOT NULL,
      service_type TEXT NOT NULL,
      enabled INTEGER DEFAULT 0 NOT NULL,
      credential_id TEXT,
      created_at TEXT DEFAULT CURRENT_TIMESTAMP NOT NULL,
      updated_at TEXT DEFAULT CURRENT_TIMESTAMP NOT NULL,
      UNIQUE(agent_id, service_type)
    );
  `);

  await client.execute(`CREATE INDEX IF NOT EXISTS idx_agent_service_agent ON agent_service_access(agent_id);`);

  await client.execute(`
    -- Agent tool permissions - per-tool permission overrides
    CREATE TABLE IF NOT EXISTS agent_tool_permissions (
      id TEXT PRIMARY KEY,
      agent_id TEXT NOT NULL,
      service_type TEXT NOT NULL,
      tool_name TEXT NOT NULL,
      permission TEXT NOT NULL,
      created_at TEXT DEFAULT CURRENT_TIMESTAMP NOT NULL,
      updated_at TEXT DEFAULT CURRENT_TIMESTAMP NOT NULL,
      UNIQUE(agent_id, service_type, tool_name)
    );
  `);

  await client.execute(`CREATE INDEX IF NOT EXISTS idx_agent_tool_perm ON agent_tool_permissions(agent_id, service_type);`);

  // Agent service credentials junction table (multi-account support)
  await client.execute(`
    CREATE TABLE IF NOT EXISTS agent_service_credentials (
      id TEXT PRIMARY KEY,
      agent_id TEXT NOT NULL,
      service_type TEXT NOT NULL,
      credential_id TEXT NOT NULL,
      is_default INTEGER DEFAULT 0 NOT NULL,
      created_at TEXT DEFAULT CURRENT_TIMESTAMP NOT NULL,
      UNIQUE(agent_id, service_type, credential_id)
    );
  `);

  await client.execute(`CREATE INDEX IF NOT EXISTS idx_asc_agent_service ON agent_service_credentials(agent_id, service_type);`);

  // Migrate: backfill agent_service_credentials from agent_service_access rows that have a credential_id
  {
    const existing = await client.execute(`SELECT COUNT(*) as count FROM agent_service_credentials`);
    const existingCount = existing.rows[0].count as number;
    if (existingCount === 0) {
      const accessRows = await client.execute(
        `SELECT id, agent_id, service_type, credential_id FROM agent_service_access WHERE credential_id IS NOT NULL`
      );
      for (const row of accessRows.rows) {
        const id = `asc_${row.agent_id}_${row.service_type}_${row.credential_id}`;
        await client.execute({
          sql: `INSERT OR IGNORE INTO agent_service_credentials (id, agent_id, service_type, credential_id, is_default, created_at)
                VALUES (?, ?, ?, ?, 1, CURRENT_TIMESTAMP)`,
          args: [id, row.agent_id as string, row.service_type as string, row.credential_id as string],
        });
      }
      if (accessRows.rows.length > 0) {
        console.log(`Backfilled ${accessRows.rows.length} agent_service_credentials from agent_service_access`);
      }
    }
  }

  await client.execute(`
    -- Pending agent registrations - agents waiting to be claimed
    CREATE TABLE IF NOT EXISTS pending_agent_registrations (
      id TEXT PRIMARY KEY,
      user_id TEXT,
      name TEXT NOT NULL,
      description TEXT,
      claim_code TEXT NOT NULL UNIQUE,
      expires_at TEXT NOT NULL,
      created_at TEXT DEFAULT CURRENT_TIMESTAMP NOT NULL
    );
  `);

  // Migrate: add user_id to pending_agent_registrations if not present
  const pendingCols = await client.execute(`PRAGMA table_info(pending_agent_registrations)`);
  const pendingColNames = pendingCols.rows.map((r) => r.name as string);
  if (!pendingColNames.includes('user_id')) {
    await client.execute(`ALTER TABLE pending_agent_registrations ADD COLUMN user_id TEXT`);
  }

  await client.execute(`CREATE INDEX IF NOT EXISTS idx_pending_claim_code ON pending_agent_registrations(claim_code);`);

  // Seed: create admin user if no users exist
  const userCount = await client.execute(`SELECT COUNT(*) as count FROM users`);
  const count = userCount.rows[0].count as number;
  if (count === 0) {
    const adminEmail = config.adminEmail || 'admin@reins.local';
    const adminPassword = config.adminPassword;
    const passwordHash = await bcrypt.hash(adminPassword, 10);
    const adminId = nanoid();
    const now = new Date().toISOString();

    await client.execute({
      sql: `INSERT INTO users (id, email, name, password_hash, role, status, created_at, updated_at)
            VALUES (?, ?, ?, ?, 'admin', 'active', ?, ?)`,
      args: [adminId, adminEmail, 'Admin', passwordHash, now, now],
    });

    // Assign existing agents and credentials to the admin user
    await client.execute({
      sql: `UPDATE agents SET user_id = ? WHERE user_id IS NULL`,
      args: [adminId],
    });
    await client.execute({
      sql: `UPDATE credentials SET user_id = ? WHERE user_id IS NULL`,
      args: [adminId],
    });

    console.log(`Created admin user: ${adminEmail}`);
  }
}

export { schema, client };
