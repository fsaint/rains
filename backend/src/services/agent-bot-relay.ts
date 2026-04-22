/**
 * Agent Bot Webhook Relay
 *
 * When a deployed agent's Telegram bot is added to a group, the system needs
 * to detect it and create an approval asking how the agent should behave.
 *
 * Architecture:
 * - At deploy time, OpenClaw is configured with OPENCLAW_WEBHOOK_URL pointing to Reins
 *   and OPENCLAW_WEBHOOK_SECRET shared secret. OpenClaw self-registers the Telegram webhook.
 * - OpenClaw's webhook HTTP server runs on port 8787; Fly exposes it externally via 8443.
 * - Reins receives all Telegram updates, intercepts `my_chat_member` events, and forwards
 *   all updates to OpenClaw at https://<app>.fly.dev:8443/telegram-webhook.
 */

import { client } from '../db/index.js';
import { approvalQueue } from '../approvals/queue.js';
import * as provider from '../providers/index.js';
import type { ApprovalRequest } from '@reins/shared';
import type { TelegramGroup } from '../providers/index.js';

// ─── Types ────────────────────────────────────────────────────────────────────

interface ChatMemberStatus {
  status: 'left' | 'member' | 'administrator' | 'kicked' | 'creator' | 'restricted';
  user: { id: number; is_bot?: boolean };
}

interface MyChatMemberUpdate {
  my_chat_member: {
    chat: { id: number; title?: string; type: 'private' | 'group' | 'supergroup' | 'channel' };
    from: { id: number; username?: string; first_name?: string };
    date: number;
    old_chat_member: ChatMemberStatus;
    new_chat_member: ChatMemberStatus;
  };
}

interface TelegramUpdate {
  update_id?: number;
  my_chat_member?: MyChatMemberUpdate['my_chat_member'];
  [key: string]: unknown;
}

// ─── Forward to OpenClaw ──────────────────────────────────────────────────────

/**
 * Forward a Telegram update to OpenClaw's webhook server.
 * OpenClaw validates the X-Telegram-Bot-Api-Secret-Token header, so we must include it.
 */
export async function forwardToOpenclaw(
  deploymentId: string,
  openclawUrl: string,
  body: unknown,
  webhookSecret?: string
): Promise<void> {
  try {
    const headers: Record<string, string> = { 'Content-Type': 'application/json' };
    if (webhookSecret) {
      headers['X-Telegram-Bot-Api-Secret-Token'] = webhookSecret;
    }
    const res = await fetch(openclawUrl, {
      method: 'POST',
      headers,
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(10_000),
    });
    if (!res.ok) {
      console.warn(`[webhook-relay] OpenClaw returned ${res.status} for deployment ${deploymentId}`);
    }
  } catch (err: unknown) {
    console.error(`[webhook-relay] Forward error for deployment ${deploymentId}:`, err);
  }
}

// ─── Group join/leave detection ───────────────────────────────────────────────

/**
 * Process a my_chat_member update.
 * - Bot added to group → create an approval
 * - Bot removed from group → clean up config + cancel pending approval
 */
export async function handleMyChatMember(
  deploymentId: string,
  agentId: string,
  update: TelegramUpdate['my_chat_member'] & {}
): Promise<void> {
  const { chat, from, old_chat_member, new_chat_member } = update;

  // Only care about groups/supergroups (not channels or private)
  if (chat.type !== 'group' && chat.type !== 'supergroup') return;

  const chatId = String(chat.id);
  const chatTitle = chat.title ?? `Group ${chatId}`;

  const wasIn = ['member', 'administrator', 'creator'].includes(old_chat_member.status);
  const isNowIn = ['member', 'administrator', 'creator'].includes(new_chat_member.status);

  if (!wasIn && isNowIn) {
    await handleBotAddedToGroup(deploymentId, agentId, chatId, chatTitle, chat.type, from);
  } else if (wasIn && !isNowIn) {
    await handleBotRemovedFromGroup(deploymentId, agentId, chatId, chatTitle);
  }
}

async function handleBotAddedToGroup(
  deploymentId: string,
  agentId: string,
  chatId: string,
  chatTitle: string,
  chatType: string,
  addedBy: { username?: string; first_name?: string; id: number }
): Promise<void> {
  // Check if already configured — idempotent
  const row = await client.execute({
    sql: `SELECT telegram_groups_json FROM deployed_agents WHERE id = ?`,
    args: [deploymentId],
  });
  if (row.rows.length > 0) {
    const existing: TelegramGroup[] = parseGroups(row.rows[0].telegram_groups_json as string | null);
    if (existing.some((g) => g.chatId === chatId)) {
      console.info(`[webhook-relay] Group ${chatId} already configured for deployment ${deploymentId}, skipping`);
      return;
    }
  }

  // De-duplicate: check for an existing pending approval
  const pending = await client.execute({
    sql: `SELECT id FROM approvals
          WHERE status = 'pending' AND tool = 'telegram_group' AND agent_id = ?
            AND json_extract(arguments_json, '$.chatId') = ?
          LIMIT 1`,
    args: [agentId, chatId],
  });
  if (pending.rows.length > 0) {
    console.info(`[webhook-relay] Pending approval already exists for agent ${agentId} / group ${chatId}`);
    return;
  }

  const addedByStr = addedBy.username
    ? `@${addedBy.username}`
    : addedBy.first_name ?? String(addedBy.id);

  await approvalQueue.submit(
    agentId,
    'telegram_group',
    {
      chatId,
      chatTitle,
      chatType,
      addedBy: addedByStr,
      deploymentId,
    },
    `Your bot was added to the Telegram ${chatType} "${chatTitle}". Configure how it should behave.`,
    7 * 24 * 60 * 60 * 1000 // 7 days
  );

  console.info(`[webhook-relay] Group-join approval created for agent ${agentId}, group "${chatTitle}" (${chatId})`);
}

async function handleBotRemovedFromGroup(
  deploymentId: string,
  agentId: string,
  chatId: string,
  chatTitle: string
): Promise<void> {
  // Load the deployment to update config
  const row = await client.execute({
    sql: `SELECT fly_app_name, fly_machine_id, telegram_groups_json FROM deployed_agents WHERE id = ?`,
    args: [deploymentId],
  });
  if (row.rows.length === 0) return;

  const r = row.rows[0];
  const groups = parseGroups(r.telegram_groups_json as string | null).filter((g) => g.chatId !== chatId);

  // Update DB
  await client.execute({
    sql: `UPDATE deployed_agents SET telegram_groups_json = ? WHERE id = ?`,
    args: [JSON.stringify(groups), deploymentId],
  });

  // Apply to running machine if Fly-provisioned
  const appName = r.fly_app_name as string | null;
  const machineId = r.fly_machine_id as string | null;
  if (appName && machineId) {
    try {
      await provider.updateEnv(appName, machineId, {
        TELEGRAM_GROUPS_JSON: groups.length > 0 ? JSON.stringify(groups) : undefined,
      });
    } catch (err) {
      console.warn(`[webhook-relay] Could not update env after group removal for ${deploymentId}:`, err);
    }
  }

  // Cancel any pending approval for this group
  await client.execute({
    sql: `UPDATE approvals SET status = 'expired', resolved_at = ?, resolved_by = ?
          WHERE status = 'pending' AND tool = 'telegram_group' AND agent_id = ?
            AND json_extract(arguments_json, '$.chatId') = ?`,
    args: [new Date().toISOString(), 'system:bot_removed', agentId, chatId],
  });

  console.info(`[webhook-relay] Bot removed from group "${chatTitle}" (${chatId}), config updated for deployment ${deploymentId}`);
}

// ─── Apply group config after approval ────────────────────────────────────────

/**
 * Called when a `telegram_group` approval is resolved as approved.
 * Adds the group to the agent's config and applies via env update.
 */
export async function applyGroupConfig(approval: ApprovalRequest): Promise<void> {
  const { chatId, chatTitle, deploymentId } = approval.arguments as {
    chatId: string;
    chatTitle: string;
    deploymentId: string;
  };

  // behavior is stored in resolutionComment: 'all' | 'mention'
  const behavior = approval.resolutionComment;
  const requireMention = behavior !== 'all'; // default to requireMention=true unless explicitly 'all'

  const row = await client.execute({
    sql: `SELECT fly_app_name, fly_machine_id, telegram_groups_json FROM deployed_agents WHERE id = ?`,
    args: [deploymentId],
  });
  if (row.rows.length === 0) {
    console.warn(`[webhook-relay] applyGroupConfig: deployment ${deploymentId} not found`);
    return;
  }

  const r = row.rows[0];
  const groups = parseGroups(r.telegram_groups_json as string | null);

  // Idempotent: don't add if already there
  if (!groups.some((g) => g.chatId === chatId)) {
    groups.push({ chatId, name: chatTitle, requireMention });
  } else {
    // Update existing (preserve other fields like topicPrompts)
    const idx = groups.findIndex((g) => g.chatId === chatId);
    groups[idx] = { ...groups[idx], name: chatTitle, requireMention };
  }

  // Update DB first
  await client.execute({
    sql: `UPDATE deployed_agents SET telegram_groups_json = ? WHERE id = ?`,
    args: [JSON.stringify(groups), deploymentId],
  });

  const appName = r.fly_app_name as string | null;
  const machineId = r.fly_machine_id as string | null;

  if (appName && machineId) {
    await provider.updateEnv(appName, machineId, {
      TELEGRAM_GROUPS_JSON: JSON.stringify(groups),
    });
    // After container restart, entrypoint.sh re-reads TELEGRAM_GROUPS_JSON and OPENCLAW_WEBHOOK_URL/SECRET
    // so the webhook config is automatically preserved — no manual re-override needed.
  }

  console.info(
    `[webhook-relay] Group "${chatTitle}" (${chatId}) added to deployment ${deploymentId} with requireMention=${requireMention}`
  );
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function parseGroups(json: string | null | undefined): TelegramGroup[] {
  if (!json) return [];
  try {
    return JSON.parse(json) as TelegramGroup[];
  } catch {
    return [];
  }
}

