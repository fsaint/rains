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
import { ApprovalQueue, MAX_REVISIONS } from './queue.js';

const EMPTY = { rows: [], rowsAffected: 0, lastInsertRowid: 0n, columns: [] };

/**
 * submit() first looks for a changes_requested approval to link this one to as
 * a revision. Queue this "none found" answer ahead of a submit()'s own mocks.
 */
function mockNoRevisionParent() {
  vi.mocked(client.execute).mockResolvedValueOnce({ ...EMPTY });
}

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
      mockNoRevisionParent();
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
      // parent lookup, insert, get
      expect(client.execute).toHaveBeenCalledTimes(3);

      const insertCall = vi.mocked(client.execute).mock.calls[1][0];
      expect(typeof insertCall === 'object' && insertCall.sql).toContain('INSERT INTO approvals');
    });

    it('should set default expiry of 1 hour', async () => {
      mockNoRevisionParent();
      vi.mocked(client.execute)
        .mockResolvedValueOnce({ rows: [], rowsAffected: 1, lastInsertRowid: 0n, columns: [] })
        .mockResolvedValueOnce({ rows: [], rowsAffected: 0, lastInsertRowid: 0n, columns: [] });

      await queue.submit('agent-1', 'tool', {});

      const call = vi.mocked(client.execute).mock.calls[1][0] as { args: unknown[] };
      const expiresAt = new Date(call.args[6] as string);
      const now = new Date('2024-06-15T12:00:00Z');
      expect(expiresAt.getTime() - now.getTime()).toBe(60 * 60 * 1000);
    });

    it('should accept custom expiry', async () => {
      mockNoRevisionParent();
      vi.mocked(client.execute)
        .mockResolvedValueOnce({ rows: [], rowsAffected: 1, lastInsertRowid: 0n, columns: [] })
        .mockResolvedValueOnce({ rows: [], rowsAffected: 0, lastInsertRowid: 0n, columns: [] });

      await queue.submit('agent-1', 'tool', {}, undefined, 5 * 60 * 1000);

      const call = vi.mocked(client.execute).mock.calls[1][0] as { args: unknown[] };
      const expiresAt = new Date(call.args[6] as string);
      const now = new Date('2024-06-15T12:00:00Z');
      expect(expiresAt.getTime() - now.getTime()).toBe(5 * 60 * 1000);
    });

    it('should emit request event', async () => {
      const handler = vi.fn();
      queue.on('request', handler);

      mockNoRevisionParent();
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

  describe('requestChanges', () => {
    const changesRow = (overrides: Record<string, unknown> = {}) => ({
      id: 'ap-1', agent_id: 'agent-1', tool: 'gmail_send_message', arguments_json: '{}',
      context: null, status: 'changes_requested', requested_at: '2024-06-15T12:00:00Z',
      expires_at: '2024-06-15T13:00:00Z', resolved_at: '2024-06-15T12:05:00Z',
      resolved_by: 'telegram:42', resolution_comment: 'drop Bob, make it shorter',
      revision: 0, parent_approval_id: null, result_json: null,
      ...overrides,
    });

    it('sends a pending request back with the feedback as the resolution comment', async () => {
      vi.mocked(client.execute)
        .mockResolvedValueOnce({ rows: [], rowsAffected: 1, lastInsertRowid: 0n, columns: [] })
        .mockResolvedValueOnce({ rows: [changesRow()], rowsAffected: 0, lastInsertRowid: 0n, columns: [] });

      const result = await queue.requestChanges('ap-1', 'telegram:42', 'drop Bob, make it shorter');

      expect(result).toBe('ok');
      const update = vi.mocked(client.execute).mock.calls[0][0] as { sql: string; args: unknown[] };
      expect(update.sql).toContain("status = 'changes_requested'");
      expect(update.args).toContain('drop Bob, make it shorter');
    });

    it('emits resolved so the Telegram message gets edited in place', async () => {
      const handler = vi.fn();
      queue.on('resolved', handler);

      vi.mocked(client.execute)
        .mockResolvedValueOnce({ rows: [], rowsAffected: 1, lastInsertRowid: 0n, columns: [] })
        .mockResolvedValueOnce({ rows: [changesRow()], rowsAffected: 0, lastInsertRowid: 0n, columns: [] });

      await queue.requestChanges('ap-1', 'telegram:42', 'shorter');

      expect(handler).toHaveBeenCalledTimes(1);
      expect(handler.mock.calls[0][0].status).toBe('changes_requested');
    });

    it('discards the stale executor — the agent will resubmit with new arguments', async () => {
      mockNoRevisionParent();
      vi.mocked(client.execute)
        .mockResolvedValueOnce({ rows: [], rowsAffected: 1, lastInsertRowid: 0n, columns: [] })
        .mockResolvedValueOnce({ rows: [changesRow({ status: 'pending' })], rowsAffected: 0, lastInsertRowid: 0n, columns: [] })
        // requestChanges: update, then get
        .mockResolvedValueOnce({ rows: [], rowsAffected: 1, lastInsertRowid: 0n, columns: [] })
        .mockResolvedValueOnce({ rows: [changesRow()], rowsAffected: 0, lastInsertRowid: 0n, columns: [] })
        // approve attempt afterwards: update matches nothing
        .mockResolvedValueOnce({ rows: [], rowsAffected: 0, lastInsertRowid: 0n, columns: [] });

      const executorFn = vi.fn();
      await queue.submit('agent-1', 'gmail_send_message', {});
      queue.registerExecutor('test-approval-id', executorFn);
      await queue.requestChanges('test-approval-id', 'telegram:42', 'shorter');
      await queue.approve('test-approval-id', 'telegram:42');

      expect(executorFn).not.toHaveBeenCalled();
    });

    it('reports not_pending when someone already approved or denied it', async () => {
      vi.mocked(client.execute)
        .mockResolvedValueOnce({ rows: [], rowsAffected: 0, lastInsertRowid: 0n, columns: [] })
        .mockResolvedValueOnce({ rows: [changesRow({ status: 'approved' })], rowsAffected: 0, lastInsertRowid: 0n, columns: [] });

      expect(await queue.requestChanges('ap-1', 'telegram:42', 'shorter')).toBe('not_pending');
    });

    it('reports cap_reached when the request is still pending at the revision cap', async () => {
      vi.mocked(client.execute)
        // the guarded UPDATE matches nothing because revision >= MAX_REVISIONS
        .mockResolvedValueOnce({ rows: [], rowsAffected: 0, lastInsertRowid: 0n, columns: [] })
        .mockResolvedValueOnce({
          rows: [changesRow({ status: 'pending', revision: MAX_REVISIONS })],
          rowsAffected: 0, lastInsertRowid: 0n, columns: [],
        });

      expect(await queue.requestChanges('ap-1', 'telegram:42', 'shorter')).toBe('cap_reached');
    });

    it('caps at MAX_REVISIONS in the UPDATE itself, not just in the UI', async () => {
      vi.mocked(client.execute)
        .mockResolvedValueOnce({ rows: [], rowsAffected: 1, lastInsertRowid: 0n, columns: [] })
        .mockResolvedValueOnce({ rows: [changesRow()], rowsAffected: 0, lastInsertRowid: 0n, columns: [] });

      await queue.requestChanges('ap-1', 'telegram:42', 'shorter');

      const update = vi.mocked(client.execute).mock.calls[0][0] as { sql: string; args: unknown[] };
      expect(update.sql).toContain('revision');
      expect(update.args).toContain(MAX_REVISIONS);
    });
  });

  describe('revision chain linking', () => {
    it('links a resubmitted call to the request that was sent back', async () => {
      vi.mocked(client.execute)
        // parent lookup finds an unclaimed changes_requested row at revision 1
        .mockResolvedValueOnce({
          rows: [{ id: 'parent-ap', revision: 1 }],
          rowsAffected: 0, lastInsertRowid: 0n, columns: [],
        })
        .mockResolvedValueOnce({ rows: [], rowsAffected: 1, lastInsertRowid: 0n, columns: [] })
        .mockResolvedValueOnce({ ...EMPTY });

      await queue.submit('agent-1', 'gmail_send_message', { to: 'alice' });

      const insert = vi.mocked(client.execute).mock.calls[1][0] as { sql: string; args: unknown[] };
      expect(insert.sql).toContain('parent_approval_id');
      expect(insert.args).toContain('parent-ap');
      expect(insert.args).toContain(2); // parent revision 1 + 1
    });

    it('starts at revision 0 when nothing was sent back', async () => {
      mockNoRevisionParent();
      vi.mocked(client.execute)
        .mockResolvedValueOnce({ rows: [], rowsAffected: 1, lastInsertRowid: 0n, columns: [] })
        .mockResolvedValueOnce({ ...EMPTY });

      await queue.submit('agent-1', 'gmail_send_message', { to: 'alice' });

      const insert = vi.mocked(client.execute).mock.calls[1][0] as { sql: string; args: unknown[] };
      expect(insert.args[insert.args.length - 2]).toBeNull(); // parent_approval_id
      expect(insert.args[insert.args.length - 1]).toBe(0);    // revision
    });

    it('only considers parents inside the link window and not already claimed', async () => {
      mockNoRevisionParent();
      vi.mocked(client.execute)
        .mockResolvedValueOnce({ rows: [], rowsAffected: 1, lastInsertRowid: 0n, columns: [] })
        .mockResolvedValueOnce({ ...EMPTY });

      await queue.submit('agent-1', 'gmail_send_message', {});

      const lookup = vi.mocked(client.execute).mock.calls[0][0] as { sql: string; args: unknown[] };
      expect(lookup.sql).toContain("status = 'changes_requested'");
      expect(lookup.sql).toContain('resolved_at >');
      expect(lookup.sql).toContain('parent_approval_id IS NOT NULL');
      // 15-minute window measured back from the frozen clock
      expect(lookup.args).toContain(new Date('2024-06-15T11:45:00.000Z').toISOString());
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

  describe('storeResult', () => {
    it('storeResult should update result_json in DB', async () => {
      vi.mocked(client.execute).mockResolvedValueOnce({
        rows: [], rowsAffected: 1, lastInsertRowid: 0n, columns: [],
      });
      await queue.storeResult('test-approval-id', { message: 'done' });
      expect(vi.mocked(client.execute)).toHaveBeenCalledWith(
        expect.objectContaining({
          sql: expect.stringContaining('result_json'),
        })
      );
    });
  });

  describe('registerExecutor + auto-execution on approve', () => {
    it('runs the executor when approve() is called and stores result', async () => {
      // Mock: submit insert, get (after submit), then update for approve, then get (after approve), then storeResult update
      const mockApprovalRow = {
        id: 'test-approval-id',
        agent_id: 'agent-1',
        tool: 'gmail_send_email',
        arguments_json: '{}',
        context: null,
        status: 'pending',
        requested_at: '2024-06-15T12:00:00.000Z',
        expires_at: '2024-06-15T13:00:00.000Z',
        resolved_at: null,
        resolved_by: null,
        resolution_comment: null,
        email_last_sent_at: null,
        telegram_chat_id: null,
        telegram_message_id: null,
        result_json: null,
      };
      // submit: parent lookup
      mockNoRevisionParent();
      // submit: insert
      vi.mocked(client.execute)
        .mockResolvedValueOnce({ rows: [], rowsAffected: 1, lastInsertRowid: 0n, columns: [] })
        // submit: get
        .mockResolvedValueOnce({ rows: [mockApprovalRow], rowsAffected: 0, lastInsertRowid: 0n, columns: [] })
        // approve: update
        .mockResolvedValueOnce({ rows: [], rowsAffected: 1, lastInsertRowid: 0n, columns: [] })
        // approve: get (after update)
        .mockResolvedValueOnce({ rows: [{ ...mockApprovalRow, status: 'approved', resolved_by: 'alice@example.com' }], rowsAffected: 0, lastInsertRowid: 0n, columns: [] })
        // storeResult: update
        .mockResolvedValueOnce({ rows: [], rowsAffected: 1, lastInsertRowid: 0n, columns: [] });

      const executorFn = vi.fn().mockResolvedValue({ message: 'email sent' });
      await queue.submit('agent-1', 'gmail_send_email', {}, 'context');
      queue.registerExecutor('test-approval-id', executorFn);
      await queue.approve('test-approval-id', 'alice@example.com', 'looks good');

      expect(executorFn).toHaveBeenCalledOnce();
      // storeResult should have been called with the executor's result
      const calls = vi.mocked(client.execute).mock.calls;
      const storeCall = calls.find(([arg]) =>
        typeof arg === 'object' && 'sql' in arg && (arg as any).sql.includes('result_json')
      );
      expect(storeCall).toBeDefined();
      expect((storeCall![0] as any).args[0]).toBe(JSON.stringify({ message: 'email sent' }));
    });

    it('does not fail approve() if no executor is registered', async () => {
      const mockApprovalRow = {
        id: 'test-approval-id',
        agent_id: 'agent-1',
        tool: 'gmail_send_email',
        arguments_json: '{}',
        context: null,
        status: 'pending',
        requested_at: '2024-06-15T12:00:00.000Z',
        expires_at: '2024-06-15T13:00:00.000Z',
        resolved_at: null,
        resolved_by: null,
        resolution_comment: null,
        email_last_sent_at: null,
        telegram_chat_id: null,
        telegram_message_id: null,
        result_json: null,
      };
      vi.mocked(client.execute)
        .mockResolvedValueOnce({ rows: [], rowsAffected: 1, lastInsertRowid: 0n, columns: [] })
        .mockResolvedValueOnce({ rows: [mockApprovalRow], rowsAffected: 0, lastInsertRowid: 0n, columns: [] })
        .mockResolvedValueOnce({ rows: [], rowsAffected: 1, lastInsertRowid: 0n, columns: [] })
        .mockResolvedValueOnce({ rows: [{ ...mockApprovalRow, status: 'approved' }], rowsAffected: 0, lastInsertRowid: 0n, columns: [] });
      // No registerExecutor call
      await expect(queue.approve('test-approval-id', 'alice@example.com')).resolves.not.toThrow();
    });

    it('cleans up executor when approval is rejected', async () => {
      const mockApprovalRow = {
        id: 'test-approval-id',
        agent_id: 'agent-1',
        tool: 'gmail_send_email',
        arguments_json: '{}',
        context: null,
        status: 'pending',
        requested_at: '2024-06-15T12:00:00.000Z',
        expires_at: '2024-06-15T13:00:00.000Z',
        resolved_at: null,
        resolved_by: null,
        resolution_comment: null,
        email_last_sent_at: null,
        telegram_chat_id: null,
        telegram_message_id: null,
        result_json: null,
      };
      mockNoRevisionParent();
      vi.mocked(client.execute)
        .mockResolvedValueOnce({ rows: [], rowsAffected: 1, lastInsertRowid: 0n, columns: [] })
        .mockResolvedValueOnce({ rows: [mockApprovalRow], rowsAffected: 0, lastInsertRowid: 0n, columns: [] })
        .mockResolvedValueOnce({ rows: [], rowsAffected: 1, lastInsertRowid: 0n, columns: [] })
        .mockResolvedValueOnce({ rows: [{ ...mockApprovalRow, status: 'rejected' }], rowsAffected: 0, lastInsertRowid: 0n, columns: [] });

      const executorFn = vi.fn().mockResolvedValue({ message: 'should not run' });
      await queue.submit('agent-1', 'gmail_send_email', {}, 'context');
      queue.registerExecutor('test-approval-id', executorFn);
      await queue.reject('test-approval-id', 'alice@example.com', 'Not allowed');

      expect(executorFn).not.toHaveBeenCalled();
    });
  });
});
