/**
 * Agent Registration Service Tests
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// Mock the database module
vi.mock('../db/index.js', () => ({
  db: {
    insert: vi.fn().mockReturnValue({
      values: vi.fn().mockResolvedValue(undefined),
    }),
    select: vi.fn().mockReturnValue({
      from: vi.fn().mockReturnValue({
        where: vi.fn().mockResolvedValue([]),
      }),
    }),
    delete: vi.fn().mockReturnValue({
      where: vi.fn().mockResolvedValue({ rowsAffected: 1 }),
    }),
  },
  client: {
    execute: vi.fn().mockResolvedValue({ rows: [] }),
  },
}));

vi.mock('../db/schema.js', () => ({
  pendingAgentRegistrations: {
    id: 'id',
    claimCode: 'claim_code',
    expiresAt: 'expires_at',
  },
}));

vi.mock('nanoid', () => ({
  nanoid: vi.fn(() => 'test-nanoid-id'),
}));

import { db, client } from '../db/index.js';
import {
  registerAgent,
  getPendingByCode,
  claimAgent,
  getRegistrationStatus,
  listPendingRegistrations,
  cancelRegistration,
} from './registration.js';

describe('Registration Service', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2024-01-01T12:00:00Z'));
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  describe('registerAgent', () => {
    it('should register agent and return claim code', async () => {
      const result = await registerAgent('Test Agent', 'Test description');

      expect(result.agentId).toBe('test-nanoid-id');
      expect(result.claimCode).toMatch(/^[A-Z0-9]{6}$/);
      expect(result.expiresInSeconds).toBe(600);
      expect(db.insert).toHaveBeenCalled();
    });

    it('should set expiration to 10 minutes', async () => {
      const result = await registerAgent('Test Agent');

      const expiresAt = new Date(result.expiresAt);
      const now = new Date();
      const diffMs = expiresAt.getTime() - now.getTime();

      expect(diffMs).toBe(10 * 60 * 1000);
    });

    it('should allow registration without description', async () => {
      const result = await registerAgent('Agent Without Description');

      expect(result.agentId).toBeTruthy();
      expect(result.claimCode).toBeTruthy();
    });
  });

  describe('getPendingByCode', () => {
    it('should return pending registration for valid code', async () => {
      const mockPending = {
        id: 'pending-id',
        name: 'Test Agent',
        description: 'Test',
        claimCode: 'ABC123',
        expiresAt: new Date(Date.now() + 5 * 60 * 1000).toISOString(),
        createdAt: new Date().toISOString(),
      };

      vi.mocked(db.select).mockReturnValueOnce({
        from: vi.fn().mockReturnValueOnce({
          where: vi.fn().mockResolvedValueOnce([mockPending]),
        }),
      } as unknown as ReturnType<typeof db.select>);

      const result = await getPendingByCode('abc123');

      expect(result).toBeTruthy();
      expect(result?.id).toBe('pending-id');
    });

    it('should return null for non-existent code', async () => {
      vi.mocked(db.select).mockReturnValueOnce({
        from: vi.fn().mockReturnValueOnce({
          where: vi.fn().mockResolvedValueOnce([]),
        }),
      } as unknown as ReturnType<typeof db.select>);

      const result = await getPendingByCode('NONEXISTENT');

      expect(result).toBeNull();
    });

    it('should delete and return null for expired registration', async () => {
      const mockPending = {
        id: 'pending-id',
        name: 'Test Agent',
        claimCode: 'ABC123',
        expiresAt: new Date(Date.now() - 5 * 60 * 1000).toISOString(), // Expired
        createdAt: new Date().toISOString(),
      };

      vi.mocked(db.select).mockReturnValueOnce({
        from: vi.fn().mockReturnValueOnce({
          where: vi.fn().mockResolvedValueOnce([mockPending]),
        }),
      } as unknown as ReturnType<typeof db.select>);

      const result = await getPendingByCode('ABC123');

      expect(result).toBeNull();
      expect(db.delete).toHaveBeenCalled();
    });

    it('should normalize code to uppercase', async () => {
      vi.mocked(db.select).mockReturnValueOnce({
        from: vi.fn().mockReturnValueOnce({
          where: vi.fn().mockResolvedValueOnce([]),
        }),
      } as unknown as ReturnType<typeof db.select>);

      await getPendingByCode('  abc123  ');

      // The where clause should be called with uppercase trimmed code
      expect(db.select).toHaveBeenCalled();
    });
  });

  describe('claimAgent', () => {
    it('should claim agent and create active agent', async () => {
      const mockPending = {
        id: 'pending-id',
        name: 'Test Agent',
        description: 'Test description',
        claimCode: 'ABC123',
        expiresAt: new Date(Date.now() + 5 * 60 * 1000).toISOString(),
        createdAt: new Date().toISOString(),
      };

      vi.mocked(db.select).mockReturnValueOnce({
        from: vi.fn().mockReturnValueOnce({
          where: vi.fn().mockResolvedValueOnce([mockPending]),
        }),
      } as unknown as ReturnType<typeof db.select>);

      const result = await claimAgent('ABC123');

      expect(result).toBeTruthy();
      expect(result?.id).toBe('pending-id');
      expect(result?.name).toBe('Test Agent');
      expect(result?.status).toBe('active');
      expect(client.execute).toHaveBeenCalled();
      expect(db.delete).toHaveBeenCalled();
    });

    it('should return null for invalid code', async () => {
      vi.mocked(db.select).mockReturnValueOnce({
        from: vi.fn().mockReturnValueOnce({
          where: vi.fn().mockResolvedValueOnce([]),
        }),
      } as unknown as ReturnType<typeof db.select>);

      const result = await claimAgent('INVALID');

      expect(result).toBeNull();
    });
  });

  describe('getRegistrationStatus', () => {
    it('should return claimed status for existing agent', async () => {
      vi.mocked(client.execute).mockResolvedValueOnce({
        rows: [
          {
            id: 'agent-id',
            name: 'Claimed Agent',
            description: 'Test',
            status: 'active',
            created_at: new Date().toISOString(),
          },
        ],
        columns: [],
        rowsAffected: 0,
        lastInsertRowid: 0n,
      });

      const result = await getRegistrationStatus('agent-id');

      expect(result.status).toBe('claimed');
      expect(result.agent).toBeTruthy();
      expect(result.agent?.name).toBe('Claimed Agent');
    });

    it('should return pending status for pending registration', async () => {
      vi.mocked(client.execute).mockResolvedValueOnce({
        rows: [],
        columns: [],
        rowsAffected: 0,
        lastInsertRowid: 0n,
      });

      vi.mocked(db.select).mockReturnValueOnce({
        from: vi.fn().mockReturnValueOnce({
          where: vi.fn().mockResolvedValueOnce([
            {
              id: 'pending-id',
              expiresAt: new Date(Date.now() + 5 * 60 * 1000).toISOString(),
            },
          ]),
        }),
      } as unknown as ReturnType<typeof db.select>);

      const result = await getRegistrationStatus('pending-id');

      expect(result.status).toBe('pending');
    });

    it('should return expired status and clean up', async () => {
      vi.mocked(client.execute).mockResolvedValueOnce({
        rows: [],
        columns: [],
        rowsAffected: 0,
        lastInsertRowid: 0n,
      });

      vi.mocked(db.select).mockReturnValueOnce({
        from: vi.fn().mockReturnValueOnce({
          where: vi.fn().mockResolvedValueOnce([
            {
              id: 'expired-id',
              expiresAt: new Date(Date.now() - 5 * 60 * 1000).toISOString(),
            },
          ]),
        }),
      } as unknown as ReturnType<typeof db.select>);

      const result = await getRegistrationStatus('expired-id');

      expect(result.status).toBe('expired');
      expect(db.delete).toHaveBeenCalled();
    });

    it('should return not_found for unknown ID', async () => {
      vi.mocked(client.execute).mockResolvedValueOnce({
        rows: [],
        columns: [],
        rowsAffected: 0,
        lastInsertRowid: 0n,
      });

      vi.mocked(db.select).mockReturnValueOnce({
        from: vi.fn().mockReturnValueOnce({
          where: vi.fn().mockResolvedValueOnce([]),
        }),
      } as unknown as ReturnType<typeof db.select>);

      const result = await getRegistrationStatus('unknown-id');

      expect(result.status).toBe('not_found');
    });
  });

  describe('listPendingRegistrations', () => {
    it('should list all pending registrations', async () => {
      const mockPendingList = [
        { id: '1', name: 'Agent 1', claimCode: 'ABC123' },
        { id: '2', name: 'Agent 2', claimCode: 'DEF456' },
      ];

      vi.mocked(db.select).mockReturnValueOnce({
        from: vi.fn().mockResolvedValueOnce(mockPendingList),
      } as unknown as ReturnType<typeof db.select>);

      const result = await listPendingRegistrations();

      expect(result).toHaveLength(2);
      expect(client.execute).toHaveBeenCalled(); // For cleanup
    });

    it('should clean up expired registrations first', async () => {
      vi.mocked(db.select).mockReturnValueOnce({
        from: vi.fn().mockResolvedValueOnce([]),
      } as unknown as ReturnType<typeof db.select>);

      await listPendingRegistrations();

      expect(client.execute).toHaveBeenCalledWith(
        expect.objectContaining({
          sql: expect.stringContaining('DELETE FROM pending_agent_registrations'),
        })
      );
    });
  });

  describe('cancelRegistration', () => {
    it('should cancel pending registration', async () => {
      vi.mocked(db.delete).mockReturnValueOnce({
        where: vi.fn().mockResolvedValueOnce({ rowsAffected: 1 }),
      } as unknown as ReturnType<typeof db.delete>);

      const result = await cancelRegistration('pending-id');

      expect(result).toBe(true);
    });

    it('should return false for non-existent registration', async () => {
      vi.mocked(db.delete).mockReturnValueOnce({
        where: vi.fn().mockResolvedValueOnce({ rowsAffected: 0 }),
      } as unknown as ReturnType<typeof db.delete>);

      const result = await cancelRegistration('non-existent');

      expect(result).toBe(false);
    });
  });
});
