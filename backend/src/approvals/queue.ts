import { client } from '../db/index.js';
import { nanoid } from 'nanoid';
import { EventEmitter } from 'events';
import { getPostHog } from '../analytics/posthog.js';
import { redactToolArgs } from '../mcp/redact-args.js';
import type { ApprovalRequest, ApprovalStatus, ApprovalDecision } from '@reins/shared';

const DEFAULT_EXPIRY_MS = 60 * 60 * 1000; // 1 hour

/**
 * How many times a human may send a request back to the agent for correction
 * before they must simply approve or deny. Bounds the revise/resubmit loop.
 */
export const MAX_REVISIONS = 3;

/**
 * Window in which a fresh approval for the same agent+tool is treated as the
 * agent's revision of a request that was sent back. The agent normally
 * resubmits within seconds of polling.
 */
const REVISION_LINK_WINDOW_MS = 15 * 60 * 1000;

export type RequestChangesResult = 'ok' | 'not_pending' | 'cap_reached';

export interface ApprovalEvents {
  'request': [ApprovalRequest];
  'resolved': [ApprovalRequest];
  'expired': [string[]];
}

export class ApprovalQueue extends EventEmitter<ApprovalEvents> {
  private pendingWaiters: Map<string, {
    resolve: (decision: ApprovalDecision | null) => void;
    timeout: NodeJS.Timeout;
  }> = new Map();

  private pendingExecutors: Map<string, () => Promise<unknown>> = new Map();

  /**
   * Register an async function to auto-execute when approval is granted.
   * The result will be stored in result_json for later retrieval.
   */
  registerExecutor(id: string, executor: () => Promise<unknown>): void {
    this.pendingExecutors.set(id, executor);
  }

  /**
   * Submit a new approval request
   */
  async submit(
    agentId: string,
    tool: string,
    args: Record<string, unknown>,
    context?: string,
    expiryMs: number = DEFAULT_EXPIRY_MS
  ): Promise<string> {
    const id = nanoid();
    const now = new Date();
    const expiresAt = new Date(now.getTime() + expiryMs);

    // If the human recently sent an equivalent request back for correction, this
    // is the agent's revision of it — link the chain so the UI can show lineage
    // and the revision cap can be enforced.
    const parent = await this.findRevisionParent(agentId, tool, now);

    await client.execute({
      sql: `INSERT INTO approvals (id, agent_id, tool, arguments_json, context, status, requested_at, expires_at, parent_approval_id, revision)
            VALUES (?, ?, ?, ?, ?, 'pending', ?, ?, ?, ?)`,
      args: [
        id,
        agentId,
        tool,
        // Display-only snapshot: the deferred executor runs from an in-memory
        // copy of `args`, so stripping bulk payloads here cannot affect it.
        JSON.stringify(redactToolArgs(args)),
        context ?? null,
        now.toISOString(),
        expiresAt.toISOString(),
        parent?.id ?? null,
        parent ? parent.revision + 1 : 0,
      ],
    });

    const request = await this.get(id);
    if (request) {
      this.emit('request', request);
      getPostHog()?.capture({
        distinctId: agentId,
        event: 'approval_requested',
        properties: { agentId, tool, revision: request.revision },
      });
    }

    return id;
  }

  /**
   * Find the approval a new request is a revision of: the most recent
   * changes_requested row for the same agent+tool, inside the link window, that
   * no other revision has already claimed.
   *
   * The link is inferred server-side rather than declared by the agent — making
   * the model thread a parent id through every tool's arguments would pollute
   * each tool schema for a concern the model has no reason to know about.
   */
  private async findRevisionParent(
    agentId: string,
    tool: string,
    now: Date
  ): Promise<{ id: string; revision: number } | null> {
    const since = new Date(now.getTime() - REVISION_LINK_WINDOW_MS).toISOString();

    const result = await client.execute({
      sql: `SELECT id, revision FROM approvals
            WHERE agent_id = ? AND tool = ? AND status = 'changes_requested'
              AND resolved_at > ?
              AND id NOT IN (SELECT parent_approval_id FROM approvals WHERE parent_approval_id IS NOT NULL)
            ORDER BY resolved_at DESC LIMIT 1`,
      args: [agentId, tool, since],
    });

    if (result.rows.length === 0) return null;
    const row = result.rows[0] as { id: string; revision: number | null };
    return { id: row.id, revision: Number(row.revision ?? 0) };
  }

  /**
   * Get an approval request by ID
   */
  async get(id: string): Promise<ApprovalRequest | null> {
    const result = await client.execute({
      sql: `SELECT * FROM approvals WHERE id = ?`,
      args: [id],
    });

    if (result.rows.length === 0) {
      return null;
    }

    return this.mapToRequest(result.rows[0]);
  }

  /**
   * Get the most recently submitted deferred approval for an agent.
   * Used as a fallback when the LLM calls get_result without a jobId.
   */
  async getLatestDeferred(agentId: string): Promise<ApprovalRequest | null> {
    const result = await client.execute({
      sql: `SELECT * FROM approvals WHERE agent_id = ?
            ORDER BY requested_at DESC LIMIT 1`,
      args: [agentId],
    });
    if (result.rows.length === 0) return null;
    return this.mapToRequest(result.rows[0]);
  }

  /**
   * List pending approvals
   */
  async listPending(agentId?: string): Promise<ApprovalRequest[]> {
    let sql = `SELECT * FROM approvals WHERE status = 'pending'`;
    const args: string[] = [];

    if (agentId) {
      sql += ` AND agent_id = ?`;
      args.push(agentId);
    }

    const result = await client.execute({ sql, args });
    return result.rows.map(this.mapToRequest);
  }

  /**
   * Approve a request
   */
  async approve(id: string, approver: string, comment?: string): Promise<boolean> {
    const now = new Date();

    const result = await client.execute({
      sql: `UPDATE approvals SET status = 'approved', resolved_at = ?, resolved_by = ?, resolution_comment = ?
            WHERE id = ? AND status = 'pending'`,
      args: [now.toISOString(), approver, comment ?? null, id],
    });

    if (result.rowsAffected > 0) {
      const request = await this.get(id);
      if (request) {
        this.emit('resolved', request);
        this.notifyWaiter(id, { approved: true, approver, comment });
        const waitTimeMs = now.getTime() - request.requestedAt.getTime();
        getPostHog()?.capture({ distinctId: request.agentId, event: 'approval_resolved', properties: { agentId: request.agentId, tool: request.tool, decision: 'approved', waitTimeMs } });
      }

      // Auto-execute deferred tool if an executor was registered
      const executor = this.pendingExecutors.get(id);
      if (executor) {
        this.pendingExecutors.delete(id);
        try {
          const execResult = await executor();
          await this.storeResult(id, execResult);
        } catch (err) {
          await this.storeResult(id, { error: String(err) });
          console.error(`[approvals] executor failed for ${id}:`, err);
        }
      }

      return true;
    }

    return false;
  }

  /**
   * Reject a request
   */
  async reject(id: string, approver: string, reason: string): Promise<boolean> {
    const now = new Date();

    const result = await client.execute({
      sql: `UPDATE approvals SET status = 'rejected', resolved_at = ?, resolved_by = ?, resolution_comment = ?
            WHERE id = ? AND status = 'pending'`,
      args: [now.toISOString(), approver, reason, id],
    });

    if (result.rowsAffected > 0) {
      const request = await this.get(id);
      if (request) {
        this.emit('resolved', request);
        this.notifyWaiter(id, { approved: false, approver, comment: reason });
        const waitTimeMs = now.getTime() - request.requestedAt.getTime();
        getPostHog()?.capture({ distinctId: request.agentId, event: 'approval_resolved', properties: { agentId: request.agentId, tool: request.tool, decision: 'rejected', waitTimeMs } });
      }
      // Clean up any registered executor — approval was rejected
      this.pendingExecutors.delete(id);
      return true;
    }

    return false;
  }

  /**
   * Send a request back to the agent with free-text feedback instead of
   * approving or denying it.
   *
   * This closes the approval — the held executor is discarded, exactly as with
   * reject(). The agent learns of the feedback by polling get_result,
   * revises the arguments, and issues a fresh tool call, which submit() links
   * back to this row as the next revision.
   */
  async requestChanges(id: string, requester: string, feedback: string): Promise<RequestChangesResult> {
    const now = new Date();

    const result = await client.execute({
      sql: `UPDATE approvals SET status = 'changes_requested', resolved_at = ?, resolved_by = ?, resolution_comment = ?
            WHERE id = ? AND status = 'pending' AND COALESCE(revision, 0) < ?`,
      args: [now.toISOString(), requester, feedback, id, MAX_REVISIONS],
    });

    if (result.rowsAffected === 0) {
      // Distinguish "someone already handled it" from "out of revisions" so the
      // caller can tell the user which it was.
      const current = await this.get(id);
      return current && current.status === 'pending' ? 'cap_reached' : 'not_pending';
    }

    const request = await this.get(id);
    if (request) {
      this.emit('resolved', request);
      this.notifyWaiter(id, { approved: false, approver: requester, comment: feedback });
      const waitTimeMs = now.getTime() - request.requestedAt.getTime();
      getPostHog()?.capture({
        distinctId: request.agentId,
        event: 'approval_resolved',
        properties: {
          agentId: request.agentId,
          tool: request.tool,
          decision: 'changes_requested',
          revision: request.revision,
          waitTimeMs,
        },
      });
    }

    // The captured executor is stale — the agent will resubmit with new arguments.
    this.pendingExecutors.delete(id);
    return 'ok';
  }

  /**
   * Wait for a decision on an approval request
   */
  async waitForDecision(id: string, timeoutMs: number): Promise<ApprovalDecision | null> {
    // Check if already resolved
    const request = await this.get(id);
    if (!request) {
      return null;
    }

    if (request.status === 'approved') {
      return {
        approved: true,
        approver: request.resolvedBy || 'unknown',
        comment: request.resolutionComment,
      };
    }

    // changes_requested is also "not approved" for the legacy blocking caller —
    // it has no way to resubmit, so the feedback is surfaced as the comment.
    if (request.status === 'rejected' || request.status === 'changes_requested') {
      return {
        approved: false,
        approver: request.resolvedBy || 'unknown',
        comment: request.resolutionComment,
      };
    }

    if (request.status === 'expired') {
      return null;
    }

    // Wait for decision
    return new Promise((resolve) => {
      const timeout = setTimeout(() => {
        this.pendingWaiters.delete(id);
        resolve(null);
      }, timeoutMs);

      this.pendingWaiters.set(id, { resolve, timeout });
    });
  }

  /**
   * Expire old pending requests
   */
  async expireOldRequests(): Promise<string[]> {
    const now = new Date().toISOString();

    const expiredResult = await client.execute({
      sql: `SELECT id FROM approvals WHERE status = 'pending' AND expires_at < ?`,
      args: [now],
    });

    const expiredIds = expiredResult.rows.map((r) => r.id as string);

    if (expiredIds.length > 0) {
      await client.execute({
        sql: `UPDATE approvals SET status = 'expired' WHERE status = 'pending' AND expires_at < ?`,
        args: [now],
      });

      // Clean up any registered executors for expired approvals and notify waiters
      for (const id of expiredIds) {
        this.pendingExecutors.delete(id);
        this.notifyWaiter(id, null);
      }

      this.emit('expired', expiredIds);
    }

    return expiredIds;
  }

  private notifyWaiter(id: string, decision: ApprovalDecision | null) {
    const waiter = this.pendingWaiters.get(id);
    if (waiter) {
      clearTimeout(waiter.timeout);
      waiter.resolve(decision);
      this.pendingWaiters.delete(id);
    } else {
      // No in-memory waiter. This is the expected path for deferred approvals
      // (agent returned immediately with a jobId and is polling via get_result).
      // It can also occur when the agent's HTTP connection timed out before the
      // user resolved a legacy blocking approval.
    }
  }

  /**
   * Submit a reauth approval — de-duplicates by agentId+provider and checks the
   * 24-hour email throttle.
   *
   * Returns:
   *   id             — existing or newly created approval ID
   *   isNew          — true if a new row was inserted
   *   emailThrottled — true if email was already sent within the last 24 hours
   */
  async submitReauth(
    agentId: string,
    provider: string,
    context: string,
    extraArgs: Record<string, unknown> = {},
    expiryMs: number = 7 * 24 * 60 * 60 * 1000,
  ): Promise<{ id: string; isNew: boolean; emailThrottled: boolean }> {
    // Dedup per agent + provider + credential. The credential matters: with two
    // Google accounts on one agent, "gmail is broken" collapsing into a single
    // pending row hides that a second account is broken too — and the row that
    // survives names the wrong account. Producers without a credentialId
    // (codex, minimax, provisioning) keep the per-provider dedup: null = null.
    const credentialKey = (extraArgs.credentialId as string | null | undefined) ?? null;
    const existing = await client.execute({
      sql: `SELECT id, email_last_sent_at FROM approvals
            WHERE status = 'pending' AND tool = 'reauth' AND agent_id = ?
              AND arguments_json::jsonb->>'provider' = ?
              AND arguments_json::jsonb->>'credentialId' IS NOT DISTINCT FROM ?
            LIMIT 1`,
      args: [agentId, provider, credentialKey],
    });

    if (existing.rows.length > 0) {
      const row = existing.rows[0] as { id: string; email_last_sent_at: string | null };
      const lastSent = row.email_last_sent_at ? new Date(row.email_last_sent_at).getTime() : 0;
      const emailThrottled = Date.now() - lastSent < 24 * 60 * 60 * 1000;
      return { id: row.id, isNew: false, emailThrottled };
    }

    // No existing — insert a new approval
    const id = await this.submit(
      agentId,
      'reauth',
      { provider, ...extraArgs },
      context,
      expiryMs,
    );

    return { id, isNew: true, emailThrottled: false };
  }

  /**
   * Record that a notification email was sent for an approval (for 24h throttle).
   */
  async markEmailSent(id: string): Promise<void> {
    await client.execute({
      sql: `UPDATE approvals SET email_last_sent_at = ? WHERE id = ?`,
      args: [new Date().toISOString(), id],
    });
  }

  /**
   * Store the result of an auto-executed tool call for later retrieval.
   */
  async storeResult(id: string, result: unknown): Promise<void> {
    await client.execute({
      sql: `UPDATE approvals SET result_json = ? WHERE id = ?`,
      args: [JSON.stringify(result), id],
    });
  }

  private mapToRequest(row: Record<string, unknown>): ApprovalRequest {
    return {
      id: row.id as string,
      agentId: row.agent_id as string,
      tool: row.tool as string,
      arguments: row.arguments_json ? JSON.parse(row.arguments_json as string) : {},
      context: row.context as string | undefined,
      status: row.status as ApprovalStatus,
      requestedAt: new Date(row.requested_at as string),
      expiresAt: new Date(row.expires_at as string),
      resolvedAt: row.resolved_at ? new Date(row.resolved_at as string) : undefined,
      resolvedBy: row.resolved_by as string | undefined,
      resolutionComment: row.resolution_comment as string | undefined,
      emailLastSentAt: row.email_last_sent_at ? new Date(row.email_last_sent_at as string) : undefined,
      telegramChatId: row.telegram_chat_id as string | undefined,
      telegramMessageId: row.telegram_message_id as string | undefined,
      telegramPromptMessageId: row.telegram_prompt_message_id as string | undefined,
      resultJson: row.result_json as string | undefined,
      parentApprovalId: row.parent_approval_id as string | undefined,
      revision: Number(row.revision ?? 0),
    };
  }
}

export const approvalQueue = new ApprovalQueue();

// Start expiry check interval
setInterval(() => {
  approvalQueue.expireOldRequests().catch(console.error);
}, 60 * 1000); // Check every minute
