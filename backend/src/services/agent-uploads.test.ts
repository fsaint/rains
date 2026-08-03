import { describe, it, expect, vi, beforeEach } from 'vitest';

const execute = vi.fn();
vi.mock('../db/index.js', () => ({ client: { execute: (...a: unknown[]) => execute(...a) } }));

import {
  createUpload,
  getUpload,
  purgeExpiredUploads,
  MAX_UPLOAD_BYTES,
  MAX_UPLOADS_PER_AGENT,
} from './agent-uploads.js';

/** Calls matching a SQL fragment, in order. */
function callsMatching(fragment: string) {
  return execute.mock.calls
    .map(([arg]) => arg as { sql: string; args: unknown[] })
    .filter((call) => call.sql.includes(fragment));
}

beforeEach(() => {
  execute.mockReset();
  // Default: no existing uploads, inserts succeed.
  execute.mockResolvedValue({ rows: [], rowsAffected: 0 });
});

describe('createUpload', () => {
  it('stores the blob and returns its metadata', async () => {
    const data = Buffer.from('hello world');
    const upload = await createUpload({
      agentId: 'agent-1',
      userId: 'user-1',
      filename: 'report.pdf',
      mimeType: 'application/pdf',
      data,
    });

    expect(upload.sizeBytes).toBe(11);
    expect(upload.filename).toBe('report.pdf');
    expect(upload.mimeType).toBe('application/pdf');
    // sha256("hello world")
    expect(upload.sha256).toBe(
      'b94d27b9934d3e08a52e52d7da7dabfac484efe37a5380ee9088f7ace2efcde9'
    );
    expect(new Date(upload.expiresAt).getTime()).toBeGreaterThan(Date.now());

    const insert = callsMatching('INSERT INTO agent_uploads')[0];
    expect(insert.args).toContain('agent-1');
    expect(insert.args).toContain(data);
  });

  it('outlives the one-hour approval window', async () => {
    // A deferred gmail_create_draft resolves its references at approval time,
    // so a TTL shorter than the approval expiry would break the whole flow.
    const upload = await createUpload({
      agentId: 'a',
      filename: 'f',
      mimeType: 'text/plain',
      data: Buffer.from('x'),
    });
    const ttlMs = new Date(upload.expiresAt).getTime() - Date.now();
    expect(ttlMs).toBeGreaterThan(2 * 60 * 60 * 1000);
  });

  it('rejects an empty upload', async () => {
    await expect(
      createUpload({ agentId: 'a', filename: 'f', mimeType: 't/p', data: Buffer.alloc(0) })
    ).rejects.toThrow(/empty/);
  });

  it('rejects an upload over the size limit', async () => {
    await expect(
      createUpload({
        agentId: 'a',
        filename: 'f',
        mimeType: 't/p',
        data: Buffer.alloc(MAX_UPLOAD_BYTES + 1),
      })
    ).rejects.toThrow(/exceeds/);
  });

  it('reduces a path to its basename', async () => {
    const upload = await createUpload({
      agentId: 'a',
      filename: '../../etc/passwd',
      mimeType: 'text/plain',
      data: Buffer.from('x'),
    });
    expect(upload.filename).toBe('passwd');
  });

  it('evicts the oldest uploads when the per-agent count quota is exceeded', async () => {
    const existing = Array.from({ length: MAX_UPLOADS_PER_AGENT }, (_, i) => ({
      id: `old-${i}`,
      size_bytes: 10,
    }));
    execute.mockImplementation(async (arg: { sql: string }) =>
      arg.sql.includes('SELECT id, size_bytes')
        ? { rows: existing }
        : { rows: [], rowsAffected: 0 }
    );

    await createUpload({
      agentId: 'a',
      filename: 'new.bin',
      mimeType: 'application/octet-stream',
      data: Buffer.from('x'),
    });

    const deletes = callsMatching('DELETE FROM agent_uploads WHERE id');
    expect(deletes).toHaveLength(1);
    expect(deletes[0].args).toEqual(['old-0']); // oldest first
  });

  it('evicts enough uploads to fit the byte quota', async () => {
    const existing = [
      { id: 'old-0', size_bytes: 20 * 1024 * 1024 },
      { id: 'old-1', size_bytes: 20 * 1024 * 1024 },
    ];
    execute.mockImplementation(async (arg: { sql: string }) =>
      arg.sql.includes('SELECT id, size_bytes')
        ? { rows: existing }
        : { rows: [], rowsAffected: 0 }
    );

    // 40 MB stored + 15 MB incoming exceeds the 50 MB cap; one eviction suffices.
    await createUpload({
      agentId: 'a',
      filename: 'big.bin',
      mimeType: 'application/octet-stream',
      data: Buffer.alloc(15 * 1024 * 1024),
    });

    expect(callsMatching('DELETE FROM agent_uploads WHERE id').map((c) => c.args)).toEqual([
      ['old-0'],
    ]);
  });

  it('does not evict when the incoming upload fits', async () => {
    execute.mockImplementation(async (arg: { sql: string }) =>
      arg.sql.includes('SELECT id, size_bytes')
        ? { rows: [{ id: 'old-0', size_bytes: 10 }] }
        : { rows: [], rowsAffected: 0 }
    );

    await createUpload({ agentId: 'a', filename: 'f', mimeType: 't/p', data: Buffer.from('x') });
    expect(callsMatching('DELETE FROM agent_uploads WHERE id')).toHaveLength(0);
  });
});

describe('getUpload', () => {
  it('scopes the lookup to the requesting agent and to unexpired rows', async () => {
    execute.mockResolvedValue({
      rows: [
        {
          id: 'up-1',
          agent_id: 'agent-1',
          filename: 'a.pdf',
          mime_type: 'application/pdf',
          size_bytes: 3,
          sha256: 'abc',
          data: Buffer.from('pdf'),
          expires_at: new Date(Date.now() + 1000).toISOString(),
        },
      ],
    });

    const upload = await getUpload('up-1', 'agent-1');
    expect(upload?.data.toString()).toBe('pdf');

    // An uploadId alone must not grant another agent access to the file.
    const [call] = execute.mock.calls[0] as [{ sql: string; args: unknown[] }];
    expect(call.sql).toContain('agent_id = ?');
    expect(call.sql).toContain('expires_at >');
    expect(call.args.slice(0, 2)).toEqual(['up-1', 'agent-1']);
  });

  it('returns null when there is no matching row', async () => {
    execute.mockResolvedValue({ rows: [] });
    expect(await getUpload('missing', 'agent-1')).toBeNull();
  });

  it('normalizes a Uint8Array column value to a Buffer', async () => {
    execute.mockResolvedValue({
      rows: [
        {
          id: 'up-1',
          agent_id: 'agent-1',
          filename: 'a.bin',
          mime_type: 'application/octet-stream',
          size_bytes: 2,
          sha256: 'abc',
          data: new Uint8Array([1, 2]),
          expires_at: new Date(Date.now() + 1000).toISOString(),
        },
      ],
    });

    const upload = await getUpload('up-1', 'agent-1');
    expect(Buffer.isBuffer(upload?.data)).toBe(true);
    expect([...(upload?.data ?? [])]).toEqual([1, 2]);
  });
});

describe('purgeExpiredUploads', () => {
  it('deletes rows past their expiry and reports the count', async () => {
    execute.mockResolvedValue({ rows: [], rowsAffected: 4 });
    expect(await purgeExpiredUploads()).toBe(4);
    expect(callsMatching('DELETE FROM agent_uploads WHERE expires_at')).toHaveLength(1);
  });
});
