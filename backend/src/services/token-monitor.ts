/**
 * Token Monitor Service
 *
 * Background loop:
 *
 * OAuth credential expiry check (every 30 min)
 *   Scans OAuth credentials whose access token has expired, attempts a
 *   refresh, and fires a reauth approval for the owning agent when the
 *   refresh fails.
 */

import { client } from '../db/index.js';
import { approvalQueue } from '../approvals/queue.js';
import { credentialVault } from '../credentials/vault.js';

const OAUTH_CHECK_INTERVAL_MS = 30 * 60 * 1000; // 30 minutes

// Maps credential service_id → reauth provider name used in the approval modal
const OAUTH_SERVICE_TO_PROVIDER: Record<string, string> = {
  google:    'gmail',
  gmail:     'gmail',
  drive:     'drive',
  calendar:  'calendar',
  microsoft: 'outlook-mail',
  outlook:   'outlook-mail',
};

// ─── OAuth credential expiry check ────────────────────────────────────────────

async function runOAuthExpiryCheck(): Promise<void> {
  // Find OAuth credentials whose access token has expired
  const result = await client.execute(
    `SELECT c.id, c.service_id, c.account_email,
            asi.agent_id, a.name AS agent_name
     FROM credentials c
     JOIN agent_service_instances asi ON asi.credential_id = c.id AND asi.enabled = true
     JOIN agents a ON a.id = asi.agent_id
     WHERE c.type = 'oauth2'
       AND c.expires_at IS NOT NULL
       AND c.expires_at::timestamptz < NOW()`
  );

  for (const row of result.rows) {
    const credentialId = row.id as string;
    const serviceId    = row.service_id as string;
    const email        = row.account_email as string | null;
    const agentId      = row.agent_id as string;
    const agentName    = row.agent_name as string;

    // Try to refresh — if it succeeds, expires_at is updated in the DB and no action needed
    try {
      const token = await credentialVault.getValidAccessToken(credentialId);
      if (token) continue; // refreshed successfully
    } catch {
      // refresh threw — treat as expired
    }

    // Refresh failed: submit a reauth approval for this agent
    const reauthProvider = OAUTH_SERVICE_TO_PROVIDER[serviceId] ?? serviceId;
    const context = email
      ? `Your ${serviceId} connection for ${email} has expired and could not be refreshed. Please re-authorize to resume access.`
      : `Your ${serviceId} connection has expired and could not be refreshed. Please re-authorize to resume access.`;

    const { isNew } = await approvalQueue.submitReauth(
      agentId,
      reauthProvider,
      context,
      { credentialId, email: email ?? undefined, accountEmail: email ?? undefined, source: 'oauth_monitor' },
    );

    if (isNew) {
      console.info(`[token-monitor] OAuth reauth approval created for agent ${agentId} (${agentName}), credential ${credentialId} (${serviceId}${email ? ` / ${email}` : ''})`);
    }
  }
}

// ─── Public API ───────────────────────────────────────────────────────────────

let oauthCheckTimer: NodeJS.Timeout | null = null;

export function startTokenMonitor(): void {
  runOAuthExpiryCheck().catch(console.error);
  oauthCheckTimer = setInterval(() => {
    runOAuthExpiryCheck().catch(console.error);
  }, OAUTH_CHECK_INTERVAL_MS);
  console.info('[token-monitor] Started (oauth check: 30min)');
}

export function stopTokenMonitor(): void {
  if (oauthCheckTimer) { clearInterval(oauthCheckTimer); oauthCheckTimer = null; }
}
