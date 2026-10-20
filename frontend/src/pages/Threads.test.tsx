import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter, Routes, Route } from 'react-router-dom';
import Threads from './Threads';

vi.mock('../api/client', () => ({
  threads: {
    list: vi.fn(),
    create: vi.fn(),
  },
  memoryScopes: {
    list: vi.fn(),
  },
}));

import { threads, memoryScopes } from '../api/client';

function createWrapper() {
  const queryClient = new QueryClient({
    defaultOptions: {
      queries: { retry: false },
      mutations: { retry: false },
    },
  });
  return ({ children }: { children: React.ReactNode }) => (
    <MemoryRouter initialEntries={['/threads']}>
      <QueryClientProvider client={queryClient}>
        <Routes>
          <Route path="/threads" element={children} />
          <Route path="/threads/:id" element={<div>Detail page</div>} />
        </Routes>
      </QueryClientProvider>
    </MemoryRouter>
  );
}

const baseThread = {
  userId: 'u1',
  scopeId: 's1',
  rootEntryId: 'root-1',
  goal: null,
  targetDate: null,
  approvalId: null,
  createdByAgentId: null,
  createdAt: new Date(Date.now() - 3 * 86400000).toISOString(),
  closedAt: null,
};

const active = {
  ...baseThread,
  id: 't1',
  title: 'Seed round',
  goal: 'Close the round',
  status: 'active',
  updatedAt: new Date(Date.now() - 2 * 3600000).toISOString(),
  nextDueAt: '2026-11-01T00:00:00.000Z',
};

const closed = {
  ...baseThread,
  id: 't2',
  title: 'Old launch',
  status: 'closed',
  updatedAt: new Date(Date.now() - 5 * 86400000).toISOString(),
  closedAt: new Date().toISOString(),
};

describe('Threads page', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(threads.list).mockImplementation(async (status) =>
      (status === 'closed' ? [closed] : status === 'paused' ? [] : [active]) as never
    );
    vi.mocked(memoryScopes.list).mockResolvedValue([
      { id: 's1', slug: 'personal', name: 'Personal', description: null, is_default: true, archived_at: null, entry_count: 1 },
      { id: 's2', slug: 'work', name: 'Work', description: null, is_default: false, archived_at: null, entry_count: 1 },
    ]);
  });

  it('lists active threads by default and switches to Closed', async () => {
    render(<Threads />, { wrapper: createWrapper() });

    expect(await screen.findByText('Seed round')).toBeInTheDocument();
    expect(screen.getByText('Close the round')).toBeInTheDocument();
    expect(screen.getByText('2 hours ago')).toBeInTheDocument();
    expect(screen.getByText(/Next due/)).toBeInTheDocument();
    expect(threads.list).toHaveBeenCalledWith('active');

    fireEvent.click(screen.getByRole('button', { name: 'Closed' }));

    expect(await screen.findByText('Old launch')).toBeInTheDocument();
    expect(screen.queryByText('Seed round')).not.toBeInTheDocument();
    expect(threads.list).toHaveBeenCalledWith('closed');
  });

  it('New thread submits title, goal, scope and navigates to the detail page', async () => {
    vi.mocked(threads.create).mockResolvedValue({ ...active, id: 'new-1' } as never);
    render(<Threads />, { wrapper: createWrapper() });

    fireEvent.click(await screen.findByRole('button', { name: /New thread/ }));
    fireEvent.change(screen.getByLabelText('Title'), { target: { value: 'Hire a CTO' } });
    fireEvent.change(screen.getByLabelText('Goal'), { target: { value: 'Offer out by Dec' } });
    await screen.findByRole('option', { name: 'Work' });
    fireEvent.change(screen.getByLabelText('Scope'), { target: { value: 'work' } });
    fireEvent.change(screen.getByLabelText('Target date'), { target: { value: '2026-12-01' } });
    fireEvent.click(screen.getByRole('button', { name: 'Create thread' }));

    await waitFor(() =>
      expect(threads.create).toHaveBeenCalledWith({
        title: 'Hire a CTO',
        goal: 'Offer out by Dec',
        scope: 'work',
        targetDate: '2026-12-01',
      })
    );
    expect(await screen.findByText('Detail page')).toBeInTheDocument();
  });

  it('does not submit without a title', async () => {
    render(<Threads />, { wrapper: createWrapper() });
    fireEvent.click(await screen.findByRole('button', { name: /New thread/ }));
    expect(screen.getByRole('button', { name: 'Create thread' })).toBeDisabled();
    expect(threads.create).not.toHaveBeenCalled();
  });

  it('shows the empty-state copy when there are no active threads', async () => {
    vi.mocked(threads.list).mockResolvedValue([]);
    render(<Threads />, { wrapper: createWrapper() });

    expect(
      await screen.findByText("No active threads. Threads are the few things you've chosen to focus on.")
    ).toBeInTheDocument();
  });
});
