/**
 * The root MCP endpoint's JSON-RPC surface.
 *
 * Two things are worth testing beyond the happy path. The subject always comes
 * from the verified token, never the request, or the endpoint would answer for
 * whoever was named in the body. And the tool surface stays closed: anything
 * other than the one listing tool is refused rather than quietly ignored.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

const { mockExecute } = vi.hoisted(() => ({ mockExecute: vi.fn() }));

vi.mock('../db/index.js', () => ({ client: { execute: mockExecute } }));
vi.mock('../config/index.js', () => ({
  config: { publicUrl: 'https://app.helm.mom', dashboardUrl: 'https://dash.example.com' },
}));

import { handleRootMcpRequest, listAgentsForUser, LIST_AGENTS_TOOL } from './root-endpoint.js';

const USER = 'user-1';

const AGENTS = [
  { id: 'agent-work', name: 'Work', description: 'Email and calendar', allow_unauthenticated: false },
  { id: 'agent-home', name: 'Home', description: null, allow_unauthenticated: true },
];

const SERVICES = [
  { agent_id: 'agent-work', service_type: 'gmail' },
  { agent_id: 'agent-work', service_type: 'memory' },
  { agent_id: 'agent-home', service_type: 'memory' },
];

/** Answer the agents query and the services query; everything else is empty. */
function wireDb(agents: unknown[] = AGENTS, services: unknown[] = SERVICES) {
  const queries: string[] = [];
  mockExecute.mockImplementation(async (q: any) => {
    const sql: string = typeof q === 'string' ? q : q.sql;
    queries.push(sql);
    const rows = (r: unknown[]) => ({ rows: r, rowsAffected: r.length, columns: [] });
    if (/FROM agents/i.test(sql) && !/agent_service_instances/i.test(sql)) return rows(agents);
    if (/agent_service_instances/i.test(sql)) return rows(services);
    return rows([]);
  });
  return queries;
}

const call = (method: string, params?: Record<string, unknown>) =>
  handleRootMcpRequest(USER, { jsonrpc: '2.0', id: 1, method, params } as never);

const payload = (result: any) => JSON.parse(result.content[0].text);

beforeEach(() => {
  vi.clearAllMocks();
  wireDb();
});

describe('listAgentsForUser', () => {
  it('gives each agent its own MCP address', async () => {
    const agents = await listAgentsForUser(USER);

    // Order is the query's (ORDER BY name); the fixture returns rows as-is.
    expect(agents.map((a) => a.mcp_url)).toEqual([
      'https://app.helm.mom/mcp/agent-work',
      'https://app.helm.mom/mcp/agent-home',
    ]);
  });

  it('orders by name in the query rather than in memory', async () => {
    const queries = wireDb();
    await listAgentsForUser(USER);

    expect(queries[0]).toMatch(/ORDER BY name/);
  });

  it('attaches each agent its own services and no one else\'s', async () => {
    const agents = await listAgentsForUser(USER);
    const work = agents.find((a) => a.id === 'agent-work')!;
    const home = agents.find((a) => a.id === 'agent-home')!;

    expect(work.services).toEqual(['gmail', 'memory']);
    expect(home.services).toEqual(['memory']);
  });

  /** A client needs to know which agents it must authorize separately. */
  it('says which agents need a token of their own', async () => {
    const agents = await listAgentsForUser(USER);

    expect(agents.find((a) => a.id === 'agent-work')!.requires_token).toBe(true);
    expect(agents.find((a) => a.id === 'agent-home')!.requires_token).toBe(false);
  });

  it('scopes both queries to the caller', async () => {
    mockExecute.mockImplementation(async (q: any) => {
      const sql: string = typeof q === 'string' ? q : q.sql;
      expect(q.args).toContain(USER);
      const rows = (r: unknown[]) => ({ rows: r, rowsAffected: r.length, columns: [] });
      return /agent_service_instances/i.test(sql) ? rows(SERVICES) : rows(AGENTS);
    });

    await listAgentsForUser(USER);
    expect(mockExecute).toHaveBeenCalledTimes(2);
  });

  it('leaves out deleted agents', async () => {
    const queries = wireDb();
    await listAgentsForUser(USER);

    expect(queries[0]).toMatch(/status <> 'deleted'/);
  });

  it('asks nothing further when the user has no agents', async () => {
    wireDb([], []);

    expect(await listAgentsForUser(USER)).toEqual([]);
    // The services query is pointless with no agents, so it is not made.
    expect(mockExecute).toHaveBeenCalledTimes(1);
  });

  it('reports an agent with no services as an empty list, not a missing field', async () => {
    wireDb(AGENTS, []);

    const agents = await listAgentsForUser(USER);
    expect(agents.every((a) => Array.isArray(a.services) && a.services.length === 0)).toBe(true);
  });
});

describe('handleRootMcpRequest', () => {
  it('introduces itself as the root server, not an agent', async () => {
    const res: any = await call('initialize', { protocolVersion: '2025-06-18' });

    expect(res.result.serverInfo.name).toBe('helm-root');
    expect(res.result.protocolVersion).toBe('2025-06-18');
  });

  /** The client should not have to guess that this endpoint cannot act. */
  it('says in its instructions that an agent needs its own authorization', async () => {
    const res: any = await call('initialize');

    expect(res.result.instructions).toMatch(/own authorization/i);
    expect(res.result.instructions).toContain(LIST_AGENTS_TOOL);
  });

  it('offers exactly one tool', async () => {
    const res: any = await call('tools/list');

    expect(res.result.tools.map((t: any) => t.name)).toEqual([LIST_AGENTS_TOOL]);
    expect(res.result.tools[0].inputSchema.required).toEqual([]);
  });

  it('answers the listing with the agents and a count', async () => {
    const res: any = await call('tools/call', { name: LIST_AGENTS_TOOL, arguments: {} });

    const body = payload(res.result);
    expect(body.count).toBe(2);
    expect(body.agents.map((a: any) => a.name).sort()).toEqual(['Home', 'Work']);
  });

  /** The surface is closed: an unknown name is an error, not an empty answer. */
  it('refuses any other tool by name', async () => {
    const res: any = await call('tools/call', { name: 'gmail_send_message', arguments: {} });

    expect(res.error.code).toBe(-32602);
    expect(res.error.message).toContain('gmail_send_message');
    expect(mockExecute).not.toHaveBeenCalled();
  });

  it('refuses a call with no tool name', async () => {
    const res: any = await call('tools/call', {});

    expect(res.error.message).toMatch(/missing required parameter/i);
  });

  it('answers ping and the initialized notification', async () => {
    expect((await call('ping') as any).result).toEqual({});
    expect((await call('notifications/initialized') as any).result).toEqual({});
  });

  it('reports an unknown method rather than failing silently', async () => {
    const res: any = await call('resources/list');

    expect(res.error.code).toBe(-32601);
    expect(res.error.message).toContain('resources/list');
  });

  /**
   * The subject comes from the token. A body naming another user must change
   * nothing, or the endpoint would answer for whoever asked.
   */
  it('ignores any user named in the request itself', async () => {
    mockExecute.mockImplementation(async (q: any) => {
      expect(q.args).toEqual([USER]);
      const sql: string = typeof q === 'string' ? q : q.sql;
      const rows = (r: unknown[]) => ({ rows: r, rowsAffected: r.length, columns: [] });
      return /agent_service_instances/i.test(sql) ? rows(SERVICES) : rows(AGENTS);
    });

    await handleRootMcpRequest(USER, {
      jsonrpc: '2.0',
      id: 1,
      method: 'tools/call',
      params: { name: LIST_AGENTS_TOOL, arguments: { userId: 'someone-else' } },
    } as never);

    expect(mockExecute).toHaveBeenCalledTimes(2);
  });
});
