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
  agents: { createAndDeploy: vi.fn(), createManual: vi.fn(), getDetail: vi.fn() },
  initialPromptTemplates: { list: vi.fn() },
  config: { getPublic: vi.fn() },
  auth: { session: vi.fn() },
  oauth: {},
  credentials: { list: vi.fn() },
  permissions: { setServiceAccess: vi.fn(), linkCredential: vi.fn() },
  billing: { status: vi.fn() },
}));

import { agents, initialPromptTemplates, config, auth, credentials, billing } from '../api/client';

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

const TYPE_CARD = /Bring your own agent|Email & Calendar|Custom Agent/;

describe('AgentNew', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(initialPromptTemplates.list).mockResolvedValue({ templates: [] } as any);
    vi.mocked(config.getPublic).mockResolvedValue({ sharedBotEnabled: true } as any);
    vi.mocked(auth.session).mockResolvedValue({ user: {} } as any);
    vi.mocked(credentials.list).mockResolvedValue([]);
    vi.mocked(billing.status).mockResolvedValue({ subscribed: true } as any);
  });

  it('offers "Bring your own agent" as the first top-level option, styled like the others', () => {
    render(<AgentNew />, { wrapper: createWrapper() });

    const cards = screen.getAllByRole('button', { name: TYPE_CARD });
    expect(cards).toHaveLength(3);
    expect(cards[0]).toHaveTextContent('Bring your own agent');
    expect(cards[1]).toHaveTextContent('Email & Calendar');
    expect(cards[2]).toHaveTextContent('Custom Agent');
    // Same card treatment as its siblings — not a footnote link.
    expect(cards[0].className).toBe(cards[1].className);
  });

  it('after creating a bring-your-own agent, goes to the agents list', async () => {
    vi.mocked(agents.createManual).mockResolvedValue({ id: 'agent-123' } as any);
    render(<AgentNew />, { wrapper: createWrapper() });

    fireEvent.click(screen.getByRole('button', { name: /Bring your own agent/ }));
    fireEvent.change(screen.getByPlaceholderText('e.g. My Assistant'), { target: { value: 'Mine' } });
    fireEvent.click(screen.getByRole('button', { name: 'Next' }));
    fireEvent.click(await screen.findByRole('button', { name: 'Create Agent' }));

    await waitFor(() => {
      expect(agents.createManual).toHaveBeenCalledWith(expect.objectContaining({ name: 'Mine' }));
      expect(mockNavigate).toHaveBeenCalledWith('/agents');
    });
    expect(mockNavigate).not.toHaveBeenCalledWith('/agents/agent-123');
  });
});
