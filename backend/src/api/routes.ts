import { FastifyInstance, FastifyPluginAsync } from 'fastify';
import { config } from '../config/index.js';
import { client } from '../db/index.js';
import { policyEngine } from '../policy/engine.js';
import { credentialVault } from '../credentials/vault.js';
import { approvalQueue } from '../approvals/queue.js';
import { auditLogger } from '../audit/logger.js';
import { mcpProxy } from '../mcp/proxy.js';
import { serverManager } from '../mcp/server-manager.js';
import { apnsService } from '../notifications/apns.js';
import {
  discoverServicesForAgent,
  discoverToolsForAgent,
  discoverServiceToolsForAgent,
} from '../services/discovery.js';
import {
  getPermissionMatrix,
  getAgentServiceConfig,
  setServiceAccess,
  linkCredential,
  autoLinkCredential,
  unlinkCredential,
  setToolPermission,
  resetToolPermission,
  setServiceToolPermissions,
  getCredentialsForService,
  setPermissionLevel,
  getPermissionLevel,
  addServiceCredential,
  removeServiceCredential,
  setDefaultCredential,
  getLinkedCredentials,
  // Instance-based functions
  getAgentPermissions,
  createServiceInstance,
  getInstanceConfig,
  updateServiceInstance,
  deleteServiceInstance,
  setInstancePermissionLevel,
  setInstanceToolPermission,
  resetInstanceToolPermission,
  type ToolPermission,
  type PermissionLevel,
} from '../services/permissions.js';
import {
  registerAgent,
  claimAgent,
  getRegistrationStatus,
  listPendingRegistrations,
  cancelRegistration,
} from '../services/registration.js';
import {
  storePendingOAuthFlow,
  getPendingOAuthFlow,
  deletePendingOAuthFlow,
} from '../oauth/pending-flows.js';
import { handleMCPRequest, type MCPRequest } from '../mcp/agent-endpoint.js';
import { getSession, type SessionPayload } from '../auth/index.js';
import * as provider from '../providers/index.js';
import { nanoid } from 'nanoid';
import {
  CreateAgentSchema,
  UpdateAgentSchema,
  CreatePolicySchema,
  UpdatePolicySchema,
  CreateCredentialSchema,
  ApprovalDecisionSchema,
  AuditFilterSchema,
} from '@reins/shared';

export const apiRoutes: FastifyPluginAsync = async (app: FastifyInstance) => {
  // Helper to get userId from authenticated request
  function getUserId(request: any): string {
    return (request.session as SessionPayload).userId;
  }

  // In-memory store for OpenAI device flows (short-lived, ~5 min)
  const deviceFlows = new Map<string, { userCode: string; deviceCode: string; verificationUrl: string; interval: number; expiresAt: number; tokens?: string }>();

  // ========================================================================
  // Health check
  // ========================================================================

  app.get('/health', async () => {
    return { status: 'ok', timestamp: new Date().toISOString() };
  });

  // ========================================================================
  // Agents
  // ========================================================================

  app.get('/api/agents', async (request) => {
    const userId = getUserId(request);
    const result = await client.execute({
      sql: `SELECT * FROM agents WHERE user_id = ?`,
      args: [userId],
    });

    const agentsWithCredentials = await Promise.all(
      result.rows.map(async (agent) => {
        const credsResult = await client.execute({
          sql: `SELECT credential_id FROM agent_credentials WHERE agent_id = ?`,
          args: [agent.id as string],
        });

        return {
          id: agent.id,
          name: agent.name,
          description: agent.description,
          policyId: agent.policy_id,
          status: agent.status,
          credentials: credsResult.rows.map((c) => c.credential_id),
          createdAt: agent.created_at,
          updatedAt: agent.updated_at,
        };
      })
    );

    return { data: agentsWithCredentials };
  });

  app.get<{ Params: { id: string } }>('/api/agents/:id', async (request, reply) => {
    const { id } = request.params;
    const userId = getUserId(request);

    const result = await client.execute({
      sql: `SELECT * FROM agents WHERE id = ? AND user_id = ?`,
      args: [id, userId],
    });

    if (result.rows.length === 0) {
      return reply.code(404).send({ error: { code: 'NOT_FOUND', message: 'Agent not found' } });
    }

    const agent = result.rows[0];
    const credsResult = await client.execute({
      sql: `SELECT credential_id FROM agent_credentials WHERE agent_id = ?`,
      args: [id],
    });

    return {
      data: {
        id: agent.id,
        name: agent.name,
        description: agent.description,
        policyId: agent.policy_id,
        status: agent.status,
        credentials: credsResult.rows.map((c) => c.credential_id),
        createdAt: agent.created_at,
        updatedAt: agent.updated_at,
      },
    };
  });

  // Connection prompt for an agent
  app.get<{ Params: { id: string } }>('/api/agents/:id/connect-prompt', async (request, reply) => {
    const { id } = request.params;
    const userId = getUserId(request);

    const result = await client.execute({
      sql: `SELECT * FROM agents WHERE id = ? AND user_id = ?`,
      args: [id, userId],
    });

    if (result.rows.length === 0) {
      return reply.code(404).send({ error: { code: 'NOT_FOUND', message: 'Agent not found' } });
    }

    const agent = result.rows[0];

    // Get enabled services for this agent
    const servicesResult = await client.execute({
      sql: `SELECT service_type, enabled FROM agent_service_access WHERE agent_id = ?`,
      args: [id],
    });
    const enabledServices = servicesResult.rows
      .filter((r) => r.enabled)
      .map((r) => r.service_type as string);

    // Build the MCP endpoint URL using the dashboard URL as the base
    const mcpUrl = `${config.dashboardUrl}/mcp/${id}`;

    // Build the prompt
    const servicesList = enabledServices.length > 0
      ? enabledServices.join(', ')
      : 'none configured yet';

    const prompt = [
      `You have access to an MCP tool server managed by Reins.`,
      ``,
      `Endpoint: ${mcpUrl}`,
      `Agent: ${agent.name}${agent.description ? ` - ${agent.description}` : ''}`,
      `Enabled services: ${servicesList}`,
      ``,
      `To discover available tools, send a JSON-RPC 2.0 request:`,
      ``,
      `POST ${mcpUrl}`,
      `Content-Type: application/json`,
      ``,
      `{"jsonrpc":"2.0","id":1,"method":"tools/list"}`,
      ``,
      `To call a tool:`,
      ``,
      `POST ${mcpUrl}`,
      `Content-Type: application/json`,
      ``,
      `{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":"<tool_name>","arguments":{...}}}`,
      ``,
      `Some tools may require approval before execution. If so, the request will block until a human approves it in the Reins dashboard.`,
    ].join('\n');

    // MCP JSON config snippets for different clients
    const claudeCodeConfig = {
      "mcpServers": {
        [`reins-${(agent.name as string).toLowerCase().replace(/[^a-z0-9]+/g, '-')}`]: {
          "type": "url",
          "url": mcpUrl,
        },
      },
    };

    const openaiClawConfig = {
      "mcpServers": [
        {
          "name": `reins-${(agent.name as string).toLowerCase().replace(/[^a-z0-9]+/g, '-')}`,
          "type": "url",
          "url": mcpUrl,
        },
      ],
    };

    return {
      data: {
        prompt,
        mcpUrl,
        agentName: agent.name,
        enabledServices,
        claudeCodeConfig,
        openaiClawConfig,
      },
    };
  });

  app.post('/api/agents', async (request, reply) => {
    const parsed = CreateAgentSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: { code: 'VALIDATION_ERROR', message: parsed.error.message } });
    }

    const userId = getUserId(request);
    const id = nanoid();
    const now = new Date().toISOString();

    await client.execute({
      sql: `INSERT INTO agents (id, user_id, name, description, policy_id, status, created_at, updated_at)
            VALUES (?, ?, ?, ?, ?, 'pending', ?, ?)`,
      args: [id, userId, parsed.data.name, parsed.data.description ?? null, parsed.data.policyId ?? null, now, now],
    });

    const result = await client.execute({
      sql: `SELECT * FROM agents WHERE id = ?`,
      args: [id],
    });

    await auditLogger.logAgentEvent(id, 'created', { name: parsed.data.name });

    return reply.code(201).send({ data: result.rows[0] });
  });

  app.patch<{ Params: { id: string } }>('/api/agents/:id', async (request, reply) => {
    const { id } = request.params;
    const userId = getUserId(request);
    const parsed = UpdateAgentSchema.safeParse(request.body);

    if (!parsed.success) {
      return reply.code(400).send({ error: { code: 'VALIDATION_ERROR', message: parsed.error.message } });
    }

    const updates: string[] = ['updated_at = ?'];
    const args: (string | null)[] = [new Date().toISOString()];

    if (parsed.data.name) {
      updates.push('name = ?');
      args.push(parsed.data.name);
    }
    if (parsed.data.description !== undefined) {
      updates.push('description = ?');
      args.push(parsed.data.description ?? null);
    }
    if (parsed.data.policyId) {
      updates.push('policy_id = ?');
      args.push(parsed.data.policyId);
    }
    if (parsed.data.status) {
      updates.push('status = ?');
      args.push(parsed.data.status);
    }

    args.push(id);
    args.push(userId);

    await client.execute({
      sql: `UPDATE agents SET ${updates.join(', ')} WHERE id = ? AND user_id = ?`,
      args,
    });

    const result = await client.execute({
      sql: `SELECT * FROM agents WHERE id = ? AND user_id = ?`,
      args: [id, userId],
    });

    if (result.rows.length === 0) {
      return reply.code(404).send({ error: { code: 'NOT_FOUND', message: 'Agent not found' } });
    }

    return { data: result.rows[0] };
  });

  app.delete<{ Params: { id: string } }>('/api/agents/:id', async (request, reply) => {
    const { id } = request.params;
    const userId = getUserId(request);

    // Verify ownership
    const check = await client.execute({
      sql: `SELECT id FROM agents WHERE id = ? AND user_id = ?`,
      args: [id, userId],
    });
    if (check.rows.length === 0) {
      return reply.code(404).send({ error: { code: 'NOT_FOUND', message: 'Agent not found' } });
    }

    await mcpProxy.disconnectAgent(id);
    await client.execute({
      sql: `DELETE FROM agent_credentials WHERE agent_id = ?`,
      args: [id],
    });
    await client.execute({
      sql: `DELETE FROM agents WHERE id = ?`,
      args: [id],
    });

    await auditLogger.logAgentEvent(id, 'deleted');

    return reply.code(204).send();
  });

  // ========================================================================
  // Agent Self-Registration
  // ========================================================================

  /**
   * Register a new agent (called by agent)
   * Returns a claim code and URL that the user can click to activate the agent
   */
  app.post<{ Body: { name: string; description?: string } }>(
    '/api/agents/register',
    async (request, reply) => {
      const { name, description } = request.body;

      if (!name || typeof name !== 'string' || name.length < 1) {
        return reply.code(400).send({
          error: { code: 'VALIDATION_ERROR', message: 'name is required' },
        });
      }

      const result = await registerAgent(name, description);

      await auditLogger.logAgentEvent(result.agentId, 'registered', { name, description });

      // Build claim URL using config
      const claimUrl = `${config.dashboardUrl}/claim/${result.claimCode}`;

      return reply.code(201).send({
        data: {
          agentId: result.agentId,
          claimCode: result.claimCode,
          claimUrl,
          expiresAt: result.expiresAt,
          expiresInSeconds: result.expiresInSeconds,
          instructions: `Share this link with your user to complete registration: ${claimUrl} (expires in 10 minutes). Alternatively, they can enter code ${result.claimCode} in the Reins dashboard.`,
        },
      });
    }
  );

  /**
   * Check registration status (called by agent polling)
   */
  app.get<{ Params: { id: string } }>(
    '/api/agents/:id/registration-status',
    async (request, reply) => {
      const { id } = request.params;
      const status = await getRegistrationStatus(id);

      if (status.status === 'not_found') {
        return reply.code(404).send({
          error: { code: 'NOT_FOUND', message: 'Registration not found' },
        });
      }

      return { data: status };
    }
  );

  /**
   * Claim an agent by code (called by user in dashboard)
   */
  app.post<{ Body: { code: string } }>('/api/agents/claim', async (request, reply) => {
    const { code } = request.body;
    const userId = getUserId(request);

    if (!code || typeof code !== 'string') {
      return reply.code(400).send({
        error: { code: 'VALIDATION_ERROR', message: 'code is required' },
      });
    }

    const agent = await claimAgent(code, userId);

    if (!agent) {
      return reply.code(404).send({
        error: { code: 'INVALID_CODE', message: 'Invalid or expired claim code' },
      });
    }

    await auditLogger.logAgentEvent(agent.id, 'claimed', { name: agent.name });

    return reply.code(201).send({ data: agent });
  });

  /**
   * List pending registrations (admin view)
   */
  app.get('/api/agents/pending', async (request) => {
    const userId = getUserId(request);
    const pending = await listPendingRegistrations(userId);
    return { data: pending };
  });

  /**
   * Cancel a pending registration
   */
  app.delete<{ Params: { id: string } }>(
    '/api/agents/pending/:id',
    async (request, reply) => {
      const { id } = request.params;
      const cancelled = await cancelRegistration(id);

      if (!cancelled) {
        return reply.code(404).send({
          error: { code: 'NOT_FOUND', message: 'Pending registration not found' },
        });
      }

      return reply.code(204).send();
    }
  );

  // ========================================================================
  // Agent Service Discovery
  // ========================================================================

  /**
   * Discover services available to an agent
   * Returns list of services with their availability and credential status
   */
  app.get<{ Params: { id: string } }>('/api/agents/:id/services', async (request, reply) => {
    const { id } = request.params;

    const services = await discoverServicesForAgent(id);
    if (!services) {
      return reply.code(404).send({
        error: { code: 'NOT_FOUND', message: 'Agent not found or has no policy' },
      });
    }

    return { data: services };
  });

  /**
   * Discover all tools available to an agent across all services
   */
  app.get<{ Params: { id: string } }>('/api/agents/:id/tools', async (request, reply) => {
    const { id } = request.params;

    const tools = await discoverToolsForAgent(id);
    if (!tools) {
      return reply.code(404).send({
        error: { code: 'NOT_FOUND', message: 'Agent not found or has no policy' },
      });
    }

    return { data: tools };
  });

  /**
   * Discover tools for a specific service for an agent
   */
  app.get<{ Params: { id: string; serviceType: string } }>(
    '/api/agents/:id/services/:serviceType/tools',
    async (request, reply) => {
      const { id, serviceType } = request.params;

      const validTypes = validServiceTypes;
      if (!validTypes.includes(serviceType)) {
        return reply.code(400).send({
          error: { code: 'INVALID_SERVICE', message: `Invalid service type: ${serviceType}` },
        });
      }

      const tools = await discoverServiceToolsForAgent(id, serviceType);
      if (!tools) {
        return reply.code(404).send({
          error: { code: 'NOT_FOUND', message: 'Agent not found or has no policy' },
        });
      }

      return { data: tools };
    }
  );

  /**
   * Link a credential to an agent
   */
  app.post<{ Params: { id: string }; Body: { credentialId: string } }>(
    '/api/agents/:id/credentials',
    async (request, reply) => {
      const { id } = request.params;
      const { credentialId } = request.body;

      // Verify agent exists
      const agentResult = await client.execute({
        sql: `SELECT id FROM agents WHERE id = ?`,
        args: [id],
      });
      if (agentResult.rows.length === 0) {
        return reply.code(404).send({
          error: { code: 'NOT_FOUND', message: 'Agent not found' },
        });
      }

      // Verify credential exists
      const credential = await credentialVault.retrieve(credentialId);
      if (!credential) {
        return reply.code(404).send({
          error: { code: 'NOT_FOUND', message: 'Credential not found' },
        });
      }

      // Link credential to agent
      await client.execute({
        sql: `INSERT INTO agent_credentials (agent_id, credential_id) VALUES (?, ?) ON CONFLICT DO NOTHING`,
        args: [id, credentialId],
      });

      return reply.code(201).send({
        data: { agentId: id, credentialId, serviceId: credential.serviceId },
      });
    }
  );

  /**
   * Unlink a credential from an agent
   */
  app.delete<{ Params: { id: string; credentialId: string } }>(
    '/api/agents/:id/credentials/:credentialId',
    async (request, reply) => {
      const { id, credentialId } = request.params;

      await client.execute({
        sql: `DELETE FROM agent_credentials WHERE agent_id = ? AND credential_id = ?`,
        args: [id, credentialId],
      });

      return reply.code(204).send();
    }
  );

  // ========================================================================
  // Native Servers
  // ========================================================================

  /**
   * List all registered native servers
   */
  app.get('/api/servers', async () => {
    const status = await serverManager.getStatus();
    return { data: status };
  });

  /**
   * Get tools for a specific server
   */
  app.get<{ Params: { serverType: string } }>(
    '/api/servers/:serverType/tools',
    async (request, reply) => {
      const { serverType } = request.params;

      const validTypes = validServiceTypes;
      if (!validTypes.includes(serverType)) {
        return reply.code(400).send({
          error: { code: 'INVALID_SERVICE', message: `Invalid server type: ${serverType}` },
        });
      }

      const server = serverManager.getServer(serverType);
      if (!server) {
        return reply.code(404).send({
          error: { code: 'NOT_FOUND', message: `Server not registered: ${serverType}` },
        });
      }

      const tools = server.getToolDefinitions();
      return { data: tools };
    }
  );

  /**
   * Check health of a specific server
   */
  app.get<{ Params: { serverType: string } }>(
    '/api/servers/:serverType/health',
    async (request, reply) => {
      const { serverType } = request.params;

      const validTypes = validServiceTypes;
      if (!validTypes.includes(serverType)) {
        return reply.code(400).send({
          error: { code: 'INVALID_SERVICE', message: `Invalid server type: ${serverType}` },
        });
      }

      const health = await serverManager.checkServerHealth(serverType);
      return { data: health };
    }
  );

  // ========================================================================
  // Services (from registry)
  // ========================================================================

  app.get('/api/services', async () => {
    try {
      const { serviceDefinitions } = await import('@reins/servers');
      return {
        data: serviceDefinitions.map((def) => ({
          type: def.type,
          name: def.name,
          description: def.description,
          icon: def.icon,
          category: def.category,
          toolPrefix: def.toolPrefix,
          auth: def.auth,
          permissions: def.permissions,
          permissionDescriptions: def.permissionDescriptions,
          toolCount: def.tools.length,
        })),
      };
    } catch {
      return { data: [] };
    }
  });

  // ========================================================================
  // Permission Instances (new instance-based API)
  // ========================================================================

  // Service types are validated dynamically from the registry
  let validServiceTypes: string[] = [];
  import('@reins/servers').then((s) => {
    validServiceTypes = s.serviceDefinitions.map((d) => d.type);
  }).catch(() => {});

  /**
   * Get all agents with their service instances
   */
  app.get('/api/permissions/agents', async (request) => {
    const userId = getUserId(request);
    const result = await getAgentPermissions(userId);
    return { data: result };
  });

  /**
   * Get available service types for the "Add Service" picker
   */
  app.get('/api/permissions/available-services', async () => {
    let services: Array<{ type: string; name: string; icon: string }> = [];
    try {
      const registry = await import('@reins/servers');
      services = registry.serviceDefinitions.map((d) => ({
        type: d.type,
        name: d.name,
        icon: d.type,
      }));
    } catch {}
    return { data: services };
  });

  /**
   * Add a service instance to an agent
   */
  app.post<{
    Params: { agentId: string };
    Body: { serviceType: string; label?: string; credentialId?: string };
  }>('/api/permissions/:agentId/instances', async (request, reply) => {
    const { agentId } = request.params;
    const { serviceType, label, credentialId } = request.body;

    if (!serviceType || !validServiceTypes.includes(serviceType)) {
      return reply.code(400).send({
        error: { code: 'INVALID_SERVICE', message: `Invalid service type: ${serviceType}` },
      });
    }

    const instance = await createServiceInstance(agentId, serviceType, label, credentialId);
    return { data: instance };
  });

  /**
   * Get instance config with tools
   */
  app.get<{ Params: { instanceId: string } }>(
    '/api/permissions/instances/:instanceId',
    async (request, reply) => {
      const config = await getInstanceConfig(request.params.instanceId);
      if (!config) {
        return reply.code(404).send({
          error: { code: 'NOT_FOUND', message: 'Instance not found' },
        });
      }
      return { data: config };
    }
  );

  /**
   * Update instance (label, credential, enabled)
   */
  app.put<{
    Params: { instanceId: string };
    Body: { label?: string; credentialId?: string; enabled?: boolean };
  }>('/api/permissions/instances/:instanceId', async (request, reply) => {
    const result = await updateServiceInstance(request.params.instanceId, request.body);
    if (!result) {
      return reply.code(404).send({
        error: { code: 'NOT_FOUND', message: 'Instance not found' },
      });
    }
    return { data: result };
  });

  /**
   * Delete a service instance
   */
  app.delete<{ Params: { instanceId: string } }>(
    '/api/permissions/instances/:instanceId',
    async (request, reply) => {
      await deleteServiceInstance(request.params.instanceId);
      return reply.code(204).send();
    }
  );

  /**
   * Set permission level for an instance
   */
  app.put<{
    Params: { instanceId: string };
    Body: { level: PermissionLevel };
  }>('/api/permissions/instances/:instanceId/level', async (request, reply) => {
    const { level } = request.body;
    const validLevels: PermissionLevel[] = ['none', 'read', 'full'];
    if (!validLevels.includes(level)) {
      return reply.code(400).send({
        error: { code: 'VALIDATION_ERROR', message: `level must be one of: ${validLevels.join(', ')}` },
      });
    }
    await setInstancePermissionLevel(request.params.instanceId, level);
    const config = await getInstanceConfig(request.params.instanceId);
    return { data: config };
  });

  /**
   * Set a tool permission for an instance
   */
  app.put<{
    Params: { instanceId: string; toolName: string };
    Body: { permission: ToolPermission };
  }>('/api/permissions/instances/:instanceId/tools/:toolName', async (request, reply) => {
    const { permission } = request.body;
    const validPermissions: ToolPermission[] = ['allow', 'block', 'require_approval'];
    if (!validPermissions.includes(permission)) {
      return reply.code(400).send({
        error: { code: 'VALIDATION_ERROR', message: `permission must be one of: ${validPermissions.join(', ')}` },
      });
    }
    await setInstanceToolPermission(request.params.instanceId, request.params.toolName, permission);
    const config = await getInstanceConfig(request.params.instanceId);
    return { data: config };
  });

  /**
   * Reset a tool permission for an instance
   */
  app.delete<{ Params: { instanceId: string; toolName: string } }>(
    '/api/permissions/instances/:instanceId/tools/:toolName',
    async (request) => {
      await resetInstanceToolPermission(request.params.instanceId, request.params.toolName);
      const config = await getInstanceConfig(request.params.instanceId);
      return { data: config };
    }
  );

  // ========================================================================
  // Permission Matrix (legacy, kept for backward compat)
  // ========================================================================

  /**
   * Get full permission matrix: all agents x all services
   */
  app.get('/api/permissions/matrix', async (request) => {
    const userId = getUserId(request);
    const matrix = await getPermissionMatrix(userId);
    return { data: matrix };
  });

  /**
   * Get service configuration for a specific agent and service
   */
  app.get<{ Params: { agentId: string; serviceType: string } }>(
    '/api/permissions/:agentId/:serviceType',
    async (request, reply) => {
      const { agentId, serviceType } = request.params;

      if (!validServiceTypes.includes(serviceType)) {
        return reply.code(400).send({
          error: { code: 'INVALID_SERVICE', message: `Invalid service type: ${serviceType}` },
        });
      }

      const config = await getAgentServiceConfig(agentId, serviceType);
      if (!config) {
        return reply.code(404).send({
          error: { code: 'NOT_FOUND', message: 'Agent not found' },
        });
      }

      // Include the permission level in the response
      const permissionLevel = await getPermissionLevel(agentId, serviceType);

      return { data: { ...config, permissionLevel } };
    }
  );

  /**
   * Enable or disable a service for an agent
   */
  app.put<{ Params: { agentId: string; serviceType: string }; Body: { enabled: boolean } }>(
    '/api/permissions/:agentId/:serviceType/access',
    async (request, reply) => {
      const { agentId, serviceType } = request.params;
      const { enabled } = request.body;

      if (!validServiceTypes.includes(serviceType)) {
        return reply.code(400).send({
          error: { code: 'INVALID_SERVICE', message: `Invalid service type: ${serviceType}` },
        });
      }

      if (typeof enabled !== 'boolean') {
        return reply.code(400).send({
          error: { code: 'VALIDATION_ERROR', message: 'enabled must be a boolean' },
        });
      }

      await setServiceAccess(agentId, serviceType, enabled);
      const config = await getAgentServiceConfig(agentId, serviceType);

      return { data: config };
    }
  );

  /**
   * Get current permission level for an agent's service
   */
  app.get<{ Params: { agentId: string; serviceType: string } }>(
    '/api/permissions/:agentId/:serviceType/level',
    async (request, reply) => {
      const { agentId, serviceType } = request.params;

      if (!validServiceTypes.includes(serviceType)) {
        return reply.code(400).send({
          error: { code: 'INVALID_SERVICE', message: `Invalid service type: ${serviceType}` },
        });
      }

      const level = await getPermissionLevel(agentId, serviceType);
      return { data: { level } };
    }
  );

  /**
   * Set permission level for an agent's service
   * Levels: none (disabled), read (read-only), full (read + write with approval)
   */
  app.put<{ Params: { agentId: string; serviceType: string }; Body: { level: PermissionLevel } }>(
    '/api/permissions/:agentId/:serviceType/level',
    async (request, reply) => {
      const { agentId, serviceType } = request.params;
      const { level } = request.body;

      if (!validServiceTypes.includes(serviceType)) {
        return reply.code(400).send({
          error: { code: 'INVALID_SERVICE', message: `Invalid service type: ${serviceType}` },
        });
      }

      const validLevels: PermissionLevel[] = ['none', 'read', 'full'];
      if (!validLevels.includes(level)) {
        return reply.code(400).send({
          error: {
            code: 'VALIDATION_ERROR',
            message: `level must be one of: ${validLevels.join(', ')}`,
          },
        });
      }

      await setPermissionLevel(agentId, serviceType, level);
      const config = await getAgentServiceConfig(agentId, serviceType);
      const currentLevel = await getPermissionLevel(agentId, serviceType);

      return { data: { ...config, permissionLevel: currentLevel } };
    }
  );

  /**
   * Link a credential to an agent's service
   */
  app.put<{ Params: { agentId: string; serviceType: string }; Body: { credentialId: string } }>(
    '/api/permissions/:agentId/:serviceType/credential',
    async (request, reply) => {
      const { agentId, serviceType } = request.params;
      const { credentialId } = request.body;

      if (!validServiceTypes.includes(serviceType)) {
        return reply.code(400).send({
          error: { code: 'INVALID_SERVICE', message: `Invalid service type: ${serviceType}` },
        });
      }

      if (!credentialId) {
        return reply.code(400).send({
          error: { code: 'VALIDATION_ERROR', message: 'credentialId is required' },
        });
      }

      await linkCredential(agentId, serviceType, credentialId);
      const config = await getAgentServiceConfig(agentId, serviceType);

      return { data: config };
    }
  );

  /**
   * Unlink a credential from an agent's service
   */
  app.delete<{ Params: { agentId: string; serviceType: string } }>(
    '/api/permissions/:agentId/:serviceType/credential',
    async (request, reply) => {
      const { agentId, serviceType } = request.params;

      if (!validServiceTypes.includes(serviceType)) {
        return reply.code(400).send({
          error: { code: 'INVALID_SERVICE', message: `Invalid service type: ${serviceType}` },
        });
      }

      await unlinkCredential(agentId, serviceType);
      return reply.code(204).send();
    }
  );

  /**
   * Set permission for a specific tool
   */
  app.put<{
    Params: { agentId: string; serviceType: string; toolName: string };
    Body: { permission: ToolPermission };
  }>(
    '/api/permissions/:agentId/:serviceType/tools/:toolName',
    async (request, reply) => {
      const { agentId, serviceType, toolName } = request.params;
      const { permission } = request.body;

      if (!validServiceTypes.includes(serviceType)) {
        return reply.code(400).send({
          error: { code: 'INVALID_SERVICE', message: `Invalid service type: ${serviceType}` },
        });
      }

      const validPermissions: ToolPermission[] = ['allow', 'block', 'require_approval'];
      if (!validPermissions.includes(permission)) {
        return reply.code(400).send({
          error: {
            code: 'VALIDATION_ERROR',
            message: `permission must be one of: ${validPermissions.join(', ')}`,
          },
        });
      }

      await setToolPermission(agentId, serviceType, toolName, permission);
      const config = await getAgentServiceConfig(agentId, serviceType);

      return { data: config };
    }
  );

  /**
   * Reset a tool permission to default
   */
  app.delete<{ Params: { agentId: string; serviceType: string; toolName: string } }>(
    '/api/permissions/:agentId/:serviceType/tools/:toolName',
    async (request, reply) => {
      const { agentId, serviceType, toolName } = request.params;

      if (!validServiceTypes.includes(serviceType)) {
        return reply.code(400).send({
          error: { code: 'INVALID_SERVICE', message: `Invalid service type: ${serviceType}` },
        });
      }

      await resetToolPermission(agentId, serviceType, toolName);
      const config = await getAgentServiceConfig(agentId, serviceType);

      return { data: config };
    }
  );

  /**
   * Bulk set tool permissions for a service
   */
  app.put<{
    Params: { agentId: string; serviceType: string };
    Body: { permissions: Record<string, ToolPermission> };
  }>(
    '/api/permissions/:agentId/:serviceType/tools',
    async (request, reply) => {
      const { agentId, serviceType } = request.params;
      const { permissions } = request.body;

      if (!validServiceTypes.includes(serviceType)) {
        return reply.code(400).send({
          error: { code: 'INVALID_SERVICE', message: `Invalid service type: ${serviceType}` },
        });
      }

      if (!permissions || typeof permissions !== 'object') {
        return reply.code(400).send({
          error: { code: 'VALIDATION_ERROR', message: 'permissions object is required' },
        });
      }

      await setServiceToolPermissions(agentId, serviceType, permissions);
      const config = await getAgentServiceConfig(agentId, serviceType);

      return { data: config };
    }
  );

  /**
   * Get available credentials for a service type
   */
  app.get<{ Params: { serviceType: string } }>(
    '/api/permissions/credentials/:serviceType',
    async (request, reply) => {
      const { serviceType } = request.params;

      if (!validServiceTypes.includes(serviceType)) {
        return reply.code(400).send({
          error: { code: 'INVALID_SERVICE', message: `Invalid service type: ${serviceType}` },
        });
      }

      const userId = getUserId(request);
      const credentials = await getCredentialsForService(serviceType, userId);
      return { data: credentials };
    }
  );

  /**
   * Add a credential to an agent's service (multi-account)
   */
  app.post<{
    Params: { agentId: string; serviceType: string };
    Body: { credentialId: string; isDefault?: boolean };
  }>(
    '/api/permissions/:agentId/:serviceType/credentials',
    async (request, reply) => {
      const { agentId, serviceType } = request.params;
      const { credentialId, isDefault } = request.body;

      if (!validServiceTypes.includes(serviceType)) {
        return reply.code(400).send({
          error: { code: 'INVALID_SERVICE', message: `Invalid service type: ${serviceType}` },
        });
      }

      if (!credentialId) {
        return reply.code(400).send({
          error: { code: 'VALIDATION_ERROR', message: 'credentialId is required' },
        });
      }

      await addServiceCredential(agentId, serviceType, credentialId, isDefault);
      const linked = await getLinkedCredentials(agentId, serviceType);
      return { data: linked };
    }
  );

  /**
   * Remove a credential from an agent's service
   */
  app.delete<{ Params: { agentId: string; serviceType: string; credentialId: string } }>(
    '/api/permissions/:agentId/:serviceType/credentials/:credentialId',
    async (request, reply) => {
      const { agentId, serviceType, credentialId } = request.params;

      if (!validServiceTypes.includes(serviceType)) {
        return reply.code(400).send({
          error: { code: 'INVALID_SERVICE', message: `Invalid service type: ${serviceType}` },
        });
      }

      await removeServiceCredential(agentId, serviceType, credentialId);
      return reply.code(204).send();
    }
  );

  /**
   * Set default credential for an agent's service
   */
  app.put<{ Params: { agentId: string; serviceType: string; credentialId: string } }>(
    '/api/permissions/:agentId/:serviceType/credentials/:credentialId/default',
    async (request, reply) => {
      const { agentId, serviceType, credentialId } = request.params;

      if (!validServiceTypes.includes(serviceType)) {
        return reply.code(400).send({
          error: { code: 'INVALID_SERVICE', message: `Invalid service type: ${serviceType}` },
        });
      }

      await setDefaultCredential(agentId, serviceType, credentialId);
      const linked = await getLinkedCredentials(agentId, serviceType);
      return { data: linked };
    }
  );

  /**
   * Get linked credentials for an agent's service
   */
  app.get<{ Params: { agentId: string; serviceType: string } }>(
    '/api/permissions/:agentId/:serviceType/credentials',
    async (request, reply) => {
      const { agentId, serviceType } = request.params;

      if (!validServiceTypes.includes(serviceType)) {
        return reply.code(400).send({
          error: { code: 'INVALID_SERVICE', message: `Invalid service type: ${serviceType}` },
        });
      }

      const linked = await getLinkedCredentials(agentId, serviceType);
      return { data: linked };
    }
  );

  // ========================================================================
  // Policies
  // ========================================================================

  app.get('/api/policies', async () => {
    const result = await client.execute(`SELECT * FROM policies`);
    return { data: result.rows };
  });

  app.get<{ Params: { id: string } }>('/api/policies/:id', async (request, reply) => {
    const { id } = request.params;

    const result = await client.execute({
      sql: `SELECT * FROM policies WHERE id = ?`,
      args: [id],
    });

    if (result.rows.length === 0) {
      return reply.code(404).send({ error: { code: 'NOT_FOUND', message: 'Policy not found' } });
    }

    const policy = result.rows[0];
    const parsed = policyEngine.parsePolicy(policy.yaml as string);

    return {
      data: {
        ...policy,
        parsed: parsed.valid ? parsed.parsed : null,
      },
    };
  });

  app.post('/api/policies', async (request, reply) => {
    const parsed = CreatePolicySchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: { code: 'VALIDATION_ERROR', message: parsed.error.message } });
    }

    // Validate YAML
    const validation = policyEngine.parsePolicy(parsed.data.yaml);
    if (!validation.valid) {
      return reply.code(400).send({
        error: {
          code: 'INVALID_POLICY',
          message: 'Policy YAML is invalid',
          details: { errors: validation.errors },
        },
      });
    }

    const id = nanoid();
    const now = new Date().toISOString();

    await client.execute({
      sql: `INSERT INTO policies (id, version, name, yaml, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)`,
      args: [id, validation.parsed!.version, parsed.data.name, parsed.data.yaml, now, now],
    });

    await auditLogger.logPolicyChange(id, 'created');

    const result = await client.execute({
      sql: `SELECT * FROM policies WHERE id = ?`,
      args: [id],
    });

    return reply.code(201).send({ data: result.rows[0] });
  });

  app.put<{ Params: { id: string } }>('/api/policies/:id', async (request, reply) => {
    const { id } = request.params;
    const parsed = UpdatePolicySchema.safeParse(request.body);

    if (!parsed.success) {
      return reply.code(400).send({ error: { code: 'VALIDATION_ERROR', message: parsed.error.message } });
    }

    const updates: string[] = ['updated_at = ?'];
    const args: (string | null)[] = [new Date().toISOString()];

    if (parsed.data.name) {
      updates.push('name = ?');
      args.push(parsed.data.name);
    }

    if (parsed.data.yaml) {
      const validation = policyEngine.parsePolicy(parsed.data.yaml);
      if (!validation.valid) {
        return reply.code(400).send({
          error: {
            code: 'INVALID_POLICY',
            message: 'Policy YAML is invalid',
            details: { errors: validation.errors },
          },
        });
      }
      updates.push('yaml = ?');
      args.push(parsed.data.yaml);
      updates.push('version = ?');
      args.push(validation.parsed!.version);
    }

    args.push(id);

    await client.execute({
      sql: `UPDATE policies SET ${updates.join(', ')} WHERE id = ?`,
      args,
    });

    await auditLogger.logPolicyChange(id, 'updated');

    const result = await client.execute({
      sql: `SELECT * FROM policies WHERE id = ?`,
      args: [id],
    });

    if (result.rows.length === 0) {
      return reply.code(404).send({ error: { code: 'NOT_FOUND', message: 'Policy not found' } });
    }

    return { data: result.rows[0] };
  });

  app.delete<{ Params: { id: string } }>('/api/policies/:id', async (request, reply) => {
    const { id } = request.params;

    await client.execute({
      sql: `DELETE FROM policies WHERE id = ?`,
      args: [id],
    });
    await auditLogger.logPolicyChange(id, 'deleted');

    return reply.code(204).send();
  });

  app.post<{ Params: { id: string } }>('/api/policies/:id/validate', async (request, reply) => {
    const body = request.body as { yaml?: string };

    if (!body.yaml) {
      return reply.code(400).send({ error: { code: 'VALIDATION_ERROR', message: 'YAML is required' } });
    }

    const validation = policyEngine.parsePolicy(body.yaml);

    return {
      data: {
        valid: validation.valid,
        errors: validation.errors,
        parsed: validation.parsed,
      },
    };
  });

  // ========================================================================
  // Credentials
  // ========================================================================

  app.get('/api/credentials', async (request) => {
    const userId = getUserId(request);
    const credentials = await credentialVault.list(userId);
    return { data: credentials };
  });

  app.post('/api/credentials', async (request, reply) => {
    const parsed = CreateCredentialSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: { code: 'VALIDATION_ERROR', message: parsed.error.message } });
    }

    const id = await credentialVault.store(
      parsed.data.serviceId,
      parsed.data.type,
      parsed.data.data
    );

    return reply.code(201).send({ data: { id, serviceId: parsed.data.serviceId, type: parsed.data.type } });
  });

  app.get<{ Params: { id: string } }>('/api/credentials/:id/health', async (request, reply) => {
    const { id } = request.params;

    const health = await credentialVault.checkHealth(id);

    if (!health.valid && health.error === 'Credential not found') {
      return reply.code(404).send({ error: { code: 'NOT_FOUND', message: 'Credential not found' } });
    }

    return { data: health };
  });

  app.delete<{ Params: { id: string } }>('/api/credentials/:id', async (request, reply) => {
    const { id } = request.params;

    const deleted = await credentialVault.delete(id);
    if (!deleted) {
      return reply.code(404).send({ error: { code: 'NOT_FOUND', message: 'Credential not found' } });
    }

    return reply.code(204).send();
  });

  // ========================================================================
  // GitHub PAT
  // ========================================================================

  /**
   * Add a GitHub Personal Access Token.
   * Validates the token, reads scopes from response headers,
   * and stores the credential with granted scopes.
   */
  app.post('/api/credentials/github', async (request, reply) => {
    const body = request.body as { token?: string } | undefined;
    if (!body?.token) {
      return reply.code(400).send({ error: { code: 'VALIDATION_ERROR', message: 'token is required' } });
    }

    const userId = getUserId(request);

    // Validate token and get scopes
    let validation: { valid: boolean; scopes: string[]; login?: string; error?: string };
    try {
      const { validateGitHubToken } = await import('@reins/servers');
      validation = await validateGitHubToken(body.token);
    } catch {
      return reply.code(500).send({ error: { code: 'SERVER_ERROR', message: 'GitHub validation not available' } });
    }

    if (!validation.valid) {
      return reply.code(401).send({
        error: { code: 'INVALID_TOKEN', message: validation.error || 'Invalid GitHub token' },
      });
    }

    // Determine which services are available based on scopes
    const grantedServices = ['github'];

    // Store credential
    const credId = await credentialVault.storeOAuth({
      serviceId: 'github',
      accountEmail: validation.login ?? '',
      accountName: validation.login,
      userId,
      grantedServices,
      data: {
        accessToken: body.token,
        scopes: validation.scopes,
      } as any,
    });

    // Auto-link to all agents that have github enabled but no credential
    await autoLinkCredential('github', credId);

    return reply.code(201).send({
      data: {
        id: credId,
        serviceId: 'github',
        login: validation.login,
        scopes: validation.scopes,
        grantedServices,
      },
    });
  });

  // ========================================================================
  // Linear API Key
  // ========================================================================

  /**
   * Add a Linear API key.
   * Validates the key against the Linear API, resolves the workspace name,
   * and stores the credential.
   */
  app.post('/api/credentials/linear', async (request, reply) => {
    const body = request.body as { token?: string; workspaceName?: string } | undefined;
    if (!body?.token || !body?.workspaceName) {
      return reply.code(400).send({
        error: { code: 'VALIDATION_ERROR', message: 'token and workspaceName are required' },
      });
    }

    const userId = getUserId(request);

    // Validate token by querying the Linear API for the current viewer and organization
    let orgName: string;
    let orgId: string;
    let viewerEmail: string;
    let viewerName: string;
    try {
      const res = await fetch('https://api.linear.app/graphql', {
        method: 'POST',
        headers: {
          Authorization: body.token,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          query: `{ viewer { id name email } organization { id name } }`,
        }),
      });

      if (!res.ok) {
        return reply.code(401).send({
          error: { code: 'INVALID_TOKEN', message: `Linear API returned ${res.status}` },
        });
      }

      const json = (await res.json()) as {
        data?: { viewer: { id: string; name: string; email: string }; organization: { id: string; name: string } };
        errors?: Array<{ message: string }>;
      };

      if (json.errors?.length || !json.data) {
        return reply.code(401).send({
          error: { code: 'INVALID_TOKEN', message: json.errors?.[0]?.message || 'Invalid Linear API key' },
        });
      }

      orgName = json.data.organization.name;
      orgId = json.data.organization.id;
      viewerEmail = json.data.viewer.email;
      viewerName = json.data.viewer.name;
    } catch (err) {
      return reply.code(500).send({
        error: { code: 'SERVER_ERROR', message: 'Failed to validate Linear API key' },
      });
    }

    // Store credential
    const credId = await credentialVault.storeOAuth({
      serviceId: 'linear',
      accountEmail: viewerEmail,
      accountName: `${body.workspaceName} (${orgName})`,
      userId,
      grantedServices: ['linear'],
      data: {
        accessToken: body.token,
        organizationId: orgId,
        organizationName: orgName,
        workspaceName: body.workspaceName,
      } as any,
    });

    // Auto-link to all agents that have linear enabled but no credential
    await autoLinkCredential('linear', credId);

    return reply.code(201).send({
      data: {
        id: credId,
        serviceId: 'linear',
        workspaceName: body.workspaceName,
        workspaceId: orgId,
      },
    });
  });

  // ========================================================================
  // OAuth - Google
  // ========================================================================

  // Base Google scopes (always included)
  const GOOGLE_BASE_SCOPES = [
    'https://www.googleapis.com/auth/userinfo.email',
    'https://www.googleapis.com/auth/userinfo.profile',
  ];

  /**
   * Initiate Google OAuth flow
   * Accepts optional `services` query param (comma-separated) to request specific scopes.
   * Example: /api/oauth/google?services=gmail,drive
   * If no services specified, requests all Google service scopes.
   */
  app.get('/api/oauth/google', async (request, reply) => {
    if (!config.googleClientId || !config.googleRedirectUri) {
      return reply.code(500).send({
        error: {
          code: 'CONFIG_ERROR',
          message: 'Google OAuth is not configured. Set GOOGLE_CLIENT_ID and GOOGLE_REDIRECT_URI in .env file.',
        },
      });
    }

    const userId = getUserId(request);
    const query = request.query as { services?: string; reconnect?: string };

    // Build scopes from requested services
    let serviceScopes: string[] = [];
    let requestedServices: string[] = [];

    try {
      const { serviceDefinitions } = await import('@reins/servers');
      const googleServices = serviceDefinitions.filter((d) => d.category === 'google');

      if (query.services) {
        requestedServices = query.services.split(',').map((s) => s.trim());
        for (const svcType of requestedServices) {
          const def = googleServices.find((d) => d.type === svcType);
          if (def?.auth.oauthScopes) {
            serviceScopes.push(...def.auth.oauthScopes);
          }
        }
      }

      // Default: request all Google service scopes
      if (serviceScopes.length === 0) {
        requestedServices = googleServices.map((d) => d.type);
        for (const def of googleServices) {
          if (def.auth.oauthScopes) {
            serviceScopes.push(...def.auth.oauthScopes);
          }
        }
      }
    } catch {
      // Fallback if registry unavailable
      serviceScopes = [
        'https://www.googleapis.com/auth/gmail.readonly',
        'https://www.googleapis.com/auth/gmail.compose',
        'https://www.googleapis.com/auth/drive.readonly',
        'https://www.googleapis.com/auth/calendar.readonly',
      ];
      requestedServices = ['gmail', 'drive', 'calendar'];
    }

    const allScopes = [...new Set([...GOOGLE_BASE_SCOPES, ...serviceScopes])];

    // Generate state token for CSRF protection
    const state = nanoid(32);
    storePendingOAuthFlow(state, {
      service: 'google',
      userId,
      grantedServices: requestedServices,
      reconnectCredentialId: query.reconnect || undefined,
    });

    // Build authorization URL
    const params = new URLSearchParams({
      client_id: config.googleClientId,
      redirect_uri: config.googleRedirectUri,
      response_type: 'code',
      scope: allScopes.join(' '),
      state,
      access_type: 'offline',
      prompt: 'consent',
    });

    const authUrl = `https://accounts.google.com/o/oauth2/v2/auth?${params.toString()}`;

    return { data: { authUrl, state } };
  });

  /**
   * Google OAuth callback
   */
  app.get<{ Querystring: { code?: string; state?: string; error?: string } }>(
    '/api/oauth/google/callback',
    async (request, reply) => {
      const { code, state, error } = request.query;

      // Build dashboard URL for redirects
      const dashboardUrl = config.dashboardUrl;

      if (error) {
        return reply.redirect(`${dashboardUrl}/credentials?oauth_error=${encodeURIComponent(error)}`);
      }

      if (!code || !state) {
        return reply.redirect(`${dashboardUrl}/credentials?oauth_error=missing_params`);
      }

      // Validate state token
      const pendingFlow = getPendingOAuthFlow(state);
      if (!pendingFlow) {
        return reply.redirect(`${dashboardUrl}/credentials?oauth_error=invalid_state`);
      }

      // Delete the pending flow to prevent replay attacks
      deletePendingOAuthFlow(state);

      if (!config.googleClientId || !config.googleClientSecret || !config.googleRedirectUri) {
        return reply.redirect(`${dashboardUrl}/credentials?oauth_error=config_error`);
      }

      try {
        // Exchange code for tokens
        const tokenResponse = await fetch('https://oauth2.googleapis.com/token', {
          method: 'POST',
          headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
          body: new URLSearchParams({
            client_id: config.googleClientId!,
            client_secret: config.googleClientSecret!,
            code,
            grant_type: 'authorization_code',
            redirect_uri: config.googleRedirectUri,
          }),
        });

        if (!tokenResponse.ok) {
          const errorData = await tokenResponse.json().catch(() => ({}));
          console.error('Token exchange failed:', errorData);
          return reply.redirect(`${dashboardUrl}/credentials?oauth_error=token_exchange_failed`);
        }

        const tokens = await tokenResponse.json() as {
          access_token: string;
          refresh_token?: string;
          expires_in: number;
          token_type: string;
        };

        // Fetch user info to get email and name
        const userInfoResponse = await fetch('https://www.googleapis.com/oauth2/v2/userinfo', {
          headers: { Authorization: `Bearer ${tokens.access_token}` },
        });

        if (!userInfoResponse.ok) {
          return reply.redirect(`${dashboardUrl}/credentials?oauth_error=userinfo_failed`);
        }

        const userInfo = await userInfoResponse.json() as {
          email: string;
          name?: string;
        };

        // Calculate expiration date
        const expiresAt = new Date(Date.now() + tokens.expires_in * 1000);

        // Build token data
        const tokenData = {
          accessToken: tokens.access_token,
          refreshToken: tokens.refresh_token,
          expiresAt,
          tokenType: tokens.token_type,
        };

        const grantedServices = pendingFlow.grantedServices ?? ['gmail', 'drive', 'calendar'];

        if (pendingFlow.reconnectCredentialId) {
          // Reconnect: update existing credential with fresh tokens
          await credentialVault.update(pendingFlow.reconnectCredentialId, tokenData);

          return reply.redirect(
            `${dashboardUrl}/credentials?oauth_success=true&email=${encodeURIComponent(userInfo.email)}&reconnected=true`
          );
        }

        // Store new credential with account info and granted services
        await credentialVault.storeOAuth({
          serviceId: 'google',
          accountEmail: userInfo.email,
          accountName: userInfo.name,
          userId: pendingFlow.userId,
          grantedServices,
          data: tokenData,
        });

        // Redirect back to credentials page with success
        return reply.redirect(
          `${dashboardUrl}/credentials?oauth_success=true&email=${encodeURIComponent(userInfo.email)}`
        );
      } catch (err) {
        console.error('OAuth callback error:', err);
        return reply.redirect(`${dashboardUrl}/credentials?oauth_error=internal_error`);
      }
    }
  );

  // ========================================================================
  // Approvals
  // ========================================================================

  app.get('/api/approvals', async (request) => {
    const query = request.query as { agentId?: string };
    const userId = getUserId(request);

    // Get user's agents to filter approvals
    const userAgents = await client.execute({
      sql: `SELECT id FROM agents WHERE user_id = ?`,
      args: [userId],
    });
    const userAgentIds = userAgents.rows.map((r) => r.id as string);

    if (query.agentId) {
      // Verify the requested agent belongs to the user
      if (!userAgentIds.includes(query.agentId)) {
        return { data: [] };
      }
      const approvals = await approvalQueue.listPending(query.agentId);
      return { data: approvals };
    }

    // Return approvals for all of user's agents
    const allApprovals = await approvalQueue.listPending();
    const filtered = allApprovals.filter((a: any) => userAgentIds.includes(a.agentId));
    return { data: filtered };
  });

  // Test endpoint: Create an approval request (for mobile app testing)
  app.post('/api/approvals/test', async (request, reply) => {
    const body = request.body as {
      agentId: string;
      tool: string;
      arguments?: Record<string, unknown>;
      context?: string;
    };

    if (!body.agentId || !body.tool) {
      return reply.code(400).send({
        error: { code: 'VALIDATION_ERROR', message: 'agentId and tool are required' }
      });
    }

    const id = await approvalQueue.submit(
      body.agentId,
      body.tool,
      body.arguments || {},
      body.context
    );

    const approval = await approvalQueue.get(id);
    return reply.code(201).send({ data: approval });
  });

  app.get<{ Params: { id: string } }>('/api/approvals/:id', async (request, reply) => {
    const { id } = request.params;

    const approval = await approvalQueue.get(id);
    if (!approval) {
      return reply.code(404).send({ error: { code: 'NOT_FOUND', message: 'Approval not found' } });
    }

    return { data: approval };
  });

  app.post<{ Params: { id: string } }>('/api/approvals/:id/approve', async (request, reply) => {
    const { id } = request.params;
    const parsed = ApprovalDecisionSchema.safeParse({ ...request.body as object, approved: true });

    if (!parsed.success) {
      return reply.code(400).send({ error: { code: 'VALIDATION_ERROR', message: parsed.error.message } });
    }

    const session = getSession(request);
    const approver = session?.email ?? 'dashboard-user';

    const success = await approvalQueue.approve(id, approver, parsed.data.comment);
    if (!success) {
      return reply.code(404).send({ error: { code: 'NOT_FOUND', message: 'Approval not found or already resolved' } });
    }

    const approval = await approvalQueue.get(id);
    return { data: approval };
  });

  app.post<{ Params: { id: string } }>('/api/approvals/:id/reject', async (request, reply) => {
    const { id } = request.params;
    const body = request.body as { reason?: string };

    const session = getSession(request);
    const approver = session?.email ?? 'dashboard-user';

    const success = await approvalQueue.reject(id, approver, body.reason ?? 'Rejected');
    if (!success) {
      return reply.code(404).send({ error: { code: 'NOT_FOUND', message: 'Approval not found or already resolved' } });
    }

    const approval = await approvalQueue.get(id);
    return { data: approval };
  });

  // ========================================================================
  // Audit
  // ========================================================================

  app.get('/api/audit', async (request) => {
    const query = request.query as Record<string, string>;
    const userId = getUserId(request);

    // Get user's agents to scope audit entries
    const userAgents = await client.execute({
      sql: `SELECT id FROM agents WHERE user_id = ?`,
      args: [userId],
    });
    const userAgentIds = userAgents.rows.map((r) => r.id as string);

    const filter = AuditFilterSchema.parse({
      startDate: query.startDate ? new Date(query.startDate) : undefined,
      endDate: query.endDate ? new Date(query.endDate) : undefined,
      agentId: query.agentId || undefined,
      eventType: query.eventType || undefined,
      tool: query.tool || undefined,
      result: query.result || undefined,
      limit: query.limit ? parseInt(query.limit) : undefined,
      offset: query.offset ? parseInt(query.offset) : undefined,
    });

    const entries = await auditLogger.query(filter);
    const filteredEntries = entries.filter((e: any) =>
      !e.agentId || userAgentIds.includes(e.agentId)
    );
    const total = filteredEntries.length;

    return {
      data: filteredEntries,
      pagination: {
        total,
        limit: filter.limit,
        offset: filter.offset,
        hasMore: false,
      },
    };
  });

  // ========================================================================
  // Connections
  // ========================================================================

  app.get('/api/connections', async () => {
    const connections = mcpProxy.listConnections();
    return { data: connections };
  });

  // ========================================================================
  // Device Registration (Push Notifications)
  // ========================================================================

  app.post('/api/devices/register', async (request, reply) => {
    const body = request.body as {
      token?: string;
      deviceId?: string;
      platform?: string;
      userId?: string;
    };

    if (!body.token || !body.deviceId || !body.platform) {
      return reply.code(400).send({
        error: { code: 'VALIDATION_ERROR', message: 'token, deviceId, and platform are required' },
      });
    }

    if (body.platform !== 'ios' && body.platform !== 'android') {
      return reply.code(400).send({
        error: { code: 'VALIDATION_ERROR', message: 'platform must be ios or android' },
      });
    }

    const id = await apnsService.registerDevice(
      body.deviceId,
      body.token,
      body.platform as 'ios' | 'android',
      body.userId
    );

    return { data: { deviceId: id } };
  });

  app.delete<{ Params: { deviceId: string } }>(
    '/api/devices/:deviceId',
    async (request, reply) => {
      const { deviceId } = request.params;

      const deleted = await apnsService.unregisterDevice(deviceId);
      if (!deleted) {
        return reply.code(404).send({
          error: { code: 'NOT_FOUND', message: 'Device not found' },
        });
      }

      return reply.code(204).send();
    }
  );

  // ========================================================================
  // MCP Endpoint for Agents
  // ========================================================================

  /**
   * MCP endpoint for agent tool discovery and execution
   *
   * Implements MCP Streamable HTTP transport:
   * - POST: JSON-RPC 2.0 requests (initialize, tools/list, tools/call, etc.)
   * - GET: SSE stream (returns 405 for now — we use stateless request-response)
   * - DELETE: Session termination (no-op, stateless)
   */
  app.post<{ Params: { agentId: string } }>(
    '/mcp/:agentId',
    async (request, reply) => {
      const { agentId } = request.params;
      const body = request.body as MCPRequest;

      // Validate basic structure
      if (!body || typeof body !== 'object') {
        return reply.code(400).send({
          jsonrpc: '2.0',
          id: null,
          error: {
            code: -32600,
            message: 'Invalid request: expected JSON-RPC 2.0 request body',
          },
        });
      }

      // Handle the MCP request
      const response = await handleMCPRequest(agentId, body);

      // JSON-RPC always returns 200 - errors are in the response body
      return response;
    }
  );

  /**
   * MCP GET endpoint — SSE stream for server-initiated messages.
   * Currently returns 405 since we use stateless request-response mode.
   * Browsers hitting this URL get a friendly message.
   */
  app.get<{ Params: { agentId: string } }>(
    '/mcp/:agentId',
    async (request, reply) => {
      const accept = request.headers.accept ?? '';

      // If client wants SSE, return 405 (not supported yet)
      if (accept.includes('text/event-stream')) {
        return reply.code(405).send({
          error: 'SSE streaming not supported. Use POST for JSON-RPC requests.',
        });
      }

      // Browser / curl hit — return a human-readable status
      return {
        name: 'Reins MCP Endpoint',
        version: '1.0.0',
        protocol: 'MCP Streamable HTTP',
        agentId: request.params.agentId,
        usage: 'Send a POST request with a JSON-RPC 2.0 body. Start with {"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-03-26","capabilities":{},"clientInfo":{"name":"your-client","version":"1.0"}}}',
      };
    }
  );

  /**
   * MCP DELETE endpoint — session termination (no-op, stateless)
   */
  app.delete<{ Params: { agentId: string } }>(
    '/mcp/:agentId',
    async (_request, reply) => {
      return reply.code(204).send();
    }
  );

  // ========================================================================
  // Agent Deployment (Fly.io / Docker provisioning)
  // ========================================================================

  /**
   * Combined create + deploy in one step.
   * Creates an agent record and immediately provisions it.
   */
  app.post('/api/agents/create-and-deploy', async (request, reply) => {
    const userId = getUserId(request);
    const body = request.body as {
      name: string;
      description?: string;
      telegramToken: string;
      telegramUserId?: string;
      modelProvider?: string;
      modelName?: string;
      soulMd?: string;
      region?: string;
      openaiApiKey?: string;
      modelCredentials?: string;
      mcpServers?: string;
    };

    if (!body?.name?.trim()) {
      return reply.code(400).send({ error: { code: 'VALIDATION_ERROR', message: 'name is required' } });
    }
    if (!body?.telegramToken?.trim()) {
      return reply.code(400).send({ error: { code: 'VALIDATION_ERROR', message: 'telegramToken is required' } });
    }

    // Validate Telegram token
    try {
      const tgRes = await fetch(`https://api.telegram.org/bot${body.telegramToken}/getMe`);
      const tgData = await tgRes.json() as { ok: boolean };
      if (!tgData.ok) {
        return reply.code(400).send({ error: { code: 'VALIDATION_ERROR', message: 'Invalid Telegram bot token' } });
      }
    } catch {
      return reply.code(400).send({ error: { code: 'VALIDATION_ERROR', message: 'Failed to validate Telegram token' } });
    }

    // Parse MCP servers if provided
    let userMcpServers: object[] = [];
    if (body.mcpServers) {
      try {
        userMcpServers = JSON.parse(body.mcpServers);
        if (!Array.isArray(userMcpServers)) throw new Error('not array');
      } catch {
        return reply.code(400).send({ error: { code: 'VALIDATION_ERROR', message: 'mcpServers must be a valid JSON array' } });
      }
    }

    const agentId = nanoid();
    const deploymentId = nanoid();
    const gatewayToken = nanoid(32);
    const now = new Date().toISOString();

    // Create agent record
    await client.execute({
      sql: `INSERT INTO agents (id, user_id, name, description, status, created_at, updated_at) VALUES (?, ?, ?, ?, 'active', ?, ?)`,
      args: [agentId, userId, body.name.trim(), body.description?.trim() ?? null, now, now],
    });

    // Build MCP configs
    const reinsUrl = process.env.REINS_PUBLIC_URL || config.dashboardUrl;
    const mcpConfigs = [
      { name: 'reins', url: `${reinsUrl}/mcp/${agentId}`, transport: 'http' },
      ...userMcpServers,
    ];

    try {
      const result = await provider.provision({
        instanceId: deploymentId,
        telegramToken: body.telegramToken,
        telegramUserId: body.telegramUserId,
        mcpConfigs,
        gatewayToken,
        soulMd: body.soulMd,
        modelProvider: body.modelProvider,
        modelName: body.modelName,
        region: body.region,
        openaiApiKey: body.openaiApiKey,
        modelCredentials: body.modelCredentials,
      });

      await client.execute({
        sql: `INSERT INTO deployed_agents (id, agent_id, fly_app_name, fly_machine_id, status, management_url, telegram_token, telegram_user_id, soul_md, model_provider, model_name, region, gateway_token, openai_api_key, model_credentials, mcp_config_json, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        args: [
          deploymentId, agentId,
          result.appName, result.machineId, 'running', result.managementUrl,
          body.telegramToken, body.telegramUserId ?? null,
          body.soulMd ?? null,
          body.modelProvider ?? 'anthropic', body.modelName ?? 'claude-sonnet-4-5',
          body.region ?? 'iad', gatewayToken,
          body.openaiApiKey ?? null, body.modelCredentials ?? null,
          body.mcpServers ?? null,
          now, now,
        ],
      });

      return reply.code(201).send({
        data: {
          id: agentId,
          name: body.name.trim(),
          status: 'active',
          deployment: {
            deploymentId,
            status: 'running',
            appName: result.appName,
            machineId: result.machineId,
            managementUrl: result.managementUrl,
          },
        },
      });
    } catch (err) {
      // Store failed deployment
      await client.execute({
        sql: `INSERT INTO deployed_agents (id, agent_id, status, gateway_token, created_at, updated_at) VALUES (?, ?, 'error', ?, ?, ?)`,
        args: [deploymentId, agentId, gatewayToken, now, now],
      });
      await client.execute({
        sql: `UPDATE agents SET status = 'error', updated_at = ? WHERE id = ?`,
        args: [now, agentId],
      });
      const message = err instanceof Error ? err.message : 'Unknown error';
      return reply.code(500).send({
        error: { code: 'DEPLOY_FAILED', message: `Deployment failed: ${message}` },
      });
    }
  });

  /**
   * Deploy an agent — provision on Fly.io or local Docker.
   * Generates MCP config pointing back to this Reins instance for policy enforcement.
   */
  app.post<{ Params: { id: string } }>('/api/agents/:id/deploy', async (request, reply) => {
    const { id } = request.params;

    // Verify agent exists
    const agentResult = await client.execute({
      sql: `SELECT * FROM agents WHERE id = ?`,
      args: [id],
    });
    if (agentResult.rows.length === 0) {
      return reply.code(404).send({ error: { code: 'NOT_FOUND', message: 'Agent not found' } });
    }

    // Check not already deployed
    const existing = await client.execute({
      sql: `SELECT * FROM deployed_agents WHERE agent_id = ? AND status NOT IN ('destroyed', 'error')`,
      args: [id],
    });
    if (existing.rows.length > 0) {
      return reply.code(409).send({
        error: { code: 'ALREADY_DEPLOYED', message: 'Agent already has an active deployment' },
      });
    }

    const body = request.body as {
      telegramToken: string;
      telegramUserId?: string;
      soulMd?: string;
      modelProvider?: string;
      modelName?: string;
      region?: string;
    };

    if (!body?.telegramToken) {
      return reply.code(400).send({
        error: { code: 'VALIDATION_ERROR', message: 'telegramToken is required' },
      });
    }

    const deploymentId = nanoid();
    const gatewayToken = nanoid(32);
    const now = new Date().toISOString();

    // Build MCP config that routes through Reins proxy for policy enforcement.
    // REINS_PUBLIC_URL takes precedence (for when backend URL differs from dashboard).
    const reinsUrl = process.env.REINS_PUBLIC_URL || config.dashboardUrl;
    const mcpConfigs = [
      {
        name: 'reins',
        url: `${reinsUrl}/mcp/${id}`,
        transport: 'http',
      },
    ];

    try {
      const result = await provider.provision({
        instanceId: deploymentId,
        telegramToken: body.telegramToken,
        telegramUserId: body.telegramUserId,
        mcpConfigs,
        gatewayToken,
        soulMd: body.soulMd,
        modelProvider: body.modelProvider,
        modelName: body.modelName,
        region: body.region,
      });

      await client.execute({
        sql: `INSERT INTO deployed_agents (id, agent_id, fly_app_name, fly_machine_id, status, management_url, telegram_token, telegram_user_id, soul_md, model_provider, model_name, region, gateway_token, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        args: [
          deploymentId,
          id,
          result.appName,
          result.machineId,
          'running',
          result.managementUrl,
          body.telegramToken,
          body.telegramUserId ?? null,
          body.soulMd ?? null,
          body.modelProvider ?? 'anthropic',
          body.modelName ?? 'claude-sonnet-4-5',
          body.region ?? 'iad',
          gatewayToken,
          now,
          now,
        ],
      });

      // Update agent status to active
      await client.execute({
        sql: `UPDATE agents SET status = 'active', updated_at = ? WHERE id = ?`,
        args: [now, id],
      });

      return reply.code(201).send({
        data: {
          deploymentId,
          agentId: id,
          status: 'running',
          appName: result.appName,
          machineId: result.machineId,
          managementUrl: result.managementUrl,
        },
      });
    } catch (err) {
      // Store failed deployment
      await client.execute({
        sql: `INSERT INTO deployed_agents (id, agent_id, status, gateway_token, created_at, updated_at) VALUES (?, ?, 'error', ?, ?, ?)`,
        args: [deploymentId, id, gatewayToken, now, now],
      });
      const message = err instanceof Error ? err.message : 'Unknown error';
      return reply.code(500).send({
        error: { code: 'DEPLOY_FAILED', message: `Deployment failed: ${message}` },
      });
    }
  });

  /**
   * Get deployment status for an agent
   */
  app.get<{ Params: { id: string } }>('/api/agents/:id/deployment', async (request, reply) => {
    const { id } = request.params;

    const result = await client.execute({
      sql: `SELECT * FROM deployed_agents WHERE agent_id = ? ORDER BY created_at DESC LIMIT 1`,
      args: [id],
    });

    if (result.rows.length === 0) {
      return reply.code(404).send({ error: { code: 'NOT_FOUND', message: 'No deployment found' } });
    }

    const deployment = result.rows[0];

    // Fetch live status from provider if deployed
    let liveStatus = deployment.status as string;
    if (deployment.fly_app_name && deployment.fly_machine_id && !['destroyed', 'error'].includes(liveStatus)) {
      try {
        liveStatus = await provider.getStatus(
          deployment.fly_app_name as string,
          deployment.fly_machine_id as string
        );
        // Update cached status
        await client.execute({
          sql: `UPDATE deployed_agents SET status = ?, updated_at = ? WHERE id = ?`,
          args: [liveStatus, new Date().toISOString(), deployment.id as string],
        });
      } catch {
        // Use cached status on failure
      }
    }

    return {
      data: {
        id: deployment.id,
        agentId: deployment.agent_id,
        flyAppName: deployment.fly_app_name,
        flyMachineId: deployment.fly_machine_id,
        status: liveStatus,
        managementUrl: deployment.management_url,
        modelProvider: deployment.model_provider,
        modelName: deployment.model_name,
        region: deployment.region,
        createdAt: deployment.created_at,
        updatedAt: deployment.updated_at,
      },
    };
  });

  /**
   * Get agent detail with deployment info joined
   */
  app.get<{ Params: { id: string } }>('/api/agents/:id/detail', async (request, reply) => {
    const { id } = request.params;

    const agentResult = await client.execute({
      sql: `SELECT * FROM agents WHERE id = ?`,
      args: [id],
    });
    if (agentResult.rows.length === 0) {
      return reply.code(404).send({ error: { code: 'NOT_FOUND', message: 'Agent not found' } });
    }

    const agent = agentResult.rows[0];
    const deployResult = await client.execute({
      sql: `SELECT * FROM deployed_agents WHERE agent_id = ? AND status NOT IN ('destroyed') ORDER BY created_at DESC LIMIT 1`,
      args: [id],
    });

    const deployment = deployResult.rows.length > 0 ? deployResult.rows[0] : null;

    // Fetch live status if deployed
    let liveStatus = deployment?.status as string | undefined;
    if (deployment?.fly_app_name && deployment?.fly_machine_id && liveStatus && !['destroyed', 'error'].includes(liveStatus)) {
      try {
        liveStatus = await provider.getStatus(
          deployment.fly_app_name as string,
          deployment.fly_machine_id as string
        );
        await client.execute({
          sql: `UPDATE deployed_agents SET status = ?, updated_at = ? WHERE id = ?`,
          args: [liveStatus, new Date().toISOString(), deployment.id as string],
        });
      } catch {
        // Use cached status
      }
    }

    // Mask telegram token: show first 5 and last 3 chars
    let maskedTelegram: string | null = null;
    if (deployment?.telegram_token) {
      const t = deployment.telegram_token as string;
      maskedTelegram = t.length > 10 ? `${t.slice(0, 5)}...${t.slice(-3)}` : '***';
    }

    return {
      data: {
        id: agent.id,
        name: agent.name,
        description: agent.description,
        status: agent.status,
        createdAt: agent.created_at,
        deployment: deployment ? {
          id: deployment.id,
          status: liveStatus || deployment.status,
          flyAppName: deployment.fly_app_name,
          flyMachineId: deployment.fly_machine_id,
          managementUrl: deployment.management_url,
          gatewayToken: deployment.gateway_token,
          telegramToken: maskedTelegram,
          telegramUserId: deployment.telegram_user_id,
          soulMd: deployment.soul_md,
          modelProvider: deployment.model_provider,
          modelName: deployment.model_name,
          region: deployment.region,
          mcpConfigJson: deployment.mcp_config_json,
          createdAt: deployment.created_at,
        } : null,
      },
    };
  });

  /**
   * Update Soul MD and trigger redeploy
   */
  app.put<{ Params: { id: string } }>('/api/agents/:id/soul', async (request, reply) => {
    const { id } = request.params;
    const body = request.body as { soulMd: string };

    const deployment = await getActiveDeployment(id);
    if (!deployment) {
      return reply.code(404).send({ error: { code: 'NOT_FOUND', message: 'No active deployment found' } });
    }

    const now = new Date().toISOString();
    await client.execute({
      sql: `UPDATE deployed_agents SET soul_md = ?, updated_at = ? WHERE id = ?`,
      args: [body.soulMd ?? null, now, deployment.id as string],
    });

    // Trigger redeploy with updated soul
    if (deployment.fly_app_name && deployment.fly_machine_id) {
      try {
        const reinsUrl = process.env.REINS_PUBLIC_URL || config.dashboardUrl;
        const mcpConfigs = [
          { name: 'reins', url: `${reinsUrl}/mcp/${id}`, transport: 'http' },
        ];
        // Add user MCP servers if stored
        if (deployment.mcp_config_json) {
          try {
            const userServers = JSON.parse(deployment.mcp_config_json as string);
            if (Array.isArray(userServers)) mcpConfigs.push(...userServers);
          } catch { /* ignore */ }
        }

        await provider.redeploy(
          deployment.fly_app_name as string,
          deployment.fly_machine_id as string,
          {
            instanceId: deployment.id as string,
            telegramToken: deployment.telegram_token as string,
            telegramUserId: deployment.telegram_user_id as string | undefined,
            mcpConfigs,
            gatewayToken: deployment.gateway_token as string,
            soulMd: body.soulMd,
            modelProvider: deployment.model_provider as string | undefined,
            modelName: deployment.model_name as string | undefined,
            openaiApiKey: deployment.openai_api_key as string | undefined,
            modelCredentials: deployment.model_credentials as string | undefined,
          }
        );

        await client.execute({
          sql: `UPDATE deployed_agents SET status = 'running', updated_at = ? WHERE id = ?`,
          args: [new Date().toISOString(), deployment.id as string],
        });
      } catch (err) {
        const message = err instanceof Error ? err.message : 'Unknown error';
        return reply.code(500).send({
          error: { code: 'REDEPLOY_FAILED', message: `Redeploy failed: ${message}` },
        });
      }
    }

    return { data: { soulMd: body.soulMd, redeployed: true } };
  });

  /**
   * Start a stopped agent deployment
   */
  app.post<{ Params: { id: string } }>('/api/agents/:id/start', async (request, reply) => {
    const { id } = request.params;
    const deployment = await getActiveDeployment(id);
    if (!deployment) {
      return reply.code(404).send({ error: { code: 'NOT_FOUND', message: 'No active deployment found' } });
    }

    try {
      await provider.start(
        deployment.fly_app_name as string,
        deployment.fly_machine_id as string
      );
      await client.execute({
        sql: `UPDATE deployed_agents SET status = 'running', updated_at = ? WHERE id = ?`,
        args: [new Date().toISOString(), deployment.id as string],
      });
      return { data: { status: 'running' } };
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Unknown error';
      return reply.code(500).send({
        error: { code: 'START_FAILED', message },
      });
    }
  });

  /**
   * Stop a running agent deployment
   */
  app.post<{ Params: { id: string } }>('/api/agents/:id/stop', async (request, reply) => {
    const deployment = await getActiveDeployment(request.params.id);
    if (!deployment) {
      return reply.code(404).send({ error: { code: 'NOT_FOUND', message: 'No active deployment found' } });
    }

    try {
      await provider.stop(
        deployment.fly_app_name as string,
        deployment.fly_machine_id as string
      );
      await client.execute({
        sql: `UPDATE deployed_agents SET status = 'stopped', updated_at = ? WHERE id = ?`,
        args: [new Date().toISOString(), deployment.id as string],
      });
      return { data: { status: 'stopped' } };
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Unknown error';
      return reply.code(500).send({
        error: { code: 'STOP_FAILED', message },
      });
    }
  });

  /**
   * Redeploy an agent with updated configuration
   */
  app.post<{ Params: { id: string } }>('/api/agents/:id/redeploy', async (request, reply) => {
    const { id } = request.params;
    const deployment = await getActiveDeployment(id);
    if (!deployment) {
      return reply.code(404).send({ error: { code: 'NOT_FOUND', message: 'No active deployment found' } });
    }

    const body = request.body as {
      telegramToken?: string;
      telegramUserId?: string;
      soulMd?: string;
      modelProvider?: string;
      modelName?: string;
    };

    const reinsUrl = process.env.REINS_PUBLIC_URL || config.dashboardUrl;
    const mcpConfigs = [
      { name: 'reins', url: `${reinsUrl}/mcp/${id}`, transport: 'http' },
    ];

    try {
      const managementUrl = await provider.redeploy(
        deployment.fly_app_name as string,
        deployment.fly_machine_id as string,
        {
          instanceId: deployment.id as string,
          telegramToken: (body?.telegramToken || deployment.telegram_token) as string,
          telegramUserId: body?.telegramUserId || deployment.telegram_user_id as string | undefined,
          mcpConfigs,
          gatewayToken: deployment.gateway_token as string,
          soulMd: body?.soulMd || deployment.soul_md as string | undefined,
          modelProvider: body?.modelProvider || deployment.model_provider as string | undefined,
          modelName: body?.modelName || deployment.model_name as string | undefined,
        }
      );

      const now = new Date().toISOString();
      await client.execute({
        sql: `UPDATE deployed_agents SET status = 'running', management_url = ?, telegram_token = COALESCE(?, telegram_token), telegram_user_id = COALESCE(?, telegram_user_id), soul_md = COALESCE(?, soul_md), model_provider = COALESCE(?, model_provider), model_name = COALESCE(?, model_name), updated_at = ? WHERE id = ?`,
        args: [
          managementUrl,
          body?.telegramToken ?? null,
          body?.telegramUserId ?? null,
          body?.soulMd ?? null,
          body?.modelProvider ?? null,
          body?.modelName ?? null,
          now,
          deployment.id as string,
        ],
      });

      return { data: { status: 'running', managementUrl } };
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Unknown error';
      return reply.code(500).send({
        error: { code: 'REDEPLOY_FAILED', message },
      });
    }
  });

  /**
   * Destroy an agent deployment
   */
  app.delete<{ Params: { id: string } }>('/api/agents/:id/deploy', async (request, reply) => {
    const { id } = request.params;
    const deployment = await getActiveDeployment(id);
    if (!deployment) {
      return reply.code(404).send({ error: { code: 'NOT_FOUND', message: 'No active deployment found' } });
    }

    try {
      await provider.destroy(
        deployment.fly_app_name as string,
        deployment.fly_machine_id as string
      );

      const now = new Date().toISOString();
      await client.execute({
        sql: `UPDATE deployed_agents SET status = 'destroyed', updated_at = ? WHERE id = ?`,
        args: [now, deployment.id as string],
      });
      await client.execute({
        sql: `UPDATE agents SET status = 'pending', updated_at = ? WHERE id = ?`,
        args: [now, id],
      });

      return reply.code(204).send();
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Unknown error';
      return reply.code(500).send({
        error: { code: 'DESTROY_FAILED', message },
      });
    }
  });

  // ========================================================================
  // OpenAI Device Flow Authentication
  // ========================================================================

  /**
   * OpenAI Codex device flow — start or poll.
   * action: "start" initiates the flow, "poll" checks for completion.
   */
  app.post('/api/auth/openai-device', async (request, reply) => {
    const body = request.body as { action: string; deviceAuthId?: string };

    if (body.action === 'start') {
      // Initiate device flow with OpenAI
      try {
        const res = await fetch('https://auth0.openai.com/oauth/device/code', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            client_id: 'pdlLIX2Y72MIl2rhLhTE9VV9bN905kBh',
            scope: 'openid profile email offline_access',
            audience: 'https://api.openai.com/v1',
          }),
        });
        const data = await res.json() as {
          device_code: string;
          user_code: string;
          verification_uri_complete: string;
          interval: number;
          expires_in: number;
        };

        const deviceAuthId = nanoid();
        deviceFlows.set(deviceAuthId, {
          userCode: data.user_code,
          deviceCode: data.device_code,
          verificationUrl: data.verification_uri_complete,
          interval: data.interval || 5,
          expiresAt: Date.now() + (data.expires_in || 300) * 1000,
        });

        // Auto-cleanup after expiry
        setTimeout(() => deviceFlows.delete(deviceAuthId), (data.expires_in || 300) * 1000 + 10000);

        return {
          data: {
            deviceAuthId,
            userCode: data.user_code,
            verificationUrl: data.verification_uri_complete,
            interval: data.interval || 5,
          },
        };
      } catch (err) {
        const message = err instanceof Error ? err.message : 'Unknown error';
        return reply.code(500).send({
          error: { code: 'DEVICE_FLOW_ERROR', message: `Failed to start device flow: ${message}` },
        });
      }
    }

    if (body.action === 'poll') {
      const flow = body.deviceAuthId ? deviceFlows.get(body.deviceAuthId) : null;
      if (!flow) {
        return reply.code(404).send({ error: { code: 'NOT_FOUND', message: 'Device flow not found or expired' } });
      }

      if (flow.tokens) {
        deviceFlows.delete(body.deviceAuthId!);
        return { data: { status: 'complete', tokens: flow.tokens } };
      }

      if (Date.now() > flow.expiresAt) {
        deviceFlows.delete(body.deviceAuthId!);
        return { data: { status: 'expired' } };
      }

      // Poll OpenAI token endpoint
      try {
        const res = await fetch('https://auth0.openai.com/oauth/token', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            grant_type: 'urn:ietf:params:oauth:grant-type:device_code',
            client_id: 'pdlLIX2Y72MIl2rhLhTE9VV9bN905kBh',
            device_code: flow.deviceCode,
          }),
        });

        if (res.ok) {
          const tokens = await res.json();
          const tokensJson = JSON.stringify(tokens);
          flow.tokens = tokensJson;
          return { data: { status: 'complete', tokens: tokensJson } };
        }

        const errBody = await res.json() as { error?: string };
        if (errBody.error === 'authorization_pending') {
          return { data: { status: 'pending' } };
        }
        if (errBody.error === 'slow_down') {
          return { data: { status: 'pending', slowDown: true } };
        }

        return { data: { status: 'error', error: errBody.error } };
      } catch {
        return { data: { status: 'error', error: 'Failed to poll token endpoint' } };
      }
    }

    return reply.code(400).send({ error: { code: 'VALIDATION_ERROR', message: 'action must be "start" or "poll"' } });
  });

  /**
   * Usage webhook — receives token usage reports from deployed agents
   */
  app.post('/api/webhooks/usage', async (request) => {
    const body = request.body as {
      userId: string; // deployment ID
      inputTokens: number;
      outputTokens: number;
    };

    if (body?.userId && (body.inputTokens || body.outputTokens)) {
      // Look up which agent this deployment belongs to
      const deployment = await client.execute({
        sql: `SELECT agent_id FROM deployed_agents WHERE id = ?`,
        args: [body.userId],
      });

      if (deployment.rows.length > 0) {
        const agentId = deployment.rows[0].agent_id as string;
        const now = new Date().toISOString();

        // Rough cost estimate (Sonnet pricing)
        const inputCost = (body.inputTokens / 1_000_000) * 3;
        const outputCost = (body.outputTokens / 1_000_000) * 15;
        const totalCost = inputCost + outputCost;

        await client.execute({
          sql: `INSERT INTO spend_records (agent_id, service_id, amount, currency, recorded_at) VALUES (?, ?, ?, 'USD', ?)`,
          args: [agentId, 'llm', totalCost, now],
        });
      }
    }

    return { ok: true };
  });

  // Helper: get active (non-destroyed, non-error) deployment for an agent
  async function getActiveDeployment(agentId: string) {
    const result = await client.execute({
      sql: `SELECT * FROM deployed_agents WHERE agent_id = ? AND status NOT IN ('destroyed', 'error') ORDER BY created_at DESC LIMIT 1`,
      args: [agentId],
    });
    return result.rows.length > 0 ? result.rows[0] : null;
  }
};
