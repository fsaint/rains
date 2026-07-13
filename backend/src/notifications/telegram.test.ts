/**
 * Tests for the rich email preview in Telegram approval messages.
 */

import { describe, it, expect, vi } from 'vitest';

// Mock the DB so importing telegram.ts (which pulls in config/db at module load)
// does not require a live database connection.
vi.mock('../db/index.js', () => ({
  client: { execute: vi.fn().mockResolvedValue({ rows: [] }) },
}));

import { formatEmailApprovalMessage } from './telegram.js';
import type { ApprovalRequest } from '@reins/shared';

function makeApproval(overrides: Partial<ApprovalRequest>): ApprovalRequest {
  return {
    id: 'appr-1',
    agentId: 'agent-abc',
    tool: 'gmail_send_message',
    arguments: {},
    status: 'pending',
    requestedAt: new Date(),
    expiresAt: new Date(Date.now() + 30 * 60 * 1000),
    ...overrides,
  };
}

describe('formatEmailApprovalMessage', () => {
  it('renders To / Cc / Subject / Body from array recipients', () => {
    const approval = makeApproval({
      tool: 'gmail_send_message',
      arguments: {
        to: ['a@x.com', 'b@y.com'],
        cc: ['c@z.com'],
        subject: 'Quarterly update',
        body: 'Hello team,\nHere is the update.',
        account: 'me@gmail.com',
      },
    });

    const { text, keyboard, parseMode } = formatEmailApprovalMessage(approval);

    expect(parseMode).toBe('HTML');
    expect(text).toContain('📧 <b>Send email</b>');
    expect(text).toContain('<b>From account:</b> me@gmail.com');
    expect(text).toContain('<b>To:</b> a@x.com, b@y.com');
    expect(text).toContain('<b>Cc:</b> c@z.com');
    expect(text).toContain('<b>Subject:</b> Quarterly update');
    expect(text).toContain('Here is the update.');
    // Approve/Deny buttons preserved with the same callback format.
    expect(keyboard[0][0].callback_data).toBe('ap:appr-1:approve');
    expect(keyboard[0][1].callback_data).toBe('ap:appr-1:deny');
  });

  it('HTML-escapes email content and does not choke on Markdown-special chars', () => {
    const approval = makeApproval({
      arguments: {
        to: ['a@x.com'],
        subject: 'Hi_there *now* [link]',
        body: 'Line1\nLine2 with `backticks` and <b>bold</b> & <script>',
      },
    });

    const { text } = formatEmailApprovalMessage(approval);

    // Markdown specials survive verbatim (HTML mode ignores them).
    expect(text).toContain('Hi_there *now* [link]');
    // Angle brackets / ampersands from the body are escaped, not rendered as tags.
    expect(text).toContain('&lt;b&gt;bold&lt;/b&gt;');
    expect(text).toContain('&amp; &lt;script&gt;');
    // The only literal <b> tags come from our own markup, never from user content.
    expect(text).not.toContain('<b>bold</b>');
  });

  it('labels draft tools and reply threads', () => {
    const draft = formatEmailApprovalMessage(
      makeApproval({ tool: 'gmail_create_draft', arguments: { to: ['a@x.com'], subject: 's' } })
    );
    expect(draft.text).toContain('📧 <b>Save draft</b>');

    const reply = formatEmailApprovalMessage(
      makeApproval({ arguments: { to: ['a@x.com'], subject: 're', body: 'ok', threadId: 't1' } })
    );
    expect(reply.text).toContain('↩︎ <i>Reply</i>');
  });

  it('falls back to stripped HTML body when only htmlBody is present', () => {
    const approval = makeApproval({
      arguments: {
        to: ['a@x.com'],
        subject: 's',
        htmlBody: '<p>Hello</p><br><b>World</b>',
      },
    });
    const { text } = formatEmailApprovalMessage(approval);
    expect(text).toContain('Hello');
    expect(text).toContain('World');
    // Tags were stripped, so no raw markup from htmlBody leaks through.
    expect(text).not.toContain('<p>');
  });

  it('truncates very long bodies within the Telegram limit', () => {
    const approval = makeApproval({
      arguments: { to: ['a@x.com'], subject: 's', body: 'x'.repeat(5000) },
    });
    const { text } = formatEmailApprovalMessage(approval);
    expect(text).toContain('…(truncated)');
    expect(text.length).toBeLessThan(4096);
  });
});
