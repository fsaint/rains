#!/usr/bin/env node
/**
 * Decrypts a Google credential and checks the actual scopes on the token
 * via Google's tokeninfo endpoint.
 *
 * Usage: node scripts/check-token-scopes.mjs <credentialId>
 */
import postgres from 'postgres';
import crypto from 'crypto';
import { config } from 'dotenv';

config({ path: new URL('../.env', import.meta.url).pathname });

const credentialId = process.argv[2];
if (!credentialId) {
  console.error('Usage: node scripts/check-token-scopes.mjs <credentialId>');
  process.exit(1);
}

const key = Buffer.from(process.env.REINS_ENCRYPTION_KEY, 'hex');
const sql = postgres(process.env.DATABASE_URL);

const [row] = await sql`SELECT * FROM credentials WHERE id = ${credentialId}`;
if (!row) { console.error('Not found'); await sql.end(); process.exit(1); }

const decipher = crypto.createDecipheriv(
  'aes-256-gcm', key,
  Buffer.from(row.iv, 'base64')
);
decipher.setAuthTag(Buffer.from(row.auth_tag, 'base64'));
const data = JSON.parse(
  Buffer.concat([decipher.update(Buffer.from(row.encrypted_data, 'base64')), decipher.final()]).toString()
);

// Try access token first; refresh if expired
let accessToken = data.accessToken;
const expiresAt = data.expiresAt ? new Date(data.expiresAt) : null;
if (expiresAt && expiresAt < new Date()) {
  console.log('Access token expired, refreshing...');
  const r = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      client_id: process.env.GOOGLE_CLIENT_ID,
      client_secret: process.env.GOOGLE_CLIENT_SECRET,
      refresh_token: data.refreshToken,
      grant_type: 'refresh_token',
    }),
  });
  const t = await r.json();
  if (t.error) { console.error('Refresh failed:', t); await sql.end(); process.exit(1); }
  accessToken = t.access_token;
}

const info = await fetch(`https://oauth2.googleapis.com/tokeninfo?access_token=${accessToken}`);
const json = await info.json();

if (json.error) {
  console.error('tokeninfo error:', json.error, json.error_description);
} else {
  console.log(`\nAccount : ${row.account_email}`);
  console.log(`Expires : ${new Date(json.exp * 1000).toISOString()}`);
  console.log(`\nGranted scopes:`);
  json.scope.split(' ').forEach(s => console.log(' ', s));
}

await sql.end();
