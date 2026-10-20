import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import ThreadTimeline from './ThreadTimeline';
import type { ThreadItem } from '../api/client';

const now = new Date('2026-10-19T12:00:00.000Z');

function item(over: Partial<ThreadItem>): ThreadItem {
  return {
    id: 'i',
    threadId: 't1',
    kind: 'event',
    title: 'Item',
    body: null,
    occurredAt: null,
    dueAt: null,
    remindAt: null,
    status: 'open',
    nudgeFiredAt: null,
    firedAt: null,
    acknowledgedAt: null,
    memoryEntryId: null,
    sourceType: null,
    sourceRef: null,
    createdAt: '2026-10-01T00:00:00.000Z',
    ...over,
  };
}

describe('ThreadTimeline', () => {
  it('puts events left of Today and deadlines right of it', () => {
    render(
      <ThreadTimeline
        now={now}
        items={[
          item({ id: 'e2', title: 'Second call', occurredAt: '2026-10-10T00:00:00.000Z' }),
          item({ id: 'e1', title: 'First call', occurredAt: '2026-10-02T00:00:00.000Z' }),
          item({ id: 'd2', kind: 'deadline', title: 'Later deadline', dueAt: '2026-12-01T00:00:00.000Z' }),
          item({ id: 'd1', kind: 'todo', title: 'Sooner todo', dueAt: '2026-10-25T00:00:00.000Z' }),
          item({ id: 'x', kind: 'deadline', title: 'Done deadline', dueAt: '2026-10-22T00:00:00.000Z', status: 'done' }),
          item({ id: 'n', kind: 'todo', title: 'No date todo' }),
        ]}
      />
    );

    expect(screen.getByText('Today')).toBeInTheDocument();
    const nodes = screen.getAllByTestId('timeline-item');
    expect(nodes.map((n) => [n.getAttribute('data-side'), n.textContent])).toEqual([
      ['past', expect.stringContaining('First call')],
      ['past', expect.stringContaining('Second call')],
      ['future', expect.stringContaining('Sooner todo')],
      ['future', expect.stringContaining('Later deadline')],
    ]);
  });

  it('renders at most 20 items', () => {
    const many = Array.from({ length: 30 }, (_, i) =>
      item({ id: `e${i}`, title: `Event ${i}`, occurredAt: `2026-09-${String((i % 28) + 1).padStart(2, '0')}T00:00:00.000Z` })
    );
    render(<ThreadTimeline now={now} items={many} />);
    expect(screen.getAllByTestId('timeline-item').length).toBeLessThanOrEqual(20);
  });
});
