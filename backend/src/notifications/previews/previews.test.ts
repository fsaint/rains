/**
 * Previews for Drive, Linear, Zendesk, Notion, GitHub and Pipedrive writes,
 * and the check that no approval-requiring tool is left without one.
 */
import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest';

vi.mock('../../db/index.js', () => ({
  client: { execute: vi.fn() },
}));
vi.mock('../../credentials/vault.js', () => ({
  credentialVault: {
    getValidAccessToken: vi.fn().mockResolvedValue('tok'),
    retrieve: vi.fn(),
  },
}));

import { serviceDefinitions } from '@reins/servers';
import { client } from '../../db/index.js';
import { credentialVault } from '../../credentials/vault.js';
import {
  ADMIN_TOOLS,
  CALENDAR_TOOLS,
  DRAFT_DELETE_TOOLS,
  DRAFT_SEND_TOOLS,
  EMAIL_TOOLS,
  HERMENEUTIX_PEOPLE_TOOLS,
  SKILL_TOOLS,
  THREAD_TOOLS,
} from '../approval-format.js';
import { hasApprovalPreview, resolveApprovalPreview } from './index.js';
import { notionValue } from './notion.js';
import { makeApproval, routeFetch } from './test-helpers.js';

const INSTANCE = { credential_id: 'cred-1', is_default: 1, account_email: 'me@example.com' };

beforeEach(() => {
  vi.mocked(client.execute).mockReset();
  vi.mocked(client.execute).mockResolvedValue({ rows: [INSTANCE] } as never);
  vi.mocked(credentialVault.retrieve).mockResolvedValue({
    serviceId: 'x',
    type: 'oauth2',
    data: { accessToken: 'tok', subdomain: 'acme', email: 'me@example.com', companydomain: 'acme' },
  } as never);
});
afterEach(() => {
  vi.unstubAllGlobals();
});

const preview = (tool: string, args: Record<string, unknown>) =>
  resolveApprovalPreview(makeApproval({ tool, arguments: args }));

describe('coverage', () => {
  // Writes that run without approval by default and act only inside Helm, and
  // tools whose arguments are already the whole story.
  const NO_PREVIEW_NEEDED = /^(memory_|thread_|skills_|browser_|sandbox_|web_search)/;

  it('every tool that can ask for approval has a preview', () => {
    const dedicated = [
      EMAIL_TOOLS, CALENDAR_TOOLS, DRAFT_SEND_TOOLS, DRAFT_DELETE_TOOLS,
      HERMENEUTIX_PEOPLE_TOOLS, ADMIN_TOOLS, SKILL_TOOLS, THREAD_TOOLS,
    ];
    const missing = serviceDefinitions
      .flatMap((definition) => [...definition.permissions.write, ...definition.permissions.blocked])
      .filter((tool) => !NO_PREVIEW_NEEDED.test(tool))
      .filter((tool) => !dedicated.some((set) => set.has(tool)) && !hasApprovalPreview(tool));

    expect(missing).toEqual([]);
  });
});

describe('Drive', () => {
  const FILE = {
    name: 'Q4 plan.docx',
    mimeType: 'application/vnd.google-apps.document',
    parents: ['folder-1'],
    size: '2048',
    modifiedTime: '2026-11-20T10:00:00Z',
    shared: true,
    owners: [{ displayName: 'Felipe' }],
  };
  const routes: Array<[string, unknown]> = [
    ['/files/file-1?', FILE],
    ['/files/folder-1?', { name: 'Planning' }],
    ['/files/folder-2?', { name: 'Archive' }],
  ];

  it('names the folder a new file goes into and shows its content', async () => {
    routeFetch(routes);
    expect(
      await preview('drive_create_file', { name: 'notes.md', mimeType: 'text/markdown', content: '# Notes', parentId: 'folder-1' })
    ).toMatchObject({
      heading: 'Create file in Drive',
      rows: [
        { label: 'Name', value: 'notes.md' },
        { label: 'Folder', value: 'Planning' },
        { label: 'Type', value: 'Markdown file' },
      ],
      body: { label: 'Content (7 B)', text: '# Notes' },
    });
  });

  it('defaults a new file to My Drive and describes a staged upload', async () => {
    routeFetch(routes);
    const result = await preview('drive_create_file', { file: { source: 'upload', uploadId: 'u1' } });
    expect(result?.rows).toEqual([
      { label: 'Name', value: '(named after the source file)' },
      { label: 'Folder', value: 'My Drive' },
      { label: 'Content', value: 'A file uploaded from your machine' },
    ]);
  });

  it('names the file an update overwrites, renames and moves', async () => {
    routeFetch(routes);
    expect(
      await preview('drive_update_file', {
        fileId: 'file-1', name: 'Q4 plan (final)', content: 'new text', addParents: ['folder-2'], removeParents: ['folder-1'],
      })
    ).toMatchObject({
      heading: 'Update file',
      note: "Replaces the file's content.",
      rows: [
        { label: 'Name', value: 'Q4 plan (final)', was: 'Q4 plan.docx' },
        { label: 'Type', value: 'Google Doc' },
        { label: 'In', value: 'Planning' },
        { label: 'Move into', value: 'Archive' },
        { label: 'Take out of', value: 'Planning' },
      ],
      body: { text: 'new text' },
    });
  });

  it('flags a link share as open to anyone', async () => {
    routeFetch(routes);
    expect(await preview('drive_share_file', { fileId: 'file-1', role: 'writer', type: 'anyone' })).toMatchObject({
      heading: 'Share file',
      destructive: true,
      note: 'Anyone who has the link can open this, signed in or not.',
      rows: expect.arrayContaining([
        { label: 'File', value: 'Q4 plan.docx' },
        { label: 'With', value: 'Anyone with the link' },
        { label: 'Access', value: 'Can edit' },
      ]),
    });
  });

  it('names the person a file is shared with', async () => {
    routeFetch(routes);
    const result = await preview('drive_share_file', {
      fileId: 'file-1', role: 'reader', type: 'user', email: 'ana@example.com', sendNotification: false,
    });
    expect(result?.destructive).toBeUndefined();
    expect(result?.rows).toEqual(
      expect.arrayContaining([
        { label: 'With', value: 'ana@example.com' },
        { label: 'Access', value: 'Can view' },
        { label: 'Notify', value: 'No email is sent' },
      ])
    );
  });

  it('distinguishes trash from permanent delete', async () => {
    routeFetch(routes);
    const trash = await preview('drive_delete_file', { fileId: 'file-1' });
    expect(trash).toMatchObject({ heading: 'Move file to trash', destructive: false });
    expect(trash?.rows).toEqual(
      expect.arrayContaining([
        { label: 'Owner', value: 'Felipe' },
        { label: 'Size', value: '2.0 KB' },
        { label: 'Last changed', value: 'Nov 20, 2026' },
        { label: 'Shared', value: 'Yes — others lose access' },
      ])
    );

    const gone = await preview('drive_delete_file', { fileId: 'file-1', permanent: true });
    expect(gone).toMatchObject({ heading: 'Delete file permanently', destructive: true });
  });

  it('warns and shows the id when the file cannot be read', async () => {
    routeFetch([]);
    expect(await preview('drive_delete_file', { fileId: 'file-9' })).toMatchObject({
      rows: [{ label: 'File', value: 'file-9' }],
      warning: 'Could not load this file. Approve only if you recognise its id.',
    });
  });
});

describe('Linear', () => {
  const ISSUE = {
    identifier: 'ENG-12',
    title: 'Fix login',
    priority: 3,
    estimate: 2,
    state: { name: 'Todo' },
    assignee: { name: 'Ana' },
    project: null,
    team: { name: 'Engineering' },
    labels: { nodes: [{ name: 'bug' }] },
  };

  it('shows an update against the issue, with ids resolved to names', async () => {
    const calls = routeFetch([
      ['linear.app/graphql', { data: { issue: ISSUE, state: { name: 'In Progress' }, assignee: { name: 'Ana' }, label0: { name: 'urgent' } } }],
    ]);

    const result = await preview('linear_update_issue', {
      issueId: 'uuid-1', stateId: 'state-2', assigneeId: 'user-1', priority: 1, labelIds: ['lab-1'],
    });

    expect(result).toMatchObject({
      heading: 'Update ENG-12',
      rows: [
        { label: 'Issue', value: 'ENG-12 Fix login' },
        { label: 'Status', value: 'In Progress', was: 'Todo' },
        // The assignee does not change, so it is not listed.
        { label: 'Priority', value: 'Urgent', was: 'Medium' },
        { label: 'Labels', value: 'urgent', was: 'bug' },
      ],
    });
    expect(calls).toHaveLength(1);
    expect(calls[0].headers.Authorization).toBe('tok');
    // Ids travel as variables, never spliced into the query.
    const sent = calls[0].body as { query: string; variables: Record<string, string> };
    expect(sent.variables).toMatchObject({ issue: 'uuid-1', state: 'state-2', label0: 'lab-1' });
    expect(sent.query).not.toContain('uuid-1');
  });

  it('names the team and project of a new issue', async () => {
    routeFetch([['linear.app/graphql', { data: { team: { name: 'Engineering' }, project: { name: 'Q4' } } }]]);
    expect(
      await preview('linear_create_issue', { teamId: 't1', projectId: 'p1', title: 'New thing', priority: 2, description: 'Details' })
    ).toMatchObject({
      heading: 'Create Linear issue',
      rows: [
        { label: 'Team', value: 'Engineering' },
        { label: 'Title', value: 'New thing' },
        { label: 'Priority', value: 'High' },
        { label: 'Project', value: 'Q4' },
      ],
      body: { label: 'Description', text: 'Details' },
    });
  });

  it('shows the issue a comment lands on', async () => {
    routeFetch([['linear.app/graphql', { data: { issue: ISSUE } }]]);
    expect(await preview('linear_comment_on_issue', { issueId: 'uuid-1', body: 'On it' })).toMatchObject({
      heading: 'Comment on ENG-12',
      rows: [{ label: 'Issue', value: 'ENG-12 Fix login' }],
      body: { label: 'Comment', text: 'On it' },
    });
  });

  it('marks a delete destructive and falls back to ids when Linear is unreachable', async () => {
    routeFetch([]);
    expect(await preview('linear_delete_issue', { issueId: 'uuid-1' })).toMatchObject({
      destructive: true,
      rows: [{ label: 'Issue', value: 'uuid-1' }],
      warning: 'Could not load this issue. Approve only if you recognise its id.',
    });
  });
});

describe('Zendesk', () => {
  const TICKET = {
    ticket: { subject: 'Refund request', status: 'open', priority: 'normal', requester_id: 7, assignee_id: 8, tags: ['billing'] },
    users: [
      { id: 7, name: 'Customer Carl', email: 'carl@example.com' },
      { id: 8, name: 'Agent Ana', email: 'ana@example.com' },
    ],
  };

  it('shows the ticket, what changes, and that a reply is public', async () => {
    const calls = routeFetch([['acme.zendesk.com/api/v2/tickets/42.json', TICKET]]);

    const result = await preview('zendesk_update_ticket', { ticket_id: 42, status: 'solved', priority: 'normal', comment: 'Refunded.' });

    expect(result).toMatchObject({
      heading: 'Update ticket #42',
      note: 'The reply is public: the requester will receive it.',
      destructive: true,
      rows: [
        { label: 'Ticket', value: '#42 Refund request' },
        { label: 'Requester', value: 'Customer Carl · carl@example.com' },
        { label: 'Status', value: 'Solved', was: 'Open' },
      ],
      body: { label: 'Public reply', text: 'Refunded.' },
    });
    expect(calls[0].headers.Authorization).toBe(`Basic ${Buffer.from('me@example.com/token:tok').toString('base64')}`);
  });

  it('labels an internal note as internal', async () => {
    routeFetch([['/tickets/42.json', TICKET]]);
    const result = await preview('zendesk_update_ticket', { ticket_id: 42, comment: 'Checking', comment_public: false });
    expect(result?.body?.label).toBe('Internal note');
    expect(result?.destructive).toBeUndefined();
  });

  it('refuses to build a host from a malformed subdomain', async () => {
    vi.mocked(credentialVault.retrieve).mockResolvedValue({
      data: { subdomain: 'evil.example.com/x', email: 'me@example.com' },
    } as never);
    const calls = routeFetch([]);
    const result = await preview('zendesk_update_ticket', { ticket_id: 42, status: 'solved' });
    expect(calls).toHaveLength(0);
    expect(result?.warning).toContain('Could not load this ticket');
  });

  it('shows a new ticket in full', async () => {
    expect(
      await preview('zendesk_create_ticket', { subject: 'Hello', body: 'Long body', requester_email: 'carl@example.com', tags: ['a', 'b'] })
    ).toMatchObject({
      heading: 'Create Zendesk ticket',
      rows: [
        { label: 'Subject', value: 'Hello' },
        { label: 'Requester', value: 'carl@example.com' },
        { label: 'Tags', value: 'a, b' },
      ],
      body: { label: 'First message', text: 'Long body' },
    });
  });
});

describe('Notion', () => {
  const PAGE = {
    parent: { database_id: 'db-1' },
    properties: {
      Name: { type: 'title', title: [{ plain_text: 'Launch plan' }] },
      Status: { type: 'status', status: { name: 'Draft' } },
      Due: { type: 'date', date: { start: '2026-12-01' } },
    },
  };
  const routes: Array<[string, unknown]> = [
    ['/pages/page-1', PAGE],
    ['/databases/db-1', { title: [{ plain_text: 'Projects' }] }],
  ];

  it('reads the property shapes Notion uses', () => {
    expect(notionValue({ title: [{ text: { content: 'Hi' } }] })).toBe('Hi');
    expect(notionValue({ multi_select: [{ name: 'a' }, { name: 'b' }] })).toBe('a, b');
    expect(notionValue({ checkbox: true })).toBe('Yes');
    expect(notionValue({ number: 0 })).toBe('0');
    expect(notionValue({ date: { start: '2026-12-01', end: '2026-12-03' } })).toBe('Dec 1, 2026 → Dec 3, 2026');
    expect(notionValue({ relation: [{ id: 'a' }, { id: 'b' }] })).toBe('2 linked pages');
  });

  it('shows an update against the page it changes', async () => {
    const calls = routeFetch(routes);
    const result = await preview('notion_update_page', {
      pageId: 'page-1',
      properties: { Status: { status: { name: 'Done' } }, Due: { date: { start: '2026-12-01' } } },
    });
    expect(result).toMatchObject({
      heading: 'Update Notion page',
      rows: [
        { label: 'Page', value: 'Launch plan' },
        { label: 'Database', value: 'Projects' },
        { label: 'Status', value: 'Done', was: 'Draft' },
      ],
    });
    expect(calls[0].headers['Notion-Version']).toBe('2022-06-28');
  });

  it('names the database a new page goes into', async () => {
    routeFetch(routes);
    expect(
      await preview('notion_create_page', {
        databaseId: 'db-1',
        properties: { Name: { title: [{ text: { content: 'New' } }] } },
        children: [{}, {}],
      })
    ).toMatchObject({
      rows: [
        { label: 'Database', value: 'Projects' },
        { label: 'Name', value: 'New' },
        { label: 'Page content', value: '2 blocks' },
      ],
    });
  });

  it('names the page an archive removes', async () => {
    routeFetch(routes);
    expect(await preview('notion_archive_page', { pageId: 'page-1' })).toMatchObject({
      heading: 'Archive Notion page',
      rows: [{ label: 'Page', value: 'Launch plan' }, { label: 'Database', value: 'Projects' }],
    });
  });
});

describe('GitHub', () => {
  const repo = { owner: 'acme', repo: 'site' };

  it('shows the whole file a write commits', async () => {
    const content = 'x'.repeat(5000);
    const result = await preview('github_create_or_update_file', {
      ...repo, path: 'src/app.ts', content, message: 'Fix bug', branch: 'main', sha: 'abc',
    });
    expect(result).toMatchObject({
      heading: 'Replace a file on GitHub',
      rows: [
        { label: 'Repository', value: 'acme/site' },
        { label: 'File', value: 'src/app.ts' },
        { label: 'Branch', value: 'main' },
        { label: 'Commit message', value: 'Fix bug' },
      ],
    });
    expect(result?.body?.text).toHaveLength(5000);
  });

  it('names the commit a branch moves to and flags a force', async () => {
    routeFetch([['/repos/acme/site/commits/', { commit: { message: 'Rewrite history\n\nbody', author: { name: 'Ana' } } }]]);
    const sha = 'a'.repeat(40);

    const forced = await preview('github_update_ref', { ...repo, ref: 'heads/main', sha, force: true });
    expect(forced).toMatchObject({
      heading: 'Force-move main',
      destructive: true,
      rows: [
        { label: 'Repository', value: 'acme/site' },
        { label: 'Branch', value: 'main' },
        { label: 'Move to', value: 'aaaaaaa — Rewrite history' },
        { label: 'Commit by', value: 'Ana' },
      ],
    });

    const normal = await preview('github_update_ref', { ...repo, ref: 'refs/heads/feature/x', sha });
    expect(normal?.heading).toBe('Move feature/x to a new commit');
    expect(normal?.destructive).toBeUndefined();
  });

  it('names the issue or pull request a comment lands on', async () => {
    routeFetch([['/repos/acme/site/issues/7', { title: 'Add dark mode', pull_request: {} }]]);
    expect(await preview('github_comment_on_issue', { ...repo, issueNumber: 7, body: 'LGTM' })).toMatchObject({
      heading: 'Comment on pull request #7',
      rows: [{ label: 'Repository', value: 'acme/site' }, { label: 'Pull request', value: '#7 Add dark mode' }],
      body: { label: 'Comment', text: 'LGTM' },
    });
  });

  it('lists the files in a tree and describes the rest', async () => {
    const tree = await preview('github_create_tree', { ...repo, files: [{ path: 'a.ts', content: 'abc' }, { path: 'b.ts', content: '' }] });
    expect(tree?.heading).toBe('Stage 2 files for a commit');
    expect(tree?.items?.list).toEqual([{ title: 'a.ts', detail: '3 B' }, { title: 'b.ts', detail: '0 B' }]);

    expect((await preview('github_create_pull_request', { ...repo, title: 'T', head: 'feat', base: 'main', draft: true }))?.rows).toEqual([
      { label: 'Repository', value: 'acme/site' },
      { label: 'Title', value: 'T' },
      { label: 'Merge', value: 'feat → main' },
      { label: 'Draft', value: 'Yes' },
    ]);
    expect((await preview('github_create_branch', { ...repo, branch: 'feat' }))?.rows[2]).toEqual({
      label: 'Starting from', value: 'the default branch',
    });
    expect((await preview('github_create_issue', { ...repo, title: 'Bug', body: 'Steps', labels: ['bug'] }))?.body?.text).toBe('Steps');
    expect((await preview('github_create_commit', { ...repo, message: 'm', tree: 't', parents: [] }))?.rows[3].value).toContain('root commit');
  });
});

describe('Pipedrive', () => {
  const routes: Array<[string, unknown]> = [
    ['/api/v1/deals/5', { data: { title: 'Acme renewal', value: 12000, status: 'open', stage_id: 2, person_id: { name: 'Bob', value: 9 }, org_id: { name: 'Acme', value: 3 } } }],
    ['/api/v1/stages/2', { data: { name: 'Proposal' } }],
    ['/api/v1/stages/4', { data: { name: 'Negotiation' } }],
    ['/api/v1/persons/9', { data: { name: 'Bob', email: [{ value: 'bob@example.com', primary: true }] } }],
    ['/api/v1/persons/11', { data: { name: 'Dora' } }],
    ['/api/v1/users/1', { data: { name: 'Felipe' } }],
  ];

  it('shows a deal update by name, with old and new values', async () => {
    const calls = routeFetch(routes);
    const result = await preview('pipedrive_update_deal', {
      deal_id: 5, stage_id: 4, value: 15000, status: 'open', person_id: 9, owner_id: 1, custom_fields: { abc123: 'x' },
    });
    expect(result).toMatchObject({
      heading: 'Update Pipedrive deal',
      rows: [
        { label: 'Deal', value: 'Acme renewal' },
        { label: 'Stage', value: 'Negotiation', was: 'Proposal' },
        { label: 'Value', value: '15000', was: '12000' },
        // status and person are unchanged, so they are not listed.
        { label: 'Owner', value: 'Felipe' },
        { label: 'Abc123', value: 'x' },
      ],
    });
    expect(calls[0].url).toBe('https://acme.pipedrive.com/api/v1/deals/5');
    expect(calls[0].headers['x-api-token']).toBe('tok');
  });

  it('shows what a delete removes', async () => {
    routeFetch(routes);
    expect(await preview('pipedrive_delete_deal', { deal_id: 5 })).toMatchObject({
      heading: 'Delete Pipedrive deal',
      destructive: true,
      rows: [
        { label: 'Deal', value: 'Acme renewal' },
        { label: 'Value', value: '12000' },
        { label: 'Status', value: 'open' },
        { label: 'Organization', value: 'Acme' },
        { label: 'Person', value: 'Bob' },
      ],
    });
  });

  it('resolves the records a new note and a participant point at', async () => {
    routeFetch(routes);
    expect(await preview('pipedrive_create_note', { content: '<p>Called Bob</p>', deal_id: 5 })).toMatchObject({
      heading: 'Create Pipedrive note',
      rows: [{ label: 'Deal', value: 'Acme renewal' }],
      body: { label: 'Content', text: 'Called Bob' },
    });
    expect(await preview('pipedrive_add_deal_participant', { deal_id: 5, person_id: 11 })).toMatchObject({
      heading: 'Add participant to deal',
      rows: [{ label: 'Deal', value: 'Acme renewal' }, { label: 'Person', value: 'Dora' }],
    });
  });

  it('warns when the record cannot be read and flags a new webhook', async () => {
    routeFetch([]);
    expect(await preview('pipedrive_delete_person', { person_id: 9 })).toMatchObject({
      rows: [{ label: 'Person', value: '#9' }],
      warning: 'Could not load this person. Approve only if you recognise its id.',
    });
    expect(await preview('pipedrive_create_webhook', { subscription_url: 'https://x.example/hook' })).toMatchObject({
      destructive: true,
      rows: [{ label: 'Subscription url', value: 'https://x.example/hook' }],
    });
  });
});
