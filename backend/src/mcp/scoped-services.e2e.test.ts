/**
 * Scoped services, end to end.
 *
 * agent-endpoint.test.ts mocks the servers package and the server manager, so
 * it proves that the endpoint *passes* an instance's config and gateway token
 * to a handler — not that any handler honours them. This harness runs the real
 * tool sets: `@reins/servers` and `./server-manager.js` are NOT mocked, the
 * Hermeneutix and memory definitions are registered on the real singleton via
 * createServerWrapper, and a tools/call goes through the real endpoint into the
 * real handler. Only the edges are stubbed: the database, the credential
 * vault, and global fetch.
 *
 * Two boundaries are exercised:
 *   - Hermeneutix: an instance pinned to one project may only reach that
 *     project, and the pin is enforced in the servers package from
 *     context.instanceConfig — so the whole chain from row to refusal is real.
 *   - Memory: a restricted agent's tool calls go through the memory handlers,
 *     out over fetch to the Reins API, and back into a real Fastify app whose
 *     scope resolution decides what the agent may touch. Fetch is routed to
 *     app.inject, so the HTTP hop is real too.
 */

import { describe, it, expect, vi, beforeAll, afterAll, beforeEach, afterEach, type Mock } from 'vitest';
import type { FastifyInstance } from 'fastify';

// ── Module mocks (hoisted) ───────────────────────────────────────────────────

const { REINS_API_URL } = vi.hoisted(() => ({ REINS_API_URL: 'http://reins.test' }));

vi.mock('../config/index.js', () => ({
  config: {
    sessionSecret: 'scoped-services-e2e-secret-at-least-32-chars!',
    nodeEnv: 'test',
    dashboardUrl: REINS_API_URL,
    publicUrl: REINS_API_URL,
    adminPassword: 'changeme',
    logLevel: 'silent',
    port: 0,
    host: '127.0.0.1',
    databaseUrl: 'postgres://localhost/test_unused',
    encryptionKey: '0'.repeat(64),
  },
}));

/**
 * The database double.
 *
 * Drizzle selects are served by table name, whatever the WHERE clause — the
 * endpoint's instance path makes a dozen selects and a call-order queue breaks
 * on any reordering. Raw client.execute calls are routed by SQL text, the way
 * the memory integration test does it.
 */
const { tables, dbUpdates, exec } = vi.hoisted(() => ({
  tables: new Map<string, unknown[]>(),
  dbUpdates: [] as Array<{ table: string; values: Record<string, unknown> }>,
  exec: { route: (async (_input: unknown) => ({ rows: [], columns: [], rowsAffected: 0, lastInsertRowid: 0n })) as (input: any) => Promise<unknown> },
}));

vi.mock('../db/index.js', async () => {
  const { getTableName } = await import('drizzle-orm');
  const name = (table: unknown) => getTableName(table as never);
  return {
    db: {
      select: () => ({
        from: (table: unknown) => ({
          where: async () => tables.get(name(table)) ?? [],
        }),
      }),
      update: (table: unknown) => ({
        set: (values: Record<string, unknown>) => ({
          where: async () => { dbUpdates.push({ table: name(table), values }); },
        }),
      }),
      insert: () => ({ values: async () => undefined }),
      delete: () => ({ where: async () => undefined }),
    },
    client: { execute: (input: unknown) => exec.route(input) },
    initializeDatabase: vi.fn(),
    schema: {},
  };
});

vi.mock('../credentials/vault.js', () => ({
  credentialVault: {
    retrieve: vi.fn().mockResolvedValue({
      serviceId: 'hermeneutix',
      type: 'oauth2',
      data: { accessToken: 'herm-token' },
    }),
    getValidAccessToken: vi.fn().mockResolvedValue('herm-token'),
    list: vi.fn().mockResolvedValue([]),
    store: vi.fn(),
    storeOAuth: vi.fn(),
    delete: vi.fn(),
    checkHealth: vi.fn(),
  },
  startTokenRefreshLoop: vi.fn(),
  stopTokenRefreshLoop: vi.fn(),
}));

vi.mock('../audit/logger.js', () => ({
  auditLogger: {
    log: vi.fn().mockResolvedValue(1),
    logToolCall: vi.fn().mockResolvedValue(1),
    logApproval: vi.fn().mockResolvedValue(1),
    logAgentEvent: vi.fn().mockResolvedValue(1),
    query: vi.fn().mockResolvedValue([]),
  },
}));

vi.mock('../approvals/queue.js', () => ({
  MAX_REVISIONS: 3,
  approvalQueue: {
    submit: vi.fn().mockResolvedValue('approval-1'),
    waitForDecision: vi.fn().mockResolvedValue({ approved: true, approver: 'user' }),
    registerExecutor: vi.fn(),
    get: vi.fn().mockResolvedValue(null),
    getLatestDeferred: vi.fn().mockResolvedValue(null),
    submitReauth: vi.fn().mockResolvedValue({ id: 'reauth-1', isNew: true, emailThrottled: false }),
    requestChanges: vi.fn(), approve: vi.fn(), reject: vi.fn(),
    listPending: vi.fn().mockResolvedValue([]),
  },
}));

vi.mock('../services/spend.js', () => ({
  checkSpendCap: vi.fn().mockResolvedValue({ allowed: true }),
  recordUsage: vi.fn().mockResolvedValue(undefined),
  estimateCost: vi.fn().mockReturnValue(0),
  currentBillingPeriod: vi.fn().mockReturnValue('2026-09'),
  markSoftStopped: vi.fn(), markAlerted80: vi.fn(), resetSpendCap: vi.fn(),
  notifySpend80: vi.fn(), notifySoftStop: vi.fn(),
}));

vi.mock('../services/billing.js', () => ({
  getSubscription: vi.fn().mockResolvedValue(null),
  upsertSubscription: vi.fn().mockResolvedValue(undefined),
  applyGracePeriod: vi.fn().mockResolvedValue(undefined),
  clearGrace: vi.fn().mockResolvedValue(undefined),
  cancelSubscription: vi.fn().mockResolvedValue(undefined),
  checkDeployGate: vi.fn().mockResolvedValue({ allowed: true }),
  checkUsageGate: vi.fn().mockResolvedValue({ allowed: true }),
}));

/** Every tool under test is allowed outright; the policy layer is not what is being tested. */
const { allowedTools, driveConfig } = vi.hoisted(() => ({
  allowedTools: {
    hermeneutix_list_meetings: 'allow',
    hermeneutix_get_meeting_instance: 'allow',
    memory_create: 'allow',
    memory_list_scopes: 'allow',
    memory_get: 'allow',
    drive_read_file: 'allow',
    drive_search: 'allow',
    drive_create_file: 'allow',
    drive_list_files: 'allow',
    gmail_create_draft: 'allow',
  } as Record<string, string>,
  driveConfig: {
    current: {
      defaultLevel: 'write' as 'read' | 'write' | 'blocked',
      rules: [] as Array<{ folderId: string; label?: string; permission: 'read' | 'write' | 'blocked' }>,
    },
  },
}));

vi.mock('../services/permissions.js', async () => {
  const actual = await vi.importActual<typeof import('../services/permissions.js')>('../services/permissions.js');
  return {
    ...actual,
    // The real decoder: the whole point is that a row's JSON reaches the handler.
    parseInstanceConfig: actual.parseInstanceConfig,
    getEffectiveInstancePermissions: vi.fn(async () => ({ enabled: true, tools: allowedTools })),
    getEffectivePermissions: vi.fn(async () => ({ enabled: true, tools: allowedTools })),
    canAccessTool: vi.fn(async () => ({ allowed: true, requiresApproval: false })),
    getDrivePathConfig: vi.fn(async () => driveConfig.current),
  };
});

/**
 * googleapis, the way servers/src/drive/handlers.test.ts mocks it: one shared
 * Drive client whose files.get answers `parents` per id, so the handlers'
 * ancestry walk runs against a small fixed tree. Reached through the built
 * servers package, which is the same code path production takes.
 */
const { mockDrive, mockGmail } = vi.hoisted(() => ({
  mockDrive: {
    files: { list: vi.fn(), get: vi.fn(), create: vi.fn(), update: vi.fn(), delete: vi.fn(), export: vi.fn() },
    permissions: { create: vi.fn() },
    drives: { list: vi.fn() },
  },
  mockGmail: {
    users: {
      drafts: { create: vi.fn(), send: vi.fn() },
      messages: { get: vi.fn(), list: vi.fn(), attachments: { get: vi.fn() } },
      getProfile: vi.fn(),
    },
  },
}));

vi.mock('googleapis', () => ({
  google: {
    auth: { OAuth2: vi.fn().mockImplementation(() => ({ setCredentials: vi.fn() })) },
    drive: vi.fn(() => mockDrive),
    gmail: vi.fn(() => mockGmail),
  },
}));

// Needed by buildApp; none of these are on the paths under test.
vi.mock('../providers/index.js', () => ({
  provision: vi.fn(), start: vi.fn(), stop: vi.fn(), restart: vi.fn(),
  getStatus: vi.fn().mockResolvedValue('running'), destroy: vi.fn(), redeploy: vi.fn(),
  getLogs: vi.fn().mockResolvedValue({ logs: [], nextToken: undefined }),
  getManagementUrl: vi.fn().mockResolvedValue(null),
}));
vi.mock('../mcp/proxy.js', () => ({
  mcpProxy: { proxyRequest: vi.fn(), getUpstreamTools: vi.fn().mockResolvedValue([]) },
}));
vi.mock('../notifications/apns.js', () => ({ apnsService: { sendPush: vi.fn() } }));
vi.mock('../services/email.js', () => ({ sendReauthEmail: vi.fn() }));
vi.mock('../services/model-router.js', () => ({
  listModelConfigs: vi.fn().mockResolvedValue([]),
  upsertModelConfig: vi.fn().mockResolvedValue(undefined),
  deleteModelConfig: vi.fn().mockResolvedValue(undefined),
  getLiteLLMConfigB64: vi.fn().mockResolvedValue(null),
}));

// ── Imports after mocks ──────────────────────────────────────────────────────

import { serviceDefinitions } from '@reins/servers';
import { serverManager } from './server-manager.js';
import { createServerWrapper } from './init-servers.js';
import { handleMCPRequest, type MCPResponse } from './agent-endpoint.js';
import { buildApp } from '../app.js';
import { getDrivePathConfig } from '../services/permissions.js';

// ── Fixtures ─────────────────────────────────────────────────────────────────

const AGENT = 'agent-scoped-1';
const USER = 'user-scoped-1';
const GATEWAY_TOKEN = 'gw-scoped-secret';
const CRED = 'cred-herm';
const PINNED = '11111111-1111-4111-8111-111111111111';
const OTHER = '22222222-2222-4222-8222-222222222222';
const SENTINEL = 'TRANSCRIPT-MUST-NOT-LEAK-7f3a';

const SCOPE_DEFAULT = 'scope-default-id';
const SCOPE_WORK = 'scope-work-id';
const ROOT_DEFAULT = 'root-default-entry';
const ROOT_WORK = 'root-work-entry';
const ENTRY_IN_DEFAULT = 'entry-in-default';
const NOW = '2026-09-04T12:00:00.000Z';

const agentRow = { id: AGENT, name: 'Scoped Agent', status: 'active', userId: USER };
const credRow = { id: CRED, serviceId: 'hermeneutix', userId: USER, accountEmail: 'hermeneutix', grantedServices: null, expiresAt: null };

const instance = (over: Record<string, unknown>) => ({
  id: 'inst-1', agentId: AGENT, serviceType: 'hermeneutix', label: null, credentialId: CRED,
  enabled: true, isDefault: true, config: null, createdAt: NOW, updatedAt: NOW, ...over,
});

const rows = (r: Record<string, unknown>[]) => ({ rows: r, columns: [], rowsAffected: r.length, lastInsertRowid: 0n });
const EMPTY = rows([]);

/**
 * What the owner's vault looks like to the memory routes: two scopes, the
 * agent granted only `work`. `granted`/`grant_count` are what
 * getAgentScopeGrants reads off the same rows.
 */
const scopeRows = [
  { id: SCOPE_DEFAULT, user_id: USER, slug: 'default', name: 'Default', description: null, root_entry_id: ROOT_DEFAULT, is_default: true, is_system: true, archived_at: null, granted: false, grant_count: 1 },
  { id: SCOPE_WORK, user_id: USER, slug: 'work', name: 'Work', description: null, root_entry_id: ROOT_WORK, is_default: false, is_system: false, archived_at: null, granted: true, grant_count: 1 },
];

const rootRow = (id: string, scopeId: string) => ({
  id, user_id: USER, scope_id: scopeId, type: 'index', title: 'Memory Index', content: '# Memory Index\n\n',
  created_at: NOW, updated_at: NOW, version: 1,
});

/** Every raw SQL statement the harness has seen, in order. */
const executed: Array<{ sql: string; args: unknown[] }> = [];

/**
 * Route raw SQL: the agent-endpoint's deployment lookups, the gateway-token
 * auth of the memory routes, and the memory routes' own reads. Writes succeed
 * and reads default to empty, as in the memory integration test.
 */
async function routeSql(input: string | { sql: string; args?: unknown[] }) {
  const sql = typeof input === 'string' ? input : input.sql;
  const args = (typeof input === 'string' ? [] : input.args) ?? [];
  executed.push({ sql, args });

  // executeTool: the gateway token a memory handler authenticates with.
  if (sql.includes('SELECT gateway_token FROM deployed_agents')) return rows([{ gateway_token: GATEWAY_TOKEN }]);
  // routes: resolveAgentFromGatewayToken.
  if (sql.includes('FROM deployed_agents da')) {
    return args[0] === GATEWAY_TOKEN
      ? rows([{ agent_id: AGENT, user_id: USER, runtime: 'openclaw', mcp_server_name: 'helm', is_manual: false }])
      : EMPTY;
  }
  // handleCallTool's subscription gate keys on a deployment id; none here.
  if (sql.includes('JOIN deployed_agents da')) return EMPTY;

  // ── Memory routes ──
  if (sql.includes('FROM memory_scopes WHERE root_entry_id = ?')) return EMPTY;
  if (sql.includes('SELECT root_entry_id, name, is_system FROM memory_scopes WHERE id = ?')) {
    const s = scopeRows.find((r) => r.id === args[0]);
    return s ? rows([s]) : EMPTY;
  }
  if (sql.includes('similarity(')) return EMPTY;
  if (sql.includes('FROM memory_scopes')) return rows(scopeRows);
  if (sql.includes('SELECT scope_id, COUNT(*)')) return EMPTY;
  // The one entry that exists, in the default scope. Visible only to a caller
  // whose scope list (bound after the id) includes that scope.
  if (sql.includes('FROM memory_entries e') && sql.includes('e.id = ?')) {
    return args[0] === ENTRY_IN_DEFAULT && args.slice(1).includes(SCOPE_DEFAULT)
      ? rows([{ id: ENTRY_IN_DEFAULT, user_id: USER, scope_id: SCOPE_DEFAULT, scope: 'default', scope_name: 'Default', type: 'note', title: 'Private', content: 'x', created_at: NOW, updated_at: NOW, version: 1 }])
      : EMPTY;
  }
  if (sql.includes("type = 'index'") && sql.includes('FROM memory_entries')) {
    const scopeId = args.find((a) => a === SCOPE_WORK || a === SCOPE_DEFAULT) as string | undefined;
    return rows([rootRow(scopeId === SCOPE_WORK ? ROOT_WORK : ROOT_DEFAULT, scopeId ?? SCOPE_DEFAULT)]);
  }
  if (sql.includes('FROM memory_branches') && sql.includes('MAX(position)')) return rows([{ next_pos: 0 }]);
  if (sql.startsWith('UPDATE memory_entries SET')) return { ...EMPTY, rowsAffected: 1 };
  return EMPTY;
}

// ── Fetch routing ────────────────────────────────────────────────────────────

let app: FastifyInstance;
let fetchMock: Mock<[input: string | URL | Request, init?: RequestInit], Promise<Response>>;

/**
 * Hand a handler's fetch to the Fastify app when it targets the Reins API;
 * anything else answers with whatever the test queued (the Hermeneutix stub).
 */
function installFetch(upstream: (url: string, init?: RequestInit) => Promise<Response> | Response) {
  fetchMock = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
    if (url.startsWith(REINS_API_URL)) {
      const u = new URL(url);
      const res = await app.inject({
        method: (init?.method ?? 'GET') as 'GET',
        url: u.pathname + u.search,
        headers: (init?.headers ?? {}) as Record<string, string>,
        payload: typeof init?.body === 'string' ? init.body : undefined,
      });
      return new Response(res.payload, {
        status: res.statusCode,
        headers: { 'content-type': String(res.headers['content-type'] ?? 'application/json') },
      });
    }
    return upstream(url, init);
  });
  vi.stubGlobal('fetch', fetchMock);
}

const upstreamJson = (body: unknown, status = 200): Response =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

// ── Helpers ──────────────────────────────────────────────────────────────────

async function callTool(name: string, args: Record<string, unknown> = {}): Promise<MCPResponse> {
  return handleMCPRequest(AGENT, { jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } });
}

const textOf = (r: MCPResponse) => (r.result as { content: Array<{ text: string }> } | undefined)?.content[0]?.text ?? '';
const isToolError = (r: MCPResponse) => Boolean((r.result as { isError?: boolean } | undefined)?.isError);

const statementsMatching = (pattern: string) => executed.filter((s) => s.sql.includes(pattern));

// ── Setup ────────────────────────────────────────────────────────────────────

beforeAll(async () => {
  // The real tool sets on the real singleton, wrapped exactly as boot does it.
  for (const type of ['hermeneutix', 'memory', 'drive', 'gmail']) {
    const def = serviceDefinitions.find((d) => d.type === type);
    if (!def) throw new Error(`service definition missing: ${type}`);
    serverManager.registerServer(createServerWrapper(def.type, def.name, def.tools));
  }
  process.env.REINS_API_URL = REINS_API_URL;
  exec.route = routeSql;
  app = await buildApp();
  await app.ready();
});

afterAll(async () => {
  await app.close();
  delete process.env.REINS_API_URL;
});

beforeEach(() => {
  tables.clear();
  dbUpdates.length = 0;
  executed.length = 0;
  tables.set('agents', [agentRow]);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

// ── Hermeneutix ──────────────────────────────────────────────────────────────

describe('Hermeneutix instance pinned to one project', () => {
  beforeEach(() => {
    tables.set('credentials', [credRow]);
    tables.set('agent_service_instances', [
      instance({ config: JSON.stringify({ projectId: PINNED, projectName: 'Acme' }) }),
    ]);
  });

  it('lists meetings in the pinned project when none is named', async () => {
    installFetch(() => upstreamJson([{ id: 'm1', name: 'Weekly' }]));

    const res = await callTool('hermeneutix_list_meetings', {});

    expect(res.error).toBeUndefined();
    expect(isToolError(res)).toBe(false);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(String(fetchMock.mock.calls[0][0])).toContain(`/projects/${PINNED}/meetings/`);
    expect(textOf(res)).toContain('Weekly');
  });

  it('refuses another project by id without touching the upstream', async () => {
    installFetch(() => upstreamJson([{ id: 'm-other', name: 'Should not be fetched' }]));

    const res = await callTool('hermeneutix_list_meetings', { project_id: OTHER });

    expect(isToolError(res)).toBe(true);
    expect(textOf(res)).toContain('limited to Hermeneutix project "Acme"');
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("refuses an instance that upstream says belongs to another project, and its payload never reaches the model", async () => {
    installFetch(() => upstreamJson({
      id: 'inst-9',
      meeting_id: 'm-other',
      meeting: { id: 'm-other', name: 'Other', project: { id: OTHER, name: 'Elsewhere' } },
      transcript: SENTINEL,
    }));

    const res = await callTool('hermeneutix_get_meeting_instance', { instance_id: 'inst-9' });

    expect(isToolError(res)).toBe(true);
    expect(textOf(res)).toContain('belongs to another project');
    expect(JSON.stringify(res)).not.toContain(SENTINEL);
  });

  it('returns the instance when upstream reports the pinned project', async () => {
    installFetch((url) =>
      url.includes('/v1/instances/')
        ? upstreamJson({ id: 'inst-1', meeting: { id: 'm1', project: { id: PINNED } }, transcript: SENTINEL })
        : upstreamJson([])
    );

    const res = await callTool('hermeneutix_get_meeting_instance', { instance_id: 'inst-1' });

    expect(isToolError(res)).toBe(false);
    expect(textOf(res)).toContain(SENTINEL);
  });
});

describe('Hermeneutix instance with no project pin', () => {
  it('still requires project_id, as before pins existed', async () => {
    tables.set('credentials', [credRow]);
    tables.set('agent_service_instances', [instance({ config: null })]);
    installFetch(() => upstreamJson([]));

    const res = await callTool('hermeneutix_list_meetings', {});

    expect(isToolError(res)).toBe(true);
    expect(textOf(res)).toContain('project_id is required');
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

// ── Memory ───────────────────────────────────────────────────────────────────

describe('memory tools for an agent granted only the work scope', () => {
  beforeEach(() => {
    // No credential of any kind: memory authenticates with the gateway token,
    // and an empty credentials table keeps the endpoint's auto-heal idle.
    tables.set('credentials', []);
    tables.set('agent_service_instances', [
      instance({ id: 'inst-mem', serviceType: 'memory', credentialId: null, config: null }),
    ]);
    installFetch(() => { throw new Error('memory tools must only call the Reins API'); });
  });

  it('memory_create with no scope lands in the work scope', async () => {
    const res = await callTool('memory_create', { title: 'Sprint notes', content: 'Plan the sprint.' });

    expect(res.error).toBeUndefined();
    expect(isToolError(res)).toBe(false);
    // The handler authenticated with the gateway token the endpoint injected.
    const init = fetchMock.mock.calls[0][1] as RequestInit;
    expect((init.headers as Record<string, string>)['x-reins-agent-secret']).toBe(GATEWAY_TOKEN);
    const inserts = statementsMatching('INSERT INTO memory_entries');
    expect(inserts).toHaveLength(1);
    expect(inserts[0].args).toContain(SCOPE_WORK);
    expect(inserts[0].args).not.toContain(SCOPE_DEFAULT);
  });

  it("memory_create in the owner's default scope is refused, naming the scopes it may use", async () => {
    const res = await callTool('memory_create', { title: 'Sneaky', scope: 'default' });

    expect(isToolError(res)).toBe(true);
    expect(textOf(res)).toContain('not available');
    expect(textOf(res)).toContain('work');
    expect(statementsMatching('INSERT INTO memory_entries')).toEqual([]);
  });

  it('memory_list_scopes shows only work', async () => {
    const res = await callTool('memory_list_scopes', {});

    expect(isToolError(res)).toBe(false);
    const data = JSON.parse(textOf(res)) as { scopes: Array<{ slug: string }> };
    expect(data.scopes.map((s) => s.slug)).toEqual(['work']);
  });

  it('memory_get on an entry in the default scope is not found', async () => {
    const res = await callTool('memory_get', { id: ENTRY_IN_DEFAULT });

    expect(isToolError(res)).toBe(true);
    expect(textOf(res)).toMatch(/not found/i);
  });
});

// ── Drive ────────────────────────────────────────────────────────────────────

describe('Drive tools scoped to one folder', () => {
  /**
   * The fixture tree from servers/src/drive/handlers.test.ts: `file` sits two
   * levels under the granted folder `proj`; `other` sits under its sibling.
   *
   *   root/
   *     proj/          ← granted, read
   *       sub/
   *         file.txt
   *     sibling/
   *       other.txt
   */
  const TREE: Record<string, { name: string; mimeType?: string; parents: string[] }> = {
    root: { name: 'My Drive', parents: [] },
    proj: { name: 'proj', mimeType: 'application/vnd.google-apps.folder', parents: ['root'] },
    sub: { name: 'sub', mimeType: 'application/vnd.google-apps.folder', parents: ['proj'] },
    file: { name: 'file.txt', mimeType: 'text/plain', parents: ['sub'] },
    sibling: { name: 'sibling', mimeType: 'application/vnd.google-apps.folder', parents: ['root'] },
    other: { name: 'other.txt', mimeType: 'text/plain', parents: ['sibling'] },
  };
  const FILE_CONTENT = 'SECRET CONTENT of file.txt';

  const googleCred = { id: 'cred-google', serviceId: 'google', userId: USER, accountEmail: 'me@example.com', grantedServices: null, expiresAt: null };
  const getCalls = () => mockDrive.files.get.mock.calls.map((c) => c[0] as Record<string, unknown>);

  beforeEach(() => {
    vi.clearAllMocks(); // call history only; implementations and resolved values survive
    tables.set('credentials', [googleCred]);
    tables.set('agent_service_instances', [
      instance({ id: 'inst-drive', serviceType: 'drive', credentialId: 'cred-google', config: null }),
      instance({ id: 'inst-gmail', serviceType: 'gmail', credentialId: 'cred-google', config: null }),
    ]);
    driveConfig.current = { defaultLevel: 'blocked', rules: [{ folderId: 'proj', permission: 'read', label: '/proj' }] };
    mockDrive.files.get.mockImplementation((async (params: Record<string, unknown>) => {
      if (params.alt === 'media') return { data: FILE_CONTENT };
      const node = TREE[params.fileId as string];
      if (!node) throw Object.assign(new Error('File not found'), { code: 404 });
      return { data: { id: params.fileId, size: '10', ...node } };
    }) as never);
    // Drive and Gmail never leave googleapis; any fetch here is a bug.
    installFetch(() => { throw new Error('drive tools must not use fetch'); });
  });

  it('reads a file two levels under the granted folder', async () => {
    const res = await callTool('drive_read_file', { fileId: 'file' });

    expect(res.error).toBeUndefined();
    expect(isToolError(res)).toBe(false);
    expect(textOf(res)).toContain(FILE_CONTENT);
    expect(getCalls().some((c) => c.alt === 'media')).toBe(true);
    // The plumbing: the endpoint fetched this agent's rules for the Drive call.
    expect(vi.mocked(getDrivePathConfig)).toHaveBeenCalledWith(AGENT);
  });

  it("refuses a sibling folder's file and never fetches its content", async () => {
    const res = await callTool('drive_read_file', { fileId: 'other' });

    expect(isToolError(res)).toBe(true);
    expect(textOf(res)).toContain('Permission denied');
    expect(textOf(res)).not.toContain(FILE_CONTENT);
    expect(getCalls().some((c) => c.alt === 'media')).toBe(false);
    expect(mockDrive.files.export).not.toHaveBeenCalled();
  });

  it('search returns only the hit under the granted folder and counts what it dropped', async () => {
    mockDrive.files.list.mockResolvedValueOnce({
      data: {
        files: [
          { id: 'file', name: 'file.txt', parents: ['sub'] },
          { id: 'other', name: 'other.txt', parents: ['sibling'] },
        ],
      },
    } as never);

    const res = await callTool('drive_search', { query: "name contains 'txt'" });

    expect(isToolError(res)).toBe(false);
    const data = JSON.parse(textOf(res)) as { files: Array<{ id: string }>; filtered_count: number };
    expect(data.files.map((f) => f.id)).toEqual(['file']);
    expect(data.filtered_count).toBe(1);
    expect(textOf(res)).not.toContain('other.txt');
  });

  it('refuses to create under a read-only folder, and says no folder is writable', async () => {
    const res = await callTool('drive_create_file', { name: 'x.txt', parentId: 'sub', content: 'hello' });

    expect(isToolError(res)).toBe(true);
    expect(textOf(res)).toContain('Permission denied');
    expect(textOf(res)).toContain('No folder is writable for this agent.');
    expect(mockDrive.files.create).not.toHaveBeenCalled();
  });

  it('a root listing under a blocked default returns the granted folder itself, not the drive', async () => {
    const res = await callTool('drive_list_files', {});

    expect(isToolError(res)).toBe(false);
    const data = JSON.parse(textOf(res)) as { files: Array<{ id: string }>; note: string };
    expect(data.files.map((f) => f.id)).toEqual(['proj']);
    expect(data.note).toMatch(/granted/i);
    expect(mockDrive.files.list).not.toHaveBeenCalled();
  });

  it('gmail_create_draft cannot launder a refused Drive file through an attachment', async () => {
    const res = await callTool('gmail_create_draft', {
      to: 'someone@example.com',
      subject: 'Here is the file',
      body: 'Attached.',
      attachments: [{ source: 'drive', fileId: 'other' }],
    });

    expect(isToolError(res)).toBe(true);
    expect(textOf(res)).toMatch(/permission denied/i);
    expect(textOf(res)).toContain('other.txt');
    expect(mockGmail.users.drafts.create).not.toHaveBeenCalled();
    expect(getCalls().some((c) => c.alt === 'media')).toBe(false);
    // Gmail gets the same folder rules, or the attachment path would be a bypass.
    expect(vi.mocked(getDrivePathConfig)).toHaveBeenCalledWith(AGENT);
  });
});
