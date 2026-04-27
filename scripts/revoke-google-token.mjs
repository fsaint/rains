#!/usr/bin/env node
/**
 * Revokes the Google OAuth token for a credential so Google clears its grant
 * record. After revoking, the user must reconnect via OAuth to get a fresh
 * token with the correct scopes.
 *
 * Usage: node scripts/revoke-google-token.mjs <credentialId>
 */
import postgres from 'postgres';
import crypto from 'crypto';
import { config } from 'dotenv';

config({ path: new URL('../.env', import.meta.url).pathname });

const credentialId = process.argv[2];
if (!credentialId) {
  console.error('Usage: node scripts/revoke-google-token.mjs <credentialId>');
  process.exit(1);
}

const DATABASE_URL = process.env.DATABASE_URL;
const ENCRYPTION_KEY = process.env.REINS_ENCRYPTION_KEY;

if (!DATABASE_URL || !ENCRYPTION_KEY) {
  console.error('DATABASE_URL and REINS_ENCRYPTION_KEY must be set in .env');
  process.exit(1);
}

const key = Buffer.from(ENCRYPTION_KEY, 'hex');
const sql = postgres(DATABASE_URL);

const rows = await sql`SELECT * FROM credentials WHERE id = ${credentialId}`;
if (rows.length === 0) {
  console.error(`Credential ${credentialId} not found`);
  await sql.end();
  process.exit(1);
}

const row = rows[0];

// Decrypt
const encryptedData = Buffer.from(row.encrypted_data, 'base64');
const iv = Buffer.from(row.iv, 'base64');
const authTag = Buffer.from(row.auth_tag, 'base64');

const decipher = crypto.createDecipheriv('aes-256-gcm', key, iv);
decipher.setAuthTag(authTag);
const decrypted = Buffer.concat([decipher.update(encryptedData), decipher.final()]);
const data = JSON.parse(decrypted.toString('utf8'));

const refreshToken = data.refreshToken;
const accessToken = data.accessToken;

if (!refreshToken && !accessToken) {
  console.error('No token found in credential to revoke');
  await sql.end();
  process.exit(1);
}

// Revoke refresh token (preferred) or access token
const tokenToRevoke = refreshToken || accessToken;
console.log(`Revoking ${refreshToken ? 'refresh' : 'access'} token for ${row.account_email}...`);

const res = await fetch(`https://oauth2.googleapis.com/revoke?token=${tokenToRevoke}`, {
  method: 'POST',
  headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
});

if (res.ok || res.status === 200) {
  console.log('Token revoked successfully.');
} else {
  const body = await res.text();
  console.warn(`Revocation returned ${res.status}: ${body}`);
  console.warn('Token may already be expired or invalid — continuing anyway.');
}

// Clear the credential's token data from our DB too
await sql`
  UPDATE credentials
  SET expires_at = '1970-01-01T00:00:00.000Z', updated_at = NOW()::text
  WHERE id = ${credentialId}
`;
console.log('Credential marked as expired in DB.');
console.log(`\nNext step: reconnect via https://reins.btv.pw/api/oauth/google?reconnect=${credentialId}`);

await sql.end();
