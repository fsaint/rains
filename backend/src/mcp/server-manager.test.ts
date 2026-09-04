/**
 * ServerManager.callTool context injection.
 *
 * The Drive path config has to reach two handlers: drive itself, and gmail,
 * whose attachment resolver uses it to stop a Drive read being laundered
 * through a Gmail tool. agent-endpoint.ts injects it for both; this path
 * used to inject it for drive only.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

const { mockGetDrivePathConfig } = vi.hoisted(() => ({
  mockGetDrivePathConfig: vi.fn(),
}));

vi.mock('../services/permissions.js', () => ({
  getDrivePathConfig: mockGetDrivePathConfig,
}));
vi.mock('../policy/engine.js', () => ({
  policyEngine: {
    evaluateTool: vi.fn().mockReturnValue({ action: 'allow' }),
    applyConstraints: vi.fn((_tool: string, _type: string, args: unknown) => args),
    filterTools: vi.fn((tools: unknown) => tools),
  },
}));
vi.mock('../approvals/queue.js', () => ({
  approvalQueue: { submit: vi.fn(), waitForDecision: vi.fn() },
}));
vi.mock('../audit/logger.js', () => ({
  auditLogger: {
    logToolCall: vi.fn().mockResolvedValue(undefined),
    logApproval: vi.fn().mockResolvedValue(undefined),
  },
}));
vi.mock('../credentials/vault.js', () => ({
  credentialVault: { retrieve: vi.fn().mockResolvedValue(null) },
}));

import { ServerManager, type NativeServer, type ToolContext } from './server-manager.js';
import type { ParsedPolicy } from '@reins/shared';

const DRIVE_CONFIG = {
  defaultLevel: 'blocked' as const,
  rules: [{ folderId: 'folder-abc', label: 'Reports', permission: 'read' as const }],
};

function fakeServer(serverType: string, toolName: string) {
  const callTool = vi.fn().mockResolvedValue({ success: true, data: 'ok' });
  const server: NativeServer = {
    serverType,
    name: serverType,
    getToolDefinitions: () => [
      { name: toolName, description: toolName, inputSchema: { type: 'object', properties: {} } },
    ],
    callTool,
  };
  return { server, callTool };
}

const policy = {} as ParsedPolicy;

describe('ServerManager.callTool Drive config injection', () => {
  let manager: ServerManager;

  beforeEach(() => {
    vi.clearAllMocks();
    mockGetDrivePathConfig.mockResolvedValue(DRIVE_CONFIG);
    manager = new ServerManager();
  });

  it('hands a drive tool the Drive path config', async () => {
    const { server, callTool } = fakeServer('drive', 'drive_list_files');
    manager.registerServer(server);

    await manager.callTool('agent-1', 'drive', 'drive_list_files', {}, policy);

    expect(mockGetDrivePathConfig).toHaveBeenCalledWith('agent-1');
    const context = callTool.mock.calls[0][2] as ToolContext;
    expect(context.driveDefaultLevel).toBe('blocked');
    expect(context.drivePathRules).toEqual(DRIVE_CONFIG.rules);
  });

  it('hands a gmail tool the Drive path config too', async () => {
    const { server, callTool } = fakeServer('gmail', 'gmail_get_attachment');
    manager.registerServer(server);

    await manager.callTool('agent-1', 'gmail', 'gmail_get_attachment', { messageId: 'm1' }, policy);

    expect(mockGetDrivePathConfig).toHaveBeenCalledWith('agent-1');
    const context = callTool.mock.calls[0][2] as ToolContext;
    expect(context.driveDefaultLevel).toBe('blocked');
    expect(context.drivePathRules).toEqual(DRIVE_CONFIG.rules);
  });

  it('does not load or inject the Drive config for a calendar tool', async () => {
    const { server, callTool } = fakeServer('calendar', 'calendar_list_events');
    manager.registerServer(server);

    await manager.callTool('agent-1', 'calendar', 'calendar_list_events', {}, policy);

    expect(mockGetDrivePathConfig).not.toHaveBeenCalled();
    const context = callTool.mock.calls[0][2] as ToolContext;
    expect(context.driveDefaultLevel).toBeUndefined();
    expect(context.drivePathRules).toBeUndefined();
  });
});
