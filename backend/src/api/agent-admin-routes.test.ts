/**
 * Route-level tests for /api/agent-admin/*.
 *
 * These exist because the privilege boundary is the routes, not the MCP tool
 * list. Every deployed agent has its own gateway token and REINS_API_URL in its
 * environment, so an agent merely denied the tools can still issue these
 * requests by hand — a gate that lived only in tools/list would look enforced
 * and enforce nothing.
 *
 * The properties under test are the ones that make the admin MCP safe to hand to
 * an agent at all: it cannot reach another owner's agents, it cannot grant or
 * revoke helm-admin, and it cannot arm an agent that anyone can already drive.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import cookie from '@fastify/cookie';

const {
  mockExecute, mockGetSession, mockRequireAdmin, mockIsServiceEnabled,
  mockListEnabled, mockListOpen, mockUserHasAdmin, mockCreateInstance,
  mockSetPermissionLevel, mockGetPermissionLevel,
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
    // Imported by routes.ts but unused by these paths.
    getPermissionMatrix: vi.fn(), getAgentServiceConfig: vi.fn(), setServiceAccess: vi.fn(),
    linkCredential: vi.fn(), autoLinkCredential: vi.fn(), unlinkCredential: vi.fn(),
    setToolPermission: vi.fn(), resetToolPermission: vi.fn(), setServiceToolPermissions: vi.fn(),
    getCredentialsForService: vi.fn(), addServiceCredential: vi.fn(), removeServiceCredential: vi.fn(),
    setDefaultCredential: vi.fn(), getLinkedCredentials: vi.fn(), getAgentPermissions: vi.fn(),
    getInstanceConfig: vi.fn(), updateServiceInstance: vi.fn(), deleteServiceInstance: vi.fn(),
    setInstancePermissionLevel: vi.fn(), setInstanceToolPermission: vi.fn(),
    resetInstanceToolPermission: vi.fn(), getDrivePathConfig: vi.fn(), setDrivePathConfig: vi.fn(),
    enableDefaultServices: vi.fn(),
  };
});

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
  ],
  serviceRegistry: new Map(),
  getServiceTypeFromToolName: () => null,
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
vi.mock('../credentials/vault.js', () => ({ credentialVault: {} }));
vi.mock('../mcp/proxy.js', () => ({ mcpProxy: {} }));
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

const ADMIN_AGENT = 'admin-agent';
const TARGET = 'target-agent';
const TOKEN = 'gateway-token';
const rows = (r: Record<string, unknown>[]) => ({ rows: r, rowsAffected: r.length, columns: [], lastInsertRowid: 0n });

/**
 * Route the two lookups these handlers make: the gateway token → agent, and the
 * target agent → owner. Anything else answers empty.
 */
function wireDb(opts: { targetOwnedByCaller?: boolean } = {}) {
  const { targetOwnedByCaller = true } = opts;
  mockExecute.mockImplementation(async (q: any) => {
    const sql: string = typeof q === 'string' ? q : q.sql;
    if (sql.includes('FROM deployed_agents da') && sql.includes('gateway_token')) {
      return rows([{ agent_id: ADMIN_AGENT, user_id: 'user-1', runtime: 'openclaw', mcp_server_name: 'helm' }]);
    }
    if (sql.includes('FROM agents WHERE id = ? AND user_id = ?')) {
      return targetOwnedByCaller
        ? rows([{ id: TARGET, name: 'Work', description: null, status: 'active' }])
        : rows([]);
    }
    if (sql.includes('FROM agents a') && sql.includes('LEFT JOIN LATERAL')) {
      return rows([{ id: TARGET, name: 'Work', description: null, status: 'active', deployment_status: 'running', runtime: 'openclaw', is_manual: false }]);
    }
    return rows([]);
  });
}

let app: FastifyInstance;
/** What the auth hook would have attached. Null for agent-token requests. */
let testSession: { userId: string; email: string } | null = null;

beforeEach(async () => {
  testSession = null;
  vi.clearAllMocks();
  mockGetSession.mockReturnValue(null);
  mockRequireAdmin.mockReturnValue(true);
  mockIsServiceEnabled.mockResolvedValue(true);
  mockListEnabled.mockResolvedValue(['memory']);
  mockListOpen.mockResolvedValue([]);
  mockUserHasAdmin.mockResolvedValue(false);
  mockCreateInstance.mockResolvedValue({ instance: {}, created: true });
  mockSetPermissionLevel.mockResolvedValue(undefined);
  mockGetPermissionLevel.mockResolvedValue('read');
  wireDb();

  app = Fastify({ logger: false });
  await app.register(cookie);
  // getUserId reads request.session, which the real auth hook attaches. That
  // hook is mocked away here, so stand in for it.
  app.addHook('onRequest', async (req) => {
    (req as unknown as { session: unknown }).session = testSession;
  });
  await app.register(apiRoutes);
  await app.ready();
  await new Promise((r) => setTimeout(r, 0));
});

const auth = { 'x-reins-agent-secret': TOKEN };

describe('the service enablement gate', () => {
  it('serves an admin agent', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/agent-admin/agents', headers: auth });
    expect(res.statusCode).toBe(200);
  });

  it('403s an agent without helm-admin, without revealing anything about the account', async () => {
    mockIsServiceEnabled.mockResolvedValue(false);

    const res = await app.inject({ method: 'GET', url: '/api/agent-admin/agents', headers: auth });

    expect(res.statusCode).toBe(403);
    expect(res.json().error.code).toBe('SERVICE_NOT_ENABLED');
    expect(res.payload).not.toContain('Work');
  });

  it('401s with no gateway token at all', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/agent-admin/agents' });
    expect(res.statusCode).toBe(401);
  });

  it('gates the writes too, not just the reads', async () => {
    mockIsServiceEnabled.mockResolvedValue(false);

    const res = await app.inject({
      method: 'PATCH', url: `/api/agent-admin/agents/${TARGET}`, headers: auth,
      payload: { name: 'Renamed' },
    });

    expect(res.statusCode).toBe(403);
  });
});

describe('scoping to the caller\'s owner', () => {
  it('404s an agent belonging to someone else rather than acting on it', async () => {
    wireDb({ targetOwnedByCaller: false });

    const res = await app.inject({
      method: 'PATCH', url: '/api/agent-admin/agents/someone-elses', headers: auth,
      payload: { name: 'Renamed' },
    });

    // 404 not 403: an admin agent must not be able to probe which ids exist.
    expect(res.statusCode).toBe(404);
  });
});

describe('helm-admin is not grantable from here', () => {
  it('refuses to grant it', async () => {
    const res = await app.inject({
      method: 'POST', url: `/api/agent-admin/agents/${TARGET}/services`, headers: auth,
      payload: { serviceType: 'helm-admin' },
    });

    expect(res.statusCode).toBe(403);
    expect(res.json().error.code).toBe('SERVICE_NOT_GRANTABLE');
    expect(mockCreateInstance).not.toHaveBeenCalled();
  });

  it('refuses to revoke it — that is the first half of undoing the latch', async () => {
    const res = await app.inject({
      method: 'DELETE', url: `/api/agent-admin/agents/${TARGET}/services/helm-admin`, headers: auth,
    });

    expect(res.statusCode).toBe(403);
    expect(mockSetPermissionLevel).not.toHaveBeenCalled();
  });

  it('leaves it out of the catalog it advertises', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/agent-admin/services', headers: auth });

    const types = res.json().data.services.map((s: { serviceType: string }) => s.serviceType);
    expect(types).toContain('gmail');
    expect(types).not.toContain('helm-admin');
  });
});

describe('refusing to arm an agent anyone can already drive', () => {
  it('409s a grant to an agent with an open MCP endpoint', async () => {
    // Otherwise the grant hands capability to anyone holding that agent's id.
    mockListOpen.mockResolvedValue([{ id: TARGET, name: 'Work' }]);

    const res = await app.inject({
      method: 'POST', url: `/api/agent-admin/agents/${TARGET}/services`, headers: auth,
      payload: { serviceType: 'gmail' },
    });

    expect(res.statusCode).toBe(409);
    expect(res.json().error.code).toBe('TARGET_ACCEPTS_UNAUTHENTICATED_MCP');
    expect(mockCreateInstance).not.toHaveBeenCalled();
  });

  it('409s a level raise for the same reason', async () => {
    mockListOpen.mockResolvedValue([{ id: TARGET, name: 'Work' }]);

    const res = await app.inject({
      method: 'PUT', url: `/api/agent-admin/agents/${TARGET}/services/gmail/level`, headers: auth,
      payload: { level: 'full' },
    });

    expect(res.statusCode).toBe(409);
    expect(mockSetPermissionLevel).not.toHaveBeenCalled();
  });

  it('still allows turning a service off, which only narrows', async () => {
    mockListOpen.mockResolvedValue([{ id: TARGET, name: 'Work' }]);

    const res = await app.inject({
      method: 'PUT', url: `/api/agent-admin/agents/${TARGET}/services/gmail/level`, headers: auth,
      payload: { level: 'none' },
    });

    expect(res.statusCode).toBe(200);
    expect(mockSetPermissionLevel).toHaveBeenCalledWith(TARGET, 'gmail', 'none');
  });

  it('allows a grant once the target is closed', async () => {
    const res = await app.inject({
      method: 'POST', url: `/api/agent-admin/agents/${TARGET}/services`, headers: auth,
      payload: { serviceType: 'gmail' },
    });

    expect(res.statusCode).toBe(200);
    expect(mockCreateInstance).toHaveBeenCalledWith(TARGET, 'gmail');
  });
});

describe('the exclusivity guard reaches this API too', () => {
  it('surfaces a combination refusal as a 409 naming the conflict', async () => {
    const { ServiceCombinationError } = await import('../services/permissions.js');
    mockCreateInstance.mockRejectedValue(
      new ServiceCombinationError('nope', 'gmail', ['helm-admin'])
    );

    const res = await app.inject({
      method: 'POST', url: `/api/agent-admin/agents/${TARGET}/services`, headers: auth,
      payload: { serviceType: 'gmail' },
    });

    expect(res.statusCode).toBe(409);
    // Under `details`, which is the envelope the frontend ApiError carries.
    expect(res.json().error.details.conflicting).toEqual(['helm-admin']);
  });
});

describe('metadata writes', () => {
  it('renames an agent', async () => {
    const res = await app.inject({
      method: 'PATCH', url: `/api/agent-admin/agents/${TARGET}`, headers: auth,
      payload: { name: 'Work Email' },
    });

    expect(res.statusCode).toBe(200);
    const update = mockExecute.mock.calls.find((c) => (c[0] as any).sql?.startsWith('UPDATE agents'));
    expect(update).toBeTruthy();
    expect((update![0] as any).args).toContain('Work Email');
  });

  it('rejects an empty name rather than blanking it', async () => {
    const res = await app.inject({
      method: 'PATCH', url: `/api/agent-admin/agents/${TARGET}`, headers: auth,
      payload: { name: '   ' },
    });

    expect(res.statusCode).toBe(400);
  });

  it('rejects a status outside the allowed set', async () => {
    const res = await app.inject({
      method: 'PATCH', url: `/api/agent-admin/agents/${TARGET}`, headers: auth,
      payload: { status: 'destroyed' },
    });

    expect(res.statusCode).toBe(400);
  });

  it('rejects a body with nothing to change', async () => {
    const res = await app.inject({
      method: 'PATCH', url: `/api/agent-admin/agents/${TARGET}`, headers: auth, payload: {},
    });

    expect(res.statusCode).toBe(400);
  });
});

describe('the latch on re-opening an unauthenticated endpoint', () => {
  // Session-authed, so this is the owner acting, not the agent. The point is
  // that the precondition cannot be undone while an admin agent exists —
  // otherwise it is close everything, enable admin, re-open.
  beforeEach(() => {
    testSession = { userId: 'user-1', email: 'a@b.c' };
    mockGetSession.mockReturnValue(testSession);
  });

  it('409s re-opening while the account has an admin agent', async () => {
    mockUserHasAdmin.mockResolvedValue(true);

    const res = await app.inject({
      method: 'PUT', url: `/api/agents/${TARGET}/mcp-unauthenticated`, payload: { allowed: true },
    });

    expect(res.statusCode).toBe(409);
    expect(res.json().error.code).toBe('ADMIN_AGENT_EXISTS');
  });

  it('still allows closing one, which is always safe', async () => {
    mockUserHasAdmin.mockResolvedValue(true);

    const res = await app.inject({
      method: 'PUT', url: `/api/agents/${TARGET}/mcp-unauthenticated`, payload: { allowed: false },
    });

    expect(res.statusCode).toBe(200);
  });

  it('allows re-opening once no admin agent remains', async () => {
    mockUserHasAdmin.mockResolvedValue(false);

    const res = await app.inject({
      method: 'PUT', url: `/api/agents/${TARGET}/mcp-unauthenticated`, payload: { allowed: true },
    });

    expect(res.statusCode).toBe(200);
  });
});
