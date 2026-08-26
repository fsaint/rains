import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter } from 'react-router-dom';
import AgentSkillToggles from './AgentSkillToggles';

vi.mock('../api/client', () => ({
  skills: {
    list: vi.fn(),
    setForAgent: vi.fn(),
  },
  permissions: {
    getAgentPermissions: vi.fn(),
  },
}));

import { skills, permissions } from '../api/client';

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

const baseSkill = {
  slug: 'x',
  description: '',
  body: '',
  isSystem: false,
  autoAssign: false,
  enabled: true,
  createdAt: '',
  updatedAt: '',
};

const skillList = [
  { ...baseSkill, id: 's-memory', slug: 'helm-memory', name: 'Helm Memory', requiredServices: [], assignedAgentIds: ['a1'] },
  { ...baseSkill, id: 's-help', slug: 'helm-help', name: 'Helm Help', requiredServices: [], assignedAgentIds: [] },
  { ...baseSkill, id: 's-triage', slug: 'email-triage', name: 'Email Triage', requiredServices: ['gmail'], assignedAgentIds: [] },
];

const agentPerms = {
  agents: [
    { id: 'a1', name: 'Agent One', status: 'active', instances: [] },
  ],
  availableServices: [
    { type: 'gmail', name: 'Gmail', icon: 'Mail', authRequired: true },
  ],
};

describe('AgentSkillToggles', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(skills.list).mockResolvedValue(skillList as any);
    vi.mocked(permissions.getAgentPermissions).mockResolvedValue(agentPerms as any);
    vi.mocked(skills.setForAgent).mockResolvedValue([]);
  });

  it('lists every skill with a switch reflecting whether it is assigned to the agent', async () => {
    render(<AgentSkillToggles agentId="a1" />, { wrapper: createWrapper() });

    const memory = await screen.findByRole('switch', { name: /Helm Memory/ });
    const help = screen.getByRole('switch', { name: /Helm Help/ });
    expect(memory).toHaveAttribute('aria-checked', 'true');
    expect(help).toHaveAttribute('aria-checked', 'false');
  });

  it('turning a skill on replaces the agent set with the current set plus that skill', async () => {
    render(<AgentSkillToggles agentId="a1" />, { wrapper: createWrapper() });

    fireEvent.click(await screen.findByRole('switch', { name: /Helm Help/ }));

    await waitFor(() => {
      expect(skills.setForAgent).toHaveBeenCalledWith('a1', ['s-memory', 's-help']);
    });
  });

  it('turning a skill off replaces the agent set without that skill', async () => {
    render(<AgentSkillToggles agentId="a1" />, { wrapper: createWrapper() });

    fireEvent.click(await screen.findByRole('switch', { name: /Helm Memory/ }));

    await waitFor(() => {
      expect(skills.setForAgent).toHaveBeenCalledWith('a1', []);
    });
  });

  it('cannot turn on a skill whose required service is not connected, and names the service', async () => {
    render(<AgentSkillToggles agentId="a1" />, { wrapper: createWrapper() });

    const triage = await screen.findByRole('switch', { name: /Email Triage/ });
    expect(triage).toBeDisabled();
    expect(screen.getByText(/Needs Gmail/)).toBeInTheDocument();
  });
});
