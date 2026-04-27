#!/usr/bin/env node
/**
 * Creates a dedicated admin user for e2e tests.
 * Run once: node scripts/create-e2e-user.mjs
 */
import postgres from 'postgres';
import bcrypt from 'bcryptjs';
import { randomBytes } from 'crypto';
import { config } from 'dotenv';

config({ path: new URL('../.env', import.meta.url).pathname });

const DATABASE_URL = process.env.DATABASE_URL;
if (!DATABASE_URL) {
  console.error('DATABASE_URL not set');
  process.exit(1);
}

const EMAIL = process.env.E2E_ADMIN_EMAIL || 'e2e-admin@reins.local';
const PASSWORD = process.env.E2E_ADMIN_PASSWORD || 'E2eT3stPass!';

const sql = postgres(DATABASE_URL);

const existing = await sql`SELECT id FROM users WHERE email = ${EMAIL}`;
if (existing.length > 0) {
  console.log(`User ${EMAIL} already exists (id: ${existing[0].id})`);
  await sql.end();
  process.exit(0);
}

const id = randomBytes(10).toString('base64url');
const hash = await bcrypt.hash(PASSWORD, 10);
const now = new Date().toISOString();

await sql`
  INSERT INTO users (id, email, name, password_hash, role, status, created_at, updated_at)
  VALUES (${id}, ${EMAIL}, 'E2E Admin', ${hash}, 'admin', 'active', ${now}, ${now})
`;

console.log(`Created e2e admin user:`);
console.log(`  email:    ${EMAIL}`);
console.log(`  password: ${PASSWORD}`);
console.log(`  id:       ${id}`);

await sql.end();
