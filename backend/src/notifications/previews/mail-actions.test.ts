/**
 * Email actions name their targets by id. These check that each email is shown
 * by subject and sender, and each label or folder by name.
 */
import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest';

vi.mock('../../db/index.js', () => ({
  client: { execute: vi.fn() },
}));
vi.mock('../../credentials/vault.js', () => ({
  credentialVault: { getValidAccessToken: vi.fn().mockResolvedValue('tok') },
}));

import { client } from '../../db/index.js';
import { resolveApprovalPreview, formatPreviewApprovalMessage, previewFromMessageText } from './index.js';
import { makeApproval, routeFetch } from './test-helpers.js';

const INSTANCE = { credential_id: 'cred-1', is_default: 1, account_email: 'me@example.com' };

const gmailMessage = (subject: string, from: string) => ({
  payload: {
    headers: [
      { name: 'Subject', value: subject },
      { name: 'From', value: from },
      { name: 'Date', value: 'Fri, 20 Nov 2026 09:12:00 +0000' },
    ],
  },
});

beforeEach(() => {
  vi.mocked(client.execute).mockReset();
  vi.mocked(client.execute).mockResolvedValue({ rows: [INSTANCE] } as never);
});
afterEach(() => {
  vi.unstubAllGlobals();
});

describe('Gmail actions', () => {
  it('lists the emails an archive removes from the inbox', async () => {
    routeFetch([
      ['/messages/m1?', gmailMessage('Invoice 114', 'Bob <bob@example.com>')],
      ['/messages/m2?', gmailMessage('', 'ana@example.com')],
    ]);

    const preview = await resolveApprovalPreview(
      makeApproval({ tool: 'gmail_archive', arguments: { messageIds: ['m1', 'm2'] } })
    );

    expect(preview).toMatchObject({
      heading: 'Archive 2 emails',
      note: 'Removed from the inbox. Nothing is deleted.',
      items: {
        label: 'Emails',
        more: 0,
        list: [
          { title: 'Invoice 114', detail: 'Bob <bob@example.com> · Nov 20, 2026' },
          { title: '(no subject)', detail: 'ana@example.com · Nov 20, 2026' },
        ],
      },
    });
    expect(preview?.warning).toBeUndefined();
  });

  it('resolves only the first ten of a large batch and counts the rest', async () => {
    const ids = Array.from({ length: 25 }, (_, i) => `m${i}`);
    const calls = routeFetch([['/messages/', gmailMessage('Newsletter', 'news@example.com')]]);

    const preview = await resolveApprovalPreview(
      makeApproval({ tool: 'gmail_mark_read', arguments: { messageIds: ids, unread: true } })
    );

    expect(preview?.heading).toBe('Mark 25 emails as unread');
    expect(preview?.items?.list).toHaveLength(10);
    expect(preview?.items?.more).toBe(15);
    expect(calls).toHaveLength(10);
  });

  it('names the labels a change adds and removes', async () => {
    const calls = routeFetch([
      ['/messages/m1?', gmailMessage('Contract', 'bob@example.com')],
      ['/labels', { labels: [{ id: 'Label_12', name: 'Clients/Acme' }] }],
    ]);

    const preview = await resolveApprovalPreview(
      makeApproval({
        tool: 'gmail_modify_labels',
        arguments: { messageId: 'm1', addLabelIds: ['Label_12', 'STARRED'], removeLabelIds: ['INBOX', 'Label_99'] },
      })
    );

    expect(preview?.heading).toBe('Change labels on email');
    expect(preview?.rows).toEqual([
      { label: 'Add', value: 'Clients/Acme, Starred' },
      // A label that resolves to nothing is shown as given, not dropped.
      { label: 'Remove', value: 'Inbox, Label_99' },
    ]);
    expect(calls.filter((call) => call.url.endsWith('/labels'))).toHaveLength(1);
  });

  it('does not list labels when only system labels are involved', async () => {
    const calls = routeFetch([['/messages/m1?', gmailMessage('Contract', 'bob@example.com')]]);

    const preview = await resolveApprovalPreview(
      makeApproval({ tool: 'gmail_label_message', arguments: { messageId: 'm1', labelId: 'IMPORTANT' } })
    );

    expect(preview?.rows).toEqual([{ label: 'Label', value: 'Important' }]);
    expect(calls.some((call) => call.url.endsWith('/labels'))).toBe(false);
  });

  it('marks a permanent delete as destructive', async () => {
    routeFetch([['/messages/m1?', gmailMessage('Tax return', 'irs@example.com')]]);

    const preview = await resolveApprovalPreview(
      makeApproval({ tool: 'gmail_delete_message', arguments: { messageId: 'm1', account: 'me@example.com' } })
    );

    expect(preview).toMatchObject({
      heading: 'Delete email permanently',
      destructive: true,
      rows: [{ label: 'Account', value: 'me@example.com' }],
      items: { label: 'Email', list: [{ title: 'Tax return' }] },
    });
  });

  it('warns and shows the ids when nothing could be loaded', async () => {
    routeFetch([]);

    const preview = await resolveApprovalPreview(
      makeApproval({ tool: 'gmail_archive', arguments: { messageId: 'm1' } })
    );

    expect(preview?.warning).toBe('Could not load this email. Approve only if you recognise it.');
    expect(preview?.items?.list).toEqual([{ title: 'Could not load this email', detail: 'm1' }]);
  });

  it('still previews when the agent has no mail credential', async () => {
    vi.mocked(client.execute).mockResolvedValue({ rows: [] } as never);
    const calls = routeFetch([]);

    const preview = await resolveApprovalPreview(
      makeApproval({ tool: 'gmail_archive', arguments: { messageIds: ['m1', 'm2'] } })
    );

    expect(preview?.warning).toContain('Could not load these emails');
    expect(calls).toHaveLength(0);
  });

  it('has no preview when no message is named', async () => {
    expect(await resolveApprovalPreview(makeApproval({ tool: 'gmail_archive', arguments: {} }))).toBeNull();
  });
});

describe('Outlook actions', () => {
  const MESSAGE = {
    subject: 'Budget',
    from: { emailAddress: { name: 'Ana', address: 'ana@example.com' } },
    receivedDateTime: '2026-11-20T09:12:00Z',
  };

  it('names the email and the folder a move sends it to', async () => {
    const calls = routeFetch([
      ['/me/messages/AAMk%2Fx%3D?', MESSAGE],
      ['/me/mailFolders/AAMkFolder?', { displayName: 'Clients' }],
    ]);

    const preview = await resolveApprovalPreview(
      makeApproval({
        tool: 'outlook_mail_move_message',
        arguments: { messageId: 'AAMk/x=', destinationFolder: 'AAMkFolder' },
      })
    );

    expect(preview).toMatchObject({
      heading: 'Move email',
      rows: [{ label: 'To folder', value: 'Clients' }],
      items: { list: [{ title: 'Budget', detail: 'Ana <ana@example.com> · Nov 20, 2026' }] },
    });
    expect(calls[0].headers.Authorization).toBe('Bearer tok');
  });

  it('knows the well-known folders without a lookup', async () => {
    const calls = routeFetch([['/me/messages/', MESSAGE]]);

    const preview = await resolveApprovalPreview(
      makeApproval({
        tool: 'outlook_mail_move_message',
        arguments: { messageId: 'm1', destinationFolder: 'deleteditems' },
      })
    );

    expect(preview?.rows).toEqual([{ label: 'To folder', value: 'Deleted Items' }]);
    expect(calls.some((call) => call.url.includes('mailFolders'))).toBe(false);
  });

  it('shows the folder id under a warning when the folder cannot be read', async () => {
    routeFetch([['/me/messages/', MESSAGE]]);

    const preview = await resolveApprovalPreview(
      makeApproval({
        tool: 'outlook_mail_move_message',
        arguments: { messageId: 'm1', destinationFolder: 'AAMkGone' },
      })
    );

    expect(preview?.rows).toEqual([{ label: 'To folder', value: 'AAMkGone' }]);
    expect(preview?.warning).toContain('destination folder');
  });
});

describe('formatPreviewApprovalMessage', () => {
  const approval = makeApproval({ tool: 'gmail_archive', context: 'Clearing <old> mail' });

  it('renders heading, note, rows, items and the approve buttons', () => {
    const { text, keyboard, parseMode } = formatPreviewApprovalMessage(approval, {
      icon: '🗄',
      heading: 'Archive 12 emails',
      note: 'Removed from the inbox. Nothing is deleted.',
      rows: [{ label: 'Account', value: 'me@example.com' }],
      items: {
        label: 'Emails',
        list: [{ title: 'Q&A <draft>', detail: 'Bob <bob@example.com> · Nov 20, 2026' }, { title: 'Hello' }],
        more: 10,
      },
    });

    expect(parseMode).toBe('HTML');
    expect(text).toContain('🗄 <b>Archive 12 emails</b>');
    expect(text).toContain('<i>Removed from the inbox. Nothing is deleted.</i>');
    expect(text).toContain('<b>Account:</b> me@example.com');
    expect(text).toContain('• Q&amp;A &lt;draft&gt; — <i>Bob &lt;bob@example.com&gt; · Nov 20, 2026</i>');
    expect(text).toContain('• Hello\n…and 10 more');
    expect(text).toContain('<b>Context:</b> Clearing &lt;old&gt; mail');
    expect(text).toContain('<b>Agent:</b> <code>agent-abc</code>');
    expect(text).toMatch(/Expires in ~\d+ min$/);
    expect(keyboard[0][0].callback_data).toBe('ap:appr-1:approve');
  });

  it('renders a change, a destructive note, a warning and a long body', () => {
    const { text } = formatPreviewApprovalMessage(approval, {
      icon: '🗑',
      heading: 'Delete file',
      note: 'This cannot be undone.',
      destructive: true,
      warning: 'Could not load this file.',
      rows: [
        { label: 'Status', value: 'Done', was: 'In progress' },
        { label: 'Assignee', value: 'Ana', was: '' },
      ],
      body: { label: 'Comment', text: 'x'.repeat(2600) },
    });

    expect(text).toContain('⚠️ <b>This cannot be undone.</b>');
    expect(text).toContain('⚠️ <b>Could not load this file.</b>');
    expect(text).toContain('<b>Status:</b> <s>In progress</s> → Done');
    expect(text).toContain('<b>Assignee:</b> <s>(empty)</s> → Ana');
    expect(text).toContain('<b>Comment:</b>\n<blockquote>');
    expect(text).toContain('…(100 more characters)</blockquote>');
    expect(text.length).toBeLessThan(4096);
  });
});

describe('previewFromMessageText', () => {
  it('turns a formatted approval message into a dashboard preview', () => {
    const preview = previewFromMessageText(
      [
        '✏️ Revision 1 of 3',
        '⚠️ <b>Destroy agent</b>',
        '<b>Agent:</b> “Research &amp; &lt;Ops&gt;”',
        '<b>Agent:</b> <code>agent-abc</code>',
        '<blockquote>Everything it holds is removed.</blockquote>',
        '',
        '',
        '',
        '<i>This cannot be undone.</i>',
        '',
        'Expires in ~30 min',
      ].join('\n')
    );

    expect(preview).toEqual({
      icon: '⚠️',
      heading: 'Destroy agent',
      rows: [],
      body: { text: 'Everything it holds is removed.\n\nThis cannot be undone.' },
    });
  });

  it('keeps a heading that has no emoji, and returns null for nothing', () => {
    expect(previewFromMessageText('<b>Approval Required</b>')).toMatchObject({ icon: '', heading: 'Approval Required' });
    expect(previewFromMessageText('')).toBeNull();
  });
});
