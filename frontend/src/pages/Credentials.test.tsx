import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter } from 'react-router-dom';
import Credentials from './Credentials';

vi.mock('../api/client', () => ({
  ApiError: class ApiError extends Error {
    constructor(public code: string, message: string, public details?: Record<string, unknown>) {
      super(message);
    }
  },
  credentials: {
    list: vi.fn(),
    checkHealth: vi.fn(),
    delete: vi.fn(),
  },
  oauth: {},
  permissions: {},
}));

import { credentials } from '../api/client';

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

const cred = (id: string, serviceId: string) => ({
  id,
  serviceId,
  type: 'api_key',
  accountEmail: `${serviceId}@example.com`,
  createdAt: '2026-09-01T00:00:00Z',
});

beforeEach(() => {
  vi.clearAllMocks();
  // Health never resolves in these tests: the button must not depend on it.
  vi.mocked(credentials.checkHealth).mockReturnValue(new Promise(() => {}));
});

describe('updating an API-key credential', () => {
  it('offers Update token on a token credential before any health check', async () => {
    vi.mocked(credentials.list).mockResolvedValue([cred('c1', 'hermeneutix')] as never);

    render(<Credentials />, { wrapper: createWrapper() });

    const button = await screen.findByTitle('Update token');
    fireEvent.click(button);

    expect(await screen.findByText('Update Hermeneutix Token')).toBeInTheDocument();
  });

  it('does not offer Update token on an OAuth credential', async () => {
    vi.mocked(credentials.list).mockResolvedValue([cred('c2', 'google')] as never);

    render(<Credentials />, { wrapper: createWrapper() });

    await waitFor(() => expect(screen.getByText('google@example.com')).toBeInTheDocument());
    expect(screen.queryByTitle('Update token')).not.toBeInTheDocument();
  });

  it('opens the Zendesk update form for a Zendesk credential', async () => {
    vi.mocked(credentials.list).mockResolvedValue([cred('c3', 'zendesk')] as never);

    render(<Credentials />, { wrapper: createWrapper() });

    fireEvent.click(await screen.findByTitle('Update token'));

    expect(await screen.findByText('Update Zendesk Credentials')).toBeInTheDocument();
  });
});
