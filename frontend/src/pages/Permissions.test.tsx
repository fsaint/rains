import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor, within } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter } from 'react-router-dom';
import Permissions from './Permissions';

vi.mock('../components/DeploymentPanel', () => ({ DeploymentPanel: () => null }));

vi.mock('../api/client', () => ({
  ApiError: class ApiError extends Error {
    constructor(public code: string, message: string, public details?: Record<string, unknown>) {
      super(message);
    }
  },
  permissions: {
    getAgentPermissions: vi.fn(),
    getInstanceConfig: vi.fn(),
    getServiceCredentials: vi.fn(),
    createInstance: vi.fn(),
    deleteInstance: vi.fn(),
    setServiceAccess: vi.fn(),
    setInstanceLevel: vi.fn(),
    updateInstance: vi.fn(),
    setInstanceToolPermission: vi.fn(),
    getDrivePathConfig: vi.fn(),
    setDrivePathConfig: vi.fn(),
    getAgentMemoryScopes: vi.fn(),
    setAgentMemoryScopes: vi.fn(),
    listHermeneutixProjects: vi.fn(),
  },
  agents: { listPending: vi.fn(), update: vi.fn(), delete: vi.fn(), cancelPending: vi.fn() },
  credentials: { list: vi.fn() },
  skills: { listForAgent: vi.fn(), list: vi.fn(), setForAgent: vi.fn() },
}));

import { permissions, agents, credentials, skills, ApiError } from '../api/client';

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

const hermeneutixInstance = {
  ...instanceBase,
  id: 'i-herm',
  serviceType: 'hermeneutix',
  serviceName: 'Hermeneutix',
  credentialId: 'cred-h',
  credentialEmail: 'me@hermeneutix.test',
  credentialStatus: 'connected' as const,
  permissionLevel: 'read' as const,
  config: { projectId: 'p1', projectName: 'Alpha' },
};

const agentPerms = {
  agents: [
    { id: 'a1', name: 'Agent One', status: 'active', instances: [gmailInstance, skillsInstance] },
  ],
  availableServices: [
    { type: 'gmail', name: 'Gmail', icon: 'Mail', authRequired: true },
    { type: 'skills', name: 'Skills', icon: 'BookOpen', authRequired: false },
    { type: 'hermeneutix', name: 'Hermeneutix', icon: 'Mic', authRequired: true },
  ],
};

const hermeneutixCred = {
  id: 'cred-h', serviceId: 'hermeneutix', grantedServices: ['hermeneutix'], accountEmail: 'me@hermeneutix.test', type: 'api_key', status: 'active',
};

const hermeneutixProjects = [
  { id: 'p1', name: 'Alpha' },
  { id: 'p2', name: 'Beta' },
];

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
    vi.mocked(permissions.listHermeneutixProjects).mockResolvedValue(hermeneutixProjects);
    vi.mocked(permissions.updateInstance).mockResolvedValue({} as any);
    vi.mocked(permissions.getInstanceConfig).mockImplementation(async (id: string) => ({
      ...(id === 'i-skills' ? skillsInstance : id === 'i-herm' ? hermeneutixInstance : gmailInstance),
      tools: [],
    }) as any);
  });

  /**
   * Hermeneutix can be pinned to one project. "All projects" is the default
   * and means unscoped, so it sends no config at all rather than an empty one.
   */
  describe('adding Hermeneutix', () => {
    async function openProjectStep() {
      render(<Permissions />, { wrapper: createWrapper() });
      await expandAgent();
      fireEvent.click(screen.getByRole('button', { name: /Add Service/ }));
      const add = modal(/Choose a service to add/);
      fireEvent.click(await add.findByRole('button', { name: /Hermeneutix/ }));
      expect(await screen.findByText(/Which project should Hermeneutix use/)).toBeInTheDocument();
    }

    beforeEach(() => {
      vi.mocked(credentials.list).mockResolvedValue([...googleCreds, hermeneutixCred] as any);
    });

    it('asks which project, listing the fetched projects after "All projects"', async () => {
      await openProjectStep();

      expect(permissions.createInstance).not.toHaveBeenCalled();
      await waitFor(() => {
        expect(permissions.listHermeneutixProjects).toHaveBeenCalledWith('a1', 'cred-h');
      });
      const radios = await screen.findAllByRole('radio');
      expect(radios.map((r) => (r as HTMLInputElement).checked)).toEqual([true, false, false]);
      expect(screen.getByLabelText(/All projects/)).toBeChecked();
      expect(screen.getByLabelText(/Alpha/)).toBeInTheDocument();
      expect(screen.getByLabelText(/Beta/)).toBeInTheDocument();
    });

    it('sends no config when "All projects" is confirmed', async () => {
      await openProjectStep();
      await screen.findByLabelText(/Alpha/);

      fireEvent.click(screen.getByRole('button', { name: /^Add Hermeneutix/ }));

      await waitFor(() => {
        expect(permissions.createInstance).toHaveBeenCalledWith('a1', 'hermeneutix', undefined, 'cred-h', undefined);
      });
    });

    it('pins the instance to the chosen project', async () => {
      await openProjectStep();

      fireEvent.click(await screen.findByLabelText(/Beta/));
      fireEvent.click(screen.getByRole('button', { name: /^Add Hermeneutix/ }));

      await waitFor(() => {
        expect(permissions.createInstance).toHaveBeenCalledWith(
          'a1', 'hermeneutix', undefined, 'cred-h', { projectId: 'p2', projectName: 'Beta' }
        );
      });
    });

    it('explains a stale token and points at the credentials page', async () => {
      vi.mocked(permissions.listHermeneutixProjects).mockRejectedValue(
        new ApiError('INVALID_TOKEN', 'Hermeneutix rejected the token')
      );
      await openProjectStep();

      expect(await screen.findByText(/Hermeneutix rejected the token/)).toBeInTheDocument();
      expect(screen.getByRole('link', { name: /Reconnect on the Credentials page/ })).toHaveAttribute('href', '/credentials');
    });

    it('shows any load error with the reconnect link and hides the project list', async () => {
      vi.mocked(permissions.listHermeneutixProjects).mockRejectedValue(
        new ApiError('NOT_FOUND', 'Credential not found')
      );
      await openProjectStep();

      expect(await screen.findByText(/Credential not found/)).toBeInTheDocument();
      expect(screen.getByRole('link', { name: /Reconnect on the Credentials page/ })).toHaveAttribute('href', '/credentials');
      expect(screen.queryAllByRole('radio')).toHaveLength(0);
    });
  });

  /**
   * The server's combination guard counts the legacy per-service access row
   * as well as instances. An agent can have that row enabled with no instance
   * left, so resolving a conflict must turn the row off too, or the retry hits
   * the same refusal and the button can never clear it.
   */
  describe('resolving a service-combination conflict', () => {
    const adminService = { type: 'helm-admin', name: 'Helm Admin', icon: 'Shield', authRequired: false };

    function callOrder(fn: unknown) {
      return vi.mocked(fn as (...a: unknown[]) => unknown).mock.invocationCallOrder;
    }

    async function addAdminAndResolve(instances: unknown[]) {
      vi.mocked(permissions.getAgentPermissions).mockResolvedValue({
        ...agentPerms,
        agents: [{ ...agentPerms.agents[0], instances }],
        availableServices: [...agentPerms.availableServices, adminService],
      } as any);
      vi.mocked(permissions.createInstance)
        .mockRejectedValueOnce(
          new ApiError('SERVICE_COMBINATION_NOT_ALLOWED', 'Helm Admin cannot share an agent', { conflicting: ['skills'] })
        )
        .mockResolvedValue({} as any);
      vi.mocked(permissions.deleteInstance).mockResolvedValue(undefined);
      vi.mocked(permissions.setServiceAccess).mockResolvedValue({} as any);

      render(<Permissions />, { wrapper: createWrapper() });
      await expandAgent();
      fireEvent.click(screen.getByRole('button', { name: /Add Service/ }));
      const add = modal(/Choose a service to add/);
      fireEvent.click(await add.findByRole('button', { name: /Helm Admin/ }));

      fireEvent.click(await screen.findByRole('button', { name: /Turn those off and add Helm Admin/ }));
      await waitFor(() => expect(permissions.createInstance).toHaveBeenCalledTimes(2));
    }

    it('turns off legacy access for a conflicting service that has no instance', async () => {
      await addAdminAndResolve([gmailInstance]);

      expect(permissions.deleteInstance).not.toHaveBeenCalled();
      expect(permissions.setServiceAccess).toHaveBeenCalledWith('a1', 'skills', false);
      expect(callOrder(permissions.setServiceAccess)[0]).toBeLessThan(callOrder(permissions.createInstance)[1]);
    });

    it('deletes the instance, then turns off legacy access, then retries', async () => {
      await addAdminAndResolve([gmailInstance, skillsInstance]);

      expect(permissions.deleteInstance).toHaveBeenCalledWith('i-skills');
      expect(permissions.setServiceAccess).toHaveBeenCalledWith('a1', 'skills', false);
      expect(callOrder(permissions.deleteInstance)[0]).toBeLessThan(callOrder(permissions.setServiceAccess)[0]);
      expect(callOrder(permissions.setServiceAccess)[0]).toBeLessThan(callOrder(permissions.createInstance)[1]);
    });
  });

  /**
   * Folder overrides are matched by id, so what is stored must be the bare id
   * even when a whole Drive URL was pasted; and a second rule for the same
   * folder would never be reached, so it is refused rather than stored dead.
   */
  describe('a Drive instance', () => {
    const driveInstance = {
      ...instanceBase,
      id: 'i-drive',
      serviceType: 'drive',
      serviceName: 'Google Drive',
      credentialId: 'cred-1',
      credentialEmail: 'drive@example.com',
      credentialStatus: 'connected' as const,
      permissionLevel: 'full' as const,
      config: null,
    };
    const docsRule = { folderId: 'FOLDER_DOCS', label: 'Docs', permission: 'read' as const };

    beforeEach(() => {
      vi.mocked(permissions.getAgentPermissions).mockResolvedValue({
        ...agentPerms,
        agents: [{ ...agentPerms.agents[0], instances: [driveInstance] }],
        availableServices: [
          ...agentPerms.availableServices,
          { type: 'drive', name: 'Google Drive', icon: 'HardDrive', authRequired: true },
        ],
      } as any);
      vi.mocked(permissions.getInstanceConfig).mockResolvedValue({ ...driveInstance, tools: [] } as any);
      vi.mocked(permissions.getDrivePathConfig).mockResolvedValue({ defaultLevel: 'write', rules: [docsRule] });
      vi.mocked(permissions.setDrivePathConfig).mockResolvedValue({ defaultLevel: 'write', rules: [docsRule] });
    });

    async function openEditor() {
      render(<Permissions />, { wrapper: createWrapper() });
      await expandAgent();
      fireEvent.click(screen.getByText('drive@example.com'));
      return screen.findByPlaceholderText(/Folder ID or Drive URL/);
    }

    it('stores the bare folder id when a Drive URL is pasted', async () => {
      const input = await openEditor();
      fireEvent.change(input, { target: { value: 'https://drive.google.com/drive/u/0/folders/FOLDER_NEW?usp=sharing' } });
      fireEvent.click(screen.getByRole('button', { name: /^Add$/ }));

      await waitFor(() => {
        expect(permissions.setDrivePathConfig).toHaveBeenCalledWith('a1', {
          defaultLevel: 'write',
          rules: [docsRule, { folderId: 'FOLDER_NEW', label: undefined, permission: 'write' }],
        });
      });
    });

    it('refuses a folder that already has an override, without saving', async () => {
      const input = await openEditor();
      fireEvent.change(input, { target: { value: 'https://drive.google.com/drive/folders/FOLDER_DOCS' } });
      fireEvent.click(screen.getByRole('button', { name: /^Add$/ }));

      expect(await screen.findByText(/already has an override/i)).toBeInTheDocument();
      expect(permissions.setDrivePathConfig).not.toHaveBeenCalled();
    });

    it('removes a single override and sends the whole config back', async () => {
      await openEditor();
      fireEvent.click(screen.getByRole('button', { name: /Remove override for Docs/ }));

      await waitFor(() => {
        expect(permissions.setDrivePathConfig).toHaveBeenCalledWith('a1', { defaultLevel: 'write', rules: [] });
      });
    });

    it('explains what the default level means and follows a change to it', async () => {
      vi.mocked(permissions.getDrivePathConfig)
        .mockResolvedValueOnce({ defaultLevel: 'write', rules: [docsRule] })
        .mockResolvedValue({ defaultLevel: 'blocked', rules: [docsRule] });
      await openEditor();
      expect(screen.getByText(/Folders not listed: write/)).toBeInTheDocument();

      fireEvent.click(screen.getByRole('button', { name: /^blocked$/i }));

      await waitFor(() => {
        expect(permissions.setDrivePathConfig).toHaveBeenCalledWith('a1', { defaultLevel: 'blocked', rules: [docsRule] });
      });
      expect(await screen.findByText(/Folders not listed: blocked/)).toBeInTheDocument();
    });
  });

  describe('a Memory instance', () => {
    const memoryInstance = {
      ...instanceBase,
      id: 'i-memory',
      serviceType: 'memory',
      serviceName: 'Memory',
      credentialStatus: 'not_linked' as const,
      permissionLevel: 'full' as const,
      config: null,
    };

    beforeEach(() => {
      vi.mocked(permissions.getAgentPermissions).mockResolvedValue({
        ...agentPerms,
        agents: [{ ...agentPerms.agents[0], instances: [gmailInstance, memoryInstance] }],
        availableServices: [
          ...agentPerms.availableServices,
          { type: 'memory', name: 'Memory', icon: 'Brain', authRequired: false },
        ],
      } as any);
      vi.mocked(permissions.getInstanceConfig).mockResolvedValue({ ...memoryInstance, tools: [] } as any);
      vi.mocked(permissions.getAgentMemoryScopes).mockResolvedValue({
        mode: 'restricted',
        defaultScopeId: 'sc-live',
        grantedScopeIds: ['sc-live', 'sc-old'],
        availableScopes: [
          { id: 'sc-live', slug: 'live', name: 'Live scope', is_default: true, archived_at: null },
          { id: 'sc-old', slug: 'old', name: 'Old scope', is_default: false, archived_at: '2026-08-01T00:00:00Z' },
        ],
      });
    });

    it('marks a granted scope that has been archived, and only that one', async () => {
      render(<Permissions />, { wrapper: createWrapper() });
      await expandAgent();
      fireEvent.click(screen.getByText('Memory'));

      const old = (await screen.findByText('Old scope')).closest('label') as HTMLElement;
      const live = screen.getByText('Live scope').closest('label') as HTMLElement;
      expect(within(old).getByText('(archived)')).toBeInTheDocument();
      expect(within(live).queryByText('(archived)')).not.toBeInTheDocument();
    });
  });

  describe('a Hermeneutix instance', () => {
    beforeEach(() => {
      vi.mocked(permissions.getAgentPermissions).mockResolvedValue({
        ...agentPerms,
        agents: [{ ...agentPerms.agents[0], instances: [gmailInstance, hermeneutixInstance] }],
      } as any);
    });

    it('shows the pinned project on the card', async () => {
      render(<Permissions />, { wrapper: createWrapper() });
      await expandAgent();

      expect(screen.getByText('Project: Alpha')).toBeInTheDocument();
    });

    it('lets the owner change the project from the detail', async () => {
      render(<Permissions />, { wrapper: createWrapper() });
      await expandAgent();
      fireEvent.click(screen.getByText('me@hermeneutix.test'));

      const select = await screen.findByLabelText(/^Project$/);
      await waitFor(() => expect(select).toHaveValue('p1'));
      await waitFor(() => {
        expect(permissions.listHermeneutixProjects).toHaveBeenCalledWith('a1', 'cred-h');
      });

      fireEvent.change(select, { target: { value: 'p2' } });
      await waitFor(() => {
        expect(permissions.updateInstance).toHaveBeenCalledWith('i-herm', {
          config: { projectId: 'p2', projectName: 'Beta' },
        });
      });

      fireEvent.change(select, { target: { value: '' } });
      await waitFor(() => {
        expect(permissions.updateInstance).toHaveBeenCalledWith('i-herm', { config: null });
      });
    });

    it('shows any load error with the reconnect link instead of the select', async () => {
      vi.mocked(permissions.listHermeneutixProjects).mockRejectedValue(
        new ApiError('NOT_FOUND', 'Credential not found')
      );
      render(<Permissions />, { wrapper: createWrapper() });
      await expandAgent();
      fireEvent.click(screen.getByText('me@hermeneutix.test'));

      expect(await screen.findByText(/Credential not found/)).toBeInTheDocument();
      expect(screen.getByRole('link', { name: /Reconnect on the Credentials page/ })).toHaveAttribute('href', '/credentials');
      expect(screen.queryByLabelText(/^Project$/)).not.toBeInTheDocument();
    });

    it('says the account needs reconnecting without fetching when the credential is expired', async () => {
      vi.mocked(permissions.getInstanceConfig).mockResolvedValue({
        ...hermeneutixInstance,
        credentialStatus: 'expired',
        tools: [],
      } as any);
      render(<Permissions />, { wrapper: createWrapper() });
      await expandAgent();
      fireEvent.click(screen.getByText('me@hermeneutix.test'));

      expect(await screen.findByText(/Which project should this agent see/)).toBeInTheDocument();
      expect(screen.getByRole('link', { name: /Reconnect on the Credentials page/ })).toHaveAttribute('href', '/credentials');
      expect(screen.getByText(/account is expired/i)).toBeInTheDocument();
      expect(screen.queryByLabelText(/^Project$/)).not.toBeInTheDocument();
      expect(permissions.listHermeneutixProjects).not.toHaveBeenCalled();
    });
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
        expect(permissions.createInstance).toHaveBeenCalledWith('a1', 'gmail', undefined, 'cred-3', undefined);
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
        expect(permissions.createInstance).toHaveBeenCalledWith('a1', 'gmail', undefined, 'cred-2', undefined);
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
