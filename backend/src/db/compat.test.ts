/**
 * Database Compatibility Layer Tests
 *
 * Tests the PostgreSQL compatibility wrapper that translates
 * the @libsql/client execute() API to postgres.js.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

// Use vi.hoisted to create mocks that are available in vi.mock factories
const { mockUnsafe } = vi.hoisted(() => {
  const mockUnsafe = vi.fn().mockResolvedValue([]);
  return { mockUnsafe };
});

vi.mock('../config/index.js', () => ({
  config: {
    databaseUrl: 'postgres://localhost:5432/reins_test',
    adminPassword: 'test',
    adminEmail: 'admin@test.com',
    sessionSecret: 'test-secret-that-is-at-least-32-characters-long!',
  },
}));

vi.mock('postgres', () => {
  const sqlFn: any = vi.fn().mockResolvedValue([]);
  sqlFn.unsafe = mockUnsafe;
  return { default: () => sqlFn };
});

vi.mock('bcryptjs', () => ({
  default: { hash: vi.fn().mockResolvedValue('$2a$10$hash') },
}));

vi.mock('nanoid', () => ({
  nanoid: vi.fn(() => 'test-id'),
}));

import { client } from './index.js';

describe('Database Compatibility Layer', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe('client.execute with string SQL', () => {
    it('should execute raw SQL string', async () => {
      mockUnsafe.mockResolvedValueOnce([
        { id: '1', name: 'Agent 1' },
        { id: '2', name: 'Agent 2' },
      ]);

      const result = await client.execute('SELECT * FROM agents');

      expect(mockUnsafe).toHaveBeenCalledWith('SELECT * FROM agents');
      expect(result.rows).toHaveLength(2);
      expect(result.rows[0].name).toBe('Agent 1');
    });

    it('should return columns from first row', async () => {
      mockUnsafe.mockResolvedValueOnce([
        { id: '1', name: 'Test', status: 'active' },
      ]);

      const result = await client.execute('SELECT * FROM agents');
      expect(result.columns).toEqual(['id', 'name', 'status']);
    });

    it('should return empty columns for empty results', async () => {
      mockUnsafe.mockResolvedValueOnce([]);

      const result = await client.execute('SELECT * FROM agents WHERE 1=0');
      expect(result.rows).toHaveLength(0);
      expect(result.columns).toHaveLength(0);
    });
  });

  describe('client.execute with parameterized SQL', () => {
    it('should convert ? placeholders to $1, $2, ...', async () => {
      mockUnsafe.mockResolvedValueOnce([{ id: '1' }]);

      await client.execute({
        sql: 'SELECT * FROM agents WHERE id = ? AND status = ?',
        args: ['agent-1', 'active'],
      });

      expect(mockUnsafe).toHaveBeenCalledWith(
        'SELECT * FROM agents WHERE id = $1 AND status = $2',
        ['agent-1', 'active']
      );
    });

    it('should handle multiple placeholders correctly', async () => {
      mockUnsafe.mockResolvedValueOnce([]);

      await client.execute({
        sql: 'INSERT INTO agents (id, name, status, a, b) VALUES (?, ?, ?, ?, ?)',
        args: ['id-1', 'Test', 'pending', '2024-01-01', '2024-01-01'],
      });

      expect(mockUnsafe).toHaveBeenCalledWith(
        'INSERT INTO agents (id, name, status, a, b) VALUES ($1, $2, $3, $4, $5)',
        ['id-1', 'Test', 'pending', '2024-01-01', '2024-01-01']
      );
    });

    it('should handle null args', async () => {
      mockUnsafe.mockResolvedValueOnce([]);

      await client.execute({
        sql: 'INSERT INTO agents (id, description) VALUES (?, ?)',
        args: ['id-1', null],
      });

      expect(mockUnsafe).toHaveBeenCalledWith(
        'INSERT INTO agents (id, description) VALUES ($1, $2)',
        ['id-1', null]
      );
    });
  });

  describe('result format', () => {
    it('should set rowsAffected to row count', async () => {
      mockUnsafe.mockResolvedValueOnce([{ id: '1' }, { id: '2' }, { id: '3' }]);

      const result = await client.execute('SELECT * FROM agents');
      expect(result.rowsAffected).toBe(3);
    });

    it('should provide lastInsertRowid from id column', async () => {
      mockUnsafe.mockResolvedValueOnce([{ id: 42 }]);

      const result = await client.execute('INSERT INTO audit_log (...) RETURNING id');
      expect(result.lastInsertRowid).toBe(42n);
    });

    it('should default lastInsertRowid to 0n for empty results', async () => {
      mockUnsafe.mockResolvedValueOnce([]);

      const result = await client.execute('DELETE FROM agents WHERE 1=0');
      expect(result.lastInsertRowid).toBe(0n);
    });
  });
});
