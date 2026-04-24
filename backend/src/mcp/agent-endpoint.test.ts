/**
 * Tests for MCP Agent Endpoint
 */

import { describe, it, expect, vi, beforeEach, beforeAll } from 'vitest';
import { approvalQueue } from '../approvals/queue.js';
import {
  handleMCPRequest,
  getServiceTypeFromTool,
  MCP_ERROR_CODES,
  type MCPRequest,
} from './agent-endpoint.js';

// Mock dependencies
vi.mock('../config/index.js', () => ({
  config: {
    sessionSecret: 'test-secret-32-chars-long-padded!!',
    nodeEnv: 'test',
    dashboardUrl: 'http://localhost:5173',
    adminPassword: 'test-password',
    logLevel: 'silent',
    port: 0,
    host: '127.0.0.1',
    databaseUrl: 'postgres://localhost/test',
    encryptionKey: '0'.repeat(64),
  },
}));

vi.mock('../services/email.js', () => ({
  sendReauthEmail: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('../db/index.js', () => ({
  db: {
    select: () => ({
      from: () => ({
        where: vi.fn().mockResolvedValue([{ id: 'agent-1', name: 'Test Agent', status: 'active' }]),
      }),
    }),
  },
}));

vi.mock('../services/permissions.js', () => ({
  getEffectivePermissions: vi.fn().mockResolvedValue({
    enabled: true,
    tools: {
      gmail_list_messages: 'allow',
      gmail_get_message: 'allow',
      gmail_send_message: 'block',
      gmail_create_draft: 'require_approval',
    },
  }),
  getEffectiveInstancePermissions: vi.fn().mockResolvedValue({
    enabled: true,
    tools: {
      gmail_list_messages: 'allow',
      gmail_get_message: 'allow',
      gmail_send_message: 'block',
      gmail_create_draft: 'require_approval',
    },
  }),
  canAccessTool: vi.fn().mockImplementation(async (_agentId: string, _serviceType: string, toolName: string) => {
    if (toolName === 'gmail_send_message') {
      return { allowed: false, requiresApproval: false };
    }
    if (toolName === 'gmail_create_draft') {
      return { allowed: true, requiresApproval: true };
    }
    return { allowed: true, requiresApproval: false };
  }),
}));

vi.mock('@reins/servers', () => ({
  serviceDefinitions: [
    { type: 'gmail', name: 'Gmail' },
    { type: 'drive', name: 'Google Drive' },
    { type: 'calendar', name: 'Google Calendar' },
    { type: 'web-search', name: 'Web Search' },
    { type: 'browser', name: 'Browser' },
  ],
  serviceRegistry: new Map([
    ['gmail', { type: 'gmail', auth: { required: false } }],
    ['drive', { type: 'drive', auth: { required: false } }],
    ['calendar', { type: 'calendar', auth: { required: false } }],
    ['web-search', { type: 'web-search', auth: { required: false } }],
    ['browser', { type: 'browser', auth: { required: false } }],
  ]),
  getServiceTypeFromToolName: (name: string) => {
    if (name.startsWith('gmail_')) return 'gmail';
    if (name.startsWith('drive_')) return 'drive';
    if (name.startsWith('calendar_')) return 'calendar';
    if (name === 'web_search' || name.startsWith('web_search_')) return 'web-search';
    if (name.startsWith('browser_')) return 'browser';
    return null;
  },
}));

vi.mock('./server-manager.js', () => ({
  serverManager: {
    getServer: vi.fn().mockReturnValue({
      serverType: 'gmail',
      name: 'Gmail',
      getToolDefinitions: () => [
        {
          name: 'gmail_list_messages',
          description: 'List email messages',
          inputSchema: {
            type: 'object',
            properties: {
              query: { type: 'string' },
              maxResults: { type: 'number' },
            },
          },
        },
        {
          name: 'gmail_get_message',
          description: 'Get email message by ID',
          inputSchema: {
            type: 'object',
            properties: {
              messageId: { type: 'string' },
            },
            required: ['messageId'],
          },
        },
        {
          name: 'gmail_send_message',
          description: 'Send an email',
          inputSchema: {
            type: 'object',
            properties: {
              to: { type: 'string' },
              subject: { type: 'string' },
              body: { type: 'string' },
            },
          },
        },
        {
          name: 'gmail_create_draft',
          description: 'Create a draft email',
          inputSchema: {
            type: 'object',
            properties: {
              to: { type: 'string' },
              subject: { type: 'string' },
              body: { type: 'string' },
            },
          },
        },
      ],
      callTool: vi.fn().mockResolvedValue({
        success: true,
        data: [{ id: 'msg1', subject: 'Hello' }],
      }),
    }),
  },
}));

vi.mock('../approvals/queue.js', () => ({
  approvalQueue: {
    submit: vi.fn().mockResolvedValue('approval-123'),
    waitForDecision: vi.fn().mockResolvedValue({ approved: true, approver: 'user' }),
    registerExecutor: vi.fn(),
    get: vi.fn().mockResolvedValue(null),
  },
}));

vi.mock('../audit/logger.js', () => ({
  auditLogger: {
    logToolCall: vi.fn().mockResolvedValue(undefined),
    logApproval: vi.fn().mockResolvedValue(undefined),
  },
}));

vi.mock('../credentials/vault.js', () => ({
  credentialVault: {
    retrieve: vi.fn().mockResolvedValue({
      serviceId: 'gmail',
      type: 'oauth2',
      data: { accessToken: 'test-token' },
    }),
  },
}));

// Trigger ensureRegistry() so _getServiceType is populated before synchronous tests run
beforeAll(async () => {
  await handleMCPRequest('any', { jsonrpc: '1.0' as '2.0', id: 0, method: 'tools/list' });
});

describe('getServiceTypeFromTool', () => {
  it('should return gmail for gmail_ prefix', () => {
    expect(getServiceTypeFromTool('gmail_list_messages')).toBe('gmail');
    expect(getServiceTypeFromTool('gmail_get_message')).toBe('gmail');
  });

  it('should return drive for drive_ prefix', () => {
    expect(getServiceTypeFromTool('drive_list_files')).toBe('drive');
    expect(getServiceTypeFromTool('drive_read_file')).toBe('drive');
  });

  it('should return calendar for calendar_ prefix', () => {
    expect(getServiceTypeFromTool('calendar_list_events')).toBe('calendar');
  });

  it('should return web-search for web_search prefix', () => {
    expect(getServiceTypeFromTool('web_search')).toBe('web-search');
    expect(getServiceTypeFromTool('web_search_news')).toBe('web-search');
  });

  it('should return browser for browser_ prefix', () => {
    expect(getServiceTypeFromTool('browser_navigate')).toBe('browser');
    expect(getServiceTypeFromTool('browser_screenshot')).toBe('browser');
  });

  it('should return null for unknown prefix', () => {
    expect(getServiceTypeFromTool('unknown_tool')).toBeNull();
    expect(getServiceTypeFromTool('random')).toBeNull();
  });
});

describe('handleMCPRequest', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe('Invalid requests', () => {
    it('should reject invalid JSON-RPC version', async () => {
      const request = {
        jsonrpc: '1.0' as '2.0',
        id: 1,
        method: 'tools/list' as const,
      };

      const response = await handleMCPRequest('agent-1', request);

      expect(response.error).toBeDefined();
      expect(response.error?.code).toBe(MCP_ERROR_CODES.INVALID_REQUEST);
    });

    it('should reject unknown method', async () => {
      const request: MCPRequest = {
        jsonrpc: '2.0',
        id: 1,
        method: 'unknown/method' as 'tools/list',
      };

      const response = await handleMCPRequest('agent-1', request);

      expect(response.error).toBeDefined();
      expect(response.error?.code).toBe(MCP_ERROR_CODES.METHOD_NOT_FOUND);
    });
  });

  describe('tools/list', () => {
    it('should return filtered tools for agent', async () => {
      const request: MCPRequest = {
        jsonrpc: '2.0',
        id: 1,
        method: 'tools/list',
      };

      const response = await handleMCPRequest('agent-1', request);

      expect(response.result).toBeDefined();
      const result = response.result as { tools: Array<{ name: string }> };
      expect(result.tools).toBeInstanceOf(Array);

      // Should include allowed tools
      const toolNames = result.tools.map((t) => t.name);
      expect(toolNames).toContain('gmail_list_messages');
      expect(toolNames).toContain('gmail_get_message');
      expect(toolNames).toContain('gmail_create_draft'); // require_approval is visible

      // Should NOT include blocked tools
      expect(toolNames).not.toContain('gmail_send_message');
    });
  });

  describe('tools/call', () => {
    it('should reject call without tool name', async () => {
      const request: MCPRequest = {
        jsonrpc: '2.0',
        id: 1,
        method: 'tools/call',
        params: {},
      };

      const response = await handleMCPRequest('agent-1', request);

      expect(response.error).toBeDefined();
      expect(response.error?.code).toBe(MCP_ERROR_CODES.INVALID_PARAMS);
    });

    it('should reject call for unknown tool', async () => {
      const request: MCPRequest = {
        jsonrpc: '2.0',
        id: 1,
        method: 'tools/call',
        params: {
          name: 'unknown_tool',
          arguments: {},
        },
      };

      const response = await handleMCPRequest('agent-1', request);

      expect(response.error).toBeDefined();
      expect(response.error?.code).toBe(MCP_ERROR_CODES.INVALID_PARAMS);
    });

    it('returns deferred response immediately when tool requires approval', async () => {
      const { approvalQueue } = await import('../approvals/queue.js');

      const request: MCPRequest = {
        jsonrpc: '2.0',
        id: 42,
        method: 'tools/call',
        params: {
          name: 'gmail_create_draft',
          arguments: { to: 'test@example.com', subject: 'Hello', body: 'World' },
        },
      };

      const response = await handleMCPRequest('agent-1', request);

      // Should return a result (not an error)
      expect(response.error).toBeUndefined();
      expect(response.result).toBeDefined();

      const result = response.result as { content: Array<{ type: string; text: string }> };
      expect(result.content).toHaveLength(1);
      expect(result.content[0].type).toBe('text');

      const parsed = JSON.parse(result.content[0].text);
      expect(parsed.deferred).toBe(true);
      expect(typeof parsed.jobId).toBe('string');
      expect(parsed.jobId.length).toBeGreaterThan(0);

      // registerExecutor must have been called with the jobId
      expect(approvalQueue.registerExecutor).toHaveBeenCalledWith(
        parsed.jobId,
        expect.any(Function),
      );
    });
  });
});

describe('reins_get_result tool', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('appears in tools/list for any agent', async () => {
    const response = await handleMCPRequest('agent-1', {
      jsonrpc: '2.0', id: 1, method: 'tools/list',
    });
    const toolNames = (response.result as { tools: Array<{ name: string }> }).tools.map((t) => t.name);
    expect(toolNames).toContain('reins_get_result');
  });

  it('returns pending status for an unresolved job', async () => {
    vi.mocked(approvalQueue.get).mockResolvedValueOnce({
      id: 'job-1', agentId: 'agent-1', tool: 'gmail_send_email',
      arguments: {}, status: 'pending',
      requestedAt: new Date(), expiresAt: new Date(Date.now() + 3600_000),
    } as any);

    const response = await handleMCPRequest('agent-1', {
      jsonrpc: '2.0', id: 1, method: 'tools/call',
      params: { name: 'reins_get_result', arguments: { jobId: 'job-1' } },
    });

    expect(response.error).toBeUndefined();
    const content = JSON.parse((response.result as { content: Array<{ text: string }> }).content[0].text);
    expect(content.status).toBe('pending');
    expect(content.jobId).toBe('job-1');
  });

  it('returns completed status with result when job is approved and executed', async () => {
    vi.mocked(approvalQueue.get).mockResolvedValueOnce({
      id: 'job-1', agentId: 'agent-1', tool: 'gmail_send_email',
      arguments: {}, status: 'approved',
      requestedAt: new Date(), expiresAt: new Date(Date.now() + 3600_000),
      resultJson: JSON.stringify({ messageId: 'msg-123' }),
    } as any);

    const response = await handleMCPRequest('agent-1', {
      jsonrpc: '2.0', id: 1, method: 'tools/call',
      params: { name: 'reins_get_result', arguments: { jobId: 'job-1' } },
    });

    expect(response.error).toBeUndefined();
    const content = JSON.parse((response.result as { content: Array<{ text: string }> }).content[0].text);
    expect(content.status).toBe('completed');
    expect(content.result).toEqual({ messageId: 'msg-123' });
  });

  it('returns rejected status with reason', async () => {
    vi.mocked(approvalQueue.get).mockResolvedValueOnce({
      id: 'job-1', agentId: 'agent-1', tool: 'gmail_send_email',
      arguments: {}, status: 'rejected',
      requestedAt: new Date(), expiresAt: new Date(Date.now() + 3600_000),
      resolutionComment: 'Not allowed at this time',
    } as any);

    const response = await handleMCPRequest('agent-1', {
      jsonrpc: '2.0', id: 1, method: 'tools/call',
      params: { name: 'reins_get_result', arguments: { jobId: 'job-1' } },
    });

    expect(response.error).toBeUndefined();
    const content = JSON.parse((response.result as { content: Array<{ text: string }> }).content[0].text);
    expect(content.status).toBe('rejected');
    expect(content.reason).toBe('Not allowed at this time');
  });

  it('returns error for unknown jobId', async () => {
    vi.mocked(approvalQueue.get).mockResolvedValueOnce(null);

    const response = await handleMCPRequest('agent-1', {
      jsonrpc: '2.0', id: 1, method: 'tools/call',
      params: { name: 'reins_get_result', arguments: { jobId: 'nonexistent' } },
    });

    expect(response.error).toBeDefined();
    expect(response.error!.message).toMatch(/not found/i);
  });

  it('only returns results for jobs belonging to the calling agent', async () => {
    vi.mocked(approvalQueue.get).mockResolvedValueOnce({
      id: 'job-1', agentId: 'other-agent', tool: 'gmail_send_email',
      arguments: {}, status: 'approved',
      requestedAt: new Date(), expiresAt: new Date(Date.now() + 3600_000),
      resultJson: JSON.stringify({ secret: 'data' }),
    } as any);

    const response = await handleMCPRequest('agent-1', {
      jsonrpc: '2.0', id: 1, method: 'tools/call',
      params: { name: 'reins_get_result', arguments: { jobId: 'job-1' } },
    });

    expect(response.error).toBeDefined();
    expect(response.error!.message).toMatch(/not found/i);
  });

  it('returns expired status for an expired job', async () => {
    vi.mocked(approvalQueue.get).mockResolvedValueOnce({
      id: 'job-1', agentId: 'agent-1', tool: 'gmail_send_email',
      arguments: {}, status: 'expired',
      requestedAt: new Date(), expiresAt: new Date(Date.now() - 1000),
    } as any);

    const response = await handleMCPRequest('agent-1', {
      jsonrpc: '2.0', id: 1, method: 'tools/call',
      params: { name: 'reins_get_result', arguments: { jobId: 'job-1' } },
    });

    expect(response.error).toBeUndefined();
    const content = JSON.parse((response.result as { content: Array<{ text: string }> }).content[0].text);
    expect(content.status).toBe('expired');
    expect(content.jobId).toBe('job-1');
  });

  it('returns pending when approved but execution not yet complete', async () => {
    vi.mocked(approvalQueue.get).mockResolvedValueOnce({
      id: 'job-1', agentId: 'agent-1', tool: 'gmail_send_email',
      arguments: {}, status: 'approved',
      requestedAt: new Date(), expiresAt: new Date(Date.now() + 3600_000),
      resultJson: undefined,
    } as any);

    const response = await handleMCPRequest('agent-1', {
      jsonrpc: '2.0', id: 1, method: 'tools/call',
      params: { name: 'reins_get_result', arguments: { jobId: 'job-1' } },
    });

    expect(response.error).toBeUndefined();
    const content = JSON.parse((response.result as { content: Array<{ text: string }> }).content[0].text);
    expect(content.status).toBe('pending');
    expect(content.jobId).toBe('job-1');
  });
});
