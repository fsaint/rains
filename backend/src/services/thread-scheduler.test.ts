/**
 * The thread reminder tick: claim due items with one UPDATE ... RETURNING that
 * stamps them, then deliver. Stamp-before-send, as in trial-reminders.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

const { mockExecute, mockTelegram, mockApns } = vi.hoisted(() => ({
  mockExecute: vi.fn(),
  mockTelegram: { sendToChatId: vi.fn(), isConfigured: vi.fn(() => true) },
  mockApns: { notifyUser: vi.fn() },
}));

vi.mock('../db/index.js', () => ({ client: { execute: mockExecute } }));
vi.mock('../notifications/telegram.js', () => ({ telegramNotifier: mockTelegram }));
vi.mock('../notifications/apns.js', () => ({ apnsService: mockApns }));
vi.mock('../config/index.js', () => ({ config: { dashboardUrl: 'https://app.helm.mom' } }));

vi.mock('./thread-watchers.js', () => ({ runWatcherSweep: vi.fn().mockResolvedValue({ checked: 0, found: 0, suspended: 0 }) }));

import { runWatcherSweep } from './thread-watchers.js';
import { runReminderTick, startThreadScheduler } from './thread-scheduler.js';

const NOW = new Date('2026-10-19T12:00:00.000Z');

function item(over: Record<string, unknown> = {}) {
  return {
    id: 'i1', thread_id: 't1', kind: 'reminder', title: 'Call the vendor',
    due_at: null, remind_at: '2026-10-19T11:00:00.000Z',
    thread_title: 'Vendor <contract> & more', user_id: 'u1', ...over,
  };
}

const rows = (r: unknown[]) => ({ rows: r, rowsAffected: r.length, columns: [] });
const sqlOf = (q: any): string => (typeof q === 'string' ? q : q.sql);

/** Serve claims by shape; users lookup returns the chat id. */
function wire(nudges: unknown[], dues: unknown[], chatId: string | null = '555') {
  mockExecute.mockImplementation(async (q: any) => {
    const sql = sqlOf(q);
    if (sql.includes('UPDATE thread_items') && sql.includes('nudge_fired_at = ?')) return rows(nudges);
    if (sql.includes('UPDATE thread_items') && sql.includes('fired_at = ?')) return rows(dues);
    if (sql.includes('FROM users')) return rows([{ telegram_chat_id: chatId }]);
    return rows([]);
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  mockTelegram.sendToChatId.mockResolvedValue(undefined);
  mockTelegram.isConfigured.mockReturnValue(true);
  mockApns.notifyUser.mockResolvedValue(undefined);
});

describe('runReminderTick', () => {
  it('claims nudges and dues in separate statements and delivers each claimed row once', async () => {
    wire([item()], [item({ id: 'i2', kind: 'deadline', title: 'File taxes', due_at: '2026-10-19T11:30:00.000Z' })]);

    const result = await runReminderTick(NOW);

    expect(result).toEqual({ delivered: 2 });
    const claims = mockExecute.mock.calls.map((c: any) => sqlOf(c[0])).filter((s: string) => s.includes('UPDATE thread_items'));
    expect(claims).toHaveLength(2);
    expect(mockTelegram.sendToChatId).toHaveBeenCalledTimes(2);
    expect(mockApns.notifyUser).toHaveBeenCalledWith('u1', { title: 'Vendor <contract> & more', body: 'Call the vendor' }, { threadId: 't1' });

    const first = mockTelegram.sendToChatId.mock.calls[0][1] as string;
    expect(first).toBe('⏰ Vendor <contract> & more: Call the vendor\n\nhttps://app.helm.mom/threads/t1');
    const second = mockTelegram.sendToChatId.mock.calls[1][1] as string;
    expect(second).toContain('Due 2026-10-19T11:30:00.000Z');
  });

  it('a deadline with remind_at and due_at fires twice across two ticks: nudge then due', async () => {
    const deadline = item({ kind: 'deadline', due_at: '2026-10-19T11:30:00.000Z' });
    wire([deadline], []);
    await runReminderTick(NOW);
    expect(mockTelegram.sendToChatId.mock.calls[0][1]).not.toContain('Due ');

    wire([], [deadline]);
    await runReminderTick(new Date(NOW.getTime() + 60_000));
    expect(mockTelegram.sendToChatId).toHaveBeenCalledTimes(2);
    expect(mockTelegram.sendToChatId.mock.calls[1][1]).toContain('Due ');
  });

  it('fires an item created with a past remind_at exactly once', async () => {
    wire([item({ remind_at: '2020-01-01T00:00:00.000Z' })], []);
    await runReminderTick(NOW);
    wire([], []);
    await runReminderTick(new Date(NOW.getTime() + 60_000));
    expect(mockTelegram.sendToChatId).toHaveBeenCalledTimes(1);
    expect(mockApns.notifyUser).toHaveBeenCalledTimes(1);
  });

  it('does not select items on paused threads (claim SQL filters t.status = \'active\')', async () => {
    wire([], []);
    await runReminderTick(NOW);
    const claims = mockExecute.mock.calls.map((c: any) => sqlOf(c[0]));
    expect(claims).toHaveLength(2);
    for (const sql of claims) {
      expect(sql).toContain("t.status = 'active'");
      expect(sql).toContain("i.status = 'open'");
      expect(sql).toContain('RETURNING');
    }
    // Compared as ISO text against the supplied clock.
    expect(mockExecute.mock.calls[0][0].args).toContain(NOW.toISOString());
  });

  it('a Telegram failure does not throw and does not un-stamp', async () => {
    wire([item()], []);
    mockTelegram.sendToChatId.mockRejectedValue(new Error('telegram down'));

    await expect(runReminderTick(NOW)).resolves.toEqual({ delivered: 1 });

    expect(mockApns.notifyUser).toHaveBeenCalledTimes(1);
    const sqls = mockExecute.mock.calls.map((c: any) => sqlOf(c[0]));
    expect(sqls.some((s: string) => /nudge_fired_at\s*=\s*NULL|fired_at\s*=\s*NULL/.test(s))).toBe(false);
  });

  it('skips Telegram when the user has no chat id but still pushes', async () => {
    wire([item()], [], null);

    await runReminderTick(NOW);

    expect(mockTelegram.sendToChatId).not.toHaveBeenCalled();
    expect(mockApns.notifyUser).toHaveBeenCalledTimes(1);
  });
});

describe('startThreadScheduler', () => {
  it('schedules the tick every 60 seconds and the watcher sweep every 15 minutes, both unref\'d', () => {
    const unref = vi.fn();
    const spy = vi.spyOn(globalThis, 'setInterval').mockReturnValue({ unref } as any);
    startThreadScheduler();
    expect(spy).toHaveBeenCalledWith(expect.any(Function), 60_000);
    expect(spy).toHaveBeenCalledWith(expect.any(Function), 15 * 60_000);
    expect(unref).toHaveBeenCalledTimes(2);

    const sweep = spy.mock.calls.find((c) => c[1] === 15 * 60_000)![0] as () => void;
    sweep();
    expect(runWatcherSweep).toHaveBeenCalledTimes(1);
    spy.mockRestore();
  });
});
