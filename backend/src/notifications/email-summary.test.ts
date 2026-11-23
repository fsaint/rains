/**
 * What an email approval would send, as shown on the approvals page and in
 * Telegram. Send-draft tools carry only an id, so these resolve the draft.
 */
import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest';

vi.mock('../db/index.js', () => ({
  client: { execute: vi.fn().mockResolvedValue({ rows: [] }) },
}));
vi.mock('../credentials/vault.js', () => ({
  credentialVault: { getValidAccessToken: vi.fn().mockResolvedValue('tok') },
}));

import { client } from '../db/index.js';
import {
  buildEmailApprovalSummary,
  resolveDraftSendSummary,
  resolveOutlookReplySummary,
  isEmailApprovalTool,
} from './email-summary.js';
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
    revision: 0,
    ...overrides,
  };
}

const INSTANCE = { credential_id: 'cred-1', is_default: 1, account_email: 'me@example.com' };

/** Route each SQL statement to rows; the credential lookup always finds one account. */
function dbRows(rowsFor: (sql: string) => unknown[]) {
  vi.mocked(client.execute).mockImplementation(async (q: unknown) => {
    const sql = typeof q === 'string' ? q : (q as { sql: string }).sql;
    if (sql.includes('agent_service_instances')) return { rows: [INSTANCE] } as never;
    return { rows: rowsFor(sql) } as never;
  });
}

function stubFetch(body: unknown, status = 200) {
  const fetchMock = vi.fn(async (_url: string, _init?: RequestInit) =>
    new Response(JSON.stringify(body), { status })
  );
  vi.stubGlobal('fetch', fetchMock);
  return fetchMock;
}

beforeEach(() => {
  vi.mocked(client.execute).mockReset();
  vi.mocked(client.execute).mockResolvedValue({ rows: [] } as never);
});
afterEach(() => {
  vi.unstubAllGlobals();
});

describe('isEmailApprovalTool', () => {
  it('covers sends, drafts, replies and both send-draft tools', () => {
    for (const tool of ['gmail_send_draft', 'outlook_mail_send_draft', 'outlook_mail_reply', 'gmail_create_draft']) {
      expect(isEmailApprovalTool(tool)).toBe(true);
    }
    expect(isEmailApprovalTool('drive_delete_file')).toBe(false);
  });
});

describe('buildEmailApprovalSummary from arguments', () => {
  it('reads recipients, subject and body straight from a send', async () => {
    const summary = await buildEmailApprovalSummary(
      makeApproval({
        arguments: { to: ['a@example.com', 'b@example.com'], subject: 'Hi', htmlBody: '<p>Hello</p>' },
      })
    );
    expect(summary).toMatchObject({ action: 'send', to: 'a@example.com, b@example.com', subject: 'Hi', body: 'Hello', resolved: true });
  });

  it('labels a draft save as not sending', async () => {
    const summary = await buildEmailApprovalSummary(
      makeApproval({ tool: 'outlook_mail_create_draft', arguments: { to: ['a@example.com'], subject: 'S' } })
    );
    expect(summary?.action).toBe('save_draft');
  });

  it('fills an Outlook reply with the message it answers', async () => {
    dbRows(() => []);
    const fetchMock = stubFetch({
      subject: 'Contract',
      from: { emailAddress: { name: 'Bob', address: 'bob@example.com' } },
    });
    const summary = await buildEmailApprovalSummary(
      makeApproval({ tool: 'outlook_mail_reply', arguments: { messageId: 'm-1', body: 'Sounds good' } })
    );
    expect(summary).toMatchObject({
      action: 'reply',
      to: 'Bob <bob@example.com>',
      subject: 'Re: Contract',
      body: 'Sounds good',
      inReplyTo: { subject: 'Contract', from: 'Bob <bob@example.com>' },
    });
    expect(String(fetchMock.mock.calls[0][0])).toContain('/me/messages/m-1');
  });

  it('returns null for a tool that is not an email', async () => {
    expect(await buildEmailApprovalSummary(makeApproval({ tool: 'drive_delete_file' }))).toBeNull();
  });
});

describe('Outlook reply recipients', () => {
  /** A message from Bob to me and Dan, Cc Ana and Carl. */
  const THREAD = {
    subject: 'Contract',
    from: { emailAddress: { name: 'Bob', address: 'bob@example.com' } },
    toRecipients: [
      { emailAddress: { name: 'Me', address: 'ME@example.com' } },
      { emailAddress: { address: 'dan@example.com' } },
    ],
    ccRecipients: [
      { emailAddress: { name: 'Ana', address: 'ana@example.com' } },
      { emailAddress: { address: 'carl@example.com' } },
    ],
  };

  const reply = (args: Record<string, unknown>) =>
    buildEmailApprovalSummary(
      makeApproval({ tool: 'outlook_mail_reply', arguments: { messageId: 'm-1', body: 'ok', ...args } })
    );

  it('lists everyone a default reply reaches, without the owner', async () => {
    dbRows(() => []);
    stubFetch(THREAD);

    expect(await reply({})).toMatchObject({
      action: 'reply',
      replyAll: true,
      to: 'Bob <bob@example.com>, dan@example.com',
      cc: 'Ana <ana@example.com>, carl@example.com',
    });
  });

  it('lists the sender only when replyAll is false', async () => {
    dbRows(() => []);
    stubFetch(THREAD);

    const summary = await reply({ replyAll: false });
    expect(summary).toMatchObject({ replyAll: false, to: 'Bob <bob@example.com>' });
    expect(summary?.cc).toBeUndefined();
  });

  it('adds the extra recipients to the thread, once each', async () => {
    dbRows(() => []);
    stubFetch(THREAD);

    expect(
      await reply({ to: ['eve@example.com'], cc: ['x@example.com', 'ANA@example.com', 'bob@example.com'], bcc: ['boss@example.com'] })
    ).toMatchObject({
      to: 'Bob <bob@example.com>, dan@example.com, eve@example.com',
      cc: 'Ana <ana@example.com>, carl@example.com, x@example.com',
      bcc: 'boss@example.com',
    });
  });

  it('answers the Reply-To address when the message sets one', async () => {
    dbRows(() => []);
    stubFetch({ ...THREAD, replyTo: [{ emailAddress: { address: 'list@example.com' } }] });

    expect((await reply({ replyAll: false }))?.to).toBe('list@example.com');
  });

  it('flags a thread whose recipients could not be loaded', async () => {
    dbRows(() => []);
    stubFetch({ error: { message: 'gone' } }, 404);

    expect(await reply({ cc: ['x@example.com'] })).toMatchObject({
      action: 'reply',
      replyAll: true,
      recipientsUnresolved: true,
      cc: 'x@example.com',
      body: 'ok',
    });
  });

  it('gives Telegram the same recipients', async () => {
    dbRows(() => []);
    stubFetch(THREAD);

    const summary = await resolveOutlookReplySummary(
      makeApproval({ tool: 'outlook_mail_reply', arguments: { messageId: 'm-1', body: 'ok', cc: ['x@example.com'] } })
    );
    expect(summary).toMatchObject({
      replyAll: true,
      resolved: true,
      to: 'Bob <bob@example.com>, dan@example.com',
      cc: 'Ana <ana@example.com>, carl@example.com, x@example.com',
      subject: 'Re: Contract',
    });
  });
});

describe('Outlook send-draft', () => {
  it('reads the draft live from Graph as text', async () => {
    dbRows(() => []);
    const fetchMock = stubFetch({
      subject: 'Quote for Q4',
      toRecipients: [{ emailAddress: { name: 'Ana', address: 'ana@example.com' } }],
      ccRecipients: [{ emailAddress: { address: 'cc@example.com' } }],
      body: { contentType: 'text', content: 'Hi Ana\n' },
    });

    const summary = await buildEmailApprovalSummary(
      makeApproval({ tool: 'outlook_mail_send_draft', arguments: { messageId: 'AAMk=' } })
    );

    expect(summary).toMatchObject({
      action: 'send_draft',
      draftId: 'AAMk=',
      to: 'Ana <ana@example.com>',
      cc: 'cc@example.com',
      subject: 'Quote for Q4',
      body: 'Hi Ana',
      resolved: true,
      source: 'outlook',
    });
    const [url, init] = fetchMock.mock.calls[0];
    expect(String(url)).toContain('/me/messages/AAMk%3D');
    expect((init?.headers as Record<string, string>).Prefer).toContain('text');
  });

  it('is unresolved, not an error, when Graph refuses', async () => {
    dbRows(() => []);
    stubFetch({ error: 'nope' }, 404);
    const summary = await buildEmailApprovalSummary(
      makeApproval({ tool: 'outlook_mail_send_draft', arguments: { messageId: 'm-1' } })
    );
    expect(summary).toMatchObject({ action: 'send_draft', resolved: false, draftId: 'm-1' });
  });
});

/**
 * The send-draft preview replays the arguments of the approval that created
 * the draft. Once a draft can be edited, those arguments describe a version
 * that no longer exists — and the owner would approve a send while reading
 * the old text.
 */
describe('Gmail send-draft', () => {
  const CREATED = {
    id: 'job-1',
    tool: 'gmail_create_draft',
    agent_id: 'agent-abc',
    arguments_json: JSON.stringify({ to: ['ana@example.com'], subject: 'Quote v1', body: 'Old text' }),
    result_json: JSON.stringify({ data: { draftId: 'r-1' } }),
  };

  const sendDraft = makeApproval({ tool: 'gmail_send_draft', arguments: { draftId: 'r-1' } });

  function stubGmailDraft(payload: unknown = { headers: [{ name: 'Subject', value: 'Quote v3' }] }) {
    return stubFetch({ message: { snippet: 'New text', payload } });
  }

  it('still replays the creating approval for a draft that was never edited', async () => {
    const fetchMock = stubGmailDraft();
    dbRows((sql) => (sql.includes('gmail_update_draft') ? [] : sql.includes('result_json LIKE') ? [CREATED] : []));

    const summary = await resolveDraftSendSummary(sendDraft);

    expect(summary?.subject).toBe('Quote v1');
    expect(summary?.resolvedFrom).toBe('creation-approval');
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('reads the draft live from Gmail once it has been edited', async () => {
    const fetchMock = stubGmailDraft();
    dbRows((sql) =>
      sql.includes('gmail_update_draft') ? [{ edited: 1 }] : sql.includes('result_json LIKE') ? [CREATED] : []
    );

    const summary = await resolveDraftSendSummary(sendDraft);

    expect(summary?.subject).toBe('Quote v3');
    expect(summary?.bodyPreview).toBe('New text');
    expect(summary?.resolvedFrom).toBe('gmail');
    expect(String(fetchMock.mock.calls[0][0])).toContain('/drafts/r-1');
  });

  it('reads the full text body, not just the snippet, for a draft created without approval', async () => {
    const full = 'Line one of a long draft.\nLine two that the snippet would cut.';
    stubGmailDraft({
      headers: [{ name: 'To', value: 'ana@example.com' }, { name: 'Subject', value: 'Unattended' }],
      mimeType: 'multipart/alternative',
      parts: [
        { mimeType: 'text/plain', body: { data: Buffer.from(full).toString('base64url') } },
        { mimeType: 'text/html', body: { data: Buffer.from('<p>html</p>').toString('base64url') } },
      ],
    });
    dbRows(() => []);

    const summary = await resolveDraftSendSummary(sendDraft);

    expect(summary).toMatchObject({ to: 'ana@example.com', subject: 'Unattended', bodyPreview: full, resolvedFrom: 'gmail' });
  });
});
