import type { client as DbClient } from '../db/index.js';
import type { Config } from '../config/index.js';

type DatabaseClient = typeof DbClient;

// ---------------------------------------------------------------------------
// Model-aware pricing ($ per 1M tokens)
// ---------------------------------------------------------------------------

interface ModelPricing {
  inputPer1M: number;
  outputPer1M: number;
}

const MODEL_PRICING: Record<string, ModelPricing> = {
  // Anthropic
  'anthropic':          { inputPer1M: 3.00,  outputPer1M: 15.00 },
  'claude-sonnet-4-5':  { inputPer1M: 3.00,  outputPer1M: 15.00 },
  'claude-sonnet-4-6':  { inputPer1M: 3.00,  outputPer1M: 15.00 },
  'claude-opus-4-7':    { inputPer1M: 15.00, outputPer1M: 75.00 },
  'claude-haiku-4-5':   { inputPer1M: 0.80,  outputPer1M: 4.00  },
  // OpenAI
  'openai':             { inputPer1M: 2.50,  outputPer1M: 10.00 },
  'gpt-4o':             { inputPer1M: 2.50,  outputPer1M: 10.00 },
  'gpt-4.1':            { inputPer1M: 2.00,  outputPer1M: 8.00  },
  'openai-codex':       { inputPer1M: 3.00,  outputPer1M: 15.00 },
  // MiniMax
  'minimax':            { inputPer1M: 0.80,  outputPer1M: 1.60  },
  'minimax-m2.7':       { inputPer1M: 0.80,  outputPer1M: 1.60  },
};

const DEFAULT_PRICING: ModelPricing = { inputPer1M: 3.00, outputPer1M: 15.00 };

export function estimateCost(
  inputTokens: number,
  outputTokens: number,
  modelProvider?: string | null,
  modelName?: string | null,
): number {
  const pricing =
    MODEL_PRICING[modelName ?? ''] ??
    MODEL_PRICING[modelProvider ?? ''] ??
    DEFAULT_PRICING;
  return (
    (inputTokens / 1_000_000) * pricing.inputPer1M +
    (outputTokens / 1_000_000) * pricing.outputPer1M
  );
}

// ---------------------------------------------------------------------------
// Billing period helpers
// ---------------------------------------------------------------------------

export function currentBillingPeriod(): string {
  const now = new Date();
  return `${now.getUTCFullYear()}-${String(now.getUTCMonth() + 1).padStart(2, '0')}`;
}

// ---------------------------------------------------------------------------
// Spend summary for current billing period
// ---------------------------------------------------------------------------

export interface PeriodSpend {
  totalDollars: number;
  totalInputTokens: number;
  totalOutputTokens: number;
}

export async function getPeriodSpend(
  client: DatabaseClient,
  agentId: string,
  period?: string,
): Promise<PeriodSpend> {
  const bp = period ?? currentBillingPeriod();
  const result = await client.execute({
    sql: `
      SELECT
        COALESCE(SUM(amount), 0)         AS total_dollars,
        COALESCE(SUM(input_tokens), 0)   AS total_input,
        COALESCE(SUM(output_tokens), 0)  AS total_output
      FROM spend_records
      WHERE agent_id = ? AND billing_period = ?
    `,
    args: [agentId, bp],
  });
  const row = result.rows[0];
  return {
    totalDollars:      Number(row?.total_dollars ?? 0),
    totalInputTokens:  Number(row?.total_input   ?? 0),
    totalOutputTokens: Number(row?.total_output  ?? 0),
  };
}

// ---------------------------------------------------------------------------
// Cap check — returns whether the agent should be allowed to proceed
// ---------------------------------------------------------------------------

export interface CapCheckResult {
  allowed: boolean;
  percentUsed: number;
  shouldAlert80: boolean;   // true if 80% threshold just crossed
  shouldSoftStop: boolean;  // true if 100% threshold crossed
}

export async function checkSpendCap(
  client: DatabaseClient,
  agentId: string,
): Promise<CapCheckResult> {
  // Load deployment config
  const depResult = await client.execute({
    sql: `SELECT spend_limit_dollars, spend_limit_tokens, spend_soft_stopped, spend_alerted_80
          FROM deployed_agents WHERE agent_id = ? AND status NOT IN ('destroyed','error')
          ORDER BY created_at DESC LIMIT 1`,
    args: [agentId],
  });

  if (depResult.rows.length === 0) {
    return { allowed: true, percentUsed: 0, shouldAlert80: false, shouldSoftStop: false };
  }

  const dep = depResult.rows[0];
  const limitDollars  = dep.spend_limit_dollars  != null ? Number(dep.spend_limit_dollars)  : null;
  const limitTokens   = dep.spend_limit_tokens   != null ? Number(dep.spend_limit_tokens)   : null;
  const alreadyStopped = Number(dep.spend_soft_stopped ?? 0) === 1;
  const alerted80      = Number(dep.spend_alerted_80    ?? 0) === 1;

  if (limitDollars == null && limitTokens == null) {
    return { allowed: true, percentUsed: 0, shouldAlert80: false, shouldSoftStop: false };
  }

  const spend = await getPeriodSpend(client, agentId);

  // Prefer token-based cap if set, else dollar-based
  let percentUsed = 0;
  if (limitTokens != null) {
    const totalTokens = spend.totalInputTokens + spend.totalOutputTokens;
    percentUsed = limitTokens > 0 ? (totalTokens / limitTokens) * 100 : 0;
  } else if (limitDollars != null) {
    percentUsed = limitDollars > 0 ? (spend.totalDollars / limitDollars) * 100 : 0;
  }

  const hitCap     = percentUsed >= 100;
  const hit80      = percentUsed >= 80;

  return {
    allowed:        !hitCap && !alreadyStopped,
    percentUsed,
    shouldAlert80:  hit80 && !hitCap && !alerted80,
    shouldSoftStop: hitCap && !alreadyStopped,
  };
}

// ---------------------------------------------------------------------------
// Mutators
// ---------------------------------------------------------------------------

export async function markSoftStopped(client: DatabaseClient, agentId: string): Promise<void> {
  await client.execute({
    sql: `UPDATE deployed_agents SET spend_soft_stopped = 1, updated_at = ?
          WHERE agent_id = ? AND status NOT IN ('destroyed','error')`,
    args: [new Date().toISOString(), agentId],
  });
}

export async function markAlerted80(client: DatabaseClient, agentId: string): Promise<void> {
  await client.execute({
    sql: `UPDATE deployed_agents SET spend_alerted_80 = 1, updated_at = ?
          WHERE agent_id = ? AND status NOT IN ('destroyed','error')`,
    args: [new Date().toISOString(), agentId],
  });
}

export async function resetSpendCap(client: DatabaseClient, agentId: string): Promise<void> {
  await client.execute({
    sql: `UPDATE deployed_agents
          SET spend_soft_stopped = 0, spend_alerted_80 = 0, updated_at = ?
          WHERE agent_id = ?`,
    args: [new Date().toISOString(), agentId],
  });
}

// ---------------------------------------------------------------------------
// Telegram notification helpers
// ---------------------------------------------------------------------------

async function sendTelegramToAgent(
  client: DatabaseClient,
  config: Config,
  agentId: string,
  text: string,
): Promise<void> {
  if (!config.sharedBotToken) return;

  const r = await client.execute({
    sql: `SELECT u.telegram_chat_id
          FROM users u JOIN agents a ON a.user_id = u.id
          WHERE a.id = ? LIMIT 1`,
    args: [agentId],
  });
  const chatId = r.rows[0]?.telegram_chat_id as string | null;
  if (!chatId) return;

  fetch(`https://api.telegram.org/bot${config.sharedBotToken}/sendMessage`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ chat_id: chatId, text, parse_mode: 'Markdown' }),
  }).catch(() => {});
}

export async function notifySpend80(
  client: DatabaseClient,
  config: Config,
  agentId: string,
  percentUsed: number,
): Promise<void> {
  await sendTelegramToAgent(
    client, config, agentId,
    `⚠️ *Spend cap warning*\n\nYour agent has used ${Math.round(percentUsed)}% of its monthly budget. It will pause automatically at 100%.\n\nRaise your cap in the [dashboard](${config.dashboardUrl}/agents).`,
  );
}

export async function notifySoftStop(
  client: DatabaseClient,
  config: Config,
  agentId: string,
): Promise<void> {
  await sendTelegramToAgent(
    client, config, agentId,
    `🛑 *Agent paused — spend cap reached*\n\nYour agent has reached its monthly budget limit and will not execute tools until you raise the cap.\n\nResume in the [dashboard](${config.dashboardUrl}/agents).`,
  );
}
