/**
 * Pending OAuth Flows Storage
 *
 * DB-backed storage for OAuth state tokens with 10-minute TTL.
 * Replaces the previous in-memory Map to work correctly across
 * multiple Fly.io machines and survive process restarts.
 */

import { sql } from '../db/index.js';

export interface PendingOAuthFlow {
  service: string;
  userId?: string;
  grantedServices?: string[];
  reconnectCredentialId?: string;
  reauthApprovalId?: string;
  telegramUserId?: number;
  initiatedAt: Date;
}

const TTL_MS = 10 * 60 * 1000; // 10 minutes

export async function storePendingOAuthFlow(
  state: string,
  flow: {
    service: string;
    userId?: string;
    grantedServices?: string[];
    reconnectCredentialId?: string;
    reauthApprovalId?: string;
    telegramUserId?: number;
  }
): Promise<void> {
  const now = new Date();
  const expiresAt = new Date(now.getTime() + TTL_MS);
  await sql`
    INSERT INTO pending_oauth_flows (
      state, service, user_id, granted_services, reconnect_credential_id,
      reauth_approval_id, telegram_user_id, initiated_at, expires_at
    )
    VALUES (
      ${state}, ${flow.service}, ${flow.userId ?? null},
      ${flow.grantedServices ? JSON.stringify(flow.grantedServices) : null},
      ${flow.reconnectCredentialId ?? null}, ${flow.reauthApprovalId ?? null},
      ${flow.telegramUserId ?? null}, ${now.toISOString()}, ${expiresAt.toISOString()}
    )
    ON CONFLICT (state) DO UPDATE SET
      service = EXCLUDED.service,
      user_id = EXCLUDED.user_id,
      granted_services = EXCLUDED.granted_services,
      reconnect_credential_id = EXCLUDED.reconnect_credential_id,
      reauth_approval_id = EXCLUDED.reauth_approval_id,
      telegram_user_id = EXCLUDED.telegram_user_id,
      initiated_at = EXCLUDED.initiated_at,
      expires_at = EXCLUDED.expires_at
  `;
}

export async function getPendingOAuthFlow(state: string): Promise<PendingOAuthFlow | undefined> {
  const rows = await sql`
    SELECT * FROM pending_oauth_flows
    WHERE state = ${state} AND expires_at > now()
  `;
  if (rows.length === 0) return undefined;
  const row = rows[0];
  return {
    service: row.service as string,
    userId: row.user_id != null ? (row.user_id as string) : undefined,
    grantedServices: row.granted_services ? JSON.parse(row.granted_services as string) : undefined,
    reconnectCredentialId: row.reconnect_credential_id != null ? (row.reconnect_credential_id as string) : undefined,
    reauthApprovalId: row.reauth_approval_id != null ? (row.reauth_approval_id as string) : undefined,
    telegramUserId: row.telegram_user_id != null ? Number(row.telegram_user_id) : undefined,
    initiatedAt: new Date(row.initiated_at as string),
  };
}

export async function deletePendingOAuthFlow(state: string): Promise<boolean> {
  const result = await sql`DELETE FROM pending_oauth_flows WHERE state = ${state}`;
  return (result as any).count > 0;
}

export async function cleanupExpiredFlows(): Promise<number> {
  const result = await sql`DELETE FROM pending_oauth_flows WHERE expires_at <= now()`;
  return (result as any).count ?? 0;
}
