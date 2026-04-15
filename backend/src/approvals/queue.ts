import { client } from '../db/index.js';
import { nanoid } from 'nanoid';
import { EventEmitter } from 'events';
import type { ApprovalRequest, ApprovalStatus, ApprovalDecision } from '@reins/shared';

const DEFAULT_EXPIRY_MS = 60 * 60 * 1000; // 1 hour

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

    await client.execute({
      sql: `INSERT INTO approvals (id, agent_id, tool, arguments_json, context, status, requested_at, expires_at)
            VALUES (?, ?, ?, ?, ?, 'pending', ?, ?)`,
      args: [
        id,
        agentId,
        tool,
        JSON.stringify(args),
        context ?? null,
        now.toISOString(),
        expiresAt.toISOString(),
      ],
    });

    const request = await this.get(id);
    if (request) {
      this.emit('request', request);
    }

    return id;
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
      }
      return true;
    }

    return false;
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

    if (request.status === 'rejected') {
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

      // Notify waiters
      for (const id of expiredIds) {
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
    // Check for an existing pending reauth for this agent + provider
    const existing = await client.execute({
      sql: `SELECT id, email_last_sent_at FROM approvals
            WHERE status = 'pending' AND tool = 'reauth' AND agent_id = ?
              AND arguments_json::jsonb->>'provider' = ?
            LIMIT 1`,
      args: [agentId, provider],
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
    };
  }
}

export const approvalQueue = new ApprovalQueue();

// Start expiry check interval
setInterval(() => {
  approvalQueue.expireOldRequests().catch(console.error);
}, 60 * 1000); // Check every minute
