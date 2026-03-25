/**
 * Approval Queue Tests
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

vi.mock('../db/index.js', () => ({
  client: {
    execute: vi.fn().mockResolvedValue({ rows: [], rowsAffected: 0, lastInsertRowid: 0n }),
  },
}));

vi.mock('nanoid', () => ({
  nanoid: vi.fn(() => 'test-approval-id'),
}));

import { client } from '../db/index.js';
import { ApprovalQueue } from './queue.js';

describe('ApprovalQueue', () => {
  let queue: ApprovalQueue;

  beforeEach(() => {
    vi.clearAllMocks();
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2024-06-15T12:00:00Z'));
    queue = new ApprovalQueue();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  describe('submit', () => {
    it('should create an approval request and return its ID', async () => {
      // Mock the insert, then the get
      vi.mocked(client.execute)
        .mockResolvedValueOnce({ rows: [], rowsAffected: 1, lastInsertRowid: 0n, columns: [] })
        .mockResolvedValueOnce({
          rows: [{
            id: 'test-approval-id',
            agent_id: 'agent-1',
            tool: 'send_message',
            arguments_json: '{"to":"alice"}',
            context: null,
            status: 'pending',
            requested_at: '2024-06-15T12:00:00.000Z',
            expires_at: '2024-06-15T13:00:00.000Z',
            resolved_at: null,
            resolved_by: null,
            resolution_comment: null,
          }],
          rowsAffected: 0,
          lastInsertRowid: 0n,
          columns: [],
        });

      const id = await queue.submit('agent-1', 'send_message', { to: 'alice' });

      expect(id).toBe('test-approval-id');
      expect(client.execute).toHaveBeenCalledTimes(2);

      const insertCall = vi.mocked(client.execute).mock.calls[0][0];
      expect(typeof insertCall === 'object' && insertCall.sql).toContain('INSERT INTO approvals');
    });

    it('should set default expiry of 1 hour', async () => {
      vi.mocked(client.execute)
        .mockResolvedValueOnce({ rows: [], rowsAffected: 1, lastInsertRowid: 0n, columns: [] })
        .mockResolvedValueOnce({ rows: [], rowsAffected: 0, lastInsertRowid: 0n, columns: [] });

      await queue.submit('agent-1', 'tool', {});

      const call = vi.mocked(client.execute).mock.calls[0][0] as { args: unknown[] };
      const expiresAt = new Date(call.args[6] as string);
      const now = new Date('2024-06-15T12:00:00Z');
      expect(expiresAt.getTime() - now.getTime()).toBe(60 * 60 * 1000);
    });

    it('should accept custom expiry', async () => {
      vi.mocked(client.execute)
        .mockResolvedValueOnce({ rows: [], rowsAffected: 1, lastInsertRowid: 0n, columns: [] })
        .mockResolvedValueOnce({ rows: [], rowsAffected: 0, lastInsertRowid: 0n, columns: [] });

      await queue.submit('agent-1', 'tool', {}, undefined, 5 * 60 * 1000);

      const call = vi.mocked(client.execute).mock.calls[0][0] as { args: unknown[] };
      const expiresAt = new Date(call.args[6] as string);
      const now = new Date('2024-06-15T12:00:00Z');
      expect(expiresAt.getTime() - now.getTime()).toBe(5 * 60 * 1000);
    });

    it('should emit request event', async () => {
      const handler = vi.fn();
      queue.on('request', handler);

      vi.mocked(client.execute)
        .mockResolvedValueOnce({ rows: [], rowsAffected: 1, lastInsertRowid: 0n, columns: [] })
        .mockResolvedValueOnce({
          rows: [{
            id: 'test-approval-id', agent_id: 'agent-1', tool: 'send_message',
            arguments_json: '{}', context: null, status: 'pending',
            requested_at: '2024-06-15T12:00:00Z', expires_at: '2024-06-15T13:00:00Z',
            resolved_at: null, resolved_by: null, resolution_comment: null,
          }],
          rowsAffected: 0, lastInsertRowid: 0n, columns: [],
        });

      await queue.submit('agent-1', 'send_message', {});

      expect(handler).toHaveBeenCalledTimes(1);
      expect(handler.mock.calls[0][0].id).toBe('test-approval-id');
    });
  });

  describe('get', () => {
    it('should return approval request by ID', async () => {
      vi.mocked(client.execute).mockResolvedValueOnce({
        rows: [{
          id: 'ap-1', agent_id: 'agent-1', tool: 'send_message',
          arguments_json: '{"to":"bob"}', context: 'test context', status: 'pending',
          requested_at: '2024-06-15T12:00:00Z', expires_at: '2024-06-15T13:00:00Z',
          resolved_at: null, resolved_by: null, resolution_comment: null,
        }],
        rowsAffected: 0, lastInsertRowid: 0n, columns: [],
      });

      const result = await queue.get('ap-1');

      expect(result).not.toBeNull();
      expect(result!.id).toBe('ap-1');
      expect(result!.agentId).toBe('agent-1');
      expect(result!.tool).toBe('send_message');
      expect(result!.arguments).toEqual({ to: 'bob' });
      expect(result!.context).toBe('test context');
      expect(result!.status).toBe('pending');
    });

    it('should return null for non-existent ID', async () => {
      vi.mocked(client.execute).mockResolvedValueOnce({
        rows: [], rowsAffected: 0, lastInsertRowid: 0n, columns: [],
      });

      const result = await queue.get('non-existent');
      expect(result).toBeNull();
    });
  });

  describe('listPending', () => {
    it('should list all pending approvals', async () => {
      vi.mocked(client.execute).mockResolvedValueOnce({
        rows: [
          { id: 'ap-1', agent_id: 'agent-1', tool: 'tool1', arguments_json: '{}', context: null, status: 'pending', requested_at: '2024-06-15T12:00:00Z', expires_at: '2024-06-15T13:00:00Z', resolved_at: null, resolved_by: null, resolution_comment: null },
          { id: 'ap-2', agent_id: 'agent-2', tool: 'tool2', arguments_json: '{}', context: null, status: 'pending', requested_at: '2024-06-15T12:00:00Z', expires_at: '2024-06-15T13:00:00Z', resolved_at: null, resolved_by: null, resolution_comment: null },
        ],
        rowsAffected: 0, lastInsertRowid: 0n, columns: [],
      });

      const result = await queue.listPending();
      expect(result).toHaveLength(2);
    });

    it('should filter by agentId', async () => {
      vi.mocked(client.execute).mockResolvedValueOnce({
        rows: [], rowsAffected: 0, lastInsertRowid: 0n, columns: [],
      });

      await queue.listPending('agent-1');

      const call = vi.mocked(client.execute).mock.calls[0][0] as { sql: string; args: unknown[] };
      expect(call.sql).toContain('agent_id = ');
      expect(call.args).toContain('agent-1');
    });
  });

  describe('approve', () => {
    it('should approve a pending request', async () => {
      vi.mocked(client.execute)
        .mockResolvedValueOnce({ rows: [], rowsAffected: 1, lastInsertRowid: 0n, columns: [] }) // update
        .mockResolvedValueOnce({
          rows: [{
            id: 'ap-1', agent_id: 'agent-1', tool: 'send', arguments_json: '{}',
            context: null, status: 'approved', requested_at: '2024-06-15T12:00:00Z',
            expires_at: '2024-06-15T13:00:00Z', resolved_at: '2024-06-15T12:05:00Z',
            resolved_by: 'admin', resolution_comment: 'looks good',
          }],
          rowsAffected: 0, lastInsertRowid: 0n, columns: [],
        });

      const result = await queue.approve('ap-1', 'admin', 'looks good');
      expect(result).toBe(true);
    });

    it('should return false if request not found or already resolved', async () => {
      vi.mocked(client.execute).mockResolvedValueOnce({
        rows: [], rowsAffected: 0, lastInsertRowid: 0n, columns: [],
      });

      const result = await queue.approve('non-existent', 'admin');
      expect(result).toBe(false);
    });

    it('should emit resolved event on approval', async () => {
      const handler = vi.fn();
      queue.on('resolved', handler);

      vi.mocked(client.execute)
        .mockResolvedValueOnce({ rows: [], rowsAffected: 1, lastInsertRowid: 0n, columns: [] })
        .mockResolvedValueOnce({
          rows: [{
            id: 'ap-1', agent_id: 'agent-1', tool: 'send', arguments_json: '{}',
            context: null, status: 'approved', requested_at: '2024-06-15T12:00:00Z',
            expires_at: '2024-06-15T13:00:00Z', resolved_at: '2024-06-15T12:05:00Z',
            resolved_by: 'admin', resolution_comment: null,
          }],
          rowsAffected: 0, lastInsertRowid: 0n, columns: [],
        });

      await queue.approve('ap-1', 'admin');
      expect(handler).toHaveBeenCalledTimes(1);
    });
  });

  describe('reject', () => {
    it('should reject a pending request', async () => {
      vi.mocked(client.execute)
        .mockResolvedValueOnce({ rows: [], rowsAffected: 1, lastInsertRowid: 0n, columns: [] })
        .mockResolvedValueOnce({
          rows: [{
            id: 'ap-1', agent_id: 'agent-1', tool: 'send', arguments_json: '{}',
            context: null, status: 'rejected', requested_at: '2024-06-15T12:00:00Z',
            expires_at: '2024-06-15T13:00:00Z', resolved_at: '2024-06-15T12:05:00Z',
            resolved_by: 'admin', resolution_comment: 'not allowed',
          }],
          rowsAffected: 0, lastInsertRowid: 0n, columns: [],
        });

      const result = await queue.reject('ap-1', 'admin', 'not allowed');
      expect(result).toBe(true);
    });

    it('should return false for non-existent request', async () => {
      vi.mocked(client.execute).mockResolvedValueOnce({
        rows: [], rowsAffected: 0, lastInsertRowid: 0n, columns: [],
      });

      const result = await queue.reject('gone', 'admin', 'reason');
      expect(result).toBe(false);
    });
  });

  describe('waitForDecision', () => {
    it('should return immediately if already approved', async () => {
      vi.mocked(client.execute).mockResolvedValueOnce({
        rows: [{
          id: 'ap-1', agent_id: 'a', tool: 't', arguments_json: '{}', context: null,
          status: 'approved', requested_at: '2024-06-15T12:00:00Z',
          expires_at: '2024-06-15T13:00:00Z', resolved_at: '2024-06-15T12:05:00Z',
          resolved_by: 'admin', resolution_comment: 'ok',
        }],
        rowsAffected: 0, lastInsertRowid: 0n, columns: [],
      });

      const decision = await queue.waitForDecision('ap-1', 5000);
      expect(decision).not.toBeNull();
      expect(decision!.approved).toBe(true);
      expect(decision!.approver).toBe('admin');
    });

    it('should return immediately if already rejected', async () => {
      vi.mocked(client.execute).mockResolvedValueOnce({
        rows: [{
          id: 'ap-1', agent_id: 'a', tool: 't', arguments_json: '{}', context: null,
          status: 'rejected', requested_at: '2024-06-15T12:00:00Z',
          expires_at: '2024-06-15T13:00:00Z', resolved_at: '2024-06-15T12:05:00Z',
          resolved_by: 'admin', resolution_comment: 'nope',
        }],
        rowsAffected: 0, lastInsertRowid: 0n, columns: [],
      });

      const decision = await queue.waitForDecision('ap-1', 5000);
      expect(decision).not.toBeNull();
      expect(decision!.approved).toBe(false);
    });

    it('should return null if already expired', async () => {
      vi.mocked(client.execute).mockResolvedValueOnce({
        rows: [{
          id: 'ap-1', agent_id: 'a', tool: 't', arguments_json: '{}', context: null,
          status: 'expired', requested_at: '2024-06-15T12:00:00Z',
          expires_at: '2024-06-15T13:00:00Z', resolved_at: null,
          resolved_by: null, resolution_comment: null,
        }],
        rowsAffected: 0, lastInsertRowid: 0n, columns: [],
      });

      const decision = await queue.waitForDecision('ap-1', 5000);
      expect(decision).toBeNull();
    });

    it('should return null if request not found', async () => {
      vi.mocked(client.execute).mockResolvedValueOnce({
        rows: [], rowsAffected: 0, lastInsertRowid: 0n, columns: [],
      });

      const decision = await queue.waitForDecision('missing', 5000);
      expect(decision).toBeNull();
    });

    it('should timeout and return null if no decision within timeout', async () => {
      vi.mocked(client.execute).mockResolvedValueOnce({
        rows: [{
          id: 'ap-1', agent_id: 'a', tool: 't', arguments_json: '{}', context: null,
          status: 'pending', requested_at: '2024-06-15T12:00:00Z',
          expires_at: '2024-06-15T13:00:00Z', resolved_at: null,
          resolved_by: null, resolution_comment: null,
        }],
        rowsAffected: 0, lastInsertRowid: 0n, columns: [],
      });

      const promise = queue.waitForDecision('ap-1', 3000);
      // Advance past the timeout; also need to handle the module-level setInterval
      await vi.advanceTimersByTimeAsync(3500);

      const decision = await promise;
      expect(decision).toBeNull();
    });
  });

  describe('expireOldRequests', () => {
    it('should expire old pending requests', async () => {
      vi.mocked(client.execute)
        .mockResolvedValueOnce({
          rows: [{ id: 'ap-1' }, { id: 'ap-2' }],
          rowsAffected: 0, lastInsertRowid: 0n, columns: [],
        })
        .mockResolvedValueOnce({
          rows: [], rowsAffected: 2, lastInsertRowid: 0n, columns: [],
        });

      const expired = await queue.expireOldRequests();
      expect(expired).toEqual(['ap-1', 'ap-2']);
    });

    it('should emit expired event', async () => {
      const handler = vi.fn();
      queue.on('expired', handler);

      vi.mocked(client.execute)
        .mockResolvedValueOnce({
          rows: [{ id: 'ap-1' }],
          rowsAffected: 0, lastInsertRowid: 0n, columns: [],
        })
        .mockResolvedValueOnce({
          rows: [], rowsAffected: 1, lastInsertRowid: 0n, columns: [],
        });

      await queue.expireOldRequests();
      expect(handler).toHaveBeenCalledWith(['ap-1']);
    });

    it('should return empty array when nothing expired', async () => {
      vi.mocked(client.execute).mockResolvedValueOnce({
        rows: [], rowsAffected: 0, lastInsertRowid: 0n, columns: [],
      });

      const expired = await queue.expireOldRequests();
      expect(expired).toEqual([]);
    });
  });
});
