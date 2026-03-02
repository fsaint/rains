/**
 * Service Discovery
 *
 * Enables agents to discover what services and tools are available to them
 * based on their policy and credentials.
 */

import { client } from '../db/index.js';
import { policyEngine } from '../policy/engine.js';
import { serverManager, type NativeServerType } from '../mcp/server-manager.js';
import type { ParsedPolicy } from '@reins/shared';

/**
 * Service status for an agent
 */
export interface AgentService {
  /** Service type (gmail, drive, calendar, web-search, browser) */
  serviceType: NativeServerType;
  /** Human-readable name */
  name: string;
  /** Whether the service is available (server registered) */
  available: boolean;
  /** Credential status */
  credentialStatus: 'connected' | 'needs_auth' | 'missing' | 'expired';
  /** Credential ID if exists */
  credentialId?: string;
  /** Number of tools available after policy filtering */
  toolCount: number;
  /** Whether any tools require approval */
  hasApprovalRequired: boolean;
}

/**
 * Tool available to an agent
 */
export interface AgentTool {
  /** Tool name */
  name: string;
  /** Tool description */
  description: string;
  /** Which service provides this tool */
  serviceType: NativeServerType;
  /** Whether this tool requires approval */
  requiresApproval: boolean;
  /** Tool input schema */
  inputSchema: Record<string, unknown>;
}

/**
 * Get agent's parsed policy
 */
async function getAgentPolicy(agentId: string): Promise<ParsedPolicy | null> {
  // Get agent with policy
  const agentResult = await client.execute({
    sql: `SELECT a.*, p.yaml as policy_yaml
          FROM agents a
          LEFT JOIN policies p ON a.policy_id = p.id
          WHERE a.id = ?`,
    args: [agentId],
  });

  if (agentResult.rows.length === 0) {
    return null;
  }

  const policyYaml = agentResult.rows[0].policy_yaml as string | null;
  if (!policyYaml) {
    return null;
  }

  const parsed = policyEngine.parsePolicy(policyYaml);
  return parsed.valid ? parsed.parsed! : null;
}

/**
 * Get credentials linked to an agent
 */
async function getAgentCredentials(agentId: string): Promise<Map<string, { id: string; type: string; expiresAt?: string }>> {
  const result = await client.execute({
    sql: `SELECT c.id, c.service_id, c.type, c.expires_at
          FROM credentials c
          JOIN agent_credentials ac ON c.id = ac.credential_id
          WHERE ac.agent_id = ?`,
    args: [agentId],
  });

  const map = new Map<string, { id: string; type: string; expiresAt?: string }>();
  for (const row of result.rows) {
    map.set(row.service_id as string, {
      id: row.id as string,
      type: row.type as string,
      expiresAt: row.expires_at as string | undefined,
    });
  }
  return map;
}

/**
 * Determine credential status for a service
 */
function getCredentialStatus(
  serviceType: NativeServerType,
  credentials: Map<string, { id: string; type: string; expiresAt?: string }>
): { status: AgentService['credentialStatus']; credentialId?: string } {
  const cred = credentials.get(serviceType);

  if (!cred) {
    // Some services don't need credentials (browser)
    if (serviceType === 'browser') {
      return { status: 'connected' };
    }
    return { status: 'missing' };
  }

  // Check if expired
  if (cred.expiresAt) {
    const expiresAt = new Date(cred.expiresAt);
    if (expiresAt < new Date()) {
      return { status: 'expired', credentialId: cred.id };
    }
  }

  // OAuth credentials might need authorization
  if (cred.type === 'oauth2') {
    // Would need to check if tokens are actually present
    // For now, assume connected if credential exists
    return { status: 'connected', credentialId: cred.id };
  }

  return { status: 'connected', credentialId: cred.id };
}

/**
 * Discover services available to an agent
 */
export async function discoverServicesForAgent(agentId: string): Promise<AgentService[] | null> {
  const policy = await getAgentPolicy(agentId);
  if (!policy) {
    return null;
  }

  const credentials = await getAgentCredentials(agentId);
  const services: AgentService[] = [];

  // Get all registered server types
  const serverTypes = serverManager.getServerTypes();

  // Also check policy for services that might not have servers registered yet
  const policyServices = Object.keys(policy.services) as NativeServerType[];
  const allServiceTypes = [...new Set([...serverTypes, ...policyServices])];

  for (const serviceType of allServiceTypes) {
    const server = serverManager.getServer(serviceType);
    const available = !!server;

    // Get filtered tools for this service
    const tools = available
      ? serverManager.getServerTools(serviceType, policy)
      : [];

    const { status, credentialId } = getCredentialStatus(serviceType, credentials);

    const hasApprovalRequired = tools.some((t) => {
      const decision = policyEngine.evaluateTool(t.name, serviceType, policy);
      return decision.action === 'require_approval';
    });

    services.push({
      serviceType,
      name: server?.name ?? serviceType,
      available,
      credentialStatus: status,
      credentialId,
      toolCount: tools.length,
      hasApprovalRequired,
    });
  }

  return services;
}

/**
 * Discover tools available to an agent
 */
export async function discoverToolsForAgent(agentId: string): Promise<AgentTool[] | null> {
  const policy = await getAgentPolicy(agentId);
  if (!policy) {
    return null;
  }

  const tools: AgentTool[] = [];

  // Get tools from all registered servers
  const filteredByServer = serverManager.getFilteredTools(policy);

  for (const { serverType, tools: serverTools } of filteredByServer) {
    for (const tool of serverTools) {
      const decision = policyEngine.evaluateTool(tool.name, serverType, policy);

      tools.push({
        name: tool.name,
        description: tool.description,
        serviceType: serverType,
        requiresApproval: decision.action === 'require_approval',
        inputSchema: tool.inputSchema as Record<string, unknown>,
      });
    }
  }

  return tools;
}

/**
 * Get tools for a specific service for an agent
 */
export async function discoverServiceToolsForAgent(
  agentId: string,
  serviceType: NativeServerType
): Promise<AgentTool[] | null> {
  const policy = await getAgentPolicy(agentId);
  if (!policy) {
    return null;
  }

  const serverTools = serverManager.getServerTools(serviceType, policy);

  return serverTools.map((tool) => {
    const decision = policyEngine.evaluateTool(tool.name, serviceType, policy);
    return {
      name: tool.name,
      description: tool.description,
      serviceType,
      requiresApproval: decision.action === 'require_approval',
      inputSchema: tool.inputSchema as Record<string, unknown>,
    };
  });
}
