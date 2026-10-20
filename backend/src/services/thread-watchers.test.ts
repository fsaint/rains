/**
 * Thread Watcher Tests
 *
 * A watcher is bounded by its creating agent's own access: these pin the
 * refusals (no service, an account the agent does not hold, a tool that is not
 * `allow`, a project other than the pinned one) and the plain-words text the
 * approval message shows.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../db/index.js', () => ({
  client: {
    execute: vi.fn().mockResolvedValue({ rows: [], rowsAffected: 1, lastInsertRowid: 0n, columns: [] }),
  },
}));

vi.mock('nanoid', () => ({
  nanoid: vi.fn(() => 'w-id'),
}));

vi.mock('../mcp/agent-endpoint.js', () => ({
  resolveToolPolicy: vi.fn(),
}));

vi.mock('./permissions.js', () => ({
  getInstanceConfig: vi.fn(),
}));

import { client } from '../db/index.js';
import { resolveToolPolicy } from '../mcp/agent-endpoint.js';
import { getInstanceConfig } from './permissions.js';
import { checkWatcherAccess, addWatcher, describeWatcher } from './thread-watchers.js';

const gmailInst = { id: 'inst-g', agentId: 'a1', serviceType: 'gmail', enabled: true, isDefault: true, credentialId: 'cred-g' };
const hxInst = { id: 'inst-h', agentId: 'a1', serviceType: 'hermeneutix', enabled: true, isDefault: true, credentialId: 'cred-h' };

const policy = (over: Record<string, unknown> = {}) => ({
  allowed: true,
  requiresApproval: false,
  hasInstances: true,
  serviceInstances: [gmailInst],
  policyInstance: gmailInst,
  ...over,
});

const notEnabled = { error: { code: -32003, message: 'Service not enabled for this agent: gmail', data: {} } };
const noAccount = { error: { code: -32001, message: 'No credential found for account: z@y.com.', data: {} } };

beforeEach(() => {
  vi.clearAllMocks();
});

describe('checkWatcherAccess', () => {
  it('refuses a gmail watcher when the agent has no gmail service → WATCHER_SOURCE_NOT_GRANTED message', async () => {
    vi.mocked(resolveToolPolicy).mockResolvedValue(notEnabled as never);

    const res = await checkWatcherAccess('a1', { kind: 'gmail_sender', value: 'bob@x.com' });

    expect(res.ok).toBe(false);
    expect(!res.ok && res.message).toMatch(/^WATCHER_SOURCE_NOT_GRANTED/);
    expect(!res.ok && res.message).toContain('Gmail');
    expect(resolveToolPolicy).toHaveBeenCalledWith('a1', 'gmail', 'gmail_search', {});
  });

  it('refuses a gmail watcher for an account the agent does not hold', async () => {
    vi.mocked(resolveToolPolicy).mockResolvedValue(noAccount as never);

    const res = await checkWatcherAccess('a1', { kind: 'gmail_query', value: 'from:bob', account: 'z@y.com' });

    expect(res.ok).toBe(false);
    expect(!res.ok && res.message).toMatch(/^WATCHER_SOURCE_NOT_GRANTED/);
    expect(!res.ok && res.message).toContain('z@y.com');
    expect(resolveToolPolicy).toHaveBeenCalledWith('a1', 'gmail', 'gmail_search', { account: 'z@y.com' });
  });

  it('refuses a named account when the agent has gmail only through the legacy access row', async () => {
    // The legacy path cannot resolve an account, so it must not be read as "holds it".
    vi.mocked(resolveToolPolicy).mockResolvedValue(
      policy({ hasInstances: false, serviceInstances: [], policyInstance: undefined }) as never
    );

    const res = await checkWatcherAccess('a1', { kind: 'gmail_sender', value: 'bob@x.com', account: 'ana@y.com' });

    expect(res.ok).toBe(false);
    expect(!res.ok && res.message).toContain('ana@y.com');
  });

  it.each([
    ['require_approval', { requiresApproval: true }],
    ['block', { allowed: false }],
  ])('refuses a gmail watcher when gmail_search is %s', async (_label, over) => {
    vi.mocked(resolveToolPolicy).mockResolvedValue(policy(over) as never);

    const res = await checkWatcherAccess('a1', { kind: 'gmail_thread', value: 'th-1' });

    expect(res.ok).toBe(false);
    expect(!res.ok && res.message).toMatch(/^WATCHER_SOURCE_NOT_GRANTED/);
    expect(!res.ok && res.message).toContain('gmail_search');
  });

  it('accepts a gmail_sender watcher when gmail_search is allow', async () => {
    vi.mocked(resolveToolPolicy).mockResolvedValue(policy() as never);

    const res = await checkWatcherAccess('a1', { kind: 'gmail_sender', value: 'bob@x.com', account: 'ana@y.com' });

    expect(res).toEqual({ ok: true });
    expect(resolveToolPolicy).toHaveBeenCalledWith('a1', 'gmail', 'gmail_search', { account: 'ana@y.com' });
  });

  it('refuses an hx_project watcher for a project other than the pinned one', async () => {
    vi.mocked(resolveToolPolicy).mockResolvedValue(
      policy({ serviceInstances: [hxInst], policyInstance: hxInst }) as never
    );
    vi.mocked(getInstanceConfig).mockResolvedValue({ config: { projectId: 'proj-pinned' } } as never);

    const res = await checkWatcherAccess('a1', { kind: 'hx_project', value: 'proj-other' });

    expect(res.ok).toBe(false);
    expect(!res.ok && res.message).toMatch(/^WATCHER_SOURCE_NOT_GRANTED/);
    expect(!res.ok && res.message).toContain('proj-other');
    expect(resolveToolPolicy).toHaveBeenCalledWith('a1', 'hermeneutix', 'hermeneutix_list_sessions', {});
    expect(getInstanceConfig).toHaveBeenCalledWith('inst-h');
  });

  it('accepts an hx_project watcher for the pinned project', async () => {
    vi.mocked(resolveToolPolicy).mockResolvedValue(
      policy({ serviceInstances: [hxInst], policyInstance: hxInst }) as never
    );
    vi.mocked(getInstanceConfig).mockResolvedValue({ config: { projectId: 'proj-pinned' } } as never);

    expect(await checkWatcherAccess('a1', { kind: 'hx_project', value: 'proj-pinned' })).toEqual({ ok: true });
  });

  it.each([
    ['no config', null],
    ['no projectId', {}],
    ['empty projectId', { projectId: '' }],
    ['numeric projectId', { projectId: 42 }],
  ])('refuses hx watchers when no project is pinned (%s)', async (_label, config) => {
    vi.mocked(resolveToolPolicy).mockResolvedValue(
      policy({ serviceInstances: [hxInst], policyInstance: hxInst }) as never
    );
    vi.mocked(getInstanceConfig).mockResolvedValue({ config } as never);

    for (const kind of ['hx_project', 'hx_meeting'] as const) {
      const res = await checkWatcherAccess('a1', { kind, value: 'x' });
      expect(res.ok).toBe(false);
      expect(!res.ok && res.message).toMatch(/pinned/);
    }
  });

  it('refuses hx watchers when hermeneutix is enabled only through the legacy access row', async () => {
    vi.mocked(resolveToolPolicy).mockResolvedValue(
      policy({ hasInstances: false, serviceInstances: [], policyInstance: undefined }) as never
    );

    const res = await checkWatcherAccess('a1', { kind: 'hx_meeting', value: 'm-1' });

    expect(res.ok).toBe(false);
    expect(getInstanceConfig).not.toHaveBeenCalled();
  });

  it('accepts an hx_meeting watcher under any pin — the sweep fails closed outside it', async () => {
    vi.mocked(resolveToolPolicy).mockResolvedValue(
      policy({ serviceInstances: [hxInst], policyInstance: hxInst }) as never
    );
    vi.mocked(getInstanceConfig).mockResolvedValue({ config: { projectId: 'proj-pinned' } } as never);

    expect(await checkWatcherAccess('a1', { kind: 'hx_meeting', value: 'meeting-9' })).toEqual({ ok: true });
  });

  it('refuses hx watchers when hermeneutix_list_sessions is not allow', async () => {
    vi.mocked(resolveToolPolicy).mockResolvedValue(
      policy({ serviceInstances: [hxInst], policyInstance: hxInst, requiresApproval: true }) as never
    );
    vi.mocked(getInstanceConfig).mockResolvedValue({ config: { projectId: 'p' } } as never);

    const res = await checkWatcherAccess('a1', { kind: 'hx_project', value: 'p' });

    expect(res.ok).toBe(false);
    expect(!res.ok && res.message).toContain('hermeneutix_list_sessions');
  });

  it.each([
    ['an unknown kind', { kind: 'gmail_label', value: 'x' }],
    ['an empty value', { kind: 'gmail_sender', value: '  ' }],
    ['a non-string value', { kind: 'gmail_sender', value: 7 }],
    ['a non-string account', { kind: 'gmail_sender', value: 'x', account: 7 }],
  ])('refuses %s without resolving any policy', async (_label, w) => {
    const res = await checkWatcherAccess('a1', w as never);

    expect(res.ok).toBe(false);
    expect(!res.ok && res.message).toMatch(/^WATCHER_SOURCE_NOT_GRANTED/);
    expect(resolveToolPolicy).not.toHaveBeenCalled();
  });
});

describe('addWatcher', () => {
  it('inserts an active watcher row owned by the agent', async () => {
    const res = await addWatcher('t1', 'a1', { kind: 'gmail_query', value: 'from:bob', account: 'ana@y.com' });

    expect(res).toEqual({ id: 'w-id' });
    const call = vi.mocked(client.execute).mock.calls[0][0] as { sql: string; args: unknown[] };
    expect(call.sql).toContain('INSERT INTO thread_watchers');
    expect(call.sql).toContain("'active'");
    expect(call.args.slice(0, 6)).toEqual(['w-id', 't1', 'a1', 'gmail_query', 'from:bob', 'ana@y.com']);
    expect(typeof call.args[6]).toBe('string');
  });

  it('stores a missing account as null', async () => {
    await addWatcher('t1', 'a1', { kind: 'hx_project', value: 'p' });

    const call = vi.mocked(client.execute).mock.calls[0][0] as { args: unknown[] };
    expect(call.args[5]).toBeNull();
  });
});

describe('describeWatcher', () => {
  it('describeWatcher names the account and query in plain words', () => {
    expect(describeWatcher({ kind: 'gmail_sender', value: 'bob@x.com', account: 'ana@y.com' }))
      .toBe('scan ana@y.com for mail from bob@x.com every 15 minutes');
  });

  it('falls back to the default Gmail account when none is named', () => {
    expect(describeWatcher({ kind: 'gmail_sender', value: 'bob@x.com' }))
      .toBe('scan the default Gmail account for mail from bob@x.com every 15 minutes');
  });

  it('describes the other kinds', () => {
    expect(describeWatcher({ kind: 'gmail_query', value: 'from:bob', account: 'ana@y.com' }))
      .toBe('scan ana@y.com for mail matching "from:bob" every 15 minutes');
    expect(describeWatcher({ kind: 'gmail_thread', value: 'th-1', account: null }))
      .toBe('scan the default Gmail account for new messages in Gmail thread th-1 every 15 minutes');
    expect(describeWatcher({ kind: 'hx_project', value: 'p-1' }))
      .toBe('scan Hermeneutix project p-1 for new sessions every 15 minutes');
    expect(describeWatcher({ kind: 'hx_meeting', value: 'm-1' }))
      .toBe('scan Hermeneutix meeting m-1 for new sessions every 15 minutes');
  });
});
