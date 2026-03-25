import { client } from '../db/index.js';
import type { AuditEntry, AuditEventType, AuditResult, AuditFilter } from '@reins/shared';

export class AuditLogger {
  /**
   * Log an audit entry
   */
  async log(entry: Omit<AuditEntry, 'id' | 'timestamp'>): Promise<number> {
    const result = await client.execute({
      sql: `INSERT INTO audit_log (event_type, agent_id, tool, arguments_json, result, duration_ms, metadata_json)
            VALUES (?, ?, ?, ?, ?, ?, ?)`,
      args: [
        entry.eventType,
        entry.agentId ?? null,
        entry.tool ?? null,
        entry.arguments ? JSON.stringify(entry.arguments) : null,
        entry.result ?? null,
        entry.durationMs ?? null,
        entry.metadata ? JSON.stringify(entry.metadata) : null,
      ],
    });

    return Number(result.lastInsertRowid);
  }

  /**
   * Log a tool call
   */
  async logToolCall(
    agentId: string,
    tool: string,
    args: Record<string, unknown>,
    result: AuditResult,
    durationMs?: number,
    metadata?: Record<string, unknown>
  ): Promise<number> {
    return this.log({
      eventType: 'tool_call',
      agentId,
      tool,
      arguments: args,
      result,
      durationMs,
      metadata,
    });
  }

  /**
   * Log an approval event
   */
  async logApproval(
    agentId: string,
    tool: string,
    result: 'success' | 'blocked',
    approver?: string
  ): Promise<number> {
    return this.log({
      eventType: 'approval',
      agentId,
      tool,
      result,
      metadata: approver ? { approver } : undefined,
    });
  }

  /**
   * Log a policy change
   */
  async logPolicyChange(
    policyId: string,
    action: 'created' | 'updated' | 'deleted',
    changedBy?: string
  ): Promise<number> {
    return this.log({
      eventType: 'policy_change',
      result: 'success',
      metadata: { policyId, action, changedBy },
    });
  }

  /**
   * Log an auth event
   */
  async logAuth(
    agentId: string,
    action: 'connected' | 'disconnected' | 'auth_failed',
    metadata?: Record<string, unknown>
  ): Promise<number> {
    return this.log({
      eventType: 'auth',
      agentId,
      result: action === 'auth_failed' ? 'error' : 'success',
      metadata: { action, ...metadata },
    });
  }

  /**
   * Log an agent lifecycle event (created, claimed, deleted, etc.)
   */
  async logAgentEvent(
    agentId: string,
    action: 'created' | 'registered' | 'claimed' | 'deleted' | 'activated' | 'deactivated',
    metadata?: Record<string, unknown>
  ): Promise<number> {
    return this.log({
      eventType: 'agent_event',
      agentId,
      result: 'success',
      metadata: { action, ...metadata },
    });
  }

  /**
   * Log a connection event
   */
  async logConnection(
    agentId: string,
    action: 'connected' | 'disconnected',
    transport: string
  ): Promise<number> {
    return this.log({
      eventType: 'connection',
      agentId,
      result: 'success',
      metadata: { action, transport },
    });
  }

  /**
   * Query audit logs
   */
  async query(filter: AuditFilter): Promise<AuditEntry[]> {
    let sql = `SELECT * FROM audit_log WHERE 1=1`;
    const args: (string | number)[] = [];

    if (filter.startDate) {
      sql += ` AND timestamp >= ?`;
      args.push(filter.startDate.toISOString());
    }

    if (filter.endDate) {
      sql += ` AND timestamp <= ?`;
      args.push(filter.endDate.toISOString());
    }

    if (filter.agentId) {
      sql += ` AND agent_id = ?`;
      args.push(filter.agentId);
    }

    if (filter.eventType) {
      sql += ` AND event_type = ?`;
      args.push(filter.eventType);
    }

    if (filter.tool) {
      sql += ` AND tool = ?`;
      args.push(filter.tool);
    }

    if (filter.result) {
      sql += ` AND result = ?`;
      args.push(filter.result);
    }

    sql += ` ORDER BY timestamp DESC`;

    const limit = filter.limit ?? 100;
    const offset = filter.offset ?? 0;

    sql += ` LIMIT ? OFFSET ?`;
    args.push(limit, offset);

    const result = await client.execute({ sql, args });
    return result.rows.map(this.mapToEntry);
  }

  /**
   * Get recent entries
   */
  async getRecent(limit: number = 50): Promise<AuditEntry[]> {
    const result = await client.execute({
      sql: `SELECT * FROM audit_log ORDER BY timestamp DESC LIMIT ?`,
      args: [limit],
    });

    return result.rows.map(this.mapToEntry);
  }

  /**
   * Count entries matching filter
   */
  async count(filter: AuditFilter): Promise<number> {
    let sql = `SELECT COUNT(*) as count FROM audit_log WHERE 1=1`;
    const args: (string | number)[] = [];

    if (filter.startDate) {
      sql += ` AND timestamp >= ?`;
      args.push(filter.startDate.toISOString());
    }

    if (filter.endDate) {
      sql += ` AND timestamp <= ?`;
      args.push(filter.endDate.toISOString());
    }

    if (filter.agentId) {
      sql += ` AND agent_id = ?`;
      args.push(filter.agentId);
    }

    if (filter.eventType) {
      sql += ` AND event_type = ?`;
      args.push(filter.eventType);
    }

    if (filter.tool) {
      sql += ` AND tool = ?`;
      args.push(filter.tool);
    }

    if (filter.result) {
      sql += ` AND result = ?`;
      args.push(filter.result);
    }

    const result = await client.execute({ sql, args });
    return Number(result.rows[0].count);
  }

  private mapToEntry(row: Record<string, unknown>): AuditEntry {
    return {
      id: Number(row.id),
      timestamp: new Date(row.timestamp as string),
      eventType: row.event_type as AuditEventType,
      agentId: row.agent_id as string | undefined,
      tool: row.tool as string | undefined,
      arguments: row.arguments_json ? JSON.parse(row.arguments_json as string) : undefined,
      result: row.result as AuditResult | undefined,
      durationMs: row.duration_ms as number | undefined,
      metadata: row.metadata_json ? JSON.parse(row.metadata_json as string) : undefined,
    };
  }
}

export const auditLogger = new AuditLogger();
