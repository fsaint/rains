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
}));

vi.mock('../db/schema.js', () => ({
  agents: { id: 'id', name: 'name', status: 'status' },
  agentServiceAccess: { id: 'id', agentId: 'agent_id', serviceType: 'service_type', enabled: 'enabled', credentialId: 'credential_id' },
  agentToolPermissions: { id: 'id', agentId: 'agent_id', serviceType: 'service_type', toolName: 'tool_name', permission: 'permission' },
  credentials: { id: 'id', serviceId: 'service_id', type: 'type', expiresAt: 'expires_at' },
}));

vi.mock('nanoid', () => ({
  nanoid: vi.fn(() => 'new-id'),
}));

vi.mock('../mcp/server-manager.js', () => ({
  serverManager: {
    getAllServerTools: vi.fn(() => []),
  },
}));

import { db } from '../db/index.js';
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
        .mockReturnValueOnce(mockQueryChain(mockCredentials, false) as never); // credentials

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
        .mockReturnValueOnce(mockQueryChain([], false) as never);

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
        .mockReturnValueOnce(mockQueryChain([]) as never); // tool overrides

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
        .mockReturnValueOnce(mockQueryChain(mockOverrides) as never);

      const result = await getAgentServiceConfig('agent-1', 'gmail');

      const sendTool = result?.tools.find((t) => t.toolName === 'gmail_send_message');
      expect(sendTool?.permission).toBe('allow');
      expect(sendTool?.isDefault).toBe(false);
    });
  });

  describe('setServiceAccess', () => {
    it('should update existing access record', async () => {
      const mockExisting = { id: 'access-1', agentId: 'agent-1', serviceType: 'gmail' };

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

      await setServiceAccess('agent-1', 'gmail', true);

      expect(db.update).toHaveBeenCalled();
    });

    it('should create new access record if none exists', async () => {
      vi.mocked(db.select).mockReturnValueOnce({
        from: vi.fn().mockReturnValue({
          where: vi.fn().mockResolvedValue([]),
        }),
      } as never);

      vi.mocked(db.insert).mockReturnValueOnce({
        values: vi.fn().mockResolvedValue(undefined),
      } as never);

      await setServiceAccess('agent-1', 'gmail', true);

      expect(db.insert).toHaveBeenCalled();
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
      vi.mocked(db.select).mockReturnValueOnce({
        from: vi.fn().mockReturnValue({
          where: vi.fn().mockResolvedValue([{ id: 'access-1' }]),
        }),
      } as never);

      vi.mocked(db.update).mockReturnValueOnce({
        set: vi.fn().mockReturnValue({
          where: vi.fn().mockResolvedValue(undefined),
        }),
      } as never);

      await setPermissionLevel('agent-1', 'gmail', 'none');

      expect(db.update).toHaveBeenCalled();
    });

    it('should enable service and set read-only permissions', async () => {
      // Mock setServiceAccess
      vi.mocked(db.select).mockReturnValueOnce({
        from: vi.fn().mockReturnValue({
          where: vi.fn().mockResolvedValue([]),
        }),
      } as never);
      vi.mocked(db.insert).mockReturnValueOnce({
        values: vi.fn().mockResolvedValue(undefined),
      } as never);

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
