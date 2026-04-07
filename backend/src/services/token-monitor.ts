/**
 * Token Monitor Service
 *
 * Two background loops:
 *
 * 1. Token Expiry Check (every 15 min)
 *    Scans all openai-codex deployed agents, decodes the JWT exp from
 *    model_credentials, and fires a reauth approval if expired or expiring
 *    within 24 hours.
 *
 * 2. Health Check (every 5 min)
 *    Polls Fly/Docker agent health for running openai-codex agents. When
 *    the health check is critical AND the token is expired, fires reauth
 *    immediately — catching agents that are already broken faster than the
 *    15-min token loop.
 */

import { client } from '../db/index.js';
import { approvalQueue } from '../approvals/queue.js';
import * as provider from '../providers/index.js';

const TOKEN_CHECK_INTERVAL_MS  = 15 * 60 * 1000; // 15 minutes
const HEALTH_CHECK_INTERVAL_MS =  5 * 60 * 1000; //  5 minutes
const EXPIRY_WARN_AHEAD_MS     = 24 * 60 * 60 * 1000; // warn 24h before expiry

// ─── JWT helpers ─────────────────────────────────────────────────────────────

function decodeJwtExpMs(accessToken: string): number | null {
  try {
    const payload = JSON.parse(
      Buffer.from(accessToken.split('.')[1], 'base64url').toString('utf8')
    );
    return typeof payload.exp === 'number' ? payload.exp * 1000 : null;
  } catch {
    return null;
  }
}

function isExpiredOrExpiringSoon(expMs: number): boolean {
  return expMs < Date.now() + EXPIRY_WARN_AHEAD_MS;
}

// ─── Shared reauth trigger ────────────────────────────────────────────────────

async function maybeSubmitReauth(
  agentId: string,
  agentName: string,
  expMs: number,
  source: 'token_monitor' | 'health_monitor'
): Promise<void> {
  const expiredAt = new Date(expMs).toISOString();
  const isExpired = expMs < Date.now();

  const context = isExpired
    ? `OpenAI Codex token for agent "${agentName}" expired at ${expiredAt}. The agent cannot start until re-authenticated.`
    : `OpenAI Codex token for agent "${agentName}" expires at ${expiredAt} (within 24 hours). Re-authenticate before it stops working.`;

  const { isNew } = await approvalQueue.submitReauth(
    agentId,
    'openai-codex',
    context,
    { source, tokenExpiredAt: expiredAt, agentName }
  );

  if (isNew) {
    console.info(`[token-monitor] Reauth approval created for agent ${agentId} (${agentName}) — source: ${source}`);
  }
}

// ─── Loop 1: Token expiry check ───────────────────────────────────────────────

async function runTokenExpiryCheck(): Promise<void> {
  const result = await client.execute(
    `SELECT da.id, da.agent_id, da.model_credentials, a.name
     FROM deployed_agents da
     JOIN agents a ON a.id = da.agent_id
     WHERE da.model_provider = 'openai-codex'
       AND da.status NOT IN ('destroyed', 'error')`
  );

  for (const row of result.rows) {
    const deploymentId = row.id as string;
    const agentId      = row.agent_id as string;
    const agentName    = row.name as string;
    const credsJson    = row.model_credentials as string | null;

    if (!credsJson) continue;

    let creds: { access_token?: string };
    try {
      creds = JSON.parse(credsJson);
    } catch {
      continue;
    }

    if (!creds.access_token) continue;

    const expMs = decodeJwtExpMs(creds.access_token);
    if (expMs === null) continue;

    if (isExpiredOrExpiringSoon(expMs)) {
      await maybeSubmitReauth(agentId, agentName, expMs, 'token_monitor');
    }

    // Suppress unused variable warning
    void deploymentId;
  }
}

// ─── Loop 2: Health check correlator ─────────────────────────────────────────

async function runHealthCheck(): Promise<void> {
  const result = await client.execute(
    `SELECT da.id, da.agent_id, da.fly_app_name, da.fly_machine_id,
            da.model_credentials, da.is_manual, a.name
     FROM deployed_agents da
     JOIN agents a ON a.id = da.agent_id
     WHERE da.model_provider = 'openai-codex'
       AND da.status = 'running'
       AND da.is_manual = 0`
  );

  for (const row of result.rows) {
    const agentId    = row.agent_id as string;
    const agentName  = row.name as string;
    const appName    = row.fly_app_name as string | null;
    const machineId  = row.fly_machine_id as string | null;
    const credsJson  = row.model_credentials as string | null;

    if (!appName || !machineId || !credsJson) continue;

    let creds: { access_token?: string };
    try {
      creds = JSON.parse(credsJson);
    } catch {
      continue;
    }

    if (!creds.access_token) continue;

    const expMs = decodeJwtExpMs(creds.access_token);
    if (expMs === null || !isExpiredOrExpiringSoon(expMs)) continue;

    // Only fire reauth if the agent is actually unhealthy
    try {
      const status = await provider.getStatus(appName, machineId);
      if (status !== 'running') {
        await maybeSubmitReauth(agentId, agentName, expMs, 'health_monitor');
      }
    } catch {
      // If we can't reach the provider, assume unhealthy and fire reauth
      await maybeSubmitReauth(agentId, agentName, expMs, 'health_monitor');
    }
  }
}

// ─── Public API ───────────────────────────────────────────────────────────────

let tokenCheckTimer: NodeJS.Timeout | null = null;
let healthCheckTimer: NodeJS.Timeout | null = null;

export function startTokenMonitor(): void {
  // Run immediately on startup, then on interval
  runTokenExpiryCheck().catch(console.error);
  runHealthCheck().catch(console.error);

  tokenCheckTimer = setInterval(() => {
    runTokenExpiryCheck().catch(console.error);
  }, TOKEN_CHECK_INTERVAL_MS);

  healthCheckTimer = setInterval(() => {
    runHealthCheck().catch(console.error);
  }, HEALTH_CHECK_INTERVAL_MS);

  console.info('[token-monitor] Started (token check: 15min, health check: 5min)');
}

export function stopTokenMonitor(): void {
  if (tokenCheckTimer) { clearInterval(tokenCheckTimer); tokenCheckTimer = null; }
  if (healthCheckTimer) { clearInterval(healthCheckTimer); healthCheckTimer = null; }
}

/**
 * Utility: check if a model_credentials JSON string has an expired Codex token.
 * Used for deploy-time pre-flight validation.
 */
export function isCodexTokenExpired(modelCredentialsJson: string): boolean {
  try {
    const creds = JSON.parse(modelCredentialsJson) as { access_token?: string };
    if (!creds.access_token) return false;
    const expMs = decodeJwtExpMs(creds.access_token);
    return expMs !== null && expMs < Date.now();
  } catch {
    return false;
  }
}
