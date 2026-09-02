/**
 * Route-level tests for per-instance config and the Hermeneutix project
 * picker under /api/permissions.
 *
 * The config column is opaque JSON as far as the service layer is concerned;
 * the routes are where a shape gets enforced, so an unchecked body here would
 * let the dashboard store a project scope the handlers cannot use.
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
  mockDetachCredential, mockVaultDelete,
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
    resetInstanceToolPermission: vi.fn(), getDrivePathConfig: vi.fn(), setDrivePathConfig: vi.fn(),
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
const PROJECT_ID = '11111111-1111-4111-8111-111111111111';
const rows = (r: Record<string, unknown>[]) => ({ rows: r, rowsAffected: r.length, columns: [], lastInsertRowid: 0n });

/**
 * Route the lookups the projects endpoint makes: the agent (scoped to the
 * session user), the credential row, and the agent's hermeneutix instances.
 */
function wireDb(opts: {
  agentExists?: boolean;
  credential?: { id: string; service_id: string; user_id: string } | null;
  defaultCredentialId?: string | null;
  /** The owner's hermeneutix credentials, for the dangling-id fallback. */
  ownerCredentials?: Array<{ id: string; service_id: string; user_id: string }>;
} = {}) {
  const {
    agentExists = true,
    credential = { id: 'cred-h', service_id: 'hermeneutix', user_id: OWNER },
    defaultCredentialId = null,
    ownerCredentials = [],
  } = opts;
  mockExecute.mockImplementation(async (q: any) => {
    const sql: string = typeof q === 'string' ? q : q.sql;
    if (sql.includes('FROM credentials WHERE user_id = ?') && sql.includes("service_id = 'hermeneutix'")) {
      return rows(ownerCredentials);
    }
    if (sql.includes('FROM agents WHERE id = ? AND user_id = ?')) {
      return agentExists ? rows([{ id: AGENT, user_id: OWNER }]) : rows([]);
    }
    if (sql.includes('FROM credentials WHERE id = ?')) {
      return credential ? rows([credential]) : rows([]);
    }
    if (sql.includes('FROM agent_service_instances')) {
      return defaultCredentialId ? rows([{ credential_id: defaultCredentialId }]) : rows([]);
    }
    return rows([]);
  });
}

const mockFetch = vi.fn();

let app: FastifyInstance;
let testSession: { userId: string; email: string } | null = null;

beforeEach(async () => {
  testSession = { userId: OWNER, email: 'owner@example.com' };
  vi.clearAllMocks();
  vi.stubGlobal('fetch', mockFetch);
  mockGetSession.mockReturnValue(null);
  mockRequireAdmin.mockReturnValue(true);
  mockCreateInstance.mockResolvedValue({ instance: { id: 'inst-new' }, created: true });
  mockUpdateInstance.mockResolvedValue({ id: 'inst-h', agentId: AGENT, serviceType: 'hermeneutix' });
  mockGetInstanceConfig.mockResolvedValue({ id: 'inst-h', agentId: AGENT, serviceType: 'hermeneutix' });
  mockGetValidAccessToken.mockResolvedValue('herm-token');
  wireDb();

  app = Fastify({ logger: false });
  await app.register(cookie);
  app.addHook('onRequest', async (req) => {
    (req as unknown as { session: unknown }).session = testSession;
  });
  await app.register(apiRoutes);
  await app.ready();
  // validServiceTypes is filled by a dynamic import the plugin does not await.
  await new Promise((r) => setTimeout(r, 0));
});

afterEach(() => {
  vi.unstubAllGlobals();
});

const jsonResponse = (status: number, body: unknown) =>
  ({ ok: status >= 200 && status < 300, status, json: async () => body }) as unknown as Response;

describe('POST /api/permissions/:agentId/instances with config', () => {
  const post = (payload: Record<string, unknown>) =>
    app.inject({ method: 'POST', url: `/api/permissions/${AGENT}/instances`, payload });

  it('passes a valid hermeneutix config through to createServiceInstance', async () => {
    const config = { projectId: PROJECT_ID, projectName: 'Roadmap' };

    const res = await post({ serviceType: 'hermeneutix', label: 'Roadmap', credentialId: 'cred-h', config });

    expect(res.statusCode).toBe(200);
    expect(mockCreateInstance).toHaveBeenCalledWith(AGENT, 'hermeneutix', 'Roadmap', 'cred-h', config);
  });

  it('accepts a hermeneutix config without a projectName', async () => {
    const res = await post({ serviceType: 'hermeneutix', config: { projectId: PROJECT_ID } });
    expect(res.statusCode).toBe(200);
  });

  it.each([
    ['a projectId that is not a UUID', { projectId: 'roadmap' }],
    ['a missing projectId', { projectName: 'Roadmap' }],
    ['an unsupported key', { projectId: PROJECT_ID, sessionId: 'abc' }],
    ['a non-string projectName', { projectId: PROJECT_ID, projectName: 7 }],
    ['an array', [PROJECT_ID]],
    ['a string', PROJECT_ID],
  ])('rejects a hermeneutix config with %s', async (_label, config) => {
    const res = await post({ serviceType: 'hermeneutix', config });

    expect(res.statusCode).toBe(400);
    expect(res.json().error.code).toBe('VALIDATION_ERROR');
    expect(mockCreateInstance).not.toHaveBeenCalled();
  });

  it('still creates a hermeneutix instance with no config at all', async () => {
    const res = await post({ serviceType: 'hermeneutix' });

    expect(res.statusCode).toBe(200);
    expect(mockCreateInstance).toHaveBeenCalledWith(AGENT, 'hermeneutix', undefined, undefined, undefined);
  });

  it('accepts any plain object for other services and rejects non-objects', async () => {
    const ok = await post({ serviceType: 'gmail', config: { anything: true } });
    expect(ok.statusCode).toBe(200);
    expect(mockCreateInstance).toHaveBeenCalledWith(AGENT, 'gmail', undefined, undefined, { anything: true });

    const bad = await post({ serviceType: 'gmail', config: 'nope' });
    expect(bad.statusCode).toBe(400);
    expect(bad.json().error.code).toBe('VALIDATION_ERROR');
  });
});

describe('PUT /api/permissions/instances/:instanceId with config', () => {
  const put = (payload: Record<string, unknown>) =>
    app.inject({ method: 'PUT', url: '/api/permissions/instances/inst-h', payload });

  it('validates against the service type of the instance being updated', async () => {
    const res = await put({ config: { projectId: 'not-a-uuid' } });

    expect(res.statusCode).toBe(400);
    expect(res.json().error.code).toBe('VALIDATION_ERROR');
    expect(mockUpdateInstance).not.toHaveBeenCalled();
  });

  it('stores a valid config and does not redeploy', async () => {
    const config = { projectId: PROJECT_ID, projectName: 'Roadmap' };

    const res = await put({ config });

    expect(res.statusCode).toBe(200);
    expect(mockUpdateInstance).toHaveBeenCalledWith('inst-h', { config });
    // A redeploy reads the agent's deployment row; none of that happened.
    expect(mockExecute.mock.calls.some(([q]) => String(typeof q === 'string' ? q : q.sql).includes('deployed_agents'))).toBe(false);
  });

  it('clears the config with null', async () => {
    const res = await put({ config: null });

    expect(res.statusCode).toBe(200);
    expect(mockUpdateInstance).toHaveBeenCalledWith('inst-h', { config: null });
  });

  it('404s when the instance does not exist', async () => {
    mockGetInstanceConfig.mockResolvedValue(null);

    const res = await put({ config: { projectId: PROJECT_ID } });

    expect(res.statusCode).toBe(404);
  });

  it('leaves the config alone when the body does not mention it', async () => {
    const res = await put({ label: 'Renamed' });

    expect(res.statusCode).toBe(200);
    expect(mockUpdateInstance).toHaveBeenCalledWith('inst-h', { label: 'Renamed' });
  });
});

describe('GET /api/permissions/:agentId/hermeneutix/projects', () => {
  const get = (query = '?credentialId=cred-h') =>
    app.inject({ method: 'GET', url: `/api/permissions/${AGENT}/hermeneutix/projects${query}` });

  it('maps the upstream { projects: [...] } shape to { data: [{ id, name }] }', async () => {
    mockFetch.mockResolvedValue(jsonResponse(200, {
      projects: [
        { id: PROJECT_ID, name: 'Roadmap', description: 'Q3 planning' },
        { id: '22222222-2222-4222-8222-222222222222', name: 'Hiring', description: null },
      ],
    }));

    const res = await get();

    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({
      data: [
        { id: PROJECT_ID, name: 'Roadmap' },
        { id: '22222222-2222-4222-8222-222222222222', name: 'Hiring' },
      ],
    });
    expect(mockFetch).toHaveBeenCalledWith(
      'https://hermeneutix.btv.pw/api/mobile/projects/',
      expect.objectContaining({ headers: expect.objectContaining({ Authorization: 'Token herm-token' }) })
    );
    expect(mockGetValidAccessToken).toHaveBeenCalledWith('cred-h');
  });

  it('accepts a bare array from upstream', async () => {
    mockFetch.mockResolvedValue(jsonResponse(200, [{ id: PROJECT_ID, name: 'Roadmap' }]));

    const res = await get();

    expect(res.statusCode).toBe(200);
    expect(res.json().data).toEqual([{ id: PROJECT_ID, name: 'Roadmap' }]);
  });

  it("falls back to the agent's default hermeneutix instance when credentialId is omitted", async () => {
    wireDb({ defaultCredentialId: 'cred-h' });
    mockFetch.mockResolvedValue(jsonResponse(200, { projects: [] }));

    const res = await get('');

    expect(res.statusCode).toBe(200);
    expect(mockGetValidAccessToken).toHaveBeenCalledWith('cred-h');
  });

  it('400s when no credential is given and the agent has no hermeneutix account', async () => {
    wireDb({ defaultCredentialId: null });

    const res = await get('');

    expect(res.statusCode).toBe(400);
    expect(res.json().error.code).toBe('VALIDATION_ERROR');
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it('404s an agent the session user does not own', async () => {
    wireDb({ agentExists: false });

    const res = await get();

    expect(res.statusCode).toBe(404);
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it("403s a credential that belongs to someone other than the agent's owner", async () => {
    wireDb({ credential: { id: 'cred-h', service_id: 'hermeneutix', user_id: 'user-2' } });

    const res = await get();

    expect(res.statusCode).toBe(403);
    expect(mockGetValidAccessToken).not.toHaveBeenCalled();
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it('403s a credential of a different service', async () => {
    wireDb({ credential: { id: 'cred-h', service_id: 'gmail', user_id: OWNER } });

    const res = await get();

    expect(res.statusCode).toBe(403);
    expect(mockFetch).not.toHaveBeenCalled();
  });

  /**
   * The Credentials page "Update" flow deletes and recreates the credential,
   * and an instance can still point at the deleted id. When the owner has
   * exactly one hermeneutix credential there is nothing to choose, so use it.
   */
  describe('when the credential id has no row', () => {
    const RECONNECT = 'Hermeneutix account is no longer connected — reconnect it on the Credentials page';

    it("falls back to the owner's only hermeneutix credential without writing anything", async () => {
      wireDb({ credential: null, ownerCredentials: [{ id: 'cred-new', service_id: 'hermeneutix', user_id: OWNER }] });
      mockFetch.mockResolvedValue(jsonResponse(200, { projects: [{ id: PROJECT_ID, name: 'Roadmap' }] }));

      const res = await get('?credentialId=cred-gone');

      expect(res.statusCode).toBe(200);
      expect(res.json().data).toEqual([{ id: PROJECT_ID, name: 'Roadmap' }]);
      expect(mockGetValidAccessToken).toHaveBeenCalledWith('cred-new');
      const writes = mockExecute.mock.calls
        .map(([q]) => String(typeof q === 'string' ? q : q.sql))
        .filter((sql) => /^\s*(UPDATE|INSERT|DELETE)/i.test(sql));
      expect(writes).toEqual([]);
    });

    it('404s with a reconnect message when the owner has no hermeneutix credential', async () => {
      wireDb({ credential: null, ownerCredentials: [] });

      const res = await get('?credentialId=cred-gone');

      expect(res.statusCode).toBe(404);
      expect(res.json().error).toEqual({ code: 'NOT_FOUND', message: RECONNECT });
      expect(mockFetch).not.toHaveBeenCalled();
    });

    it('404s with the reconnect message when the owner has several, rather than guessing', async () => {
      wireDb({
        credential: null,
        ownerCredentials: [
          { id: 'cred-a', service_id: 'hermeneutix', user_id: OWNER },
          { id: 'cred-b', service_id: 'hermeneutix', user_id: OWNER },
        ],
      });

      const res = await get('?credentialId=cred-gone');

      expect(res.statusCode).toBe(404);
      expect(res.json().error.message).toBe(RECONNECT);
      expect(mockFetch).not.toHaveBeenCalled();
    });

    it('applies the fallback to the id taken from the default instance too', async () => {
      wireDb({
        credential: null,
        defaultCredentialId: 'cred-gone',
        ownerCredentials: [{ id: 'cred-new', service_id: 'hermeneutix', user_id: OWNER }],
      });
      mockFetch.mockResolvedValue(jsonResponse(200, { projects: [] }));

      const res = await get('');

      expect(res.statusCode).toBe(200);
      expect(mockGetValidAccessToken).toHaveBeenCalledWith('cred-new');
    });
  });

  it('401s INVALID_TOKEN when upstream rejects the token', async () => {
    mockFetch.mockResolvedValue(jsonResponse(401, { detail: 'Invalid token.' }));

    const res = await get();

    expect(res.statusCode).toBe(401);
    expect(res.json().error.code).toBe('INVALID_TOKEN');
  });

  it('401s INVALID_TOKEN when the vault has no usable token', async () => {
    mockGetValidAccessToken.mockResolvedValue(null);

    const res = await get();

    expect(res.statusCode).toBe(401);
    expect(res.json().error.code).toBe('INVALID_TOKEN');
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it('502s SERVER_ERROR on a network failure', async () => {
    mockFetch.mockRejectedValue(new Error('ECONNREFUSED'));

    const res = await get();

    expect(res.statusCode).toBe(502);
    expect(res.json().error.code).toBe('SERVER_ERROR');
  });

  it('502s SERVER_ERROR on an unexpected upstream status', async () => {
    mockFetch.mockResolvedValue(jsonResponse(500, 'boom'));

    const res = await get();

    expect(res.statusCode).toBe(502);
    expect(res.json().error.code).toBe('SERVER_ERROR');
  });
});

describe('DELETE /api/credentials/:id', () => {
  it('detaches every link to the credential after the vault delete', async () => {
    mockVaultDelete.mockResolvedValue(true);
    mockDetachCredential.mockResolvedValue(undefined);

    const res = await app.inject({ method: 'DELETE', url: '/api/credentials/cred-h' });

    expect(res.statusCode).toBe(204);
    expect(mockVaultDelete).toHaveBeenCalledWith('cred-h');
    expect(mockDetachCredential).toHaveBeenCalledWith('cred-h');
    // The vault delete decides whether there is anything to detach.
    expect(mockVaultDelete.mock.invocationCallOrder[0]).toBeLessThan(mockDetachCredential.mock.invocationCallOrder[0]);
  });

  it('404s and detaches nothing when the credential does not exist', async () => {
    mockVaultDelete.mockResolvedValue(false);

    const res = await app.inject({ method: 'DELETE', url: '/api/credentials/nope' });

    expect(res.statusCode).toBe(404);
    expect(mockDetachCredential).not.toHaveBeenCalled();
  });
});
