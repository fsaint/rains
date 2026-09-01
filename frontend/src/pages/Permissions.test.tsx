import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor, within } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter } from 'react-router-dom';
import Permissions from './Permissions';

vi.mock('../components/DeploymentPanel', () => ({ DeploymentPanel: () => null }));

vi.mock('../api/client', () => ({
  ApiError: class ApiError extends Error {},
  permissions: {
    getAgentPermissions: vi.fn(),
    getInstanceConfig: vi.fn(),
    getServiceCredentials: vi.fn(),
    createInstance: vi.fn(),
    deleteInstance: vi.fn(),
    setInstanceLevel: vi.fn(),
    updateInstance: vi.fn(),
    setInstanceToolPermission: vi.fn(),
    getDrivePathConfig: vi.fn(),
    setDrivePathConfig: vi.fn(),
    getAgentMemoryScopes: vi.fn(),
    setAgentMemoryScopes: vi.fn(),
  },
  agents: { listPending: vi.fn(), update: vi.fn(), delete: vi.fn(), cancelPending: vi.fn() },
  credentials: { list: vi.fn() },
  skills: { listForAgent: vi.fn(), list: vi.fn(), setForAgent: vi.fn() },
}));

import { permissions, agents, credentials, skills } from '../api/client';

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

const instanceBase = {
  agentId: 'a1',
  label: null,
  credentialId: null,
  credentialEmail: null,
  credentialName: null,
  enabled: true,
  isDefault: false,
  toolCount: 2,
  blockedCount: 0,
  approvalRequiredCount: 0,
};

const gmailInstance = {
  ...instanceBase,
  id: 'i-gmail',
  serviceType: 'gmail',
  serviceName: 'Gmail',
  credentialId: 'cred-1',
  credentialEmail: 'one@example.com',
  credentialStatus: 'connected' as const,
  permissionLevel: 'read' as const,
};

const skillsInstance = {
  ...instanceBase,
  id: 'i-skills',
  serviceType: 'skills',
  serviceName: 'Skills',
  credentialStatus: 'not_linked' as const,
  permissionLevel: 'read' as const,
};

const agentPerms = {
  agents: [
    { id: 'a1', name: 'Agent One', status: 'active', instances: [gmailInstance, skillsInstance] },
  ],
  availableServices: [
    { type: 'gmail', name: 'Gmail', icon: 'Mail', authRequired: true },
    { type: 'skills', name: 'Skills', icon: 'BookOpen', authRequired: false },
  ],
};

const googleCreds = [
  { id: 'cred-1', serviceId: 'google', grantedServices: ['gmail', 'calendar'], accountEmail: 'one@example.com', type: 'oauth2', status: 'active' },
  { id: 'cred-2', serviceId: 'google', grantedServices: ['gmail', 'calendar'], accountEmail: 'two@example.com', type: 'oauth2', status: 'active' },
  { id: 'cred-3', serviceId: 'google', grantedServices: ['gmail', 'calendar'], accountEmail: 'three@example.com', type: 'oauth2', status: 'active' },
];

async function expandAgent() {
  fireEvent.click(await screen.findByRole('button', { name: /Agent One/ }));
}

function modal(text: RegExp | string) {
  return within(screen.getByText(text).closest('.fixed') as HTMLElement);
}

describe('Permissions page', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(permissions.getAgentPermissions).mockResolvedValue(agentPerms as any);
    vi.mocked(agents.listPending).mockResolvedValue([]);
    vi.mocked(credentials.list).mockResolvedValue(googleCreds as any);
    vi.mocked(skills.listForAgent).mockResolvedValue([]);
    vi.mocked(skills.list).mockResolvedValue([]);
    vi.mocked(permissions.createInstance).mockResolvedValue({} as any);
    vi.mocked(permissions.getServiceCredentials).mockResolvedValue([]);
    vi.mocked(permissions.getInstanceConfig).mockImplementation(async (id: string) => ({
      ...(id === 'i-skills' ? skillsInstance : gmailInstance),
      tools: [],
    }) as any);
  });

  /**
   * The agent already has Gmail on cred-1. A second account is added as a
   * sibling instance, so the modal offers the accounts *not yet* on this agent
   * — offering cred-1 again would be a silent no-op on the server.
   */
  describe('adding a service that needs an account', () => {
    it('offers only accounts not already on this agent, and asks when more than one remains', async () => {
      render(<Permissions />, { wrapper: createWrapper() });
      await expandAgent();
      fireEvent.click(screen.getByRole('button', { name: /Add Service/ }));

      const add = modal(/Choose a service to add/);
      fireEvent.click(await add.findByRole('button', { name: /Gmail/ }));

      expect(await screen.findByText(/Which account should Gmail use/)).toBeInTheDocument();
      expect(permissions.createInstance).not.toHaveBeenCalled();
      expect(screen.queryByLabelText(/one@example.com/)).not.toBeInTheDocument();
      expect(screen.getByLabelText(/two@example.com/)).toBeInTheDocument();

      fireEvent.click(screen.getByLabelText(/three@example.com/));
      fireEvent.click(screen.getByRole('button', { name: /^Add Gmail/ }));

      await waitFor(() => {
        expect(permissions.createInstance).toHaveBeenCalledWith('a1', 'gmail', undefined, 'cred-3');
      });
    });

    it('adds straight away when exactly one account remains to attach', async () => {
      vi.mocked(credentials.list).mockResolvedValue([googleCreds[0], googleCreds[1]] as any);
      render(<Permissions />, { wrapper: createWrapper() });
      await expandAgent();
      fireEvent.click(screen.getByRole('button', { name: /Add Service/ }));

      const add = modal(/Choose a service to add/);
      fireEvent.click(await add.findByRole('button', { name: /Gmail/ }));

      await waitFor(() => {
        expect(permissions.createInstance).toHaveBeenCalledWith('a1', 'gmail', undefined, 'cred-2');
      });
    });

    it('does not offer a service whose every account is already on the agent', async () => {
      vi.mocked(credentials.list).mockResolvedValue([googleCreds[0]] as any);
      render(<Permissions />, { wrapper: createWrapper() });
      await expandAgent();
      fireEvent.click(screen.getByRole('button', { name: /Add Service/ }));

      const add = modal(/Choose a service to add/);
      expect(await add.findByText(/already connected/i)).toBeInTheDocument();
      expect(add.queryByRole('button', { name: /Gmail/ })).not.toBeInTheDocument();
      expect(permissions.createInstance).not.toHaveBeenCalled();
    });
  });

  it('does not say "No account linked" on a service that needs no sign-in', async () => {
    render(<Permissions />, { wrapper: createWrapper() });
    await expandAgent();

    expect(screen.getByText('Skills')).toBeInTheDocument();
    expect(screen.queryByText('No account linked')).not.toBeInTheDocument();
  });

  describe('service detail', () => {
    it('shows the account picker for a service that signs in', async () => {
      render(<Permissions />, { wrapper: createWrapper() });
      await expandAgent();
      fireEvent.click(screen.getByText('one@example.com'));

      expect(await screen.findByText(/Which account should this instance use/)).toBeInTheDocument();
    });

    it('shows no account section at all for Skills, which needs no sign-in', async () => {
      render(<Permissions />, { wrapper: createWrapper() });
      await expandAgent();
      fireEvent.click(screen.getByText('Skills'));

      await screen.findByText(/Configure access and permissions/);
      await waitFor(() => expect(permissions.getInstanceConfig).toHaveBeenCalledWith('i-skills'));
      await screen.findByText(/Permission Level|Access level/i);

      expect(screen.queryByText(/No accounts connected/)).not.toBeInTheDocument();
      expect(screen.queryByText(/Which account should this instance use/)).not.toBeInTheDocument();
    });

    it('lets the owner turn skills on and off from the Skills detail', async () => {
      vi.mocked(skills.list).mockResolvedValue([
        { id: 's-help', slug: 'helm-help', name: 'Helm Help', description: '', body: '', requiredServices: [], isSystem: true, autoAssign: false, enabled: true, assignedAgentIds: [], createdAt: '', updatedAt: '' },
      ]);
      vi.mocked(skills.setForAgent).mockResolvedValue([]);
      render(<Permissions />, { wrapper: createWrapper() });
      await expandAgent();
      fireEvent.click(screen.getByText('Skills'));

      fireEvent.click(await screen.findByRole('switch', { name: /Helm Help/ }));

      await waitFor(() => {
        expect(skills.setForAgent).toHaveBeenCalledWith('a1', ['s-help']);
      });
    });
  });
});
