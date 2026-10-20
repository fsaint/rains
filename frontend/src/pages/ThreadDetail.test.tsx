import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor, within } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter, Routes, Route } from 'react-router-dom';
import ThreadDetail from './ThreadDetail';

vi.mock('../api/client', () => ({
  threads: {
    brief: vi.fn(),
    list: vi.fn(),
    watchers: vi.fn(),
    acknowledge: vi.fn(),
    acceptCandidate: vi.fn(),
    dismissCandidate: vi.fn(),
    updateItem: vi.fn(),
    setStatus: vi.fn(),
    close: vi.fn(),
    removeWatcher: vi.fn(),
    openItems: vi.fn(),
  },
  ApiError: class ApiError extends Error {},
}));

import { threads } from '../api/client';

function renderPage() {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  return render(
    <MemoryRouter initialEntries={['/threads/t1']}>
      <QueryClientProvider client={queryClient}>
        <Routes>
          <Route path="/threads/:id" element={<ThreadDetail />} />
          <Route path="/threads" element={<div>Threads list</div>} />
        </Routes>
      </QueryClientProvider>
    </MemoryRouter>
  );
}

const baseItem = {
  threadId: 't1',
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
};

const thread = {
  id: 't1',
  userId: 'u1',
  scopeId: 's1',
  rootEntryId: 'root-1',
  title: 'Seed round',
  goal: 'Close the round',
  targetDate: null,
  status: 'active',
  approvalId: null,
  createdByAgentId: null,
  createdAt: '2026-10-01T00:00:00.000Z',
  updatedAt: '2026-10-18T00:00:00.000Z',
  closedAt: null,
};

const due = { ...baseItem, id: 'due1', kind: 'reminder', title: 'Call the lawyer', remindAt: '2026-10-19T08:00:00.000Z', firedAt: '2026-10-19T08:00:00.000Z' };
const todo = { ...baseItem, id: 'todo1', kind: 'todo', title: 'Send term sheet', dueAt: '2026-10-25T00:00:00.000Z' };
const deadline = { ...baseItem, id: 'dl1', kind: 'deadline', title: 'Wire deadline', dueAt: '2026-11-15T00:00:00.000Z' };
const event = { ...baseItem, id: 'ev1', kind: 'event', title: 'Kickoff call', occurredAt: '2026-10-05T00:00:00.000Z' };
const candidate = {
  id: 'c1', threadId: 't1', watcherId: 'w1', sourceType: 'gmail', sourceRef: 'm1',
  summary: 'Email from investor', foundAt: '2026-10-18T00:00:00.000Z', status: 'pending',
};
const milestone = { ...baseItem, id: 'ms1', kind: 'milestone', title: 'Undated milestone' };
const watcher = {
  id: 'w1', threadId: 't1', agentId: 'a1', kind: 'gmail_query', value: 'from:investor',
  account: null, createdAt: '2026-10-01T00:00:00.000Z', status: 'active', lastCheckedAt: null, description: 'Gmail matching from:investor',
};

function brief(over: Record<string, unknown> = {}, threadOver: Record<string, unknown> = {}) {
  return {
    thread: { ...thread, ...threadOver },
    sections: { Goal: 'Close the round', Past: '', Now: 'Waiting on **lawyer**', Next: 'Sign the term sheet', Retrospective: '' },
    events: [event],
    openTodos: [todo],
    upcoming: [todo, deadline],
    firedUnacknowledged: [due],
    pendingCandidates: [candidate],
    activeCount: 2,
    ...over,
  };
}

describe('ThreadDetail page', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(threads.brief).mockResolvedValue(brief() as never);
    vi.mocked(threads.watchers).mockResolvedValue([watcher] as never);
    vi.mocked(threads.openItems).mockResolvedValue([todo, deadline, due, milestone] as never);
    vi.mocked(threads.list).mockResolvedValue([
      thread,
      { ...thread, id: 't2', title: 'Hire a CTO' },
    ] as never);
    vi.mocked(threads.acknowledge).mockResolvedValue(undefined as never);
    vi.mocked(threads.acceptCandidate).mockResolvedValue({} as never);
    vi.mocked(threads.dismissCandidate).mockResolvedValue(undefined as never);
    vi.mocked(threads.updateItem).mockResolvedValue({} as never);
    vi.mocked(threads.close).mockResolvedValue({} as never);
  });

  it('renders the header, Now card, lists, watchers and root link', async () => {
    renderPage();
    expect(await screen.findByRole('heading', { name: 'Seed round' })).toBeInTheDocument();
    expect(screen.getByText('active')).toBeInTheDocument();
    expect(screen.getByText('lawyer').tagName).toBe('STRONG');
    expect(screen.getByText('Sign the term sheet')).toBeInTheDocument();
    expect(screen.getAllByText('Send term sheet').length).toBeGreaterThan(0);
    expect(screen.getAllByText('Wire deadline').length).toBeGreaterThan(0);
    expect(await screen.findByText('Gmail matching from:investor')).toBeInTheDocument();
    expect(screen.getByRole('link', { name: /memory entry/i })).toHaveAttribute('href', '/memory/root-1');
  });

  it('Acknowledge on a due item calls threads.acknowledge', async () => {
    renderPage();
    await screen.findByText('Call the lawyer');
    fireEvent.click(screen.getByRole('button', { name: 'Acknowledge' }));
    await waitFor(() => expect(threads.acknowledge).toHaveBeenCalledWith('t1', 'due1'));
  });

  it('checking a todo marks it done', async () => {
    renderPage();
    fireEvent.click(await screen.findByRole('checkbox', { name: /Send term sheet/ }));
    await waitFor(() => expect(threads.updateItem).toHaveBeenCalledWith('t1', 'todo1', { status: 'done' }));
  });

  it('Accept on a candidate calls threads.acceptCandidate', async () => {
    renderPage();
    await screen.findByText('Email from investor');
    fireEvent.click(screen.getByRole('button', { name: 'Accept' }));
    await waitFor(() => expect(threads.acceptCandidate).toHaveBeenCalledWith('t1', 'c1'));
  });

  it('Dismiss on a candidate calls threads.dismissCandidate', async () => {
    renderPage();
    await screen.findByText('Email from investor');
    fireEvent.click(screen.getByRole('button', { name: 'Dismiss' }));
    await waitFor(() => expect(threads.dismissCandidate).toHaveBeenCalledWith('t1', 'c1'));
  });

  it('Pause calls setStatus', async () => {
    vi.mocked(threads.setStatus).mockResolvedValue({} as never);
    renderPage();
    fireEvent.click(await screen.findByRole('button', { name: 'Pause' }));
    await waitFor(() => expect(threads.setStatus).toHaveBeenCalledWith('t1', 'paused'));
  });

  it('Close dialog requires a retrospective and sends per-item decisions', async () => {
    renderPage();
    fireEvent.click(await screen.findByRole('button', { name: 'Close thread' }));
    const dialog = await screen.findByRole('dialog');
    const submit = within(dialog).getByRole('button', { name: 'Close thread' });
    expect(submit).toBeDisabled();

    fireEvent.change(within(dialog).getByLabelText('Retrospective'), { target: { value: 'Round closed.' } });
    expect(submit).not.toBeDisabled();

    await within(dialog).findAllByRole('option', { name: 'Hire a CTO' });
    fireEvent.change(within(dialog).getByLabelText('Send term sheet'), { target: { value: 'carry:t2' } });
    fireEvent.change(within(dialog).getByLabelText('Wire deadline'), { target: { value: 'cancel' } });
    fireEvent.click(submit);

    await waitFor(() =>
      expect(threads.close).toHaveBeenCalledWith('t1', {
        retrospective: 'Round closed.',
        decisions: expect.arrayContaining([
          { itemId: 'todo1', action: 'carry', successorThreadId: 't2' },
          { itemId: 'dl1', action: 'cancel' },
        ]),
      })
    );
    expect((vi.mocked(threads.close).mock.calls[0][1] as { decisions: unknown[] }).decisions).toHaveLength(4);
  });

  it('close dialog lists every open item, including an undated milestone', async () => {
    renderPage();
    fireEvent.click(await screen.findByRole('button', { name: 'Close thread' }));
    const dialog = await screen.findByRole('dialog');
    expect(await within(dialog).findByLabelText('Undated milestone')).toBeInTheDocument();
    expect(threads.openItems).toHaveBeenCalledWith('t1');
  });

  it('carry with no successor sends a bare carry (note in retrospective)', async () => {
    renderPage();
    fireEvent.click(await screen.findByRole('button', { name: 'Close thread' }));
    const dialog = await screen.findByRole('dialog');
    fireEvent.change(within(dialog).getByLabelText('Retrospective'), { target: { value: 'Done.' } });
    fireEvent.change(within(dialog).getByLabelText('Send term sheet'), { target: { value: 'carry' } });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Close thread' }));
    await waitFor(() => expect(threads.close).toHaveBeenCalled());
    expect(vi.mocked(threads.close).mock.calls[0][1].decisions).toContainEqual({ itemId: 'todo1', action: 'carry' });
  });

  it('the suspended badge follows the watcher status, not the thread status', async () => {
    vi.mocked(threads.watchers).mockResolvedValue([
      { ...watcher, id: 'w1', description: 'Healthy watcher' },
      { ...watcher, id: 'w2', description: 'Cut-off watcher', status: 'suspended' },
    ] as never);
    renderPage();
    const healthy = (await screen.findByText('Healthy watcher')).closest('li')!;
    const cutOff = screen.getByText('Cut-off watcher').closest('li')!;
    expect(within(healthy).queryByText('suspended')).not.toBeInTheDocument();
    expect(within(cutOff).getByText('suspended')).toBeInTheDocument();
  });

  it('the date edit keeps local time of day and converts to ISO', async () => {
    renderPage();
    const input = (await screen.findByLabelText('Date for Wire deadline')) as HTMLInputElement;
    const d = new Date('2026-11-15T00:00:00.000Z');
    const p = (n: number) => String(n).padStart(2, '0');
    expect(input.value).toBe(`${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T${p(d.getHours())}:${p(d.getMinutes())}`);

    fireEvent.change(input, { target: { value: '2026-11-20T17:30' } });
    await waitFor(() =>
      expect(threads.updateItem).toHaveBeenCalledWith('t1', 'dl1', { dueAt: new Date('2026-11-20T17:30').toISOString() })
    );
  });

  it('a failed todo update shows the error and leaves the checkbox unticked', async () => {
    vi.mocked(threads.updateItem).mockRejectedValue(new Error('boom'));
    renderPage();
    const box = (await screen.findByRole('checkbox', { name: /Send term sheet/ })) as HTMLInputElement;
    fireEvent.click(box);
    expect(await screen.findByText('That did not work. Try again.')).toBeInTheDocument();
    expect(box.checked).toBe(false);
  });

  it('a closed thread shows no write controls', async () => {
    vi.mocked(threads.brief).mockResolvedValue(brief({}, { status: 'closed', closedAt: '2026-10-18T00:00:00.000Z' }) as never);
    renderPage();
    await screen.findByRole('heading', { name: 'Seed round' });
    expect(screen.getAllByText('Send term sheet').length).toBeGreaterThan(0);
    expect(screen.queryByRole('button', { name: 'Acknowledge' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Accept' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Dismiss' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Pause' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Resume' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Close thread' })).not.toBeInTheDocument();
    expect(screen.queryByRole('checkbox')).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /Remove watcher/ })).not.toBeInTheDocument();
  });
});
