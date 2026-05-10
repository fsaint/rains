/**
 * Permission Service Tests
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

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
      permissions: {
        read: ['gmail_list_accounts', 'gmail_list_messages', 'gmail_get_message', 'gmail_search', 'gmail_list_labels'],
        write: ['gmail_create_draft', 'gmail_send_draft'],
        blocked: ['gmail_send_message', 'gmail_delete_message'],
      },
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
      return null;
    },
  };
});

import { db, client } from '../db/index.js';
import {
  getPermissionMatrix,
  getAgentServiceConfig,
  setServiceAccess,
  linkCredential,
  unlinkCredential,
  setToolPermission,
  resetToolPermission,
  getEffectivePermissions,
  canAccessTool,
  getCredentialsForService,
  setPermissionLevel,
  getPermissionLevel,
  PERMISSION_PRESETS,
} from './permissions.js';

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
      expect(result.services).toHaveLength(5);
      expect(result.cells).toHaveLength(10); // 2 agents * 5 services
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

  describe('PERMISSION_PRESETS', () => {
    it('should have presets for all services', () => {
      expect(PERMISSION_PRESETS.gmail).toBeDefined();
      expect(PERMISSION_PRESETS.drive).toBeDefined();
      expect(PERMISSION_PRESETS.calendar).toBeDefined();
      expect(PERMISSION_PRESETS['web-search']).toBeDefined();
      expect(PERMISSION_PRESETS.browser).toBeDefined();
    });

    it('should categorize gmail tools correctly', () => {
      const gmail = PERMISSION_PRESETS.gmail;
      expect(gmail.read).toContain('gmail_list_messages');
      expect(gmail.read).toContain('gmail_get_message');
      expect(gmail.write).toContain('gmail_create_draft');
      expect(gmail.blocked).toContain('gmail_send_message');
      expect(gmail.blocked).toContain('gmail_delete_message');
    });
  });

  describe('setPermissionLevel', () => {
    it('should throw error for custom level', async () => {
      await expect(setPermissionLevel('agent-1', 'gmail', 'custom'))
        .rejects.toThrow("Cannot set permission level to 'custom'");
    });

    it('should disable service for none level', async () => {
      await setPermissionLevel('agent-1', 'gmail', 'none');

      expect(client.execute).toHaveBeenCalledWith(expect.objectContaining({
        sql: expect.stringContaining('agent_service_access'),
        args: expect.arrayContaining(['agent-1', 'gmail', false]),
      }));
    });

    it('should enable service and set read-only permissions', async () => {
      // setServiceAccess now uses client.execute (no db.select/insert needed for it)

      // Mock setToolPermission calls - need multiple mocks for each tool
      const gmailTools = [...PERMISSION_PRESETS.gmail.read, ...PERMISSION_PRESETS.gmail.write, ...PERMISSION_PRESETS.gmail.blocked];
      for (let i = 0; i < gmailTools.length; i++) {
        vi.mocked(db.select).mockReturnValueOnce({
          from: vi.fn().mockReturnValue({
            where: vi.fn().mockResolvedValue([]),
          }),
        } as never);
        vi.mocked(db.insert).mockReturnValueOnce({
          values: vi.fn().mockResolvedValue(undefined),
        } as never);
      }

      await setPermissionLevel('agent-1', 'gmail', 'read');

      // Check that insert was called for enabling service and for tool permissions
      expect(db.insert).toHaveBeenCalled();
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
      const readTools = PERMISSION_PRESETS.gmail.read.reduce((acc, tool) => {
        acc[tool] = 'allow';
        return acc;
      }, {} as Record<string, string>);

      const writeTools = PERMISSION_PRESETS.gmail.write.reduce((acc, tool) => {
        acc[tool] = 'block';
        return acc;
      }, {} as Record<string, string>);

      const blockedTools = PERMISSION_PRESETS.gmail.blocked.reduce((acc, tool) => {
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
      const readTools = PERMISSION_PRESETS.gmail.read.reduce((acc, tool) => {
        acc[tool] = 'allow';
        return acc;
      }, {} as Record<string, string>);

      const writeTools = PERMISSION_PRESETS.gmail.write.reduce((acc, tool) => {
        acc[tool] = 'require_approval';
        return acc;
      }, {} as Record<string, string>);

      const blockedTools = PERMISSION_PRESETS.gmail.blocked.reduce((acc, tool) => {
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
});
