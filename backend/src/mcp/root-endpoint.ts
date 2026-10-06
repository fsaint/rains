/**
 * The root MCP endpoint: one URL, the same for everyone, whose only job is to
 * tell a client which agents the signed-in user has and where each one lives.
 *
 * Every other MCP URL in Helm carries an agent id, which means a client has to
 * be told that id out of band before it can connect to anything. This endpoint
 * is the fixed address that answers "what is there?" — the client connects once
 * to `/mcp`, reads the list, and connects to the agents it needs.
 *
 * It is deliberately the smallest useful surface. It lists; it does not act.
 * There is no tool here that touches a connected service, and no way to reach
 * an agent through it — an agent still requires its own token. The reason is
 * that a credential which could both enumerate and act would be a master key
 * for the account, which is precisely what the per-agent scoping exists to
 * prevent (see the header of mcp/oauth/routes.ts).
 *
 * Authentication is in api/routes.ts: a root token is one whose `agentId` is
 * null, and that endpoint refuses any other kind.
 */

import { client } from '../db/index.js';
import { config } from '../config/index.js';
import type { MCPRequest, MCPResponse, MCPToolSchema } from './agent-endpoint.js';

/** What the server calls itself to a client. Distinct from the agent servers. */
const ROOT_SERVER_NAME = 'helm-root';

export const LIST_AGENTS_TOOL = 'helm_list_agents';

const MCP_ERRORS = {
  METHOD_NOT_FOUND: -32601,
  INVALID_PARAMS: -32602,
} as const;

const TOOLS: MCPToolSchema[] = [
  {
    name: LIST_AGENTS_TOOL,
    description:
      'List the Helm agents on this account, with the MCP address of each. Use this to ' +
      'discover what is available before connecting to a specific agent. Each agent has ' +
      'its own services and its own credentials, so reaching one means connecting to its ' +
      'mcp_url separately — this endpoint cannot act on your behalf through any of them.',
    inputSchema: { type: 'object', properties: {}, required: [] },
  },
];

export interface RootAgentSummary {
  id: string;
  name: string;
  description: string | null;
  mcp_url: string;
  services: string[];
  /** False only where the owner has deliberately opened the agent. */
  requires_token: boolean;
}

function baseUrl(): string {
  return (config.publicUrl || config.dashboardUrl || '').replace(/\/+$/, '');
}

/**
 * The agents this user owns, each with its services.
 *
 * One query for the agents and one for the services, joined in memory rather
 * than with an aggregate: the row counts here are per-account and tiny, and a
 * second round trip costs less than a GROUP BY that every reader has to decode.
 */
export async function listAgentsForUser(userId: string): Promise<RootAgentSummary[]> {
  const agents = await client.execute({
    sql: `SELECT id, name, description, allow_unauthenticated
          FROM agents
          WHERE user_id = ? AND status <> 'deleted'
          ORDER BY name`,
    args: [userId],
  });
  if (agents.rows.length === 0) return [];

  const services = await client.execute({
    sql: `SELECT DISTINCT asi.agent_id, asi.service_type
          FROM agent_service_instances asi
          JOIN agents a ON a.id = asi.agent_id
          WHERE a.user_id = ? AND asi.enabled = true
          ORDER BY asi.service_type`,
    args: [userId],
  });

  const byAgent = new Map<string, string[]>();
  for (const row of services.rows) {
    const id = row.agent_id as string;
    const list = byAgent.get(id) ?? [];
    list.push(row.service_type as string);
    byAgent.set(id, list);
  }

  const base = baseUrl();
  return agents.rows.map((row) => ({
    id: row.id as string,
    name: row.name as string,
    description: (row.description as string | null) ?? null,
    mcp_url: `${base}/mcp/${row.id as string}`,
    services: byAgent.get(row.id as string) ?? [],
    requires_token: row.allow_unauthenticated !== true,
  }));
}

/**
 * Handle one JSON-RPC request against the root endpoint.
 *
 * `userId` comes from the verified root token, never from the request body —
 * the whole surface is "this user's agents", so taking the subject from input
 * would make it "anyone's agents".
 */
export async function handleRootMcpRequest(
  userId: string,
  request: MCPRequest
): Promise<MCPResponse> {
  switch (request.method) {
    case 'initialize':
      return {
        jsonrpc: '2.0',
        id: request.id,
        result: {
          protocolVersion: request.params?.protocolVersion ?? '2024-11-05',
          capabilities: { tools: { listChanged: false } },
          serverInfo: { name: ROOT_SERVER_NAME, version: '1.0.0' },
          instructions:
            'This endpoint lists the agents on this Helm account and nothing else. ' +
            `Call ${LIST_AGENTS_TOOL} to see them, then connect to an agent's mcp_url ` +
            'to use its tools. Each agent needs its own authorization.',
        },
      };

    case 'notifications/initialized':
    case 'ping':
      return { jsonrpc: '2.0', id: request.id, result: {} };

    case 'tools/list':
      return { jsonrpc: '2.0', id: request.id, result: { tools: TOOLS } };

    case 'tools/call': {
      const name = request.params?.name;
      if (name !== LIST_AGENTS_TOOL) {
        return {
          jsonrpc: '2.0',
          id: request.id,
          error: {
            code: MCP_ERRORS.INVALID_PARAMS,
            message: name
              ? `Unknown tool: ${name}. This endpoint provides only ${LIST_AGENTS_TOOL}.`
              : 'Missing required parameter: name',
          },
        };
      }

      const agents = await listAgentsForUser(userId);
      return {
        jsonrpc: '2.0',
        id: request.id,
        result: {
          content: [{ type: 'text', text: JSON.stringify({ agents, count: agents.length }) }],
        },
      };
    }

    default:
      return {
        jsonrpc: '2.0',
        id: request.id,
        error: {
          code: MCP_ERRORS.METHOD_NOT_FOUND,
          message: `Method not found: ${request.method}`,
        },
      };
  }
}
