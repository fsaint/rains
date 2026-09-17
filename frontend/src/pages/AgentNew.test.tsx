import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter } from 'react-router-dom';
import AgentNew from './AgentNew';

const mockNavigate = vi.fn();
vi.mock('react-router-dom', async (importOriginal) => {
  const actual = await importOriginal<typeof import('react-router-dom')>();
  return { ...actual, useNavigate: () => mockNavigate };
});

vi.mock('../api/client', () => ({
  agents: { create: vi.fn() },
}));

import { agents } from '../api/client';

function createWrapper() {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  return ({ children }: { children: React.ReactNode }) => (
    <MemoryRouter>
      <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
    </MemoryRouter>
  );
}

describe('AgentNew', () => {
  beforeEach(() => vi.clearAllMocks());

  it('creates the agent from name and description and opens its detail page', async () => {
    vi.mocked(agents.create).mockResolvedValue({ id: 'agent-123', name: 'Mine', status: 'active' });
    render(<AgentNew />, { wrapper: createWrapper() });

    fireEvent.change(screen.getByPlaceholderText('e.g. My Assistant'), { target: { value: 'Mine' } });
    fireEvent.change(screen.getByPlaceholderText('What does this agent do?'), { target: { value: 'Work mail' } });
    fireEvent.click(screen.getByRole('button', { name: 'Create Agent' }));

    await waitFor(() => {
      expect(agents.create).toHaveBeenCalledWith({ name: 'Mine', description: 'Work mail' });
      expect(mockNavigate).toHaveBeenCalledWith('/agents/agent-123');
    });
  });

  it('disables Create until a name is entered', () => {
    render(<AgentNew />, { wrapper: createWrapper() });
    expect(screen.getByRole('button', { name: 'Create Agent' })).toBeDisabled();
  });

  it('shows the API error', async () => {
    vi.mocked(agents.create).mockRejectedValue(new Error('boom'));
    render(<AgentNew />, { wrapper: createWrapper() });
    fireEvent.change(screen.getByPlaceholderText('e.g. My Assistant'), { target: { value: 'X' } });
    fireEvent.click(screen.getByRole('button', { name: 'Create Agent' }));
    expect(await screen.findByText('boom')).toBeInTheDocument();
  });
});
