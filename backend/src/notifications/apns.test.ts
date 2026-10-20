import { describe, it, expect, vi, beforeEach } from 'vitest';

const execute = vi.fn();
vi.mock('../db/index.js', () => ({ client: { execute: (...a: unknown[]) => execute(...a) } }));

import { APNsService } from './apns.js';

const devices = [
  { id: 'd1', device_id: 'dev1', token: 'tok-owner', platform: 'ios', user_id: 'u1', created_at: '2026-01-01', updated_at: '2026-01-01' },
  { id: 'd2', device_id: 'dev2', token: 'tok-other', platform: 'ios', user_id: 'u2', created_at: '2026-01-01', updated_at: '2026-01-01' },
  { id: 'd3', device_id: 'dev3', token: 'tok-null', platform: 'ios', user_id: null, created_at: '2026-01-01', updated_at: '2026-01-01' },
];

/** Behaves like the real tables: honours the user_id filter in the SQL. */
function fakeDb(agentOwner: string | null) {
  execute.mockImplementation(async ({ sql, args }: { sql: string; args: unknown[] }) => {
    if (/FROM agents WHERE id/.test(sql)) return { rows: agentOwner ? [{ user_id: agentOwner }] : [] };
    if (/FROM device_tokens/.test(sql)) {
      if (!/user_id = \?/.test(sql)) return { rows: devices };
      return { rows: devices.filter((d) => d.user_id === args[0]) };
    }
    if (/COUNT\(\*\)/.test(sql)) return { rows: [{ count: 3 }] };
    return { rows: [] };
  });
}

const approval = { id: 'ap1', agentId: 'agent1', tool: 'thread_propose', status: 'pending', context: 'x' } as never;

describe('APNsService owner filtering', () => {
  let svc: APNsService;
  let sent: string[];
  beforeEach(() => {
    execute.mockReset();
    svc = new APNsService();
    sent = [];
    vi.spyOn(svc, 'sendNotification').mockImplementation(async (token: string) => {
      sent.push(token);
      return true;
    });
  });

  it("notifyApprovalRequest sends only to the agent owner's devices", async () => {
    fakeDb('u1');
    await svc.notifyApprovalRequest(approval);
    expect(sent).toEqual(['tok-owner']);
  });

  it('notifyApprovalResolved sends only to the owner too', async () => {
    fakeDb('u2');
    await svc.notifyApprovalResolved({ ...(approval as object), status: 'approved' } as never);
    expect(sent).toEqual(['tok-other']);
  });

  it('devices with a null user_id receive nothing', async () => {
    fakeDb(null);
    await svc.notifyApprovalRequest(approval);
    expect(sent).toEqual([]);
    fakeDb('u3');
    await svc.notifyApprovalRequest(approval);
    expect(sent).toEqual([]);
  });

  it("notifyUser sends the alert to that user's devices only", async () => {
    fakeDb('u1');
    await svc.notifyUser('u2', { title: 'Hi', body: 'There' }, { threadId: 't1' });
    expect(sent).toEqual(['tok-other']);
    const payload = (svc.sendNotification as any).mock.calls[0][1];
    expect(payload.aps.alert).toEqual({ title: 'Hi', body: 'There' });
    expect(payload.threadId).toBe('t1');
  });
});
