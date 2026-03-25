/**
 * Audit Logger Tests
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../db/index.js', () => ({
  client: {
    execute: vi.fn().mockResolvedValue({ rows: [], rowsAffected: 0, lastInsertRowid: 42n }),
  },
}));

import { client } from '../db/index.js';
import { AuditLogger } from './logger.js';

describe('AuditLogger', () => {
  let logger: AuditLogger;

  beforeEach(() => {
    vi.clearAllMocks();
    logger = new AuditLogger();
  });

  describe('log', () => {
    it('should insert an audit entry and return the ID', async () => {
      vi.mocked(client.execute).mockResolvedValueOnce({
        rows: [], rowsAffected: 1, lastInsertRowid: 99n, columns: [],
      });

      const id = await logger.log({
        eventType: 'tool_call',
        agentId: 'agent-1',
        tool: 'gmail_send',
        arguments: { to: 'test@test.com' },
        result: 'success',
        durationMs: 150,
        metadata: { service: 'gmail' },
      });

      expect(id).toBe(99);
      const call = vi.mocked(client.execute).mock.calls[0][0] as { sql: string; args: unknown[] };
      expect(call.sql).toContain('INSERT INTO audit_log');
      expect(call.args[0]).toBe('tool_call');
      expect(call.args[1]).toBe('agent-1');
      expect(call.args[2]).toBe('gmail_send');
      expect(call.args[3]).toBe('{"to":"test@test.com"}');
      expect(call.args[4]).toBe('success');
      expect(call.args[5]).toBe(150);
    });

    it('should handle null optional fields', async () => {
      vi.mocked(client.execute).mockResolvedValueOnce({
        rows: [], rowsAffected: 1, lastInsertRowid: 1n, columns: [],
      });

      await logger.log({ eventType: 'connection' });

      const call = vi.mocked(client.execute).mock.calls[0][0] as { args: unknown[] };
      expect(call.args[1]).toBeNull(); // agentId
      expect(call.args[2]).toBeNull(); // tool
      expect(call.args[3]).toBeNull(); // arguments
      expect(call.args[4]).toBeNull(); // result
      expect(call.args[5]).toBeNull(); // durationMs
      expect(call.args[6]).toBeNull(); // metadata
    });
  });

  describe('logToolCall', () => {
    it('should log a tool call with all fields', async () => {
      vi.mocked(client.execute).mockResolvedValueOnce({
        rows: [], rowsAffected: 1, lastInsertRowid: 10n, columns: [],
      });

      const id = await logger.logToolCall(
        'agent-1', 'gmail_read', { messageId: '123' }, 'success', 200, { cached: true }
      );

      expect(id).toBe(10);
      const call = vi.mocked(client.execute).mock.calls[0][0] as { args: unknown[] };
      expect(call.args[0]).toBe('tool_call');
      expect(call.args[1]).toBe('agent-1');
      expect(call.args[2]).toBe('gmail_read');
    });
  });

  describe('logApproval', () => {
    it('should log approval with approver', async () => {
      vi.mocked(client.execute).mockResolvedValueOnce({
        rows: [], rowsAffected: 1, lastInsertRowid: 11n, columns: [],
      });

      await logger.logApproval('agent-1', 'send_message', 'success', 'admin');

      const call = vi.mocked(client.execute).mock.calls[0][0] as { args: unknown[] };
      expect(call.args[0]).toBe('approval');
      expect(call.args[6]).toContain('admin');
    });

    it('should log approval blocked without approver', async () => {
      vi.mocked(client.execute).mockResolvedValueOnce({
        rows: [], rowsAffected: 1, lastInsertRowid: 12n, columns: [],
      });

      await logger.logApproval('agent-1', 'delete_message', 'blocked');

      const call = vi.mocked(client.execute).mock.calls[0][0] as { args: unknown[] };
      expect(call.args[4]).toBe('blocked');
    });
  });

  describe('logPolicyChange', () => {
    it('should log policy changes', async () => {
      vi.mocked(client.execute).mockResolvedValueOnce({
        rows: [], rowsAffected: 1, lastInsertRowid: 13n, columns: [],
      });

      await logger.logPolicyChange('policy-1', 'updated', 'admin');

      const call = vi.mocked(client.execute).mock.calls[0][0] as { args: unknown[] };
      expect(call.args[0]).toBe('policy_change');
      expect(call.args[4]).toBe('success');
      const metadata = JSON.parse(call.args[6] as string);
      expect(metadata.policyId).toBe('policy-1');
      expect(metadata.action).toBe('updated');
      expect(metadata.changedBy).toBe('admin');
    });
  });

  describe('logAuth', () => {
    it('should log successful auth event', async () => {
      vi.mocked(client.execute).mockResolvedValueOnce({
        rows: [], rowsAffected: 1, lastInsertRowid: 14n, columns: [],
      });

      await logger.logAuth('agent-1', 'connected', { ip: '1.2.3.4' });

      const call = vi.mocked(client.execute).mock.calls[0][0] as { args: unknown[] };
      expect(call.args[0]).toBe('auth');
      expect(call.args[4]).toBe('success');
    });

    it('should log auth_failed with error result', async () => {
      vi.mocked(client.execute).mockResolvedValueOnce({
        rows: [], rowsAffected: 1, lastInsertRowid: 15n, columns: [],
      });

      await logger.logAuth('agent-1', 'auth_failed');

      const call = vi.mocked(client.execute).mock.calls[0][0] as { args: unknown[] };
      expect(call.args[4]).toBe('error');
    });
  });

  describe('logAgentEvent', () => {
    it('should log agent lifecycle events', async () => {
      vi.mocked(client.execute).mockResolvedValueOnce({
        rows: [], rowsAffected: 1, lastInsertRowid: 16n, columns: [],
      });

      await logger.logAgentEvent('agent-1', 'created', { source: 'dashboard' });

      const call = vi.mocked(client.execute).mock.calls[0][0] as { args: unknown[] };
      expect(call.args[0]).toBe('agent_event');
      const metadata = JSON.parse(call.args[6] as string);
      expect(metadata.action).toBe('created');
      expect(metadata.source).toBe('dashboard');
    });
  });

  describe('logConnection', () => {
    it('should log connection events with transport', async () => {
      vi.mocked(client.execute).mockResolvedValueOnce({
        rows: [], rowsAffected: 1, lastInsertRowid: 17n, columns: [],
      });

      await logger.logConnection('agent-1', 'connected', 'http');

      const call = vi.mocked(client.execute).mock.calls[0][0] as { args: unknown[] };
      expect(call.args[0]).toBe('connection');
      const metadata = JSON.parse(call.args[6] as string);
      expect(metadata.transport).toBe('http');
    });
  });

  describe('query', () => {
    it('should query with all filters', async () => {
      vi.mocked(client.execute).mockResolvedValueOnce({
        rows: [{
          id: 1, timestamp: '2024-06-15T12:00:00Z', event_type: 'tool_call',
          agent_id: 'agent-1', tool: 'gmail_read', arguments_json: '{}',
          result: 'success', duration_ms: 100, metadata_json: null,
        }],
        rowsAffected: 0, lastInsertRowid: 0n, columns: [],
      });

      const result = await logger.query({
        startDate: new Date('2024-06-01'),
        endDate: new Date('2024-06-30'),
        agentId: 'agent-1',
        eventType: 'tool_call',
        tool: 'gmail_read',
        result: 'success',
        limit: 10,
        offset: 5,
      });

      expect(result).toHaveLength(1);
      expect(result[0].id).toBe(1);
      expect(result[0].eventType).toBe('tool_call');

      const call = vi.mocked(client.execute).mock.calls[0][0] as { sql: string; args: unknown[] };
      expect(call.sql).toContain('timestamp >=');
      expect(call.sql).toContain('timestamp <=');
      expect(call.sql).toContain('agent_id =');
      expect(call.sql).toContain('event_type =');
      expect(call.sql).toContain('tool =');
      expect(call.sql).toContain('result =');
      expect(call.sql).toContain('LIMIT');
      expect(call.sql).toContain('OFFSET');
    });

    it('should default limit to 100 and offset to 0', async () => {
      vi.mocked(client.execute).mockResolvedValueOnce({
        rows: [], rowsAffected: 0, lastInsertRowid: 0n, columns: [],
      });

      await logger.query({});

      const call = vi.mocked(client.execute).mock.calls[0][0] as { args: unknown[] };
      expect(call.args).toContain(100);
      expect(call.args).toContain(0);
    });
  });

  describe('getRecent', () => {
    it('should fetch recent entries', async () => {
      vi.mocked(client.execute).mockResolvedValueOnce({
        rows: [
          { id: 2, timestamp: '2024-06-15T12:01:00Z', event_type: 'connection', agent_id: 'a', tool: null, arguments_json: null, result: 'success', duration_ms: null, metadata_json: null },
          { id: 1, timestamp: '2024-06-15T12:00:00Z', event_type: 'tool_call', agent_id: 'a', tool: 't', arguments_json: null, result: 'success', duration_ms: null, metadata_json: null },
        ],
        rowsAffected: 0, lastInsertRowid: 0n, columns: [],
      });

      const result = await logger.getRecent(2);
      expect(result).toHaveLength(2);

      const call = vi.mocked(client.execute).mock.calls[0][0] as { args: unknown[] };
      expect(call.args[0]).toBe(2);
    });

    it('should default limit to 50', async () => {
      vi.mocked(client.execute).mockResolvedValueOnce({
        rows: [], rowsAffected: 0, lastInsertRowid: 0n, columns: [],
      });

      await logger.getRecent();

      const call = vi.mocked(client.execute).mock.calls[0][0] as { args: unknown[] };
      expect(call.args[0]).toBe(50);
    });
  });

  describe('count', () => {
    it('should count entries matching filter', async () => {
      vi.mocked(client.execute).mockResolvedValueOnce({
        rows: [{ count: 42 }],
        rowsAffected: 0, lastInsertRowid: 0n, columns: [],
      });

      const result = await logger.count({ agentId: 'agent-1' });
      expect(result).toBe(42);
    });

    it('should count all entries with empty filter', async () => {
      vi.mocked(client.execute).mockResolvedValueOnce({
        rows: [{ count: 100 }],
        rowsAffected: 0, lastInsertRowid: 0n, columns: [],
      });

      const result = await logger.count({});
      expect(result).toBe(100);
    });
  });
});
