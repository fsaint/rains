/**
 * Route-level tests for the Drive path config under /api/permissions.
 *
 * The service layer stores whatever JSON it is handed; these routes are where
 * the rule shape is enforced and a pasted Drive URL is reduced to a folder id.
 * An unchecked body here would let the dashboard store a rule the drive
 * handlers cannot match, which reads as "the folder rule does nothing".
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import cookie from '@fastify/cookie';

const {
  mockExecute, mockGetSession, mockRequireAdmin, mockIsServiceEnabled,
  mockListEnabled, mockListOpen, mockUserHasAdmin, mockCreateInstance,
  mockSetPermissionLevel, mockGetPermissionLevel, mockSetToolPermission,
  mockResetToolPermission, mockEnableDefaults, mockDisconnectAgent,
  mockUpdateInstance, mockGetInstanceConfig, mockGetValidAccessToken,
  mockDetachCredential, mockVaultDelete, mockGetDrivePathConfig, mockSetDrivePathConfig,
} = vi.hoisted(() => ({
  mockExecute: vi.fn(),
  mockGetSession: vi.fn(),
  mockRequireAdmin: vi.fn(),
  mockIsServiceEnabled: vi.fn(),
  mockListEnabled: vi.fn(),
  mockListOpen: vi.fn(),
  mockUserHasAdmin: vi.fn(),
  mockCreateInstance: vi.fn(),
  mockSetPermissionLevel: vi.fn(),
  mockGetPermissionLevel: vi.fn(),
  mockSetToolPermission: vi.fn(),
  mockResetToolPermission: vi.fn(),
  mockEnableDefaults: vi.fn(),
  mockDisconnectAgent: vi.fn(),
  mockUpdateInstance: vi.fn(),
  mockGetInstanceConfig: vi.fn(),
  mockGetValidAccessToken: vi.fn(),
  mockDetachCredential: vi.fn(),
  mockVaultDelete: vi.fn(),
  mockGetDrivePathConfig: vi.fn(),
  mockSetDrivePathConfig: vi.fn(),
}));

vi.mock('../db/index.js', () => ({
  client: { execute: mockExecute },
  db: { select: vi.fn(), insert: vi.fn(), update: vi.fn(), delete: vi.fn() },
}));

vi.mock('../auth/index.js', () => ({
  getSession: mockGetSession,
  requireAdmin: mockRequireAdmin,
  createMagicLinkToken: vi.fn(),
  verifyMagicLinkToken: vi.fn(),
}));

vi.mock('../services/permissions.js', () => {
  class ServiceCombinationError extends Error {
    readonly code = 'SERVICE_COMBINATION_NOT_ALLOWED';
    constructor(message: string, public serviceType: string, public conflicting: string[]) {
      super(message);
      this.name = 'ServiceCombinationError';
    }
  }
  class UnauthenticatedEndpointsOpenError extends Error {
    readonly code = 'UNAUTHENTICATED_ENDPOINTS_OPEN';
    constructor(message: string, public openAgents: Array<{ id: string; name: string }>) {
      super(message);
      this.name = 'UnauthenticatedEndpointsOpenError';
    }
  }
  return {
    ADMIN_SERVICE_TYPE: 'helm-admin',
    ServiceCombinationError,
    UnauthenticatedEndpointsOpenError,
    isServiceEnabledForAgent: mockIsServiceEnabled,
    listEnabledServiceTypes: mockListEnabled,
    listOpenMcpAgents: mockListOpen,
    userHasAdminAgent: mockUserHasAdmin,
    createServiceInstance: mockCreateInstance,
    setPermissionLevel: mockSetPermissionLevel,
    getPermissionLevel: mockGetPermissionLevel,
    setToolPermission: mockSetToolPermission,
    resetToolPermission: mockResetToolPermission,
    enableDefaultServices: mockEnableDefaults,
    // Imported by routes.ts but unused by these paths.
    getPermissionMatrix: vi.fn(), getAgentServiceConfig: vi.fn(), setServiceAccess: vi.fn(),
    linkCredential: vi.fn(), autoLinkCredential: vi.fn(), unlinkCredential: vi.fn(),
    detachCredential: mockDetachCredential,
    setServiceToolPermissions: vi.fn(),
    getCredentialsForService: vi.fn(), addServiceCredential: vi.fn(), removeServiceCredential: vi.fn(),
    setDefaultCredential: vi.fn(), getLinkedCredentials: vi.fn(), getAgentPermissions: vi.fn(),
    getInstanceConfig: mockGetInstanceConfig, updateServiceInstance: mockUpdateInstance, deleteServiceInstance: vi.fn(),
    setInstancePermissionLevel: vi.fn(), setInstanceToolPermission: vi.fn(),
    resetInstanceToolPermission: vi.fn(), getDrivePathConfig: mockGetDrivePathConfig, setDrivePathConfig: mockSetDrivePathConfig,
  };
});

vi.mock('../mcp/proxy.js', () => ({ mcpProxy: { disconnectAgent: mockDisconnectAgent } }));

vi.mock('../mcp/agent-endpoint.js', () => ({ handleMCPRequest: vi.fn() }));
vi.mock('../mcp/oauth/tokens.js', () => ({
  verifyAccessToken: vi.fn().mockResolvedValue(null),
  listAgentTokens: vi.fn().mockResolvedValue([]),
  revokeAccessToken: vi.fn().mockResolvedValue(true),
}));
vi.mock('@reins/servers', () => ({
  serviceDefinitions: [
    { type: 'gmail', name: 'Gmail', description: 'Email', auth: { required: true } },
    { type: 'memory', name: 'Memory', description: 'Notes', auth: { required: false } },
    { type: 'helm-admin', name: 'Helm Admin', description: 'Admin', auth: { required: false } },
    { type: 'hermeneutix', name: 'Hermeneutix', description: 'Meetings', auth: { required: true } },
  ],
  serviceRegistry: new Map(),
  // Real prefix resolution: the per-tool routes derive serviceType from this
  // rather than trusting the caller, so a stub returning null would make those
  // tests pass on a 400 and prove nothing.
  getServiceTypeFromToolName: (name: string) => {
    if (name.startsWith('helm_admin_')) return 'helm-admin';
    if (name.startsWith('gmail_')) return 'gmail';
    if (name.startsWith('memory_')) return 'memory';
    return null;
  },
}));
vi.mock('../approvals/queue.js', () => ({
  MAX_REVISIONS: 3,
  approvalQueue: {
    requestChanges: vi.fn(), approve: vi.fn(), reject: vi.fn(), get: vi.fn(),
    submit: vi.fn(), listPending: vi.fn().mockResolvedValue([]),
  },
}));
vi.mock('../audit/logger.js', () => ({
  auditLogger: {
    log: vi.fn().mockResolvedValue(1), logApproval: vi.fn().mockResolvedValue(1),
    logToolCall: vi.fn().mockResolvedValue(1), logAgentEvent: vi.fn().mockResolvedValue(1),
    query: vi.fn().mockResolvedValue([]),
  },
}));
vi.mock('../config/index.js', () => ({
  config: {
    dashboardUrl: 'http://localhost:5173', publicUrl: 'http://localhost:3000',
    nodeEnv: 'test', encryptionKey: '0'.repeat(64),
  },
}));
vi.mock('../policy/engine.js', () => ({ policyEngine: {} }));
vi.mock('../credentials/vault.js', () => ({
  credentialVault: { getValidAccessToken: mockGetValidAccessToken, delete: mockVaultDelete },
}));
vi.mock('../mcp/server-manager.js', () => ({ serverManager: {} }));
vi.mock('../notifications/apns.js', () => ({ apnsService: {} }));
vi.mock('../notifications/telegram.js', () => ({ telegramNotifier: {} }));
vi.mock('../analytics/posthog.js', () => ({ getPostHog: () => null }));
vi.mock('../services/email.js', () => ({ sendReauthEmail: vi.fn() }));
vi.mock('../services/agent-backup.js', () => ({
  performBackup: vi.fn(), listBackups: vi.fn(), getBackup: vi.fn(), restoreBackup: vi.fn(),
}));
vi.mock('../services/agent-uploads.js', () => ({
  createUpload: vi.fn(), getUpload: vi.fn(), MAX_UPLOAD_BYTES: 1024,
}));
vi.mock('../services/token-monitor.js', () => ({ isCodexTokenExpired: vi.fn() }));
vi.mock('../services/agent-bot-relay.js', () => ({
  forwardToOpenclaw: vi.fn(), handleMyChatMember: vi.fn(),
}));
vi.mock('../services/memory.js', () => ({
  parseWikilinkRefs: vi.fn(), updateLinkIndex: vi.fn(), updateTagIndex: vi.fn(),
  ensureMemoryRoot: vi.fn(), getDreamManifest: vi.fn(), setEntryParent: vi.fn(),
  resolveOrCreate: vi.fn(), parseTransclusions: vi.fn(), lookupEntryByTitleOrAlias: vi.fn(),
}));
vi.mock('../services/memory-scopes.js', () => ({
  resolveMemoryContext: vi.fn(), listUserScopes: vi.fn(), getAgentScopeGrants: vi.fn(),
  setAgentScopeGrants: vi.fn(), pickScope: vi.fn(), isRejection: vi.fn(),
}));
vi.mock('../providers/index.js', () => ({}));
vi.mock('../services/model-router.js', () => ({
  listModelConfigs: vi.fn(), upsertModelConfig: vi.fn(), deleteModelConfig: vi.fn(),
}));
vi.mock('../services/discovery.js', () => ({ discoverServiceToolsForAgent: vi.fn() }));

import { apiRoutes } from './routes.js';

const AGENT = 'agent-1';
const OWNER = 'user-1';
const FOLDER_A = '1AbC_dEf-GhIjKlMnOpQrStUvWxYz0123456';
const FOLDER_B = '1ZyXwVuTsRqPoNmLkJiHgFeDcBa9876543210';
const URL_PATH = `/api/permissions/${AGENT}/drive/path-config`;

const mockFetch = vi.fn();

let app: FastifyInstance;
let testSession: { userId: string; email: string } | null = null;
/** What the (mocked) service layer currently holds for the agent. */
let stored: { defaultLevel: string; rules: unknown[] } | null = null;

beforeEach(async () => {
  testSession = { userId: OWNER, email: 'owner@example.com' };
  vi.clearAllMocks();
  vi.stubGlobal('fetch', mockFetch);
  mockGetSession.mockReturnValue(null);
  mockRequireAdmin.mockReturnValue(true);
  mockExecute.mockResolvedValue({ rows: [], rowsAffected: 0, columns: [], lastInsertRowid: 0n });
  stored = null;
  mockSetDrivePathConfig.mockImplementation(async (_agentId: string, config: { defaultLevel: string; rules: unknown[] }) => {
    stored = config;
  });
  mockGetDrivePathConfig.mockImplementation(async () => stored ?? { defaultLevel: 'write', rules: [] });

  app = Fastify({ logger: false });
  await app.register(cookie);
  app.addHook('onRequest', async (req) => {
    (req as unknown as { session: unknown }).session = testSession;
  });
  await app.register(apiRoutes);
  await app.ready();
  await new Promise((r) => setTimeout(r, 0));
});

afterEach(() => {
  vi.unstubAllGlobals();
});

const put = (payload: unknown) => app.inject({ method: 'PUT', url: URL_PATH, payload: payload as Record<string, unknown> });
const get = () => app.inject({ method: 'GET', url: URL_PATH });

describe('PUT /api/permissions/:agentId/drive/path-config', () => {
  it('stores normalised rules and returns them', async () => {
    const res = await put({
      defaultLevel: 'read',
      rules: [
        { folderId: `https://drive.google.com/drive/folders/${FOLDER_A}?usp=sharing`, label: 'Reports', permission: 'write' },
        { folderId: FOLDER_B, permission: 'blocked' },
      ],
    });

    expect(res.statusCode).toBe(200);
    expect(mockSetDrivePathConfig).toHaveBeenCalledWith(AGENT, {
      defaultLevel: 'read',
      rules: [
        { folderId: FOLDER_A, label: 'Reports', permission: 'write' },
        { folderId: FOLDER_B, permission: 'blocked' },
      ],
    });
    expect(res.json().data).toEqual({
      defaultLevel: 'read',
      rules: [
        { folderId: FOLDER_A, label: 'Reports', permission: 'write' },
        { folderId: FOLDER_B, permission: 'blocked' },
      ],
    });
  });

  it.each([
    ['a /drive/folders/ URL', `https://drive.google.com/drive/folders/${FOLDER_A}`],
    ['a /drive/u/0/folders/ URL', `https://drive.google.com/drive/u/0/folders/${FOLDER_A}`],
    ['a /drive/u/2/folders/ URL with a query', `https://drive.google.com/drive/u/2/folders/${FOLDER_A}?usp=drive_link`],
    ['an ?id= URL', `https://drive.google.com/open?id=${FOLDER_A}`],
    ['a /file/d/ URL', `https://drive.google.com/file/d/${FOLDER_A}/view?usp=sharing`],
    ['a bare id with surrounding whitespace', `  ${FOLDER_A}  `],
  ])('normalises %s to the folder id', async (_label, folderId) => {
    const res = await put({ defaultLevel: 'write', rules: [{ folderId, permission: 'read' }] });

    expect(res.statusCode).toBe(200);
    expect(mockSetDrivePathConfig.mock.calls[0][1].rules).toEqual([{ folderId: FOLDER_A, permission: 'read' }]);
  });

  it('treats a missing rules field as no rules', async () => {
    const res = await put({ defaultLevel: 'blocked' });

    expect(res.statusCode).toBe(200);
    expect(mockSetDrivePathConfig).toHaveBeenCalledWith(AGENT, { defaultLevel: 'blocked', rules: [] });
  });

  it('rejects an invalid defaultLevel', async () => {
    const res = await put({ defaultLevel: 'admin', rules: [] });

    expect(res.statusCode).toBe(400);
    expect(res.json().error.code).toBe('VALIDATION_ERROR');
    expect(mockSetDrivePathConfig).not.toHaveBeenCalled();
  });

  it.each([
    ['rules that are not an array', { rules: { folderId: FOLDER_A, permission: 'read' } }, 'rules'],
    ['a rule that is not an object', { rules: [FOLDER_A] }, 'rules[0]'],
    ['a rule with no folderId', { rules: [{ permission: 'read' }] }, 'rules[0].folderId'],
    ['a rule with an empty folderId', { rules: [{ folderId: '   ', permission: 'read' }] }, 'rules[0].folderId'],
    ['a rule with a non-string folderId', { rules: [{ folderId: 42, permission: 'read' }] }, 'rules[0].folderId'],
    ['a Drive URL with no folder id in it', { rules: [{ folderId: 'https://drive.google.com/drive/my-drive', permission: 'read' }] }, 'rules[0].folderId'],
    ['a folder id with characters Drive never issues', { rules: [{ folderId: 'not a folder id!', permission: 'read' }] }, 'rules[0].folderId'],
    ['a rule with an unknown permission', { rules: [{ folderId: FOLDER_A, permission: 'admin' }] }, 'rules[0].permission'],
    ['a rule with no permission', { rules: [{ folderId: FOLDER_A }] }, 'rules[0].permission'],
    ['a rule with a non-string label', { rules: [{ folderId: FOLDER_A, label: 7, permission: 'read' }] }, 'rules[0].label'],
    ['a bad rule after a good one', { rules: [{ folderId: FOLDER_A, permission: 'read' }, { folderId: FOLDER_B, permission: 'nope' }] }, 'rules[1].permission'],
  ])('rejects %s with a message naming the rule', async (_label, body, offender) => {
    const res = await put({ defaultLevel: 'write', ...body });

    expect(res.statusCode).toBe(400);
    expect(res.json().error.code).toBe('VALIDATION_ERROR');
    expect(res.json().error.message).toContain(offender);
    expect(mockSetDrivePathConfig).not.toHaveBeenCalled();
  });

  it('rejects two rules for the same folder, even when one is pasted as a URL', async () => {
    const res = await put({
      defaultLevel: 'write',
      rules: [
        { folderId: FOLDER_A, permission: 'read' },
        { folderId: `https://drive.google.com/drive/folders/${FOLDER_A}`, permission: 'blocked' },
      ],
    });

    expect(res.statusCode).toBe(400);
    expect(res.json().error.code).toBe('VALIDATION_ERROR');
    expect(res.json().error.message).toContain('rules[1]');
    expect(res.json().error.message).toContain(FOLDER_A);
    expect(mockSetDrivePathConfig).not.toHaveBeenCalled();
  });
});

describe('GET /api/permissions/:agentId/drive/path-config', () => {
  it('returns the permissive default for an agent with no config', async () => {
    const res = await get();

    expect(res.statusCode).toBe(200);
    expect(res.json().data).toEqual({ defaultLevel: 'write', rules: [] });
  });

  it('reads back what PUT stored', async () => {
    await put({
      defaultLevel: 'blocked',
      rules: [{ folderId: `https://drive.google.com/drive/folders/${FOLDER_A}`, label: 'Shared', permission: 'read' }],
    });

    const res = await get();

    expect(res.statusCode).toBe(200);
    expect(res.json().data).toEqual({
      defaultLevel: 'blocked',
      rules: [{ folderId: FOLDER_A, label: 'Shared', permission: 'read' }],
    });
  });
});
