#!/usr/bin/env node
/**
 * Migrate data from SQLite (data/reins.db) to PostgreSQL.
 *
 * Usage:  node scripts/migrate-sqlite-to-pg.mjs
 *
 * Requires: DATABASE_URL env var or defaults to postgres://rains:rains@localhost:5432/rains
 */

import Database from 'better-sqlite3';
import postgres from 'postgres';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const SQLITE_PATH = process.argv[2]
  ? resolve(process.argv[2])
  : resolve(__dirname, '..', 'backend', 'data', 'reins.db');
const PG_URL = process.env.DATABASE_URL || 'postgres://rains:rains@localhost:5432/rains';

const sqlite = new Database(SQLITE_PATH, { readonly: true });
const sql = postgres(PG_URL);

// Tables to migrate in dependency order.
// audit_log and spend_records use SERIAL ids in PG, so we insert with explicit id.
const TABLES = [
  'users',
  'agents',
  'policies',
  'credentials',
  'agent_credentials',
  'audit_log',
  'approvals',
  'spend_records',
  'mcp_servers',
  'device_tokens',
  'agent_service_access',
  'agent_service_credentials',
  'agent_service_instances',
  'agent_tool_permissions',
  'pending_agent_registrations',
];

// Columns that are BOOLEAN in PG but INTEGER in SQLite
const BOOLEAN_COLUMNS = new Set(['enabled', 'is_default']);

async function migrate() {
  console.log(`SQLite: ${SQLITE_PATH}`);
  console.log(`PG:     ${PG_URL.replace(/\/\/[^@]+@/, '//***@')}`);
  console.log('');

  let totalRows = 0;

  for (const table of TABLES) {
    // Check if table exists in SQLite
    const tableExists = sqlite.prepare(
      `SELECT name FROM sqlite_master WHERE type='table' AND name=?`
    ).get(table);

    if (!tableExists) {
      console.log(`  ${table}: skipped (not in SQLite)`);
      continue;
    }

    const rows = sqlite.prepare(`SELECT * FROM ${table}`).all();
    if (rows.length === 0) {
      console.log(`  ${table}: 0 rows (empty)`);
      continue;
    }

    const columns = Object.keys(rows[0]);

    // Insert in batches
    let inserted = 0;
    const BATCH = 500;

    for (let i = 0; i < rows.length; i += BATCH) {
      const batch = rows.slice(i, i + BATCH);
      const values = batch.map(row =>
        columns.map(col => {
          let v = row[col];
          // Convert SQLite integers to booleans for PG boolean columns
          if (BOOLEAN_COLUMNS.has(col) && typeof v === 'number') {
            v = v !== 0;
          }
          // Convert Buffer/Uint8Array to hex string for TEXT columns that were BLOB
          if (v instanceof Buffer || v instanceof Uint8Array) {
            v = Buffer.from(v).toString('hex');
          }
          return v;
        })
      );

      const colList = columns.map(c => `"${c}"`).join(', ');
      const placeholders = values.map(
        (_, rowIdx) =>
          `(${columns.map((_, colIdx) => `$${rowIdx * columns.length + colIdx + 1}`).join(', ')})`
      ).join(', ');

      const flat = values.flat();

      await sql.unsafe(
        `INSERT INTO ${table} (${colList}) VALUES ${placeholders} ON CONFLICT DO NOTHING`,
        flat
      );

      inserted += batch.length;
    }

    // Reset serial sequences for tables with SERIAL primary keys
    if (table === 'audit_log' || table === 'spend_records') {
      await sql.unsafe(
        `SELECT setval(pg_get_serial_sequence('${table}', 'id'), COALESCE((SELECT MAX(id) FROM ${table}), 0))`
      );
    }

    console.log(`  ${table}: ${inserted} rows migrated`);
    totalRows += inserted;
  }

  console.log(`\nDone — ${totalRows} total rows migrated.`);

  sqlite.close();
  await sql.end();
}

migrate().catch(err => {
  console.error('Migration failed:', err);
  process.exit(1);
});
