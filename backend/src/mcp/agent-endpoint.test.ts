/**
 * Tests for MCP Agent Endpoint
 */

import { describe, it, expect, vi, beforeEach, beforeAll } from 'vitest';
import { approvalQueue } from '../approvals/queue.js';
import {
  handleMCPRequest,
  getServiceTypeFromTool,
  buildSkillCatalog,
  MCP_ERROR_CODES,
  type MCPRequest,
  looksLikeAuthFailure,
  _resetReauthThrottleForTests,
} from './agent-endpoint.js';
import { client } from '../db/index.js';

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

// Shared `where` mock so individual tests can override with mockReturnValueOnce
const { dbWhereMock } = vi.hoisted(() => ({
  dbWhereMock: vi.fn().mockResolvedValue([{ id: 'agent-1', name: 'Test Agent', status: 'active' }]),
}));

vi.mock('../db/index.js', () => ({
  db: {
    select: vi.fn(() => ({
      from: () => ({
        where: dbWhereMock,
      }),
    })),
  },
  client: {
    execute: vi.fn().mockResolvedValue({ rows: [] }),
  },
}));

vi.mock('../services/permissions.js', () => ({
  getDrivePathConfig: vi.fn().mockResolvedValue({ defaultLevel: 'write', rules: [] }),
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
    // Before the gmail_ arm, mirroring the real resolver's first-match order —
    // these prefixes do not overlap, but the ordering is the property.
    if (name.startsWith('helm_admin_')) return 'helm-admin';
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
  MAX_REVISIONS: 3,
  approvalQueue: {
    submit: vi.fn().mockResolvedValue('approval-123'),
    waitForDecision: vi.fn().mockResolvedValue({ approved: true, approver: 'user' }),
    registerExecutor: vi.fn(),
    get: vi.fn().mockResolvedValue(null),
    getLatestDeferred: vi.fn().mockResolvedValue(null),
    submitReauth: vi.fn().mockResolvedValue({ id: 'reauth-1', isNew: true, emailThrottled: false }),
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
      data: { accessToken: 'test-token', tokenType: 'Bearer' },
    }),
    getValidAccessToken: vi.fn().mockResolvedValue('test-access-token'),
  },
}));
vi.mock('../services/spend.js', () => ({
  checkSpendCap: vi.fn().mockResolvedValue({ allowed: true }),
  recordUsage: vi.fn().mockResolvedValue(undefined),
}));
vi.mock('../services/billing.js', () => ({
  getSubscription: vi.fn().mockResolvedValue(null),
  upsertSubscription: vi.fn().mockResolvedValue(undefined),
  applyGracePeriod: vi.fn().mockResolvedValue(undefined),
  clearGrace: vi.fn().mockResolvedValue(undefined),
  cancelSubscription: vi.fn().mockResolvedValue(undefined),
  checkDeployGate: vi.fn().mockResolvedValue({ allowed: true }),
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
      vi.mocked(client.execute).mockResolvedValue({
        rows: [{ id: 'dep-1', runtime: 'openclaw', mcp_server_name: 'helm', has_onboarded: true }],
      } as any);

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

      const text = result.content[0].text;
      expect(text).toContain('APPROVAL_PENDING');
      expect(text).toContain('helm__get_result');
      expect(text).toContain('USER_MESSAGE:');
      expect(text).toContain('http://localhost:5173/approvals');

      // Extract jobId from "jobId: <id>" in the text
      const jobIdMatch = text.match(/jobId[":]+\s*"?([a-zA-Z0-9_-]+)"?/);
      expect(jobIdMatch).not.toBeNull();
      const jobId = jobIdMatch![1];
      expect(jobId.length).toBeGreaterThan(0);

      // registerExecutor must have been called with the jobId
      expect(approvalQueue.registerExecutor).toHaveBeenCalledWith(
        jobId,
        expect.any(Function),
      );
    });
  });
});

describe('helm rename', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('identifies the server as helm on initialize', async () => {
    const response = await handleMCPRequest('agent-1', {
      jsonrpc: '2.0', id: 1, method: 'initialize',
    });
    const result = response.result as { serverInfo: { name: string } };
    expect(result.serverInfo.name).toBe('helm');
  });

  it('advertises only the new built-in names in tools/list', async () => {
    const response = await handleMCPRequest('agent-1', {
      jsonrpc: '2.0', id: 1, method: 'tools/list',
    });
    const toolNames = (response.result as { tools: Array<{ name: string }> }).tools.map((t) => t.name);
    expect(toolNames).toContain('get_result');
    expect(toolNames).not.toContain('reins_get_result');
  });

  it('still dispatches the legacy reins_get_result name', async () => {
    vi.mocked(approvalQueue.get).mockResolvedValueOnce({
      id: 'job-1', agentId: 'agent-1', tool: 'gmail_send_email',
      arguments: {}, status: 'approved',
      requestedAt: new Date(), expiresAt: new Date(Date.now() + 3600_000),
      resultJson: JSON.stringify({ messageId: 'msg-legacy' }),
    } as any);

    const response = await handleMCPRequest('agent-1', {
      jsonrpc: '2.0', id: 1, method: 'tools/call',
      params: { name: 'reins_get_result', arguments: { jobId: 'job-1' } },
    });

    expect(response.error).toBeUndefined();
    const content = JSON.parse((response.result as { content: Array<{ text: string }> }).content[0].text);
    expect(content.status).toBe('completed');
    expect(content.result).toEqual({ messageId: 'msg-legacy' });
  });

  it('still dispatches the legacy reins__mark_onboarded name', async () => {
    vi.mocked(client.execute).mockResolvedValue({
      rows: [{ id: 'dep-1', fly_app_name: 'app', fly_machine_id: 'm1', has_onboarded: false }],
    } as any);

    const response = await handleMCPRequest('agent-1', {
      jsonrpc: '2.0', id: 1, method: 'tools/call',
      params: { name: 'reins__mark_onboarded', arguments: {} },
    });

    expect(response.error).toBeUndefined();
    expect(response.result).toBeDefined();
  });

  it('addresses get_result with the name the agent was deployed with', async () => {
    // An agent deployed before the rename still has name:"reins" baked into its
    // MCP_CONFIG, so its tool list holds reins__get_result. Rendering the
    // current constant here would name a tool it does not have, and the
    // approval would never resolve.
    vi.mocked(client.execute).mockResolvedValue({
      rows: [{ id: 'dep-1', runtime: 'openclaw', mcp_server_name: 'reins', has_onboarded: true }],
    } as any);

    const response = await handleMCPRequest('agent-1', {
      jsonrpc: '2.0', id: 42, method: 'tools/call',
      params: {
        name: 'gmail_create_draft',
        arguments: { to: 'test@example.com', subject: 'Hello', body: 'World' },
      },
    });

    const text = (response.result as { content: Array<{ text: string }> }).content[0].text;
    expect(text).toContain('reins__get_result');
    expect(text).not.toContain('helm__get_result');
  });

  it('names get_result the way a Hermes agent actually sees it', async () => {
    // Hermes namespaces as mcp__<server>__<tool>, OpenClaw as <server>__<tool>.
    // Naming it the OpenClaw way here would tell a Hermes agent to call a tool
    // that is not in its list, stranding every approval.
    vi.mocked(client.execute).mockResolvedValue({
      rows: [{ id: 'dep-1', runtime: 'hermes', mcp_server_name: 'helm', has_onboarded: true }],
    } as any);

    const response = await handleMCPRequest('agent-1', {
      jsonrpc: '2.0', id: 42, method: 'tools/call',
      params: {
        name: 'gmail_create_draft',
        arguments: { to: 'test@example.com', subject: 'Hello', body: 'World' },
      },
    });

    const text = (response.result as { content: Array<{ text: string }> }).content[0].text;
    expect(text).toContain('APPROVAL_PENDING');
    expect(text).toContain('mcp__helm__get_result');
  });

  it('addresses get_result bare for a manual (Claude-connected) deployment', async () => {
    // The client (claude.ai / Desktop / Claude Code) namespaces tools itself
    // as mcp__<connector>__<tool>; any prefix the backend renders is wrong.
    vi.mocked(client.execute).mockResolvedValue({
      rows: [{ id: 'dep-1', runtime: 'openclaw', mcp_server_name: 'reins', is_manual: 1, has_onboarded: true }],
    } as any);

    const response = await handleMCPRequest('agent-1', {
      jsonrpc: '2.0', id: 43, method: 'tools/call',
      params: {
        name: 'gmail_create_draft',
        arguments: { to: 'test@example.com', subject: 'Hello', body: 'World' },
      },
    });

    const text = (response.result as { content: Array<{ text: string }> }).content[0].text;
    expect(text).toContain('APPROVAL_PENDING');
    expect(text).toContain('get_result');
    expect(text).not.toContain('reins__get_result');
    expect(text).not.toContain('helm__get_result');
  });

  it('injects mark_onboarded under its new name when setup is incomplete', async () => {
    vi.mocked(client.execute).mockResolvedValue({
      rows: [{ id: 'dep-1', fly_app_name: 'app', fly_machine_id: 'm1', has_onboarded: false }],
    } as any);

    const response = await handleMCPRequest('agent-1', {
      jsonrpc: '2.0', id: 1, method: 'tools/list',
    });
    const toolNames = (response.result as { tools: Array<{ name: string }> }).tools.map((t) => t.name);
    expect(toolNames).toContain('mark_onboarded');
    expect(toolNames).not.toContain('reins__mark_onboarded');
  });
});

describe('get_result tool', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('appears in tools/list for any agent', async () => {
    const response = await handleMCPRequest('agent-1', {
      jsonrpc: '2.0', id: 1, method: 'tools/list',
    });
    const toolNames = (response.result as { tools: Array<{ name: string }> }).tools.map((t) => t.name);
    expect(toolNames).toContain('get_result');
  });

  it('returns pending status for an unresolved job', async () => {
    // get_result long-polls for 30s when status is pending — use fake timers
    vi.useFakeTimers();

    const pendingApproval = {
      id: 'job-1', agentId: 'agent-1', tool: 'gmail_send_email',
      arguments: {}, status: 'pending',
      requestedAt: new Date(), expiresAt: new Date(Date.now() + 3600_000),
    } as any;
    vi.mocked(approvalQueue.get).mockResolvedValue(pendingApproval);

    const responsePromise = handleMCPRequest('agent-1', {
      jsonrpc: '2.0', id: 1, method: 'tools/call',
      params: { name: 'get_result', arguments: { jobId: 'job-1' } },
    });

    // Advance past the 30s long-poll deadline
    await vi.advanceTimersByTimeAsync(31_000);
    const response = await responsePromise;

    vi.useRealTimers();

    expect(response.error).toBeUndefined();
    const content = JSON.parse((response.result as { content: Array<{ text: string }> }).content[0].text);
    expect(content.status).toBe('pending');
    expect(content.jobId).toBe('job-1');
    expect(content.message).toContain('http://localhost:5173/approvals');
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
      params: { name: 'get_result', arguments: { jobId: 'job-1' } },
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
      params: { name: 'get_result', arguments: { jobId: 'job-1' } },
    });

    expect(response.error).toBeUndefined();
    const content = JSON.parse((response.result as { content: Array<{ text: string }> }).content[0].text);
    expect(content.status).toBe('rejected');
    expect(content.reason).toBe('Not allowed at this time');
  });

  it('returns changes_requested with the human feedback and a revise instruction', async () => {
    vi.mocked(approvalQueue.get).mockResolvedValueOnce({
      id: 'job-1', agentId: 'agent-1', tool: 'gmail_send_message',
      arguments: {}, status: 'changes_requested', revision: 0,
      requestedAt: new Date(), expiresAt: new Date(Date.now() + 3600_000),
      resolutionComment: 'drop Bob, make it shorter',
    } as any);

    const response = await handleMCPRequest('agent-1', {
      jsonrpc: '2.0', id: 1, method: 'tools/call',
      params: { name: 'get_result', arguments: { jobId: 'job-1' } },
    });

    expect(response.error).toBeUndefined();
    const content = JSON.parse((response.result as { content: Array<{ text: string }> }).content[0].text);
    expect(content.status).toBe('changes_requested');
    expect(content.feedback).toBe('drop Bob, make it shorter');
    // The instruction must name the tool to re-call — weaker models otherwise
    // treat the status as a stopping point (see docs/ops/COMMON_ERRORS.md).
    expect(content.instruction).toContain('gmail_send_message');
    expect(content.revisionsRemaining).toBe(3);
  });

  it('does not long-poll on changes_requested — it is a terminal state', async () => {
    vi.mocked(approvalQueue.get).mockResolvedValueOnce({
      id: 'job-1', agentId: 'agent-1', tool: 'gmail_send_message',
      arguments: {}, status: 'changes_requested', revision: 1,
      requestedAt: new Date(), expiresAt: new Date(Date.now() + 3600_000),
      resolutionComment: 'shorter',
    } as any);

    // No timer advancement: if this awaited the 30s poll loop the test would hang.
    const response = await handleMCPRequest('agent-1', {
      jsonrpc: '2.0', id: 1, method: 'tools/call',
      params: { name: 'get_result', arguments: { jobId: 'job-1' } },
    });

    const content = JSON.parse((response.result as { content: Array<{ text: string }> }).content[0].text);
    expect(content.status).toBe('changes_requested');
    expect(content.revisionsRemaining).toBe(2);
  });

  it('warns the agent when it is on its final revision', async () => {
    vi.mocked(approvalQueue.get).mockResolvedValueOnce({
      id: 'job-1', agentId: 'agent-1', tool: 'gmail_send_message',
      arguments: {}, status: 'changes_requested', revision: 2,
      requestedAt: new Date(), expiresAt: new Date(Date.now() + 3600_000),
      resolutionComment: 'shorter still',
    } as any);

    const response = await handleMCPRequest('agent-1', {
      jsonrpc: '2.0', id: 1, method: 'tools/call',
      params: { name: 'get_result', arguments: { jobId: 'job-1' } },
    });

    const content = JSON.parse((response.result as { content: Array<{ text: string }> }).content[0].text);
    expect(content.revisionsRemaining).toBe(1);
    expect(content.instruction).toContain('last revision');
  });

  it('returns error for unknown jobId', async () => {
    vi.mocked(approvalQueue.get).mockResolvedValueOnce(null);

    const response = await handleMCPRequest('agent-1', {
      jsonrpc: '2.0', id: 1, method: 'tools/call',
      params: { name: 'get_result', arguments: { jobId: 'nonexistent' } },
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
      params: { name: 'get_result', arguments: { jobId: 'job-1' } },
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
      params: { name: 'get_result', arguments: { jobId: 'job-1' } },
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
      params: { name: 'get_result', arguments: { jobId: 'job-1' } },
    });

    expect(response.error).toBeUndefined();
    const content = JSON.parse((response.result as { content: Array<{ text: string }> }).content[0].text);
    expect(content.status).toBe('pending');
    expect(content.jobId).toBe('job-1');
    // Already approved, so this must NOT be the awaiting-approval message —
    // sending the user to /approvals would ask them to redo what they just did.
    expect(content.message).toMatch(/still running/i);
    expect(content.message).not.toContain('/approvals');
  });
});

describe('scope guard', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('returns MISSING_CREDENTIALS when credential granted_services excludes the service', async () => {
    // Override vault mock: return a valid credential + access token
    const { credentialVault } = await import('../credentials/vault.js');
    vi.mocked(credentialVault.retrieve).mockResolvedValueOnce({
      serviceId: 'google',
      type: 'oauth2' as const,
      data: { accessToken: 'test-token', tokenType: 'Bearer' },
    });
    vi.mocked(credentialVault.getValidAccessToken).mockResolvedValueOnce('test-access-token');

    // Override db mock for each sequential where() call:
    // 1. agents lookup → agent found
    dbWhereMock.mockResolvedValueOnce([{ id: 'agent-1', name: 'Test Agent', status: 'active' }]);
    // 2. agentServiceInstances → empty (forces legacy path)
    dbWhereMock.mockResolvedValueOnce([]);
    // 3. agentServiceCredentials → empty (forces agentServiceAccess path)
    dbWhereMock.mockResolvedValueOnce([]);
    // 4. agentServiceAccess → has a credential
    dbWhereMock.mockResolvedValueOnce([{ credentialId: 'cred-1' }]);
    // 5. credentials grantedServices → only gmail, not calendar
    dbWhereMock.mockResolvedValueOnce([{ grantedServices: '["gmail"]' }]);

    const request: MCPRequest = {
      jsonrpc: '2.0',
      id: 1,
      method: 'tools/call',
      params: {
        name: 'calendar_create_event',
        arguments: { summary: 'Test' },
      },
    };

    const response = await handleMCPRequest('agent-1', request);
    expect(response.error?.code).toBe(MCP_ERROR_CODES.MISSING_CREDENTIALS);
    expect(response.error?.message).toContain('insufficient scope');
  });

  it('allows through when granted_services is null (backward compat)', async () => {
    // Override vault mock
    const { credentialVault } = await import('../credentials/vault.js');
    vi.mocked(credentialVault.retrieve).mockResolvedValueOnce({
      serviceId: 'google',
      type: 'oauth2' as const,
      data: { accessToken: 'test-token', tokenType: 'Bearer' },
    });
    vi.mocked(credentialVault.getValidAccessToken).mockResolvedValueOnce('test-access-token');

    // 1. agents → found
    dbWhereMock.mockResolvedValueOnce([{ id: 'agent-1', name: 'Test Agent', status: 'active' }]);
    // 2. agentServiceInstances → empty
    dbWhereMock.mockResolvedValueOnce([]);
    // 3. agentServiceCredentials → empty
    dbWhereMock.mockResolvedValueOnce([]);
    // 4. agentServiceAccess → has credential
    dbWhereMock.mockResolvedValueOnce([{ credentialId: 'cred-1' }]);
    // 5. credentials grantedServices → null (no scope info)
    dbWhereMock.mockResolvedValueOnce([{ grantedServices: null }]);

    const request: MCPRequest = {
      jsonrpc: '2.0',
      id: 1,
      method: 'tools/call',
      params: {
        name: 'calendar_create_event',
        arguments: { summary: 'Test' },
      },
    };

    const response = await handleMCPRequest('agent-1', request);
    // Should NOT be a MISSING_CREDENTIALS error for insufficient scope
    const isInsufficientScope = response.error?.message?.includes('insufficient scope');
    expect(isInsufficientScope).toBeFalsy();
  });
});

describe('auth-failure reauth hook', () => {
  const agentRow = [{ id: 'agent-1', name: 'Test Agent', status: 'active' }];

  /** Legacy-path sequence: agent → no instances → no junction creds → access row → granted null. */
  function wireLegacyCredential() {
    dbWhereMock.mockResolvedValueOnce(agentRow);
    dbWhereMock.mockResolvedValueOnce([]);
    dbWhereMock.mockResolvedValueOnce([]);
    dbWhereMock.mockResolvedValueOnce([{ credentialId: 'cred-1' }]);
    dbWhereMock.mockResolvedValueOnce([{ grantedServices: null }]);
  }

  async function wireVault() {
    const { credentialVault } = await import('../credentials/vault.js');
    vi.mocked(credentialVault.retrieve).mockResolvedValueOnce({
      serviceId: 'google',
      type: 'oauth2' as const,
      data: { accessToken: 'test-token', tokenType: 'Bearer' },
    } as never);
    vi.mocked(credentialVault.getValidAccessToken).mockResolvedValueOnce('test-access-token');
  }

  // A calendar tool, deliberately: gmail/drive tools also trigger Drive-path
  // and gateway-token injection in executeTool, which consumes extra queries
  // and would desync the sequential dbWhereMock wiring below.
  const listCall = (): MCPRequest => ({
    jsonrpc: '2.0',
    id: 1,
    method: 'tools/call',
    params: { name: 'calendar_list_events', arguments: {} },
  });

  beforeEach(() => {
    vi.clearAllMocks();
    _resetReauthThrottleForTests();
  });

  it('raises a reauth approval when the handler reports 401', async () => {
    await wireVault();
    wireLegacyCredential();
    const { serverManager } = await import('./server-manager.js');
    const server = serverManager.getServer('calendar')!;
    vi.mocked(server.callTool).mockResolvedValueOnce({ success: false, error: 'API error: 401 Unauthorized' });

    const response = await handleMCPRequest('agent-1', listCall());

    const { approvalQueue } = await import('../approvals/queue.js');
    expect(approvalQueue.submitReauth).toHaveBeenCalledWith(
      'agent-1',
      'calendar',
      expect.stringContaining('re-authenticate'),
      expect.objectContaining({ credentialId: 'cred-1', source: 'mcp_tool_call' }),
      expect.any(Number),
    );
    expect((response.result as { isError?: boolean }).isError).toBe(true);
  });

  it('raises reauth when the handler throws a scope-flavoured 403', async () => {
    // googleapis throws (init-servers.callTool does not catch), so the hook
    // must cover the throw path, not only {success:false} returns.
    await wireVault();
    wireLegacyCredential();
    const { serverManager } = await import('./server-manager.js');
    const server = serverManager.getServer('calendar')!;
    vi.mocked(server.callTool).mockRejectedValueOnce(
      Object.assign(new Error('Insufficient Permission'), { status: 403 })
    );

    await handleMCPRequest('agent-1', listCall());

    const { approvalQueue } = await import('../approvals/queue.js');
    expect(approvalQueue.submitReauth).toHaveBeenCalled();
  });

  it('does not raise reauth for an ordinary tool error or a generic 403', async () => {
    const { serverManager } = await import('./server-manager.js');
    const { approvalQueue } = await import('../approvals/queue.js');
    const server = serverManager.getServer('calendar')!;

    await wireVault();
    wireLegacyCredential();
    vi.mocked(server.callTool).mockResolvedValueOnce({ success: false, error: 'Message not found' });
    await handleMCPRequest('agent-1', listCall());

    await wireVault();
    wireLegacyCredential();
    vi.mocked(server.callTool).mockRejectedValueOnce(
      Object.assign(new Error('API error: 403 Forbidden'), { status: 403 })
    );
    await handleMCPRequest('agent-1', listCall());

    expect(approvalQueue.submitReauth).not.toHaveBeenCalled();
  });

  it('does not raise reauth when no credential was resolved', async () => {
    // Credential-less services (memory, skills) 401 when the gateway token is
    // missing — re-consenting a human fixes nothing there. No access row →
    // no credential resolved → the 401 stays a plain tool error.
    dbWhereMock.mockResolvedValueOnce(agentRow);
    dbWhereMock.mockResolvedValueOnce([]); // no instances
    dbWhereMock.mockResolvedValueOnce([]); // no junction credentials
    dbWhereMock.mockResolvedValueOnce([]); // no access row
    const { serverManager } = await import('./server-manager.js');
    const server = serverManager.getServer('calendar')!;
    vi.mocked(server.callTool).mockResolvedValueOnce({ success: false, error: 'API error: 401 Unauthorized' });

    await handleMCPRequest('agent-1', listCall());

    const { approvalQueue } = await import('../approvals/queue.js');
    expect(approvalQueue.submitReauth).not.toHaveBeenCalled();
  });

  it('names the account in the reauth it raises', async () => {
    // "The gmail credentials for your agent" is not actionable with two Google
    // accounts connected; the approval must say which one to reconnect.
    const { client } = await import('../db/index.js');
    vi.mocked(client.execute).mockImplementation(async (q: unknown) => {
      const sql = typeof q === 'string' ? q : (q as { sql: string }).sql;
      if (sql.includes('SELECT account_email FROM credentials')) {
        return { rows: [{ account_email: 'fsaint@helloseer.com' }] } as never;
      }
      return { rows: [] } as never;
    });
    await wireVault();
    wireLegacyCredential();
    const { serverManager } = await import('./server-manager.js');
    const server = serverManager.getServer('calendar')!;
    vi.mocked(server.callTool).mockResolvedValueOnce({ success: false, error: 'API error: 401 Unauthorized' });

    await handleMCPRequest('agent-1', listCall());

    const { approvalQueue } = await import('../approvals/queue.js');
    expect(approvalQueue.submitReauth).toHaveBeenCalledWith(
      'agent-1',
      'calendar',
      expect.stringContaining('fsaint@helloseer.com'),
      expect.objectContaining({ credentialId: 'cred-1', accountEmail: 'fsaint@helloseer.com' }),
      expect.any(Number),
    );
    // Restore the plain default for the tests that follow.
    vi.mocked(client.execute).mockReset();
    vi.mocked(client.execute).mockResolvedValue({ rows: [] } as never);
  });

  it('throttles repeat failures on the same credential', async () => {
    const { serverManager } = await import('./server-manager.js');
    const { approvalQueue } = await import('../approvals/queue.js');
    const server = serverManager.getServer('calendar')!;

    for (let i = 0; i < 2; i++) {
      await wireVault();
      wireLegacyCredential();
      vi.mocked(server.callTool).mockResolvedValueOnce({ success: false, error: 'API error: 401 Unauthorized' });
      await handleMCPRequest('agent-1', listCall());
    }

    expect(approvalQueue.submitReauth).toHaveBeenCalledTimes(1);
  });
});

describe('looksLikeAuthFailure', () => {
  it('matches credential failures', () => {
    expect(looksLikeAuthFailure('API error: 401 Unauthorized')).toBe(true);
    expect(looksLikeAuthFailure('Invalid Credentials', 401)).toBe(true);
    expect(looksLikeAuthFailure('anything at all', 401)).toBe(true);
    expect(looksLikeAuthFailure('Insufficient Permission')).toBe(true);
    expect(looksLikeAuthFailure('Request had insufficient authentication scopes.')).toBe(true);
    expect(looksLikeAuthFailure('ACCESS_TOKEN_SCOPE_INSUFFICIENT')).toBe(true);
    expect(looksLikeAuthFailure('invalid api key')).toBe(true);
  });

  it('rejects failures re-consent cannot fix', () => {
    expect(looksLikeAuthFailure('API error: 403 Forbidden')).toBe(false);
    expect(looksLikeAuthFailure('API error: 404 Not Found')).toBe(false);
    expect(looksLikeAuthFailure('User rate limit exceeded')).toBe(false);
    expect(looksLikeAuthFailure(undefined)).toBe(false);
  });
});

describe('buildSkillCatalog', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  function skillRows(n: number) {
    return Array.from({ length: n }, (_, i) => ({
      slug: `skill-${i}`,
      name: `Skill ${i}`,
      description: `Use for task ${i}.`,
      required_services: '[]',
    }));
  }

  it('offers the installer when the agent has no skills at all', async () => {
    // Previously this returned null and the description stayed empty — which
    // left a fresh agent with no way to learn setup exists, since the boot
    // skill that would say so is exactly what is missing.
    vi.mocked(client.execute).mockResolvedValueOnce({ rows: [] } as any);

    const catalog = await buildSkillCatalog('agent-1');
    expect(catalog).not.toBeNull();
    expect(catalog).toContain('install-skills');
  });

  it('offers the installer when skills exist but the boot skill does not', async () => {
    vi.mocked(client.execute).mockResolvedValueOnce({ rows: skillRows(2) } as any);

    const catalog = await buildSkillCatalog('agent-1');
    expect(catalog).toContain('skill-0');
    expect(catalog).toContain('install-skills');
  });

  it('stays quiet once the boot skill is installed', async () => {
    vi.mocked(client.execute).mockResolvedValueOnce({
      rows: [{ slug: 'helm-boot', name: 'Boot', description: 'Orient.', required_services: '[]', version: null }],
    } as any);

    const catalog = await buildSkillCatalog('agent-1');
    expect(catalog).not.toContain('install-skills');
  });

  it('lists each skill with its slug, description, and required services', async () => {
    vi.mocked(client.execute).mockResolvedValueOnce({
      rows: [
        { slug: 'inbox-triage', name: 'Inbox Triage', description: 'Clean the inbox.', required_services: '["gmail"]' },
        { slug: 'notes', name: 'Notes', description: 'Take notes.', required_services: '[]' },
      ],
    } as any);

    const catalog = await buildSkillCatalog('agent-1');

    expect(catalog).toContain('- inbox-triage — Clean the inbox. (needs: gmail)');
    // No requirements means no noisy empty parenthetical.
    expect(catalog).toContain('- notes — Take notes.');
    expect(catalog).not.toContain('notes — Take notes. (needs:');
  });

  it('renders tool tokens bare for an external (manual) agent', async () => {
    vi.mocked(client.execute).mockResolvedValueOnce({
      rows: [{ slug: 'helm-boot', name: 'Boot', description: 'Use {{tool:gmail_search}}.', required_services: '[]', version: null }],
    } as any);

    const catalog = await buildSkillCatalog('agent-1', 'external', 'reins');

    expect(catalog).toContain('Use gmail_search.');
    expect(catalog).not.toContain('reins__');
  });

  it('tells the agent the list may be stale, since tools/list is cached per session', async () => {
    vi.mocked(client.execute).mockResolvedValueOnce({ rows: skillRows(1) } as any);

    const catalog = await buildSkillCatalog('agent-1');

    expect(catalog).toContain('may be stale');
    expect(catalog).toContain('skills_list');
  });

  it('caps the number of skills and says how many were omitted', async () => {
    vi.mocked(client.execute).mockResolvedValueOnce({ rows: skillRows(35) } as any);

    const catalog = await buildSkillCatalog('agent-1');

    expect(catalog).toContain('skill-29');
    expect(catalog).not.toContain('skill-30');
    expect(catalog).toContain('…and 5 more.');
  });

  it('truncates rather than letting one huge catalog bloat every tools/list', async () => {
    vi.mocked(client.execute).mockResolvedValueOnce({
      rows: Array.from({ length: 30 }, (_, i) => ({
        slug: `skill-${i}`,
        name: `Skill ${i}`,
        description: 'x'.repeat(300),
        required_services: '[]',
      })),
    } as any);

    const catalog = await buildSkillCatalog('agent-1');

    expect(catalog!.length).toBeLessThan(2200);
    expect(catalog).toContain('(truncated)');
  });
});

// ============================================================================
// The skill-authoring privilege boundary
// ============================================================================

/**
 * The feature's whole claim is "one architect agent can author skills, the
 * others cannot". There is no agent role column — the boundary is simply
 * whether the service is enabled on that agent, so it is worth a test that
 * fails loudly if anything ever auto-enables it.
 */
describe('skill-authoring enablement boundary', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('refuses an authoring call from an agent without the service enabled', async () => {
    const response = await handleMCPRequest('agent-1', {
      jsonrpc: '2.0', id: 1, method: 'tools/call',
      params: { name: 'skill_authoring_create', arguments: { name: 'X', description: 'd', body: 'b' } },
    });

    expect(response.result).toBeUndefined();
    // Either "unknown tool" or "service not enabled" — what matters is that it
    // never reaches a handler.
    expect([
      MCP_ERROR_CODES.SERVICE_NOT_ENABLED,
      MCP_ERROR_CODES.INVALID_PARAMS,
      MCP_ERROR_CODES.TOOL_BLOCKED,
    ]).toContain(response.error?.code);
  });

  it('does not advertise any authoring tool to an ordinary agent', async () => {
    const response = await handleMCPRequest('agent-1', {
      jsonrpc: '2.0', id: 1, method: 'tools/list',
    });

    const toolNames = (response.result as { tools: Array<{ name: string }> }).tools.map((t) => t.name);
    expect(toolNames.some((n) => n.startsWith('skill_authoring_'))).toBe(false);
  });
});

describe('gateway token injection', () => {
  /**
   * Services whose handlers call back into the platform API get the agent's
   * gateway token in their tool context. The list of them is hardcoded in
   * handleCallTool, and leaving a service out of it fails silently in the worst
   * way: the handlers send no x-reins-agent-secret, every request comes back
   * 401, and it reads like a broken credential rather than a missing line.
   * helm-admin was added to that list after exactly this happened.
   */
  beforeEach(() => {
    vi.clearAllMocks();
    // The same mock answers the agent lookup and the instance query, in that
    // order: the agent must exist, and no instance rows sends the call down the
    // legacy permission path, which is the simpler one to assert on.
    dbWhereMock
      .mockResolvedValueOnce([{ id: 'agent-1', name: 'Test Agent', status: 'active' }])
      .mockResolvedValue([]);
  });

  async function callAdminTool() {
    const callTool = vi.fn().mockResolvedValue({ success: true, data: { agents: [] } });
    const { serverManager } = await import('./server-manager.js');
    vi.mocked(serverManager.getServer).mockReturnValue({
      serverType: 'helm-admin',
      name: 'Helm Admin',
      getToolDefinitions: () => [
        { name: 'helm_admin_list_agents', description: 'List agents', inputSchema: { type: 'object', properties: {} } },
      ],
      callTool,
    } as never);

    const { getEffectivePermissions } = await import('../services/permissions.js');
    vi.mocked(getEffectivePermissions).mockResolvedValue({
      enabled: true,
      tools: { helm_admin_list_agents: 'allow' },
    } as never);

    vi.mocked(client.execute).mockResolvedValue({
      rows: [{ gateway_token: 'gw-secret', id: 'dep-1', runtime: 'openclaw', mcp_server_name: 'helm' }],
    } as never);

    const response = await handleMCPRequest('agent-1', {
      jsonrpc: '2.0', id: 1, method: 'tools/call',
      params: { name: 'helm_admin_list_agents', arguments: {} },
    });

    return { callTool, response };
  }

  it('gives helm-admin tools the gateway token they authenticate with', async () => {
    const { callTool, response } = await callAdminTool();

    expect(response.error).toBeUndefined();
    expect(callTool).toHaveBeenCalledWith(
      'helm_admin_list_agents',
      {},
      expect.objectContaining({ gatewayToken: 'gw-secret' })
    );
  });
});

describe('whoami tool', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // Earlier suites leave the agent lookup returning nothing; restore the default row.
    dbWhereMock.mockResolvedValue([{ id: 'agent-1', name: 'Test Agent', status: 'active' }]);
    vi.mocked(client.execute).mockResolvedValue({ rows: [] } as any);
  });

  it('appears in tools/list for any agent, whatever services it has', async () => {
    const response = await handleMCPRequest('agent-1', {
      jsonrpc: '2.0', id: 1, method: 'tools/list',
    });
    const toolNames = (response.result as { tools: Array<{ name: string }> }).tools.map((t) => t.name);
    expect(toolNames).toContain('whoami');
  });

  it('is listed for a Hermes deployment too — it does not depend on runtime', async () => {
    vi.mocked(client.execute).mockResolvedValue({
      rows: [{ id: 'dep-1', runtime: 'hermes', mcp_server_name: 'helm', has_onboarded: true }],
    } as any);

    const response = await handleMCPRequest('agent-1', {
      jsonrpc: '2.0', id: 1, method: 'tools/list',
    });
    const toolNames = (response.result as { tools: Array<{ name: string }> }).tools.map((t) => t.name);
    expect(toolNames).toContain('whoami');
  });

  it('returns the calling agent\'s id and name', async () => {
    const response = await handleMCPRequest('agent-1', {
      jsonrpc: '2.0', id: 7, method: 'tools/call',
      params: { name: 'whoami', arguments: {} },
    });

    expect(response.error).toBeUndefined();
    const text = (response.result as { content: Array<{ text: string }> }).content[0].text;
    expect(JSON.parse(text)).toEqual({ agentId: 'agent-1', name: 'Test Agent' });
  });
});

describe('multi-account policy', () => {
  const instA = { id: 'inst-a', agentId: 'agent-1', serviceType: 'gmail', enabled: true, isDefault: true, credentialId: 'cred-a' };
  const instB = { id: 'inst-b', agentId: 'agent-1', serviceType: 'gmail', enabled: true, isDefault: false, credentialId: 'cred-b' };
  const agentRow = [{ id: 'agent-1', name: 'Test Agent', status: 'active' }];

  beforeEach(async () => {
    vi.clearAllMocks();
    // Earlier tests can leave unconsumed mockResolvedValueOnce entries queued
    // (clearAllMocks does not drop once-queues), and this describe depends on
    // exact call order — start from a clean queue. Safe only because this
    // describe is last in the file.
    dbWhereMock.mockReset();
    dbWhereMock.mockResolvedValue([{ id: 'agent-1', name: 'Test Agent', status: 'active' }]);
    const { client } = await import('../db/index.js');
    vi.mocked(client.execute).mockReset();
    vi.mocked(client.execute).mockResolvedValue({ rows: [] } as never);
    // Earlier tests also override getServer's return persistently; restore a
    // stub carrying the gmail/calendar tools these tests list and call.
    const { serverManager } = await import('./server-manager.js');
    vi.mocked(serverManager.getServer).mockReset();
    vi.mocked(serverManager.getServer).mockReturnValue({
      serverType: 'gmail',
      name: 'Gmail',
      getToolDefinitions: () => [
        { name: 'gmail_list_messages', description: 'List email messages', inputSchema: { type: 'object', properties: {} } },
        { name: 'gmail_send_message', description: 'Send an email', inputSchema: { type: 'object', properties: {} } },
        { name: 'calendar_list_events', description: 'List events', inputSchema: { type: 'object', properties: {} } },
      ],
      callTool: vi.fn().mockResolvedValue({ success: true, data: [] }),
    } as never);
    const { getEffectiveInstancePermissions } = await import('../services/permissions.js');
    // The owner's intent: send is allowed only on account B.
    vi.mocked(getEffectiveInstancePermissions).mockImplementation(async (id: string) => ({
      enabled: true,
      tools: {
        gmail_list_messages: 'allow',
        calendar_list_events: 'allow',
        gmail_send_message: id === 'inst-b' ? 'allow' : 'block',
      },
    }) as never);
  });

  it('lists a tool permitted on any account — account: selects the instance', async () => {
    // tools/list is a union across instances by design: the tool IS callable,
    // with account:. Narrowing the list to the default instance would hide a
    // working capability.
    dbWhereMock.mockResolvedValueOnce(agentRow); // status check
    dbWhereMock.mockResolvedValueOnce([instA, instB]);

    const response = await handleMCPRequest('agent-1', { jsonrpc: '2.0', id: 1, method: 'tools/list' });

    const names = (response.result as { tools: Array<{ name: string }> }).tools.map((t) => t.name);
    expect(names).toContain('gmail_send_message');
    expect(names).toContain('gmail_list_messages');
  });

  it('names the account that permits a tool blocked on the default one', async () => {
    dbWhereMock.mockResolvedValueOnce(agentRow);
    dbWhereMock.mockResolvedValueOnce([instA, instB]);
    dbWhereMock.mockResolvedValueOnce([{ accountEmail: 'b@example.com' }]); // sibling inst-b credential
    dbWhereMock.mockResolvedValueOnce([{ accountEmail: 'a@example.com' }]); // blocked default's credential

    const response = await handleMCPRequest('agent-1', {
      jsonrpc: '2.0', id: 1, method: 'tools/call',
      params: { name: 'gmail_send_message', arguments: {} },
    });

    expect(response.error?.code).toBe(MCP_ERROR_CODES.TOOL_BLOCKED);
    expect(response.error?.message).toContain('blocked for a@example.com');
    expect(response.error?.message).toContain('b@example.com');
    expect(response.error?.message).toContain('account:');
    expect((response.error?.data as { permittedAccounts: string[] }).permittedAccounts).toEqual(['b@example.com']);
  });

  it('keeps the plain message when every account blocks the tool', async () => {
    const { getEffectiveInstancePermissions } = await import('../services/permissions.js');
    vi.mocked(getEffectiveInstancePermissions).mockResolvedValue({
      enabled: true,
      tools: { gmail_send_message: 'block' },
    } as never);
    dbWhereMock.mockResolvedValueOnce(agentRow);
    dbWhereMock.mockResolvedValueOnce([instA, instB]);

    const response = await handleMCPRequest('agent-1', {
      jsonrpc: '2.0', id: 1, method: 'tools/call',
      params: { name: 'gmail_send_message', arguments: {} },
    });

    expect(response.error?.code).toBe(MCP_ERROR_CODES.TOOL_BLOCKED);
    expect(response.error?.message).toBe('Tool blocked by policy');
    expect((response.error?.data as Record<string, unknown>).permittedAccounts).toBeUndefined();
  });

  it('refuses an account that matches no instance instead of policy-checking [0]', async () => {
    dbWhereMock.mockResolvedValueOnce(agentRow);
    dbWhereMock.mockResolvedValueOnce([instA, instB]);
    dbWhereMock.mockResolvedValueOnce([{ accountEmail: 'a@example.com' }]);
    dbWhereMock.mockResolvedValueOnce([{ accountEmail: 'b@example.com' }]);

    const response = await handleMCPRequest('agent-1', {
      jsonrpc: '2.0', id: 1, method: 'tools/call',
      params: { name: 'gmail_list_messages', arguments: { account: 'nobody@example.com' } },
    });

    expect(response.error?.code).toBe(MCP_ERROR_CODES.MISSING_CREDENTIALS);
    expect(response.error?.message).toContain('gmail_list_accounts');
  });

  it('hands drive tools the gateway token, so source:"upload" files resolve', async () => {
    // 'drive' was absent from the injection list; a Drive upload then 401s at
    // /api/agent-uploads, which reads like a broken credential.
    const { getEffectiveInstancePermissions } = await import('../services/permissions.js');
    vi.mocked(getEffectiveInstancePermissions).mockResolvedValue({
      enabled: true,
      tools: { drive_list_files: 'allow' },
    } as never);
    const { client } = await import('../db/index.js');
    vi.mocked(client.execute).mockImplementation(async (q: unknown) => {
      const sql = typeof q === 'string' ? q : (q as { sql: string }).sql;
      if (sql.includes('SELECT gateway_token FROM deployed_agents')) {
        return { rows: [{ gateway_token: 'gw-secret' }] } as never;
      }
      return { rows: [] } as never;
    });
    const driveInst = { id: 'inst-d', agentId: 'agent-1', serviceType: 'drive', enabled: true, isDefault: true, credentialId: 'cred-a' };
    dbWhereMock.mockResolvedValueOnce(agentRow);
    dbWhereMock.mockResolvedValueOnce([driveInst]);
    dbWhereMock.mockResolvedValueOnce([{ grantedServices: null }]); // scope guard passes open
    const { serverManager } = await import('./server-manager.js');
    const server = serverManager.getServer('drive')!;

    const response = await handleMCPRequest('agent-1', {
      jsonrpc: '2.0', id: 1, method: 'tools/call',
      params: { name: 'drive_list_files', arguments: {} },
    });

    expect(response.error).toBeUndefined();
    expect(vi.mocked(server.callTool)).toHaveBeenCalledWith(
      'drive_list_files',
      {},
      expect.objectContaining({ gatewayToken: 'gw-secret' })
    );
  });

  it('runs the tool on the instance the account names', async () => {
    // Calendar, deliberately: gmail triggers Drive-path and gateway-token
    // injection in executeTool, which would desync the sequential wiring.
    const cA = { ...instA, serviceType: 'calendar' };
    const cB = { ...instB, serviceType: 'calendar' };
    dbWhereMock.mockResolvedValueOnce(agentRow);
    dbWhereMock.mockResolvedValueOnce([cA, cB]);
    // permission-check account resolution
    dbWhereMock.mockResolvedValueOnce([{ accountEmail: 'a@example.com' }]);
    dbWhereMock.mockResolvedValueOnce([{ accountEmail: 'b@example.com' }]);
    // executeTool re-resolves the account
    dbWhereMock.mockResolvedValueOnce([{ accountEmail: 'a@example.com' }]);
    dbWhereMock.mockResolvedValueOnce([{ accountEmail: 'b@example.com' }]);
    // credentialCoversService: no granted_services restriction
    dbWhereMock.mockResolvedValueOnce([{ grantedServices: null }]);

    const response = await handleMCPRequest('agent-1', {
      jsonrpc: '2.0', id: 1, method: 'tools/call',
      params: { name: 'calendar_list_events', arguments: { account: 'b@example.com' } },
    });

    expect(response.error).toBeUndefined();
  });
});
