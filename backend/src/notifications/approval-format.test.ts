import { describe, it, expect } from 'vitest';
import { formatHermeneutixApprovalMessage } from './approval-format.js';

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
