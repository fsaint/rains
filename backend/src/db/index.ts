import { createClient } from '@libsql/client';
import { drizzle } from 'drizzle-orm/libsql';
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
  await client.execute(`
    -- Agents table
    CREATE TABLE IF NOT EXISTS agents (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      description TEXT,
      policy_id TEXT,
      status TEXT DEFAULT 'pending' NOT NULL,
      created_at TEXT DEFAULT CURRENT_TIMESTAMP NOT NULL,
      updated_at TEXT DEFAULT CURRENT_TIMESTAMP NOT NULL
    );
  `);

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
      service_id TEXT NOT NULL,
      type TEXT NOT NULL,
      encrypted_data BLOB NOT NULL,
      iv BLOB NOT NULL,
      auth_tag BLOB NOT NULL,
      expires_at TEXT,
      created_at TEXT DEFAULT CURRENT_TIMESTAMP NOT NULL,
      updated_at TEXT DEFAULT CURRENT_TIMESTAMP NOT NULL
    );
  `);

  await client.execute(`
    -- Audit log table (append-only)
    CREATE TABLE IF NOT EXISTS audit_log (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      timestamp TEXT DEFAULT CURRENT_TIMESTAMP NOT NULL,
      event_type TEXT NOT NULL,
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
}

export { schema, client };
