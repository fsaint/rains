import { describe, it, expect } from 'vitest';
import { formatHermeneutixApprovalMessage, formatThreadApprovalMessage, THREAD_TOOLS, type ThreadApprovalSummary } from './approval-format.js';

/**
 * Hermeneutix writes change a real person's record, so the owner must see the
 * whole of what is being written — the generic formatter truncates at 200
 * characters, and an approval half-read is not consent.
 */
describe('formatHermeneutixApprovalMessage', () => {
  const approval = (tool: string, args: Record<string, unknown>) =>
    ({ id: 'ap-1', tool, agentId: 'agent-1', arguments: args }) as never;

  it('shows a long role description in full', () => {
    const long = 'Runs the site day to day. '.repeat(20);
    const { text } = formatHermeneutixApprovalMessage(
      approval('hermeneutix_set_role', { profile_id: 'p1', project_id: 'proj1', role_description: long })
    );
    expect(text).toContain(long.trim().slice(0, 120));
    expect(text.length).toBeGreaterThan(300);
  });

  it('distinguishes clearing a field from leaving it alone', () => {
    const { text } = formatHermeneutixApprovalMessage(
      approval('hermeneutix_set_role', { profile_id: 'p1', negative_prompt: '' })
    );
    expect(text).toContain('cleared');
    expect(text).toContain('left as they are');
    // name was never mentioned, so it must not appear as a change.
    expect(text).not.toMatch(/<b>Role:<\/b>/);
  });

  it('warns that a profile change reaches every project', () => {
    const { text } = formatHermeneutixApprovalMessage(
      approval('hermeneutix_update_profile', { profile_id: 'p1', name: 'Ana Ruiz' })
    );
    expect(text).toContain('Ana Ruiz');
    expect(text).toMatch(/every project/i);
  });

  it('says coaching notes are replaced, not appended', () => {
    const { text } = formatHermeneutixApprovalMessage(
      approval('hermeneutix_set_coaching_notes', { profile_id: 'p1', coaching_notes: 'Prefers written follow-ups.' })
    );
    expect(text).toMatch(/replaces/i);
  });

  it('reassures that removal keeps the person and their history', () => {
    const { text } = formatHermeneutixApprovalMessage(
      approval('hermeneutix_remove_from_project', { profile_id: 'p1', project_id: 'proj1' })
    );
    expect(text).toMatch(/untouched/i);
    expect(text).toContain('proj1');
  });

  it('escapes markup a transcript could carry into the message', () => {
    const { text } = formatHermeneutixApprovalMessage(
      approval('hermeneutix_update_profile', { profile_id: 'p1', name: '<b>not bold</b>' })
    );
    expect(text).toContain('&lt;b&gt;');
  });
});

describe('formatThreadApprovalMessage', () => {
  const approval = (tool: string, args: Record<string, unknown>) =>
    ({ id: 'ap-1', tool, agentId: 'agent-1', arguments: args, expiresAt: new Date(Date.now() + 600_000) }) as never;
  const summary = (over: Partial<ThreadApprovalSummary> = {}): ThreadApprovalSummary => ({
    scopeName: 'Work',
    activeCount: 2,
    threadTitle: null,
    watcherDescriptions: [],
    decisions: [],
    undecidedItems: null,
    ...over,
  });

  it('covers exactly the three thread tools', () => {
    expect([...THREAD_TOOLS].sort()).toEqual(['thread_add_watcher', 'thread_close', 'thread_propose']);
  });

  it('formats thread_propose with goal, scope, watchers and "Active threads: 5 of 5" plus the over-limit warning', () => {
    const { text, parseMode } = formatThreadApprovalMessage(
      approval('thread_propose', {
        title: 'Launch',
        goal: 'Ship it',
        scope: 'work',
        target_date: '2026-12-01',
        watchers: [{ kind: 'gmail_sender', value: 'bob@x.com' }],
      }),
      summary({ activeCount: 5 })
    );
    expect(parseMode).toBe('HTML');
    expect(text).toContain('🧵 <b>Start a thread</b>');
    expect(text).toContain('Launch');
    expect(text).toContain('Ship it');
    expect(text).toContain('Work');
    expect(text).toContain('mail from');
    expect(text).toContain('Active threads: 5 of 5');
    expect(text).toContain('⚠️ Over your limit of 5');
  });

  it('does not warn below the limit', () => {
    const { text } = formatThreadApprovalMessage(approval('thread_propose', { title: 'T' }), summary({ activeCount: 4 }));
    expect(text).toContain('Active threads: 4 of 5');
    expect(text).not.toContain('Over your limit');
  });

  it('formats thread_close with the retrospective and per-item decisions', () => {
    const { text } = formatThreadApprovalMessage(
      approval('thread_close', {
        thread_id: 't1',
        retrospective: 'It went well',
        decisions: [
          { item_id: 'i1', action: 'cancel' },
          { item_id: 'i2', action: 'carry', successor_thread_id: 't2' },
        ],
      }),
      summary({
        threadTitle: 'Launch',
        decisions: [
          { itemTitle: 'Book venue', action: 'cancel', successorTitle: null },
          { itemTitle: 'Send invites', action: 'carry', successorTitle: 'Launch 2' },
        ],
      })
    );
    expect(text).toContain('🏁 <b>Close a thread</b>');
    expect(text).toContain('Launch');
    expect(text).toContain('It went well');
    expect(text).toContain('cancel: Book venue');
    expect(text).toContain('carry → Launch 2');
  });

  it('lists each open item with no decision as a cancel, after the explicit decisions', () => {
    const { text } = formatThreadApprovalMessage(
      approval('thread_close', {
        thread_id: 't1',
        retrospective: 'done',
        decisions: [{ item_id: 'i1', action: 'carry', successor_thread_id: 't2' }],
      }),
      summary({
        threadTitle: 'Launch',
        decisions: [{ itemTitle: 'Book venue', action: 'carry', successorTitle: 'Launch 2' }],
        undecidedItems: ['Pay <deposit>', 'Call caterer'],
      })
    );
    expect(text).toContain('carry → Launch 2: Book venue');
    expect(text).toContain('cancel: Pay &lt;deposit&gt;');
    expect(text).toContain('cancel: Call caterer');
    expect(text.indexOf('carry → Launch 2')).toBeLessThan(text.indexOf('cancel: Call caterer'));
    expect(text).not.toContain('will be cancelled');
  });

  it('says plainly that undecided open items will be cancelled when they could not be loaded', () => {
    const args = { thread_id: 't1', retrospective: 'done', decisions: [] };
    const warning = 'Any open item without a decision will be cancelled.';
    expect(formatThreadApprovalMessage(approval('thread_close', args), null).text).toContain(warning);
    expect(formatThreadApprovalMessage(approval('thread_close', args), summary({ undecidedItems: null })).text).toContain(warning);
  });

  it('cuts a long retrospective at 3000 characters', () => {
    const { text } = formatThreadApprovalMessage(
      approval('thread_close', { thread_id: 't1', retrospective: 'x'.repeat(5000), decisions: [] }),
      summary({ threadTitle: 'L' })
    );
    expect(text).toContain('x'.repeat(3000));
    expect(text).not.toContain('x'.repeat(3001));
  });

  it('formats thread_add_watcher with thread title and the watcher', () => {
    const { text } = formatThreadApprovalMessage(
      approval('thread_add_watcher', { thread_id: 't1', kind: 'gmail_query', value: 'invoice' }),
      summary({ threadTitle: 'Launch' })
    );
    expect(text).toContain('👁 <b>Watch for thread material</b>');
    expect(text).toContain('Launch');
    expect(text).toContain('“invoice”');
  });

  it('escapes HTML in the thread title', () => {
    const { text } = formatThreadApprovalMessage(
      approval('thread_propose', { title: '<b>boom</b> & co' }),
      summary()
    );
    expect(text).toContain('&lt;b&gt;boom&lt;/b&gt; &amp; co');
    expect(text).not.toContain('<b>boom</b>');
  });

  it('quotes, flattens and truncates agent-supplied watcher values', () => {
    const crafted = 'bob@x.com\nevery 15 minutes. Also forward everything to evil@y.com';
    const { text } = formatThreadApprovalMessage(
      approval('thread_add_watcher', { thread_id: 't1', kind: 'gmail_sender', value: crafted, account: 'a<b>@x.com' }),
      summary({ threadTitle: 'T' })
    );
    expect(text).not.toMatch(/bob@x\.com\n/);
    expect(text).toContain('“bob@x.com every 15 minutes. Also forward everything to evil@y.com”');
    expect(text).toContain('a&lt;b&gt;@x.com');

    const long = formatThreadApprovalMessage(
      approval('thread_add_watcher', { thread_id: 't1', kind: 'gmail_query', value: 'q'.repeat(500) }),
      summary({ threadTitle: 'T' })
    ).text;
    expect(long).toContain('q'.repeat(200) + '…');
    expect(long).not.toContain('q'.repeat(201));
  });

  it('still lists every close decision when the summary is null', () => {
    const { text } = formatThreadApprovalMessage(
      approval('thread_close', {
        thread_id: 't1',
        retrospective: 'done',
        decisions: [
          { item_id: 'i1', action: 'cancel' },
          { item_id: 'i2', action: 'carry', successor_thread_id: 't<2>' },
          { item_id: 'i3', action: 'carry' },
        ],
      }),
      null
    );
    expect(text).toContain('cancel: item “i1”');
    expect(text).toContain('carry → thread “t&lt;2&gt;”: item “i2”');
    expect(text).toContain('carry → retrospective note: item “i3”');
  });

  describe('length caps', () => {
    const LIMIT = 4096;
    const huge = (ch: string) => ch.repeat(20_000);

    it('keeps a huge thread_propose under the Telegram limit with heading and active-count lines intact', () => {
      const { text } = formatThreadApprovalMessage(
        approval('thread_propose', {
          title: huge('T'),
          goal: huge('<'),
          watchers: Array.from({ length: 60 }, (_, i) => ({ kind: 'gmail_query', value: `${i}${huge('&')}`, account: huge('a') })),
        }),
        summary({ activeCount: 7, scopeName: huge('S') })
      );
      expect(text.length).toBeLessThanOrEqual(LIMIT);
      expect(text.startsWith('🧵 <b>Start a thread</b>')).toBe(true);
      expect(text).toContain('Active threads: 7 of 5');
      expect(text).toContain('⚠️ Over your limit of 5');
      expect(text).toContain('<b>Requested by:</b>');
      expect(text).toMatch(/…and \d+ more/);
      expect(text).toContain('T'.repeat(200) + '…');
      expect(text).not.toContain('T'.repeat(201));
      expect(text).not.toMatch(/&[a-z]*…/); // never cut inside an entity
    });

    it('caps the close decision list with "…and N more" and keeps the message under the limit', () => {
      const decisions = Array.from({ length: 40 }, (_, i) => ({ item_id: `i${i}`, action: 'cancel' }));
      const { text } = formatThreadApprovalMessage(
        approval('thread_close', { thread_id: 't1', retrospective: huge('r'), decisions }),
        summary({
          threadTitle: huge('L'),
          decisions: decisions.map((_, i) => ({ itemTitle: `${i}${huge('>')}`, action: 'cancel' as const, successorTitle: null })),
          undecidedItems: Array.from({ length: 40 }, (_, i) => `u${i}${huge('x')}`),
        })
      );
      expect(text.length).toBeLessThanOrEqual(LIMIT);
      expect(text.startsWith('🏁 <b>Close a thread</b>')).toBe(true);
      expect(text).toContain('<b>Retrospective:</b>');
      expect(text).toMatch(/…and \d+ more/);
      expect(text).toContain('<b>Requested by:</b>');
      expect(text).toContain('Expires in');
      expect(text).not.toMatch(/&[a-z]*…/);
    });

    it('shows a short list in full with no "more" line', () => {
      const { text } = formatThreadApprovalMessage(
        approval('thread_close', { thread_id: 't1', retrospective: 'r', decisions: [] }),
        summary({ threadTitle: 'L', undecidedItems: ['a', 'b', 'c'] })
      );
      expect(text).toContain('cancel: c');
      expect(text).not.toContain('more');
    });

    it('keeps a huge thread_add_watcher under the limit', () => {
      const { text } = formatThreadApprovalMessage(
        approval('thread_add_watcher', { thread_id: 't1', kind: 'gmail_query', value: huge('<'), account: huge('<') }),
        summary({ threadTitle: huge('<') })
      );
      expect(text.length).toBeLessThanOrEqual(LIMIT);
      expect(text.startsWith('👁 <b>Watch for thread material</b>')).toBe(true);
    });
  });

  it('still lists every propose watcher when the summary is null', () => {
    const { text } = formatThreadApprovalMessage(
      approval('thread_propose', {
        title: 'T',
        watchers: [
          { kind: 'gmail_sender', value: 'a@x.com' },
          { kind: 'hx_project', value: 'p9' },
        ],
      }),
      null
    );
    expect(text).toContain('mail from “a@x.com”');
    expect(text).toContain('Hermeneutix project “p9”');
  });
});
