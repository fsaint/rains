/**
 * Permission Service Tests
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

/**
 * The gmail tool lists, declared once.
 *
 * These used to be written out twice — once inside the `@reins/servers` mock and
 * once as MOCK_GMAIL_PERMISSIONS for the assertions. Three tools were added to
 * the first copy and not the second, and setPermissionLevel then made more
 * db.select calls than the test had queued responses for. Hoisted so the mock
 * factory, which vitest lifts above the imports, can reach it.
 */
const { GMAIL_PERMISSIONS } = vi.hoisted(() => ({
  GMAIL_PERMISSIONS: {
    read: [
      'gmail_list_accounts', 'gmail_list_messages', 'gmail_get_message', 'gmail_get_attachment',
      'gmail_search', 'gmail_list_labels', 'gmail_create_label', 'gmail_delete_label',
    ],
    write: ['gmail_create_draft', 'gmail_send_draft'],
    blocked: ['gmail_send_message', 'gmail_delete_message'],
  },
}));

// Mock modules
vi.mock('../db/index.js', () => ({
  db: {
    select: vi.fn(),
    insert: vi.fn(),
    update: vi.fn(),
    delete: vi.fn(),
  },
  client: {
    execute: vi.fn().mockResolvedValue({ rows: [], rowsAffected: 1, columns: [], lastInsertRowid: 0n }),
  },
}));

vi.mock('../db/schema.js', () => ({
  agents: { id: 'id', name: 'name', status: 'status', userId: 'user_id' },
  agentServiceAccess: { id: 'id', agentId: 'agent_id', serviceType: 'service_type', enabled: 'enabled', credentialId: 'credential_id' },
  agentToolPermissions: { id: 'id', agentId: 'agent_id', serviceType: 'service_type', toolName: 'tool_name', permission: 'permission', instanceId: 'instance_id' },
  credentials: { id: 'id', serviceId: 'service_id', type: 'type', expiresAt: 'expires_at', userId: 'user_id', accountEmail: 'account_email', accountName: 'account_name' },
  agentServiceCredentials: { id: 'id', agentId: 'agent_id', serviceType: 'service_type', credentialId: 'credential_id', isDefault: 'is_default' },
  agentServiceInstances: { id: 'id', agentId: 'agent_id', serviceType: 'service_type', credentialId: 'credential_id', enabled: 'enabled', isDefault: 'is_default' },
}));

vi.mock('nanoid', () => ({
  nanoid: vi.fn(() => 'new-id'),
}));

vi.mock('../mcp/server-manager.js', () => ({
  serverManager: {
    getAllServerTools: vi.fn(() => []),
  },
}));

vi.mock('../credentials/vault.js', () => ({
  credentialVault: {
    getValidAccessToken: vi.fn().mockResolvedValue(null),
    retrieve: vi.fn().mockResolvedValue(null),
  },
}));

vi.mock('@reins/servers', () => {
  const defs = [
    {
      type: 'gmail',
      name: 'Gmail',
      auth: { required: true, type: 'oauth2', credentialServiceIds: ['gmail'] },
      permissions: GMAIL_PERMISSIONS,
    },
    {
      type: 'drive',
      name: 'Google Drive',
      auth: { required: true, type: 'oauth2', credentialServiceIds: ['drive'] },
      permissions: {
        read: ['drive_list_files', 'drive_get_file', 'drive_read_file', 'drive_search'],
        write: ['drive_create_file', 'drive_update_file'],
        blocked: ['drive_share_file', 'drive_delete_file'],
      },
    },
    {
      type: 'calendar',
      name: 'Google Calendar',
      auth: { required: true, type: 'oauth2', credentialServiceIds: ['calendar'] },
      permissions: {
        read: ['calendar_list_events', 'calendar_get_event', 'calendar_search_events', 'calendar_list_calendars'],
        write: ['calendar_create_event', 'calendar_update_event'],
        blocked: ['calendar_delete_event'],
      },
    },
    {
      type: 'web-search',
      name: 'Web Search',
      auth: { required: false, type: 'api-key', credentialServiceIds: ['web-search'] },
      permissions: { read: ['web_search', 'web_search_news', 'web_search_images'], write: [], blocked: [] },
    },
    {
      type: 'hermeneutix',
      name: 'Hermeneutix',
      auth: { required: true, type: 'api-key', credentialServiceIds: ['hermeneutix'] },
      permissions: { read: ['hermeneutix_list_projects', 'hermeneutix_list_meetings'], write: [], blocked: [] },
    },
    {
      type: 'browser',
      name: 'Browser',
      auth: { required: false, type: 'none', credentialServiceIds: [] },
      permissions: {
        read: ['browser_navigate', 'browser_screenshot', 'browser_get_content', 'browser_close'],
        write: ['browser_click', 'browser_type'],
        blocked: ['browser_evaluate'],
      },
    },
  ];
  return {
    serviceDefinitions: defs,
    serviceRegistry: new Map(defs.map((d) => [d.type, d])),
    getServiceTypeFromToolName: (name: string) => {
      if (name.startsWith('gmail_')) return 'gmail';
      if (name.startsWith('drive_')) return 'drive';
      if (name.startsWith('calendar_')) return 'calendar';
      if (name === 'web_search' || name.startsWith('web_search_')) return 'web-search';
      if (name.startsWith('browser_')) return 'browser';
      if (name.startsWith('hermeneutix_')) return 'hermeneutix';
      return null;
    },
  };
});

import { db, client } from '../db/index.js';
import { agents, credentials, agentServiceInstances, agentServiceCredentials, agentServiceAccess } from '../db/schema.js';
import {
  getPermissionMatrix,
  getAgentServiceConfig,
  setServiceAccess,
  linkCredential,
  unlinkCredential,
  setToolPermission,
  resetToolPermission,
  getEffectivePermissions,
  isServiceEnabledForAgent,
  canAccessTool,
  getCredentialsForService,
  setPermissionLevel,
  getPermissionLevel,
  assertServiceCombinationAllowed,
  assertNoOpenMcpEndpoints,
  listOpenMcpAgents,
  listEnabledServiceTypes,
  createServiceInstance,
  deleteServiceInstance,
  autoLinkCredential,
  detachCredential,
  updateServiceInstance,
  getAgentInstances,
  parseInstanceConfig,
  getDrivePathConfig,
  setDrivePathConfig,
  ServiceCombinationError,
  UnauthenticatedEndpointsOpenError,
} from './permissions.js';

// Tool lists mirroring the vi.mock('@reins/servers') registry above
const MOCK_GMAIL_PERMISSIONS = GMAIL_PERMISSIONS;

/**
 * Answer both queries listEnabledServiceTypes makes with the same set.
 *
 * It reads instance rows and legacy access rows and unions them, so serving one
 * list to both is equivalent for these tests and keeps them readable.
 */
function mockEnabledServices(...types: string[]) {
  const rows = types.map((serviceType) => ({ serviceType }));
  vi.mocked(db.select).mockReturnValue({
    from: vi.fn().mockReturnValue({ where: vi.fn().mockResolvedValue(rows) }),
  } as never);
}

// Helper to create mock query chain
function mockQueryChain(result: unknown, hasWhere = true) {
  if (hasWhere) {
    return {
      from: vi.fn().mockReturnValue({
        where: vi.fn().mockResolvedValue(result),
      }),
      where: vi.fn().mockResolvedValue(result),
      values: vi.fn().mockResolvedValue(undefined),
      set: vi.fn().mockReturnValue({
        where: vi.fn().mockResolvedValue(undefined),
      }),
    };
  }
  // For queries without .where() (e.g., select all)
  return {
    from: vi.fn().mockResolvedValue(result),
    values: vi.fn().mockResolvedValue(undefined),
  };
}

/**
 * Serve rows by table identity rather than call order. createServiceInstance
 * makes a dozen selects (the combination guard, the instance lookup, the
 * credential resolve, then everything getInstanceById reads back), so a
 * queue of mockReturnValueOnce would break on any reordering.
 */
function mockTables(rows: Map<object, unknown[]>) {
  vi.mocked(db.select).mockReturnValue({
    from: vi.fn((table: object) => ({ where: vi.fn().mockResolvedValue(rows.get(table) ?? []) })),
  } as never);
  const values = vi.fn().mockResolvedValue(undefined);
  vi.mocked(db.insert).mockReturnValue({ values } as never);
  const set = vi.fn().mockReturnValue({ where: vi.fn().mockResolvedValue(undefined) });
  vi.mocked(db.update).mockReturnValue({ set } as never);
  vi.mocked(db.delete).mockReturnValue({ where: vi.fn().mockResolvedValue(undefined) } as never);
  // Pair each insert(table) with the row handed to the values() that follows it.
  const inserted = (table: object) =>
    vi.mocked(db.insert).mock.calls
      .map((call, i) => [call[0], values.mock.calls[i]?.[0]] as const)
      .filter(([t]) => t === table)
      .map(([, row]) => row);
  // Every payload handed to update(table).set(...), in order.
  const updated = (table: object) =>
    vi.mocked(db.update).mock.calls
      .map((call, i) => [call[0], set.mock.calls[i]?.[0]] as const)
      .filter(([t]) => t === table)
      .map(([, row]) => row);
  // Tables handed to delete(table), in order.
  const deleted = () => vi.mocked(db.delete).mock.calls.map((call) => call[0]);
  return { inserted, updated, deleted };
}

describe('Permission Service', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe('getPermissionMatrix', () => {
    it('should return matrix with agents and services', async () => {
      const mockAgents = [
        { id: 'agent-1', name: 'Agent 1', status: 'active' },
        { id: 'agent-2', name: 'Agent 2', status: 'active' },
      ];

      const mockAccessRecords = [
        { agentId: 'agent-1', serviceType: 'gmail', enabled: true, credentialId: 'cred-1' },
      ];

      const mockToolPerms: unknown[] = [];
      const mockCredentials = [
        { id: 'cred-1', expiresAt: new Date(Date.now() + 3600000).toISOString() },
      ];

      vi.mocked(db.select)
        .mockReturnValueOnce(mockQueryChain(mockAgents, false) as never) // agents
        .mockReturnValueOnce(mockQueryChain(mockAccessRecords, false) as never) // agentServiceAccess
        .mockReturnValueOnce(mockQueryChain(mockToolPerms, false) as never) // agentToolPermissions
        .mockReturnValueOnce(mockQueryChain(mockCredentials, false) as never) // credentials
        .mockReturnValueOnce(mockQueryChain([], false) as never); // agentServiceCredentials

      const result = await getPermissionMatrix();

      expect(result.agents).toHaveLength(2);
      expect(result.services).toHaveLength(6);
      expect(result.cells).toHaveLength(12); // 2 agents * 6 services
    });

    it('should count blocked and approval-required tools', async () => {
      const mockAgents = [{ id: 'agent-1', name: 'Agent 1', status: 'active' }];
      const mockAccessRecords = [
        { agentId: 'agent-1', serviceType: 'gmail', enabled: true, credentialId: null },
      ];
      const mockToolPerms = [
        { agentId: 'agent-1', serviceType: 'gmail', toolName: 'gmail_list_messages', permission: 'block' },
      ];

      vi.mocked(db.select)
        .mockReturnValueOnce(mockQueryChain(mockAgents, false) as never)
        .mockReturnValueOnce(mockQueryChain(mockAccessRecords, false) as never)
        .mockReturnValueOnce(mockQueryChain(mockToolPerms, false) as never)
        .mockReturnValueOnce(mockQueryChain([], false) as never) // credentials
        .mockReturnValueOnce(mockQueryChain([], false) as never); // agentServiceCredentials

      const result = await getPermissionMatrix();

      const gmailCell = result.cells.find((c) => c.serviceType === 'gmail');
      expect(gmailCell).toBeTruthy();
      expect(gmailCell?.blockedCount).toBeGreaterThan(0);
    });
  });

  describe('getAgentServiceConfig', () => {
    it('should return null for non-existent agent', async () => {
      vi.mocked(db.select).mockReturnValueOnce(mockQueryChain([]) as never);

      const result = await getAgentServiceConfig('non-existent', 'gmail');

      expect(result).toBeNull();
    });

    it('should return service config with tools', async () => {
      const mockAgent = { id: 'agent-1', name: 'Agent 1', status: 'active' };
      const mockAccess = { agentId: 'agent-1', serviceType: 'gmail', enabled: true, credentialId: null };

      vi.mocked(db.select)
        .mockReturnValueOnce(mockQueryChain([mockAgent]) as never) // agent
        .mockReturnValueOnce(mockQueryChain([mockAccess]) as never) // access
        .mockReturnValueOnce(mockQueryChain([]) as never) // tool overrides
        .mockReturnValueOnce(mockQueryChain([]) as never); // agentServiceCredentials

      const result = await getAgentServiceConfig('agent-1', 'gmail');

      expect(result).toBeTruthy();
      expect(result?.agentId).toBe('agent-1');
      expect(result?.serviceType).toBe('gmail');
      expect(result?.enabled).toBe(true);
      expect(result?.tools.length).toBeGreaterThan(0);
    });

    it('should apply tool permission overrides', async () => {
      const mockAgent = { id: 'agent-1', name: 'Agent 1', status: 'active' };
      const mockAccess = { agentId: 'agent-1', serviceType: 'gmail', enabled: true, credentialId: null };
      const mockOverrides = [
        { agentId: 'agent-1', serviceType: 'gmail', toolName: 'gmail_send_message', permission: 'allow' },
      ];

      vi.mocked(db.select)
        .mockReturnValueOnce(mockQueryChain([mockAgent]) as never)
        .mockReturnValueOnce(mockQueryChain([mockAccess]) as never)
        .mockReturnValueOnce(mockQueryChain(mockOverrides) as never) // tool overrides
        .mockReturnValueOnce(mockQueryChain([]) as never); // agentServiceCredentials

      const result = await getAgentServiceConfig('agent-1', 'gmail');

      const sendTool = result?.tools.find((t) => t.toolName === 'gmail_send_message');
      expect(sendTool?.permission).toBe('allow');
      expect(sendTool?.isDefault).toBe(false);
    });
  });

  describe('setServiceAccess', () => {
    it('should upsert access record when enabling', async () => {
      mockEnabledServices();
      await setServiceAccess('agent-1', 'gmail', true);

      expect(client.execute).toHaveBeenCalledWith(expect.objectContaining({
        sql: expect.stringContaining('ON CONFLICT'),
        args: expect.arrayContaining(['agent-1', 'gmail', true]),
      }));
    });

    it('should upsert access record when disabling', async () => {
      await setServiceAccess('agent-1', 'gmail', false);

      expect(client.execute).toHaveBeenCalledWith(expect.objectContaining({
        sql: expect.stringContaining('ON CONFLICT'),
        args: expect.arrayContaining(['agent-1', 'gmail', false]),
      }));
    });
  });

  /**
   * The rule that makes the admin MCP safe to hand to an agent: helm-admin can
   * change any agent's permissions, so an agent holding it plus anything with a
   * credential is an agent that can reach everything in two steps.
   */
  describe('exclusivity between helm-admin and everything else', () => {
    it('refuses helm-admin on an agent that already has a credentialed service', async () => {
      mockEnabledServices('gmail', 'memory');

      await expect(assertServiceCombinationAllowed('agent-1', 'helm-admin'))
        .rejects.toThrow(/only memory alongside/i);
    });

    it('refuses a credentialed service on an agent that already has helm-admin', async () => {
      mockEnabledServices('helm-admin');

      await expect(assertServiceCombinationAllowed('agent-1', 'gmail'))
        .rejects.toThrow(/grant itself access/i);
    });

    it('names what is blocking, so the caller can offer to turn it off', async () => {
      mockEnabledServices('gmail', 'skills', 'memory');

      const err = await assertServiceCombinationAllowed('agent-1', 'helm-admin')
        .then(() => null)
        .catch((e: unknown) => e as ServiceCombinationError);

      expect(err).toBeInstanceOf(ServiceCombinationError);
      // memory is permitted, so it must not appear as a conflict.
      expect(err!.conflicting.sort()).toEqual(['gmail', 'skills']);
    });

    it('allows memory alongside helm-admin, in either order', async () => {
      mockEnabledServices('helm-admin');
      await expect(assertServiceCombinationAllowed('agent-1', 'memory')).resolves.toBeUndefined();

      mockEnabledServices('memory');
      await expect(assertServiceCombinationAllowed('agent-1', 'helm-admin')).resolves.toBeUndefined();
    });

    it('allows helm-admin on an agent that already has it', async () => {
      // Re-enabling must be idempotent rather than self-conflicting.
      mockEnabledServices('helm-admin');
      await expect(assertServiceCombinationAllowed('agent-1', 'helm-admin')).resolves.toBeUndefined();
    });

    it('leaves ordinary combinations alone', async () => {
      mockEnabledServices('gmail', 'drive', 'skills');
      await expect(assertServiceCombinationAllowed('agent-1', 'calendar')).resolves.toBeUndefined();
    });

    it('counts a service that is live only on the legacy access row', async () => {
      // isServiceEnabledForAgent falls back to agent_service_access when there
      // are no instance rows. If the guard read only instances, an agent whose
      // gmail predates instances would take helm-admin and keep gmail.
      vi.mocked(db.select)
        .mockReturnValueOnce({ // instances: none
          from: vi.fn().mockReturnValue({ where: vi.fn().mockResolvedValue([]) }),
        } as never)
        .mockReturnValueOnce({ // legacy: gmail
          from: vi.fn().mockReturnValue({ where: vi.fn().mockResolvedValue([{ serviceType: 'gmail' }]) }),
        } as never);

      await expect(assertServiceCombinationAllowed('agent-1', 'helm-admin')).rejects.toThrow(/gmail/);
    });

    it('setServiceAccess enforces it, and only when enabling', async () => {
      mockEnabledServices('helm-admin');
      await expect(setServiceAccess('agent-1', 'gmail', true)).rejects.toThrow(ServiceCombinationError);
      expect(client.execute).not.toHaveBeenCalled();

      // Disabling can only shrink the set, so it must never be blocked —
      // otherwise an agent in a bad state could not be repaired.
      await expect(setServiceAccess('agent-1', 'gmail', false)).resolves.toBeUndefined();
      expect(client.execute).toHaveBeenCalled();
    });

    it('createServiceInstance rejects before writing the instance row', async () => {
      // The guard has to run before the insert: this function writes the
      // instance and only then calls setServiceAccess, so guarding just the
      // latter would leave the row behind and the service would appear in
      // tools/list while the access row said no.
      mockEnabledServices('helm-admin');

      await expect(createServiceInstance('agent-1', 'gmail')).rejects.toThrow(ServiceCombinationError);
      expect(db.insert).not.toHaveBeenCalled();
    });
  });

  /**
   * The exclusivity rule keeps the admin agent poor. This keeps that from being
   * decorative: on an account where any agent answers MCP calls without a token,
   * an agent id is a credential, so an admin agent could grant a peer access and
   * then drive the peer directly.
   */
  describe('open MCP endpoints', () => {
    it('treats an agent with no live deployment row as open', async () => {
      // The one a reimplementation gets wrong. authenticateMcp serves a request
      // when the deployment row is missing, so "not explicitly closed" is open.
      vi.mocked(client.execute).mockResolvedValueOnce({
        rows: [{ id: 'agent-9', name: 'Never Deployed' }],
        rowsAffected: 1, columns: [], lastInsertRowid: 0n,
      } as never);

      await expect(assertNoOpenMcpEndpoints('user-1')).rejects.toThrow(/Never Deployed/);
    });

    it('reports every blocking agent by name, so the owner knows what to close', async () => {
      vi.mocked(client.execute).mockResolvedValueOnce({
        rows: [{ id: 'a', name: 'Home' }, { id: 'b', name: 'Work' }],
        rowsAffected: 2, columns: [], lastInsertRowid: 0n,
      } as never);

      const err = await assertNoOpenMcpEndpoints('user-1')
        .then(() => null)
        .catch((e: unknown) => e as UnauthenticatedEndpointsOpenError);

      expect(err).toBeInstanceOf(UnauthenticatedEndpointsOpenError);
      expect(err!.message).toContain('Home, Work');
      expect(err!.openAgents.map((a) => a.id)).toEqual(['a', 'b']);
    });

    it('passes when every agent is closed', async () => {
      vi.mocked(client.execute).mockResolvedValueOnce({
        rows: [], rowsAffected: 0, columns: [], lastInsertRowid: 0n,
      } as never);

      await expect(assertNoOpenMcpEndpoints('user-1')).resolves.toBeUndefined();
    });

    it('only counts an agent closed when allow_unauthenticated is explicitly false', async () => {
      // Guards the SQL: a NULL column, or no row from the lateral join, must
      // both come back as open. Asserting on the query is the only way to catch
      // a rewrite that flips this to `= true`.
      vi.mocked(client.execute).mockResolvedValueOnce({
        rows: [], rowsAffected: 0, columns: [], lastInsertRowid: 0n,
      } as never);

      await listOpenMcpAgents('user-1');

      const { sql } = vi.mocked(client.execute).mock.calls[0][0] as { sql: string };
      expect(sql).toContain('allow_unauthenticated IS NULL');
      expect(sql).toContain('allow_unauthenticated = true');
    });
  });

  describe('listEnabledServiceTypes', () => {
    it('unions instances and legacy rows without duplicates', async () => {
      vi.mocked(db.select)
        .mockReturnValueOnce({
          from: vi.fn().mockReturnValue({
            where: vi.fn().mockResolvedValue([{ serviceType: 'gmail' }, { serviceType: 'memory' }]),
          }),
        } as never)
        .mockReturnValueOnce({
          from: vi.fn().mockReturnValue({
            where: vi.fn().mockResolvedValue([{ serviceType: 'gmail' }, { serviceType: 'drive' }]),
          }),
        } as never);

      expect((await listEnabledServiceTypes('agent-1')).sort()).toEqual(['drive', 'gmail', 'memory']);
    });
  });

  describe('linkCredential', () => {
    it('should update existing access with credential', async () => {
      const mockExisting = { id: 'access-1' };

      vi.mocked(db.select).mockReturnValueOnce({
        from: vi.fn().mockReturnValue({
          where: vi.fn().mockResolvedValue([mockExisting]),
        }),
      } as never);

      vi.mocked(db.update).mockReturnValueOnce({
        set: vi.fn().mockReturnValue({
          where: vi.fn().mockResolvedValue(undefined),
        }),
      } as never);

      await linkCredential('agent-1', 'gmail', 'cred-1');

      expect(db.update).toHaveBeenCalled();
    });

    it('should create new access record with credential', async () => {
      vi.mocked(db.select).mockReturnValueOnce({
        from: vi.fn().mockReturnValue({
          where: vi.fn().mockResolvedValue([]),
        }),
      } as never);

      vi.mocked(db.insert).mockReturnValueOnce({
        values: vi.fn().mockResolvedValue(undefined),
      } as never);

      await linkCredential('agent-1', 'gmail', 'cred-1');

      expect(db.insert).toHaveBeenCalled();
    });
  });

  describe('unlinkCredential', () => {
    it('should set credential to null', async () => {
      const mockExisting = { id: 'access-1' };

      vi.mocked(db.select).mockReturnValueOnce({
        from: vi.fn().mockReturnValue({
          where: vi.fn().mockResolvedValue([mockExisting]),
        }),
      } as never);

      vi.mocked(db.update).mockReturnValueOnce({
        set: vi.fn().mockReturnValue({
          where: vi.fn().mockResolvedValue(undefined),
        }),
      } as never);

      await unlinkCredential('agent-1', 'gmail');

      expect(db.update).toHaveBeenCalled();
    });

    it('should do nothing if no access record exists', async () => {
      vi.mocked(db.select).mockReturnValueOnce({
        from: vi.fn().mockReturnValue({
          where: vi.fn().mockResolvedValue([]),
        }),
      } as never);

      await unlinkCredential('agent-1', 'gmail');

      expect(db.update).not.toHaveBeenCalled();
    });
  });

  describe('setToolPermission', () => {
    it('should update existing permission', async () => {
      const mockExisting = { id: 'perm-1' };

      vi.mocked(db.select).mockReturnValueOnce({
        from: vi.fn().mockReturnValue({
          where: vi.fn().mockResolvedValue([mockExisting]),
        }),
      } as never);

      vi.mocked(db.update).mockReturnValueOnce({
        set: vi.fn().mockReturnValue({
          where: vi.fn().mockResolvedValue(undefined),
        }),
      } as never);

      await setToolPermission('agent-1', 'gmail', 'gmail_send_message', 'allow');

      expect(db.update).toHaveBeenCalled();
    });

    it('should create new permission if none exists', async () => {
      vi.mocked(db.select).mockReturnValueOnce({
        from: vi.fn().mockReturnValue({
          where: vi.fn().mockResolvedValue([]),
        }),
      } as never);

      vi.mocked(db.insert).mockReturnValueOnce({
        values: vi.fn().mockResolvedValue(undefined),
      } as never);

      await setToolPermission('agent-1', 'gmail', 'gmail_send_message', 'allow');

      expect(db.insert).toHaveBeenCalled();
    });
  });

  describe('resetToolPermission', () => {
    it('should delete the permission override', async () => {
      vi.mocked(db.delete).mockReturnValueOnce({
        where: vi.fn().mockResolvedValue(undefined),
      } as never);

      await resetToolPermission('agent-1', 'gmail', 'gmail_send_message');

      expect(db.delete).toHaveBeenCalled();
    });
  });

  describe('getEffectivePermissions', () => {
    it('should return disabled if service not enabled', async () => {
      vi.mocked(db.select).mockReturnValueOnce({
        from: vi.fn().mockReturnValue({
          where: vi.fn().mockResolvedValue([{ enabled: false }]),
        }),
      } as never);

      const result = await getEffectivePermissions('agent-1', 'gmail');

      expect(result.enabled).toBe(false);
      expect(result.tools).toEqual({});
    });

    it('should return default permissions with overrides applied', async () => {
      vi.mocked(db.select)
        .mockReturnValueOnce({
          from: vi.fn().mockReturnValue({
            where: vi.fn().mockResolvedValue([{ enabled: true }]),
          }),
        } as never)
        .mockReturnValueOnce({
          from: vi.fn().mockReturnValue({
            where: vi.fn().mockResolvedValue([
              { toolName: 'gmail_send_message', permission: 'allow' },
            ]),
          }),
        } as never);

      const result = await getEffectivePermissions('agent-1', 'gmail');

      expect(result.enabled).toBe(true);
      expect(result.tools.gmail_send_message).toBe('allow');
      expect(result.tools.gmail_list_messages).toBe('allow'); // default
    });
  });

  /**
   * The enablement boundary. The MCP endpoint and the gateway-token HTTP routes
   * both answer "may this agent use this service?" through here, so the two
   * cannot drift apart — see the note at agent-endpoint.ts's instance lookup.
   */
  describe('isServiceEnabledForAgent', () => {
    /** One `db.select()` per call: an enabled-instance lookup, then the fallback. */
    const selectOnce = (result: unknown) =>
      vi.mocked(db.select).mockReturnValueOnce({
        from: vi.fn().mockReturnValue({ where: vi.fn().mockResolvedValue(result) }),
      } as never);

    it('is true when an enabled instance exists', async () => {
      selectOnce([{ id: 'inst-1', enabled: true }]);

      expect(await isServiceEnabledForAgent('agent-1', 'skill-authoring')).toBe(true);
    });

    it('falls back to legacy service access when the agent has no instances', async () => {
      selectOnce([]);                       // no instance rows
      selectOnce([{ enabled: true }]);      // getEffectivePermissions' access row
      selectOnce([]);                       // its tool overrides

      expect(await isServiceEnabledForAgent('agent-1', 'skill-authoring')).toBe(true);
    });

    it('is false when there is neither an instance nor legacy access', async () => {
      selectOnce([]);                       // no instance rows
      selectOnce([{ enabled: false }]);     // access row present but off

      expect(await isServiceEnabledForAgent('agent-1', 'skill-authoring')).toBe(false);
    });

    it('is false when the agent has no record of the service at all', async () => {
      selectOnce([]);                       // no instance rows
      selectOnce([]);                       // no access row either

      expect(await isServiceEnabledForAgent('agent-1', 'skill-authoring')).toBe(false);
    });
  });

  describe('canAccessTool', () => {
    it('should return not allowed if service disabled', async () => {
      vi.mocked(db.select).mockReturnValueOnce({
        from: vi.fn().mockReturnValue({
          where: vi.fn().mockResolvedValue([{ enabled: false }]),
        }),
      } as never);

      const result = await canAccessTool('agent-1', 'gmail', 'gmail_list_messages');

      expect(result.allowed).toBe(false);
      expect(result.requiresApproval).toBe(false);
    });

    it('should return allowed for allow permission', async () => {
      vi.mocked(db.select)
        .mockReturnValueOnce({
          from: vi.fn().mockReturnValue({
            where: vi.fn().mockResolvedValue([{ enabled: true }]),
          }),
        } as never)
        .mockReturnValueOnce({
          from: vi.fn().mockReturnValue({
            where: vi.fn().mockResolvedValue([]),
          }),
        } as never);

      const result = await canAccessTool('agent-1', 'gmail', 'gmail_list_messages');

      expect(result.allowed).toBe(true);
      expect(result.requiresApproval).toBe(false);
    });

    it('should return requires approval for require_approval permission', async () => {
      vi.mocked(db.select)
        .mockReturnValueOnce({
          from: vi.fn().mockReturnValue({
            where: vi.fn().mockResolvedValue([{ enabled: true }]),
          }),
        } as never)
        .mockReturnValueOnce({
          from: vi.fn().mockReturnValue({
            where: vi.fn().mockResolvedValue([]),
          }),
        } as never);

      const result = await canAccessTool('agent-1', 'gmail', 'gmail_create_draft');

      expect(result.allowed).toBe(true);
      expect(result.requiresApproval).toBe(true);
    });

    it('should return not allowed for blocked tool', async () => {
      vi.mocked(db.select)
        .mockReturnValueOnce({
          from: vi.fn().mockReturnValue({
            where: vi.fn().mockResolvedValue([{ enabled: true }]),
          }),
        } as never)
        .mockReturnValueOnce({
          from: vi.fn().mockReturnValue({
            where: vi.fn().mockResolvedValue([]),
          }),
        } as never);

      const result = await canAccessTool('agent-1', 'gmail', 'gmail_delete_message');

      expect(result.allowed).toBe(false);
      expect(result.requiresApproval).toBe(false);
    });
  });

  describe('getCredentialsForService', () => {
    it('should return credentials with status', async () => {
      const mockCreds = [
        { id: 'cred-1', type: 'oauth', expiresAt: new Date(Date.now() + 3600000).toISOString() },
        { id: 'cred-2', type: 'oauth', expiresAt: new Date(Date.now() - 3600000).toISOString() },
      ];

      vi.mocked(db.select).mockReturnValueOnce({
        from: vi.fn().mockReturnValue({
          where: vi.fn().mockResolvedValue(mockCreds),
        }),
      } as never);

      const result = await getCredentialsForService('gmail');

      expect(result).toHaveLength(2);
      expect(result[0].status).toBe('valid');
      expect(result[1].status).toBe('expired');
    });
  });

  describe('setPermissionLevel', () => {
    it('should throw error for custom level', async () => {
      await expect(setPermissionLevel('agent-1', 'gmail', 'custom'))
        .rejects.toThrow("Cannot set permission level to 'custom'");
    });

    it('should disable service for none level', async () => {
      mockEnabledServices();
      const set = vi.fn().mockReturnValue({ where: vi.fn().mockResolvedValue(undefined) });
      vi.mocked(db.update).mockReturnValue({ set } as never);

      await setPermissionLevel('agent-1', 'gmail', 'none');

      expect(client.execute).toHaveBeenCalledWith(expect.objectContaining({
        sql: expect.stringContaining('agent_service_access'),
        args: expect.arrayContaining(['agent-1', 'gmail', false]),
      }));

      // The instance rows too. Enablement is "an enabled instance, or failing
      // that an enabled access row", so clearing only the access row left every
      // instance-based agent — which is every modern one — still holding the
      // service while this reported success. Asserting only the access row is
      // what let that ship; a live run caught it by disabling a service and
      // watching it stay on.
      expect(db.update).toHaveBeenCalled();
      expect(set).toHaveBeenCalledWith(expect.objectContaining({ enabled: false }));
    });

    it('should enable service and set read-only permissions', async () => {
      // setServiceAccess now uses client.execute (no db.select/insert needed for it)

      // setToolPermission runs once per gmail tool. Answer every call rather
      // than queueing one response per tool: a counted queue silently runs dry
      // when gmail gains a tool, and the failure surfaces as an unrelated
      // "cannot read 'from' of undefined" deep inside the service.
      vi.mocked(db.select).mockReturnValue({
        from: vi.fn().mockReturnValue({
          where: vi.fn().mockResolvedValue([]),
        }),
      } as never);
      vi.mocked(db.insert).mockReturnValue({
        values: vi.fn().mockResolvedValue(undefined),
      } as never);

      await setPermissionLevel('agent-1', 'gmail', 'read');

      // One insert per tool, since none existed.
      const gmailTools = [...MOCK_GMAIL_PERMISSIONS.read, ...MOCK_GMAIL_PERMISSIONS.write, ...MOCK_GMAIL_PERMISSIONS.blocked];
      expect(db.insert).toHaveBeenCalledTimes(gmailTools.length);
    });
  });

  describe('getPermissionLevel', () => {
    it('should return none if service disabled', async () => {
      vi.mocked(db.select).mockReturnValueOnce({
        from: vi.fn().mockReturnValue({
          where: vi.fn().mockResolvedValue([{ enabled: false }]),
        }),
      } as never);

      const result = await getPermissionLevel('agent-1', 'gmail');

      expect(result).toBe('none');
    });

    it('should return read if write tools are blocked', async () => {
      const readTools = MOCK_GMAIL_PERMISSIONS.read.reduce((acc, tool) => {
        acc[tool] = 'allow';
        return acc;
      }, {} as Record<string, string>);

      const writeTools = MOCK_GMAIL_PERMISSIONS.write.reduce((acc, tool) => {
        acc[tool] = 'block';
        return acc;
      }, {} as Record<string, string>);

      const blockedTools = MOCK_GMAIL_PERMISSIONS.blocked.reduce((acc, tool) => {
        acc[tool] = 'block';
        return acc;
      }, {} as Record<string, string>);

      const allPerms = { ...readTools, ...writeTools, ...blockedTools };
      const overrides = Object.entries(allPerms).map(([toolName, permission]) => ({
        toolName,
        permission,
      }));

      vi.mocked(db.select)
        .mockReturnValueOnce({
          from: vi.fn().mockReturnValue({
            where: vi.fn().mockResolvedValue([{ enabled: true }]),
          }),
        } as never)
        .mockReturnValueOnce({
          from: vi.fn().mockReturnValue({
            where: vi.fn().mockResolvedValue(overrides),
          }),
        } as never);

      const result = await getPermissionLevel('agent-1', 'gmail');

      expect(result).toBe('read');
    });

    it('should return full if write tools require approval', async () => {
      const readTools = MOCK_GMAIL_PERMISSIONS.read.reduce((acc, tool) => {
        acc[tool] = 'allow';
        return acc;
      }, {} as Record<string, string>);

      const writeTools = MOCK_GMAIL_PERMISSIONS.write.reduce((acc, tool) => {
        acc[tool] = 'require_approval';
        return acc;
      }, {} as Record<string, string>);

      const blockedTools = MOCK_GMAIL_PERMISSIONS.blocked.reduce((acc, tool) => {
        acc[tool] = 'block';
        return acc;
      }, {} as Record<string, string>);

      const allPerms = { ...readTools, ...writeTools, ...blockedTools };
      const overrides = Object.entries(allPerms).map(([toolName, permission]) => ({
        toolName,
        permission,
      }));

      vi.mocked(db.select)
        .mockReturnValueOnce({
          from: vi.fn().mockReturnValue({
            where: vi.fn().mockResolvedValue([{ enabled: true }]),
          }),
        } as never)
        .mockReturnValueOnce({
          from: vi.fn().mockReturnValue({
            where: vi.fn().mockResolvedValue(overrides),
          }),
        } as never);

      const result = await getPermissionLevel('agent-1', 'gmail');

      expect(result).toBe('full');
    });

    it('should return custom for mixed permissions', async () => {
      // Some write tools blocked, some require approval
      const mixedOverrides = [
        { toolName: 'gmail_list_messages', permission: 'allow' },
        { toolName: 'gmail_create_draft', permission: 'block' },
        { toolName: 'gmail_send_draft', permission: 'require_approval' },
      ];

      vi.mocked(db.select)
        .mockReturnValueOnce({
          from: vi.fn().mockReturnValue({
            where: vi.fn().mockResolvedValue([{ enabled: true }]),
          }),
        } as never)
        .mockReturnValueOnce({
          from: vi.fn().mockReturnValue({
            where: vi.fn().mockResolvedValue(mixedOverrides),
          }),
        } as never);

      const result = await getPermissionLevel('agent-1', 'gmail');

      expect(result).toBe('custom');
    });
  });
  /**
   * One agent, several accounts of the same service. The instance table has no
   * unique on (agent, service) by design; what must stay idempotent is re-adding
   * the *same* account, and adding with no account at all (memory, skills,
   * helm-admin), because those callers retry.
   */
  describe('createServiceInstance with several accounts of one service', () => {
    const agentRow = { id: 'agent-1', userId: 'user-1' };
    const cred1 = { id: 'cred-1', serviceId: 'gmail', userId: 'user-1', accountEmail: 'one@example.com', expiresAt: null };
    const cred2 = { id: 'cred-2', serviceId: 'gmail', userId: 'user-1', accountEmail: 'two@example.com', expiresAt: null };
    const inst1 = { id: 'inst-1', agentId: 'agent-1', serviceType: 'gmail', credentialId: 'cred-1', enabled: true, isDefault: true, label: null };


    it('makes the first instance of a service the default', async () => {
      const { inserted } = mockTables(new Map<object, unknown[]>([
        [agents, [agentRow]], [credentials, [cred1]], [agentServiceInstances, []],
      ]));

      const { created } = await createServiceInstance('agent-1', 'gmail');

      expect(created).toBe(true);
      expect(inserted(agentServiceInstances)).toEqual([
        expect.objectContaining({ isDefault: true, credentialId: 'cred-1' }),
      ]);
    });

    it('adds a second account as a non-default sibling instance', async () => {
      const { inserted } = mockTables(new Map<object, unknown[]>([
        [agents, [agentRow]], [credentials, [cred1, cred2]], [agentServiceInstances, [inst1]],
      ]));

      const { created } = await createServiceInstance('agent-1', 'gmail', undefined, 'cred-2');

      expect(created).toBe(true);
      expect(inserted(agentServiceInstances)).toEqual([
        expect.objectContaining({ isDefault: false, credentialId: 'cred-2' }),
      ]);
      // The legacy junction must not have its default flipped to the newcomer.
      expect(inserted(agentServiceCredentials)).toEqual([
        expect.objectContaining({ credentialId: 'cred-2', isDefault: false }),
      ]);
    });

    it('re-adding the same account returns the existing instance without writing', async () => {
      const { inserted } = mockTables(new Map<object, unknown[]>([
        [agents, [agentRow]], [credentials, [cred1]], [agentServiceInstances, [inst1]],
      ]));

      const { instance, created } = await createServiceInstance('agent-1', 'gmail', undefined, 'cred-1');

      expect(created).toBe(false);
      expect(instance.id).toBe('inst-1');
      expect(inserted(agentServiceInstances)).toEqual([]);
    });

    it('adding with no account when one instance exists returns it (memory, skills, helm-admin retry)', async () => {
      const { inserted } = mockTables(new Map<object, unknown[]>([
        [agents, [agentRow]], [credentials, [cred1, cred2]], [agentServiceInstances, [inst1]],
      ]));

      const { instance, created } = await createServiceInstance('agent-1', 'gmail');

      expect(created).toBe(false);
      expect(instance.id).toBe('inst-1');
      expect(inserted(agentServiceInstances)).toEqual([]);
    });

    it('attaches the account to an unlinked existing instance instead of creating a sibling', async () => {
      const { inserted } = mockTables(new Map<object, unknown[]>([
        [agents, [agentRow]], [credentials, [cred1]],
        [agentServiceInstances, [{ ...inst1, credentialId: null }]],
      ]));

      const { created } = await createServiceInstance('agent-1', 'gmail', undefined, 'cred-1');

      expect(created).toBe(false);
      expect(inserted(agentServiceInstances)).toEqual([]);
      expect(db.update).toHaveBeenCalledWith(agentServiceInstances);
      expect(inserted(agentServiceCredentials)).toEqual([
        expect.objectContaining({ credentialId: 'cred-1', isDefault: true }),
      ]);
    });
  });
  /**
   * Per-instance settings. Hermeneutix stores which project an instance is
   * scoped to; the column is generic so other services can carry their own.
   * It is opaque JSON on the row and a parsed object everywhere else.
   */
  describe('instance config', () => {
    const agentRow = { id: 'agent-1', userId: 'user-1' };
    const cred = { id: 'cred-h', serviceId: 'hermeneutix', userId: 'user-1', accountEmail: 'hermeneutix', expiresAt: null };
    const projectConfig = { projectId: '11111111-1111-4111-8111-111111111111', projectName: 'Roadmap' };

    describe('parseInstanceConfig', () => {
      it('parses a JSON object', () => {
        expect(parseInstanceConfig(JSON.stringify(projectConfig))).toEqual(projectConfig);
      });

      it('returns null for null, undefined and empty', () => {
        expect(parseInstanceConfig(null)).toBeNull();
        expect(parseInstanceConfig(undefined)).toBeNull();
        expect(parseInstanceConfig('')).toBeNull();
      });

      it('returns null for invalid JSON and for non-object JSON', () => {
        expect(parseInstanceConfig('{not json')).toBeNull();
        expect(parseInstanceConfig('"a string"')).toBeNull();
        expect(parseInstanceConfig('[1,2]')).toBeNull();
        expect(parseInstanceConfig('null')).toBeNull();
      });
    });

    it('createServiceInstance persists config as JSON on the new row', async () => {
      const { inserted } = mockTables(new Map<object, unknown[]>([
        [agents, [agentRow]], [credentials, [cred]], [agentServiceInstances, []],
      ]));

      const { created } = await createServiceInstance('agent-1', 'hermeneutix', 'Roadmap', 'cred-h', projectConfig);

      expect(created).toBe(true);
      expect(inserted(agentServiceInstances)).toEqual([
        expect.objectContaining({ config: JSON.stringify(projectConfig) }),
      ]);
    });

    it('createServiceInstance writes a null config when none is given', async () => {
      const { inserted } = mockTables(new Map<object, unknown[]>([
        [agents, [agentRow]], [credentials, [cred]], [agentServiceInstances, []],
      ]));

      await createServiceInstance('agent-1', 'hermeneutix');

      expect(inserted(agentServiceInstances)).toEqual([expect.objectContaining({ config: null })]);
    });

    it('updateServiceInstance stores a config object as JSON', async () => {
      const inst = { id: 'inst-h', agentId: 'agent-1', serviceType: 'hermeneutix', credentialId: 'cred-h', enabled: true, isDefault: true, label: null, config: null };
      const { updated } = mockTables(new Map<object, unknown[]>([
        [agents, [agentRow]], [credentials, [cred]], [agentServiceInstances, [inst]],
      ]));

      await updateServiceInstance('inst-h', { config: projectConfig });

      expect(updated(agentServiceInstances)).toEqual([
        expect.objectContaining({ config: JSON.stringify(projectConfig) }),
      ]);
    });

    it('updateServiceInstance clears the config when given null and leaves it alone when omitted', async () => {
      const inst = { id: 'inst-h', agentId: 'agent-1', serviceType: 'hermeneutix', credentialId: 'cred-h', enabled: true, isDefault: true, label: null, config: JSON.stringify(projectConfig) };
      const { updated } = mockTables(new Map<object, unknown[]>([
        [agents, [agentRow]], [credentials, [cred]], [agentServiceInstances, [inst]],
      ]));

      await updateServiceInstance('inst-h', { config: null });
      await updateServiceInstance('inst-h', { label: 'Renamed' });

      const [cleared, renamed] = updated(agentServiceInstances) as Array<Record<string, unknown>>;
      expect(cleared).toEqual(expect.objectContaining({ config: null }));
      expect(renamed).toEqual(expect.objectContaining({ label: 'Renamed' }));
      expect(renamed).not.toHaveProperty('config');
    });

    it('getAgentInstances returns the parsed config, and null where there is none', async () => {
      const withConfig = { id: 'inst-h', agentId: 'agent-1', serviceType: 'hermeneutix', credentialId: 'cred-h', enabled: true, isDefault: true, label: 'Roadmap', config: JSON.stringify(projectConfig) };
      const without = { id: 'inst-g', agentId: 'agent-1', serviceType: 'gmail', credentialId: null, enabled: true, isDefault: true, label: null, config: null };
      mockTables(new Map<object, unknown[]>([
        [agents, [agentRow]], [credentials, [cred]], [agentServiceInstances, [withConfig, without]],
      ]));

      const instances = await getAgentInstances('agent-1');

      expect(instances.find((i) => i.id === 'inst-h')?.config).toEqual(projectConfig);
      expect(instances.find((i) => i.id === 'inst-g')?.config).toBeNull();
    });
  });
  /**
   * Deleting a credential must not leave rows pointing at its id. The
   * Credentials page "Update" flow is delete-then-recreate, and an instance
   * still holding the dead id reads as 'missing', sends the dead id to the
   * project picker, and gives tool calls no token.
   */
  describe('detachCredential', () => {
    it('nulls instance and legacy access links and drops junction rows for the credential', async () => {
      const { updated, deleted } = mockTables(new Map<object, unknown[]>());

      await detachCredential('cred-old');

      expect(updated(agentServiceInstances)).toEqual([expect.objectContaining({ credentialId: null })]);
      expect(updated(agentServiceAccess)).toEqual([expect.objectContaining({ credentialId: null })]);
      expect(deleted()).toEqual([agentServiceCredentials]);
    });
  });

  /**
   * autoLinkCredential fills the instances of one service that have no usable
   * credential. Two things count as unusable: no credential at all, and a
   * credential id whose row is gone. And it may only touch agents that belong
   * to the credential's owner.
   */
  describe('autoLinkCredential', () => {
    const agent1 = { id: 'agent-1', userId: 'user-1' };
    const agent2 = { id: 'agent-2', userId: 'user-2' };
    const credNew = { id: 'cred-new', serviceId: 'hermeneutix', userId: 'user-1', accountEmail: 'hermeneutix', expiresAt: null };
    const credLive = { id: 'cred-live', serviceId: 'hermeneutix', userId: 'user-1', accountEmail: 'hermeneutix', expiresAt: null };
    const inst = (id: string, agentId: string, credentialId: string | null) =>
      ({ id, agentId, serviceType: 'hermeneutix', credentialId, enabled: true, isDefault: true, label: null, config: null });

    it('relinks an instance whose credential row no longer exists', async () => {
      const { updated } = mockTables(new Map<object, unknown[]>([
        [agents, [agent1]], [credentials, [credNew]],
        [agentServiceInstances, [inst('inst-1', 'agent-1', 'cred-old')]],
      ]));

      await autoLinkCredential('hermeneutix', 'cred-new');

      expect(updated(agentServiceInstances)).toEqual([expect.objectContaining({ credentialId: 'cred-new' })]);
    });

    it('fills an instance that has no credential', async () => {
      const { updated } = mockTables(new Map<object, unknown[]>([
        [agents, [agent1]], [credentials, [credNew]],
        [agentServiceInstances, [inst('inst-1', 'agent-1', null)]],
      ]));

      await autoLinkCredential('hermeneutix', 'cred-new');

      expect(updated(agentServiceInstances)).toEqual([expect.objectContaining({ credentialId: 'cred-new' })]);
    });

    it('leaves an instance holding a live credential alone', async () => {
      const { updated } = mockTables(new Map<object, unknown[]>([
        [agents, [agent1]], [credentials, [credNew, credLive]],
        [agentServiceInstances, [inst('inst-1', 'agent-1', 'cred-live')]],
      ]));

      await autoLinkCredential('hermeneutix', 'cred-new');

      expect(updated(agentServiceInstances)).toEqual([]);
    });

    it("never links another user's instances, unlinked or dangling", async () => {
      const { updated } = mockTables(new Map<object, unknown[]>([
        [agents, [agent1, agent2]], [credentials, [credNew]],
        [agentServiceInstances, [inst('inst-2', 'agent-2', null), inst('inst-3', 'agent-2', 'cred-old')]],
      ]));

      await autoLinkCredential('hermeneutix', 'cred-new');

      expect(updated(agentServiceInstances)).toEqual([]);
    });

    it("links only the owner's instance when several users have unlinked ones", async () => {
      const { updated } = mockTables(new Map<object, unknown[]>([
        [agents, [agent1, agent2]], [credentials, [credNew]],
        [agentServiceInstances, [inst('inst-1', 'agent-1', null), inst('inst-2', 'agent-2', null)]],
      ]));

      await autoLinkCredential('hermeneutix', 'cred-new');

      expect(updated(agentServiceInstances)).toHaveLength(1);
    });

    it('keeps the unscoped behaviour for a credential with no owner', async () => {
      const { updated } = mockTables(new Map<object, unknown[]>([
        [agents, [agent1, agent2]], [credentials, [{ ...credNew, userId: null }]],
        [agentServiceInstances, [inst('inst-1', 'agent-1', null), inst('inst-2', 'agent-2', null)]],
      ]));

      await autoLinkCredential('hermeneutix', 'cred-new');

      expect(updated(agentServiceInstances)).toHaveLength(2);
    });

    it('applies the same rules to legacy access rows', async () => {
      const access = (id: string, agentId: string, credentialId: string | null) =>
        ({ id, agentId, serviceType: 'hermeneutix', credentialId, enabled: true });
      const { updated } = mockTables(new Map<object, unknown[]>([
        [agents, [agent1, agent2]], [credentials, [credNew, credLive]],
        [agentServiceAccess, [
          access('acc-1', 'agent-1', 'cred-old'),   // dangling, owner's → relink
          access('acc-2', 'agent-1', 'cred-live'),  // live → untouched
          access('acc-3', 'agent-2', null),         // unlinked, other user → untouched
          access('acc-4', 'agent-1', null),         // unlinked, owner's → relink
        ]],
      ]));

      await autoLinkCredential('hermeneutix', 'cred-new');

      expect(updated(agentServiceAccess)).toEqual([
        expect.objectContaining({ credentialId: 'cred-new' }),
        expect.objectContaining({ credentialId: 'cred-new' }),
      ]);
    });
  });
  /**
   * Instances and the legacy agent_service_access row are two records of one
   * fact, and listEnabledServiceTypes unions them. createServiceInstance turns
   * the access row on; deleting the last instance must turn it off, or the
   * service keeps counting as enabled (combination guard, dashboard) with no
   * instance left to remove.
   */
  describe('Drive path config', () => {
    const accessRows = (rows: unknown[]) =>
      mockTables(new Map<object, unknown[]>([[agentServiceAccess, rows]]));

    it('round-trips a config through the drive access row', async () => {
      const config = {
        defaultLevel: 'read' as const,
        rules: [{ folderId: 'folder-1', label: 'Reports', permission: 'write' as const }],
      };
      const { inserted } = accessRows([]);

      await setDrivePathConfig('agent-1', config);

      const [row] = inserted(agentServiceAccess) as Array<{ pathRules: string }>;
      expect(row).toEqual(expect.objectContaining({ agentId: 'agent-1', serviceType: 'drive' }));

      accessRows([{ pathRules: row.pathRules }]);
      await expect(getDrivePathConfig('agent-1')).resolves.toEqual(config);
    });

    it('defaults to write with no rules when the agent has no drive row', async () => {
      accessRows([]);
      await expect(getDrivePathConfig('agent-1')).resolves.toEqual({ defaultLevel: 'write', rules: [] });
    });

    /**
     * A row that cannot be decoded must not fall through to the permissive
     * default: that would silently grant full Drive write on a corrupt column.
     */
    it.each([
      ['unparseable JSON', '{not json'],
      ['a non-object', '"write"'],
      ['an unknown defaultLevel', JSON.stringify({ defaultLevel: 'admin', rules: [] })],
      ['rules that are not an array', JSON.stringify({ defaultLevel: 'write', rules: {} })],
    ])('fails closed to blocked on %s and warns', async (_label, raw) => {
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
      accessRows([{ pathRules: raw }]);

      await expect(getDrivePathConfig('agent-1')).resolves.toEqual({ defaultLevel: 'blocked', rules: [] });
      expect(warn).toHaveBeenCalledWith(expect.stringContaining('agent-1'));
      warn.mockRestore();
    });
  });

  describe('deleteServiceInstance and the legacy access row', () => {
    const accessCalls = () =>
      vi.mocked(client.execute).mock.calls
        .map((c) => c[0] as { sql: string; args: unknown[] })
        .filter((q) => typeof q?.sql === 'string' && q.sql.includes('INSERT INTO agent_service_access'));

    it('disables the access row when the last instance of a service is deleted', async () => {
      const skills = { id: 'inst-skills', agentId: 'agent-1', serviceType: 'skills', credentialId: null, enabled: true, isDefault: true, label: null, config: null };
      mockTables(new Map<object, unknown[]>([[agentServiceInstances, [skills]]]));

      await deleteServiceInstance('inst-skills');

      expect(accessCalls()).toHaveLength(1);
      expect(accessCalls()[0].args.slice(1, 4)).toEqual(['agent-1', 'skills', false]);
    });

    it('leaves the access row alone while another instance of the service remains', async () => {
      const inst1 = { id: 'inst-1', agentId: 'agent-1', serviceType: 'gmail', credentialId: null, enabled: true, isDefault: true, label: null, config: null };
      const inst2 = { id: 'inst-2', agentId: 'agent-1', serviceType: 'gmail', credentialId: null, enabled: true, isDefault: false, label: null, config: null };
      const { updated } = mockTables(new Map<object, unknown[]>([[agentServiceInstances, [inst1, inst2]]]));

      await deleteServiceInstance('inst-1');

      expect(accessCalls()).toEqual([]);
      // The sibling is promoted to default, as before.
      expect(updated(agentServiceInstances)).toEqual([expect.objectContaining({ isDefault: true })]);
    });
  });
});
