/**
 * The trial reminder sweep: one message 7 days out, one 1 day out, on email
 * always and Telegram when the user has linked it.
 *
 * The stamp is written BEFORE the send. A mail or Telegram outage then costs
 * one reminder, where stamping afterwards would re-send to everyone on every
 * hourly tick for as long as the outage lasted.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

const { mockExecute, mockSendReminder, mockTelegram } = vi.hoisted(() => ({
  mockExecute: vi.fn(),
  mockSendReminder: vi.fn(),
  mockTelegram: { sendToChatId: vi.fn(), isConfigured: vi.fn(() => true) },
}));

vi.mock('../db/index.js', () => ({ client: { execute: mockExecute } }));
vi.mock('./email.js', () => ({ sendTrialReminderEmail: mockSendReminder }));
vi.mock('../notifications/telegram.js', () => ({ telegramNotifier: mockTelegram }));
vi.mock('../config/index.js', () => ({ config: { dashboardUrl: 'https://app.helm.mom' } }));

import { sendTrialReminders } from './trial-reminders.js';

const inDays = (n: number) => new Date(Date.now() + n * 86400000).toISOString();

function user(over: Record<string, unknown> = {}) {
  return {
    id: 'u1', email: 'ana@acme.com', name: 'Ana Ruiz',
    trial_ends_at: inDays(5), telegram_chat_id: null, ...over,
  };
}

/** Serve the 7-day window, the 1-day window, and swallow the stamps. */
function wire(sevenDay: unknown[], oneDay: unknown[]) {
  const stamps: Array<{ sql: string; args: unknown[] }> = [];
  mockExecute.mockImplementation(async (q: any) => {
    const sql: string = typeof q === 'string' ? q : q.sql;
    const rows = (r: unknown[]) => ({ rows: r, rowsAffected: r.length, columns: [] });
    if (sql.startsWith('UPDATE users SET')) {
      stamps.push({ sql, args: q.args });
      return rows([]);
    }
    if (sql.includes('trial_reminder_7_sent_at IS NULL')) return rows(sevenDay);
    if (sql.includes('trial_reminder_1_sent_at IS NULL')) return rows(oneDay);
    return rows([]);
  });
  return stamps;
}

beforeEach(() => {
  vi.clearAllMocks();
  mockSendReminder.mockResolvedValue(undefined);
  mockTelegram.sendToChatId.mockResolvedValue(undefined);
  mockTelegram.isConfigured.mockReturnValue(true);
});

describe('sendTrialReminders', () => {
  it('emails the 7-day warning and stamps the row', async () => {
    const stamps = wire([user()], []);

    const result = await sendTrialReminders();

    expect(result.sent7).toBe(1);
    expect(mockSendReminder).toHaveBeenCalledWith(
      expect.objectContaining({ to: 'ana@acme.com', name: 'Ana Ruiz', daysLeft: 7 })
    );
    expect(stamps).toHaveLength(1);
    expect(stamps[0].sql).toContain('trial_reminder_7_sent_at');
  });

  it('sends the 1-day warning with its own wording and stamp', async () => {
    const stamps = wire([], [user({ trial_ends_at: inDays(1) })]);

    const result = await sendTrialReminders();

    expect(result.sent1).toBe(1);
    expect(mockSendReminder).toHaveBeenCalledWith(expect.objectContaining({ daysLeft: 1 }));
    expect(stamps[0].sql).toContain('trial_reminder_1_sent_at');
  });

  it('also messages Telegram when the user has linked it', async () => {
    wire([user({ telegram_chat_id: '12345' })], []);

    await sendTrialReminders();

    expect(mockTelegram.sendToChatId).toHaveBeenCalledWith('12345', expect.stringMatching(/7 days/));
  });

  /** An invited user has not linked Telegram yet; that must not block the email. */
  it('sends only email when Telegram is not linked', async () => {
    wire([user({ telegram_chat_id: null })], []);

    await sendTrialReminders();

    expect(mockSendReminder).toHaveBeenCalledTimes(1);
    expect(mockTelegram.sendToChatId).not.toHaveBeenCalled();
  });

  it('stamps before sending, so an outage costs one reminder and not a loop', async () => {
    const order: string[] = [];
    mockExecute.mockImplementation(async (q: any) => {
      const sql: string = typeof q === 'string' ? q : q.sql;
      if (sql.startsWith('UPDATE users SET')) { order.push('stamp'); return { rows: [], rowsAffected: 1, columns: [] }; }
      if (sql.includes('trial_reminder_7_sent_at IS NULL')) return { rows: [user()], rowsAffected: 1, columns: [] };
      return { rows: [], rowsAffected: 0, columns: [] };
    });
    mockSendReminder.mockImplementation(async () => { order.push('send'); });

    await sendTrialReminders();

    expect(order).toEqual(['stamp', 'send']);
  });

  it('keeps going when one user\'s email throws', async () => {
    wire([user({ id: 'u1', email: 'a@x.com' }), user({ id: 'u2', email: 'b@x.com' })], []);
    mockSendReminder.mockRejectedValueOnce(new Error('mailgun down'));

    const result = await sendTrialReminders();

    expect(mockSendReminder).toHaveBeenCalledTimes(2);
    expect(result.sent7).toBe(2);
  });

  it('does nothing when nobody is due', async () => {
    wire([], []);

    const result = await sendTrialReminders();

    expect(result).toEqual({ sent7: 0, sent1: 0 });
    expect(mockSendReminder).not.toHaveBeenCalled();
  });

  /** Anyone who already subscribed is not on a trial any more. */
  it('excludes subscribers in the query itself', async () => {
    wire([], []);

    await sendTrialReminders();

    const selects = mockExecute.mock.calls
      .map((c: any) => (typeof c[0] === 'string' ? c[0] : c[0].sql))
      .filter((s: string) => s.includes('trial_reminder'));
    expect(selects).toHaveLength(2);
    for (const sql of selects) {
      expect(sql).toMatch(/NOT EXISTS[\s\S]*subscriptions/);
      expect(sql).toContain("status = 'active'");
    }
  });
});
