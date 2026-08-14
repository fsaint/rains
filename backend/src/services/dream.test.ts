/**
 * Dream service tests
 *
 * Tests the runDreamProcess function by mocking fetch and client.execute.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../db/index.js', () => ({
  client: {
    execute: vi.fn().mockResolvedValue({ rows: [], rowsAffected: 0, lastInsertRowid: 0n, columns: [] }),
  },
}));

const mockFetch = vi.fn();
global.fetch = mockFetch;

import { client } from '../db/index.js';
import { runDreamProcess } from './dream.js';

const EMPTY = { rows: [], columns: [], rowsAffected: 0, lastInsertRowid: 0n };

describe('runDreamProcess', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockFetch.mockResolvedValue({ ok: true, json: async () => ({}) });
  });

  it('queries every running agent with a management URL, regardless of runtime', async () => {
    vi.mocked(client.execute).mockResolvedValueOnce(EMPTY);

    await runDreamProcess();

    const call = vi.mocked(client.execute).mock.calls[0][0] as { sql: string; args: unknown[] };
    expect(call.sql).toContain("status = 'running'");
    expect(call.sql).toContain('management_url IS NOT NULL');
    // The push is a plain POST to management_url, so hermes agents are eligible too.
    // Agents with no deployed runtime have no management_url and are excluded by that.
    expect(call.sql).not.toContain('runtime =');
  });

  it('POSTs to each agent management URL chat endpoint', async () => {
    vi.mocked(client.execute).mockResolvedValueOnce({
      rows: [
        { id: 'dep-1', management_url: 'https://agent1.fly.dev', gateway_token: 'tok-1' },
        { id: 'dep-2', management_url: 'https://agent2.fly.dev', gateway_token: 'tok-2' },
      ],
      columns: [], rowsAffected: 2, lastInsertRowid: 0n,
    });

    await runDreamProcess();

    expect(mockFetch).toHaveBeenCalledTimes(2);
    const urls = mockFetch.mock.calls.map((c) => c[0]);
    expect(urls).toContain('https://agent1.fly.dev/chat?session=dream');
    expect(urls).toContain('https://agent2.fly.dev/chat?session=dream');
  });

  it('never instructs the agent to call the blocked memory_delete tool', async () => {
    vi.mocked(client.execute).mockResolvedValueOnce({
      rows: [{ id: 'dep-1', management_url: 'https://agent1.fly.dev', gateway_token: 'tok-1' }],
      columns: [], rowsAffected: 1, lastInsertRowid: 0n,
    });

    await runDreamProcess();

    const { message } = JSON.parse(mockFetch.mock.calls[0][1].body as string);
    // memory_delete is in the memory service's blocked list, so any step telling the
    // agent to call it fails every night. Merges register an alias instead.
    expect(message).not.toMatch(/deleting the other with memory_delete|memory_delete the other/);
    expect(message).toContain('Do NOT call memory_delete');
    expect(message).toContain('alias');
  });

  it('tells the agent to work one scope at a time', async () => {
    vi.mocked(client.execute).mockResolvedValueOnce({
      rows: [{ id: 'dep-1', management_url: 'https://agent1.fly.dev', gateway_token: 'tok-1' }],
      columns: [], rowsAffected: 1, lastInsertRowid: 0n,
    });

    await runDreamProcess();

    const { message } = JSON.parse(mockFetch.mock.calls[0][1].body as string);
    expect(message).toContain('memory_list_scopes');
    expect(message).toContain('ONE SCOPE AT A TIME');
    // set_parent cannot cross scopes and will refuse; saying so up front stops
    // the model burning turns retrying, and stops it inventing a workaround.
    expect(message).toContain('cannot move an entry into a different scope');
    // One index per scope, each written from its own scope's contents.
    expect(message).toContain("THAT SCOPE'S index");
  });

  it('tells the agent not to restructure the operating map', async () => {
    vi.mocked(client.execute).mockResolvedValueOnce({
      rows: [{ id: 'dep-1', management_url: 'https://agent1.fly.dev', gateway_token: 'tok-1' }],
      columns: [], rowsAffected: 1, lastInsertRowid: 0n,
    });

    await runDreamProcess();

    const { message } = JSON.parse(mockFetch.mock.calls[0][1].body as string);
    // Skills resolve their map pages by title, so a reparent or merge breaks them silently.
    expect(message).toContain('Helm Operating Map');
  });

  it('sends gateway token as x-reins-gateway-token header', async () => {
    vi.mocked(client.execute).mockResolvedValueOnce({
      rows: [{ id: 'dep-1', management_url: 'https://agent1.fly.dev', gateway_token: 'secret-tok' }],
      columns: [], rowsAffected: 1, lastInsertRowid: 0n,
    });

    await runDreamProcess();

    const opts = mockFetch.mock.calls[0][1];
    expect(opts.headers['x-reins-gateway-token']).toBe('secret-tok');
  });

  it('sends the dream prompt in the request body', async () => {
    vi.mocked(client.execute).mockResolvedValueOnce({
      rows: [{ id: 'dep-1', management_url: 'https://agent1.fly.dev', gateway_token: 'tok' }],
      columns: [], rowsAffected: 1, lastInsertRowid: 0n,
    });

    await runDreamProcess();

    const body = JSON.parse(mockFetch.mock.calls[0][1].body);
    expect(body.message).toContain('memory_dream');
    expect(body.message).toContain('memory_set_parent');
  });

  it('does not call fetch when no eligible agents', async () => {
    vi.mocked(client.execute).mockResolvedValueOnce(EMPTY);

    await runDreamProcess();

    expect(mockFetch).not.toHaveBeenCalled();
  });

  it('continues processing remaining agents when one fetch fails', async () => {
    vi.mocked(client.execute).mockResolvedValueOnce({
      rows: [
        { id: 'dep-1', management_url: 'https://agent1.fly.dev', gateway_token: 'tok-1' },
        { id: 'dep-2', management_url: 'https://agent2.fly.dev', gateway_token: 'tok-2' },
      ],
      columns: [], rowsAffected: 2, lastInsertRowid: 0n,
    });
    mockFetch
      .mockRejectedValueOnce(new Error('Connection refused'))
      .mockResolvedValueOnce({ ok: true });

    // Should not throw
    await expect(runDreamProcess()).resolves.not.toThrow();
    expect(mockFetch).toHaveBeenCalledTimes(2);
  });
});
