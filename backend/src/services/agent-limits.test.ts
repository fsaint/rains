/**
 * Owner-set limits, gathered once and rendered for the MCP surfaces.
 *
 * A restricted agent should hear its limits from the MCP itself — in the
 * initialize instructions, on the tool descriptions, and from whoami — not
 * discover them one refusal at a time. This is the single builder all three
 * read from, so the properties here are what every surface inherits.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

const { tables } = vi.hoisted(() => ({ tables: new Map<string, unknown[]>() }));

vi.mock('../db/index.js', async () => {
  const { getTableName } = await import('drizzle-orm');
  return {
    db: {
      select: () => ({
        from: (table: unknown) => ({
          where: async () => tables.get(getTableName(table as never)) ?? [],
        }),
      }),
    },
    client: { execute: vi.fn() },
  };
});

vi.mock('./permissions.js', async () => {
  const actual = await vi.importActual<typeof import('./permissions.js')>('./permissions.js');
  return {
    parseInstanceConfig: actual.parseInstanceConfig,
    getDrivePathConfig: vi.fn(),
  };
});

vi.mock('./memory-scopes.js', () => ({
  getAgentScopeGrants: vi.fn(),
}));

import { getDrivePathConfig } from './permissions.js';
import { getAgentScopeGrants } from './memory-scopes.js';
import { getAgentLimits, renderAgentLimits, describeToolLimit, type AgentLimits } from './agent-limits.js';

const AGENT = 'agent-1';
const OWNER = 'user-1';
const PROJECT = '11111111-1111-4111-8111-111111111111';

const instance = (over: Record<string, unknown>) => ({
  id: 'inst', agentId: AGENT, serviceType: 'hermeneutix', label: null, credentialId: 'cred',
  enabled: true, isDefault: true, config: null, createdAt: '', updatedAt: '', ...over,
});

const unrestrictedGrants = { mode: 'all' as const, scopes: [], defaultScopeId: 'scope-default' };
const restrictedGrants = {
  mode: 'restricted' as const,
  scopes: [
    { id: 'scope-lva', slug: 'lva', name: 'LVA', description: null, isDefault: true, archivedAt: null },
    { id: 'scope-ops', slug: 'ops', name: 'Ops', description: null, isDefault: false, archivedAt: null },
  ],
  defaultScopeId: 'scope-lva',
};
const openDrive = { defaultLevel: 'write' as const, rules: [] };
const closedDrive = {
  defaultLevel: 'blocked' as const,
  rules: [{ folderId: 'folder-1', label: '/proj', permission: 'read' as const }],
};

beforeEach(() => {
  vi.clearAllMocks();
  tables.clear();
  tables.set('agents', [{ id: AGENT, userId: OWNER, name: 'Helm Organize', status: 'active' }]);
  tables.set('agent_service_instances', []);
  vi.mocked(getAgentScopeGrants).mockResolvedValue(unrestrictedGrants);
  vi.mocked(getDrivePathConfig).mockResolvedValue(openDrive);
});

describe('getAgentLimits', () => {
  it('is null when nothing is restricted', async () => {
    expect(await getAgentLimits(AGENT)).toBeNull();
  });

  it('is null for an agent that does not exist', async () => {
    tables.set('agents', []);
    expect(await getAgentLimits(AGENT)).toBeNull();
  });

  it("lists memory scopes only when the agent's grants are restricted, resolved against the owner", async () => {
    vi.mocked(getAgentScopeGrants).mockResolvedValue(restrictedGrants);

    const limits = await getAgentLimits(AGENT);

    expect(getAgentScopeGrants).toHaveBeenCalledWith(AGENT, OWNER);
    expect(limits).toEqual({
      memory: {
        scopes: [
          { slug: 'lva', name: 'LVA', isDefault: true },
          { slug: 'ops', name: 'Ops', isDefault: false },
        ],
      },
    });
  });

  it('lists a pinned Hermeneutix project per enabled instance, skipping unpinned and disabled ones', async () => {
    tables.set('agent_service_instances', [
      instance({ id: 'i1', config: JSON.stringify({ projectId: PROJECT, projectName: 'LVA' }) }),
      instance({ id: 'i2', config: JSON.stringify({ projectId: '22222222-2222-4222-8222-222222222222' }) }),
      instance({ id: 'i3', config: null }),
      instance({ id: 'i4', enabled: false, config: JSON.stringify({ projectId: '33333333-3333-4333-8333-333333333333' }) }),
      instance({ id: 'i5', serviceType: 'gmail', config: JSON.stringify({ projectId: 'not-hermeneutix' }) }),
    ]);

    const limits = await getAgentLimits(AGENT);

    expect(limits).toEqual({
      hermeneutix: [
        { projectId: PROJECT, projectName: 'LVA' },
        { projectId: '22222222-2222-4222-8222-222222222222' },
      ],
    });
  });

  it('includes Drive when the default is not write', async () => {
    vi.mocked(getDrivePathConfig).mockResolvedValue({ defaultLevel: 'read', rules: [] });

    expect((await getAgentLimits(AGENT))?.drive).toEqual({ defaultLevel: 'read', rules: [] });
  });

  it('includes Drive when any folder rule exists, even under a write default', async () => {
    vi.mocked(getDrivePathConfig).mockResolvedValue({
      defaultLevel: 'write',
      rules: [{ folderId: 'folder-9', permission: 'blocked' }],
    });

    expect((await getAgentLimits(AGENT))?.drive).toEqual({
      defaultLevel: 'write',
      rules: [{ folderId: 'folder-9', permission: 'blocked' }],
    });
  });

  it('carries all three when all three are restricted', async () => {
    vi.mocked(getAgentScopeGrants).mockResolvedValue(restrictedGrants);
    vi.mocked(getDrivePathConfig).mockResolvedValue(closedDrive);
    tables.set('agent_service_instances', [
      instance({ config: JSON.stringify({ projectId: PROJECT, projectName: 'LVA' }) }),
    ]);

    const limits = await getAgentLimits(AGENT);

    expect(Object.keys(limits ?? {}).sort()).toEqual(['drive', 'hermeneutix', 'memory']);
  });
});

describe('renderAgentLimits', () => {
  const HEADER = "Limits set by this agent's owner (refusals are by design; do not retry around them):";
  const FOOTER = 'Call whoami for the machine-readable version.';

  it('renders memory scopes, marking the default', () => {
    const text = renderAgentLimits({
      memory: { scopes: [{ slug: 'lva', name: 'LVA', isDefault: true }, { slug: 'ops', name: 'Ops', isDefault: false }] },
    });

    expect(text).toBe(
      `${HEADER}\n- Memory: you can reach scope(s) lva (default), ops. Others are refused.\n${FOOTER}`
    );
  });

  it('renders a Hermeneutix pin with its name and id, and without a name by id alone', () => {
    expect(renderAgentLimits({ hermeneutix: [{ projectId: PROJECT, projectName: 'LVA' }] })).toBe(
      `${HEADER}\n- Hermeneutix: limited to project "LVA" (${PROJECT}); project_id is filled in for you.\n${FOOTER}`
    );
    expect(renderAgentLimits({ hermeneutix: [{ projectId: PROJECT }] })).toContain(
      `- Hermeneutix: limited to project ${PROJECT}; project_id is filled in for you.`
    );
  });

  it('renders Drive with the default level and each folder rule', () => {
    expect(renderAgentLimits({ drive: closedDrive })).toBe(
      `${HEADER}\n- Drive: folders not listed are blocked. /proj (folder-1): read.\n${FOOTER}`
    );
    expect(renderAgentLimits({ drive: { defaultLevel: 'read', rules: [{ folderId: 'f', permission: 'write' }] } })).toContain(
      '- Drive: folders not listed are read-only. f: write.'
    );
    expect(renderAgentLimits({ drive: { defaultLevel: 'write', rules: [{ folderId: 'f', label: '/x', permission: 'blocked' }] } })).toContain(
      '- Drive: folders are writable unless listed. /x (f): blocked.'
    );
  });

  it('renders all three in a fixed order', () => {
    const limits: AgentLimits = {
      drive: closedDrive,
      hermeneutix: [{ projectId: PROJECT, projectName: 'LVA' }],
      memory: { scopes: [{ slug: 'lva', name: 'LVA', isDefault: true }] },
    };

    expect(renderAgentLimits(limits)).toBe(
      [
        HEADER,
        '- Memory: you can reach scope(s) lva (default). Others are refused.',
        `- Hermeneutix: limited to project "LVA" (${PROJECT}); project_id is filled in for you.`,
        '- Drive: folders not listed are blocked. /proj (folder-1): read.',
        FOOTER,
      ].join('\n')
    );
  });
});

describe('describeToolLimit', () => {
  const limits: AgentLimits = {
    memory: { scopes: [{ slug: 'lva', name: 'LVA', isDefault: true }, { slug: 'ops', name: 'Ops', isDefault: false }] },
    hermeneutix: [{ projectId: PROJECT, projectName: 'LVA' }],
    drive: closedDrive,
  };

  it('suffixes memory tools with the reachable scopes', () => {
    expect(describeToolLimit('memory_create', limits)).toBe(' Scopes you can reach: lva (default), ops.');
  });

  it('suffixes Hermeneutix tools with the pin', () => {
    expect(describeToolLimit('hermeneutix_list_meetings', limits)).toBe(
      ' Limited to project "LVA"; project_id is filled in.'
    );
  });

  it('suffixes Drive tools under a blocked default with the granted folders', () => {
    expect(describeToolLimit('drive_read_file', limits)).toBe(
      ' Limited to Drive folder(s) /proj (read); files elsewhere are refused.'
    );
  });

  it('suffixes Drive tools under a read-only default with rules, and says nothing under a plain write default', () => {
    const readDefault: AgentLimits = { drive: { defaultLevel: 'read', rules: [{ folderId: 'f', label: '/x', permission: 'write' }] } };
    expect(describeToolLimit('drive_create_file', readDefault)).toBe(
      ' Drive is read-only except folder(s) /x (write).'
    );
    const writeWithRules: AgentLimits = { drive: { defaultLevel: 'write', rules: [{ folderId: 'f', permission: 'blocked' }] } };
    expect(describeToolLimit('drive_create_file', writeWithRules)).toBeNull();
  });

  it('leaves other services alone and stays under 160 characters', () => {
    expect(describeToolLimit('calendar_list_events', limits)).toBeNull();
    expect(describeToolLimit('memory_create', { hermeneutix: limits.hermeneutix })).toBeNull();
    const many: AgentLimits = {
      memory: { scopes: Array.from({ length: 30 }, (_, i) => ({ slug: `scope-number-${i}`, name: `S${i}`, isDefault: i === 0 })) },
    };
    expect(describeToolLimit('memory_list', many)!.length).toBeLessThan(160);
  });
});
