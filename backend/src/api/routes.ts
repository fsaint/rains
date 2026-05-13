import { FastifyInstance, FastifyPluginAsync } from 'fastify';
import { spawn } from 'child_process';
import { config } from '../config/index.js';
import { client } from '../db/index.js';
import { policyEngine } from '../policy/engine.js';
import { credentialVault } from '../credentials/vault.js';
import { approvalQueue } from '../approvals/queue.js';
import { auditLogger } from '../audit/logger.js';
import { mcpProxy } from '../mcp/proxy.js';
import { serverManager } from '../mcp/server-manager.js';
import { apnsService } from '../notifications/apns.js';
import { telegramNotifier } from '../notifications/telegram.js';
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
  getDrivePathConfig,
  setDrivePathConfig,
  type ToolPermission,
  type PermissionLevel,
  type DrivePathConfig,
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
import { getPostHog } from '../analytics/posthog.js';
import { sendReauthEmail } from '../services/email.js';
import { performBackup, listBackups, getBackup, restoreBackup } from '../services/agent-backup.js';
import { isCodexTokenExpired } from '../services/token-monitor.js';
import { forwardToOpenclaw, handleMyChatMember } from '../services/agent-bot-relay.js';
import { parseWikilinks, updateLinkIndex, ensureMemoryRoot, getDreamManifest, setEntryParent } from '../services/memory.js';
import * as provider from '../providers/index.js';
import { nanoid } from 'nanoid';
import jwt from 'jsonwebtoken';
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

  // Helper to validate onboarding bot API key
  function validateOnboardingApiKey(request: any): boolean {
    const auth = request.headers.authorization as string | undefined;
    return !!config.onboardingApiKey && auth === `Bearer ${config.onboardingApiKey}`;
  }

  const OPENAI_AUTH_BASE = 'https://auth.openai.com';
  const OPENAI_CLIENT_ID = 'app_EMoamEEZ73f0CkXaXp7hrann';

  // ========================================================================
  // Health check
  // ========================================================================

  app.get('/health', async () => {
    return { status: 'ok', timestamp: new Date().toISOString() };
  });

  // ========================================================================
  // Initial prompt templates (public — not sensitive)
  // ========================================================================

  app.get('/api/initial-prompt-templates', async () => {
    const result = await client.execute(`SELECT id, name, content FROM initial_prompt_templates ORDER BY id`);
    return { templates: result.rows.map((r) => ({ id: r.id, name: r.name, content: r.content })) };
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
    getPostHog()?.capture({ distinctId: userId, event: 'agent_created', properties: { source: 'dashboard' } });

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

    // Destroy Fly.io deployment if one exists
    const deployResult = await client.execute({
      sql: `SELECT fly_app_name, fly_machine_id FROM deployed_agents WHERE agent_id = ? AND status NOT IN ('destroyed', 'error')`,
      args: [id],
    });
    for (const dep of deployResult.rows) {
      if (dep.fly_app_name && dep.fly_machine_id) {
        try {
          await provider.destroy(dep.fly_app_name as string, dep.fly_machine_id as string);
        } catch (err) {
          console.warn(`Failed to destroy deployment ${dep.fly_app_name}:`, err);
        }
      }
    }

    await client.execute({
      sql: `DELETE FROM deployed_agents WHERE agent_id = ?`,
      args: [id],
    });
    await client.execute({
      sql: `DELETE FROM agent_tool_permissions WHERE agent_id = ?`,
      args: [id],
    });
    await client.execute({
      sql: `DELETE FROM agent_service_credentials WHERE agent_id = ?`,
      args: [id],
    });
    await client.execute({
      sql: `DELETE FROM agent_service_instances WHERE agent_id = ?`,
      args: [id],
    });
    await client.execute({
      sql: `DELETE FROM agent_service_access WHERE agent_id = ?`,
      args: [id],
    });
    await client.execute({
      sql: `DELETE FROM agent_credentials WHERE agent_id = ?`,
      args: [id],
    });
    await client.execute({
      sql: `DELETE FROM agents WHERE id = ?`,
      args: [id],
    });

    await auditLogger.logAgentEvent(id, 'deleted');
    getPostHog()?.capture({ distinctId: userId, event: 'agent_destroyed', properties: { agentId: id } });

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
  // Drive Path-Based Permissions
  // ========================================================================

  /**
   * GET /api/permissions/:agentId/drive/path-config
   * Returns the Drive default level + path rules for an agent.
   */
  app.get<{ Params: { agentId: string } }>(
    '/api/permissions/:agentId/drive/path-config',
    async (request, _reply) => {
      const { agentId } = request.params;
      const data = await getDrivePathConfig(agentId);
      return { data };
    }
  );

  /**
   * PUT /api/permissions/:agentId/drive/path-config
   * Saves the Drive default level + path rules for an agent.
   */
  app.put<{ Params: { agentId: string }; Body: DrivePathConfig }>(
    '/api/permissions/:agentId/drive/path-config',
    async (request, reply) => {
      const { agentId } = request.params;
      const { defaultLevel, rules } = request.body;
      if (!defaultLevel || !['read', 'write', 'blocked'].includes(defaultLevel)) {
        return reply.code(400).send({ error: { code: 'VALIDATION_ERROR', message: 'defaultLevel must be read, write, or blocked' } });
      }
      await setDrivePathConfig(agentId, { defaultLevel, rules: rules ?? [] });
      const data = await getDrivePathConfig(agentId);
      return { data };
    }
  );

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
    autoRedeployIfDeployed(agentId).catch((err) =>
      console.error('[autoRedeploy] Failed after instance create:', err)
    );
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
    // Enabling/disabling a service changes what's in MCP_CONFIG — trigger redeploy
    if ('enabled' in request.body) {
      autoRedeployIfDeployed(result.agentId).catch((err) =>
        console.error('[autoRedeploy] Failed after instance update:', err)
      );
    }
    return { data: result };
  });

  /**
   * Delete a service instance
   */
  app.delete<{ Params: { instanceId: string } }>(
    '/api/permissions/instances/:instanceId',
    async (request, reply) => {
      const instance = await getInstanceConfig(request.params.instanceId);
      await deleteServiceInstance(request.params.instanceId);
      if (instance) {
        autoRedeployIfDeployed(instance.agentId).catch((err) =>
          console.error('[autoRedeploy] Failed after instance delete:', err)
        );
      }
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
  // Notion Integration Token
  // ========================================================================

  /**
   * Add a Notion internal integration token.
   * Validates the token against the Notion API, resolves the workspace,
   * and stores the credential.
   */
  app.post('/api/credentials/notion', async (request, reply) => {
    const body = request.body as { token?: string } | undefined;
    if (!body?.token) {
      return reply.code(400).send({ error: { code: 'VALIDATION_ERROR', message: 'token is required' } });
    }

    const userId = getUserId(request);

    // Validate token
    let validation: { valid: boolean; botName?: string; workspaceName?: string; error?: string };
    try {
      const { validateNotionToken } = await import('@reins/servers');
      validation = await validateNotionToken(body.token);
    } catch {
      return reply.code(500).send({ error: { code: 'SERVER_ERROR', message: 'Notion validation not available' } });
    }

    if (!validation.valid) {
      return reply.code(401).send({
        error: { code: 'INVALID_TOKEN', message: validation.error || 'Invalid Notion token' },
      });
    }

    // Store credential
    const credId = await credentialVault.storeOAuth({
      serviceId: 'notion',
      accountEmail: validation.workspaceName ?? '',
      accountName: validation.botName,
      userId,
      grantedServices: ['notion'],
      data: {
        accessToken: body.token,
      } as any,
    });

    // Auto-link to all agents that have notion enabled but no credential
    await autoLinkCredential('notion', credId);

    return reply.code(201).send({
      data: {
        id: credId,
        serviceId: 'notion',
        botName: validation.botName,
        workspaceName: validation.workspaceName,
      },
    });
  });

  app.post('/api/credentials/hermeneutix', async (request, reply) => {
    const body = request.body as { token?: string } | undefined;
    if (!body?.token) {
      return reply.code(400).send({ error: { code: 'VALIDATION_ERROR', message: 'token is required' } });
    }

    const userId = getUserId(request);

    // Validate token by hitting the projects list endpoint
    let username: string | undefined;
    try {
      const res = await fetch('https://studio.curl-newton.ts.net/api/mobile/projects/', {
        headers: { Authorization: `Token ${body.token}` },
      });
      if (!res.ok) {
        return reply.code(401).send({ error: { code: 'INVALID_TOKEN', message: 'Invalid Hermeneutix API token' } });
      }
    } catch {
      return reply.code(502).send({ error: { code: 'SERVER_ERROR', message: 'Could not reach Hermeneutix API' } });
    }

    const credId = await credentialVault.storeOAuth({
      serviceId: 'hermeneutix',
      accountEmail: username ?? 'hermeneutix',
      userId,
      grantedServices: ['hermeneutix'],
      data: { accessToken: body.token } as any,
    });

    await autoLinkCredential('hermeneutix', credId);

    return reply.code(201).send({ data: { id: credId, serviceId: 'hermeneutix' } });
  });

  app.post('/api/credentials/zendesk', async (request, reply) => {
    const body = request.body as { token?: string; email?: string; subdomain?: string } | undefined;
    if (!body?.token) {
      return reply.code(400).send({ error: { code: 'VALIDATION_ERROR', message: 'token is required' } });
    }
    if (!body?.email) {
      return reply.code(400).send({ error: { code: 'VALIDATION_ERROR', message: 'email is required' } });
    }
    if (!body?.subdomain) {
      return reply.code(400).send({ error: { code: 'VALIDATION_ERROR', message: 'subdomain is required' } });
    }

    const userId = getUserId(request);
    const basicAuth = Buffer.from(`${body.email}/token:${body.token}`).toString('base64');

    // Validate by fetching the current user profile
    try {
      const res = await fetch(`https://${body.subdomain}.zendesk.com/api/v2/users/me.json`, {
        headers: { Authorization: `Basic ${basicAuth}` },
      });
      if (!res.ok) {
        return reply.code(401).send({ error: { code: 'INVALID_TOKEN', message: 'Invalid Zendesk credentials' } });
      }
    } catch {
      return reply.code(502).send({ error: { code: 'SERVER_ERROR', message: 'Could not reach Zendesk API' } });
    }

    const credId = await credentialVault.storeOAuth({
      serviceId: 'zendesk',
      accountEmail: body.email,
      userId,
      grantedServices: ['zendesk'],
      data: {
        accessToken: body.token,
        email: body.email,
        subdomain: body.subdomain,
      } as any,
    });

    await autoLinkCredential('zendesk', credId);

    return reply.code(201).send({ data: { id: credId, serviceId: 'zendesk' } });
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
    getPostHog()?.capture({ distinctId: userId, event: 'credential_oauth_started', properties: { provider: 'google' } });
    const query = request.query as { services?: string; reconnect?: string; approvalId?: string };

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
        'https://www.googleapis.com/auth/calendar.events',
      ];
      requestedServices = ['gmail', 'drive', 'calendar'];
    }

    const allScopes = [...new Set([...GOOGLE_BASE_SCOPES, ...serviceScopes])];

    // Generate state token for CSRF protection
    const state = nanoid(32);
    await storePendingOAuthFlow(state, {
      service: 'google',
      userId,
      grantedServices: requestedServices,
      reconnectCredentialId: query.reconnect || undefined,
      reauthApprovalId: query.approvalId || undefined,
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
   * Onboarding bot: Generate one-time Gmail OAuth link tied to a Telegram user ID
   */
  app.post('/api/onboarding/oauth/google/link', async (request, reply) => {
    if (!validateOnboardingApiKey(request)) {
      return reply.code(401).send({ error: { code: 'UNAUTHORIZED', message: 'Invalid API key' } });
    }

    const body = request.body as { telegramUserId?: number };
    if (!body?.telegramUserId) {
      return reply.code(400).send({ error: { code: 'INVALID_REQUEST', message: 'telegramUserId is required' } });
    }

    // Check if credential already linked for this Telegram user via account_name prefix
    const existing = await client.execute({
      sql: `SELECT id FROM credentials WHERE account_name LIKE ?`,
      args: [`[tg:${body.telegramUserId}]%`],
    });
    if (existing.rows.length > 0) {
      return reply.code(409).send({ error: { code: 'ALREADY_LINKED', message: 'Gmail already connected for this Telegram user' } });
    }

    if (!config.googleClientId || !config.googleRedirectUri) {
      return reply.code(500).send({ error: { code: 'CONFIG_ERROR', message: 'Google OAuth not configured' } });
    }

    // Generate OAuth state and build URL
    const state = nanoid(32);
    await storePendingOAuthFlow(state, {
      service: 'google',
      telegramUserId: body.telegramUserId,
      grantedServices: ['gmail', 'calendar', 'drive'],
    });

    const params = new URLSearchParams({
      client_id: config.googleClientId,
      redirect_uri: config.googleRedirectUri,
      response_type: 'code',
      scope: 'https://www.googleapis.com/auth/gmail.readonly https://www.googleapis.com/auth/gmail.send https://www.googleapis.com/auth/gmail.compose https://www.googleapis.com/auth/userinfo.email https://www.googleapis.com/auth/userinfo.profile https://www.googleapis.com/auth/calendar.events https://www.googleapis.com/auth/drive.readonly',
      state,
      access_type: 'offline',
      prompt: 'consent',
    });

    const url = `https://accounts.google.com/o/oauth2/v2/auth?${params.toString()}`;
    const expiresAt = new Date(Date.now() + 30 * 60 * 1000).toISOString();

    return { url, expiresAt };
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
      const pendingFlow = await getPendingOAuthFlow(state);
      if (!pendingFlow) {
        return reply.redirect(`${dashboardUrl}/credentials?oauth_error=invalid_state`);
      }

      // Delete the pending flow to prevent replay attacks
      await deletePendingOAuthFlow(state);

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
          await credentialVault.updateGrantedServices(pendingFlow.reconnectCredentialId, grantedServices);

          // Auto-resolve the reauth approval if one was associated with this OAuth flow
          if (pendingFlow.reauthApprovalId) {
            try {
              await approvalQueue.approve(pendingFlow.reauthApprovalId, 'Re-authenticated via OAuth');
            } catch (approvalErr) {
              console.warn('[oauth] Could not auto-approve reauth approval:', approvalErr);
            }
          }

          return reply.redirect(
            `${dashboardUrl}/credentials?oauth_success=true&service=google&email=${encodeURIComponent(userInfo.email)}&reconnected=true`
          );
        }

        if (pendingFlow.telegramUserId) {
          // Onboarding flow: store credential without userId, tag accountName with telegram ID
          await credentialVault.storeOAuth({
            serviceId: 'google',
            accountEmail: userInfo.email,
            accountName: `[tg:${pendingFlow.telegramUserId}] ${userInfo.name ?? userInfo.email}`,
            userId: undefined,
            grantedServices,
            data: tokenData,
          });

          // Fire webhook to onboarding bot if configured
          if (config.onboardingBotWebhookUrl && config.onboardingBotWebhookSecret) {
            fetch(`${config.onboardingBotWebhookUrl}/webhook/oauth-complete`, {
              method: 'POST',
              headers: {
                'Content-Type': 'application/json',
                Authorization: `Bearer ${config.onboardingBotWebhookSecret}`,
              },
              body: JSON.stringify({
                telegramUserId: pendingFlow.telegramUserId,
                email: userInfo.email,
                success: true,
              }),
            }).catch((err) => console.error('[onboarding] webhook fire failed:', err));
          }

          return reply.redirect(`${dashboardUrl}/oauth-complete?success=true`);
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

        if (pendingFlow.userId) {
          getPostHog()?.capture({ distinctId: pendingFlow.userId, event: 'credential_connected', properties: { provider: 'google', services: grantedServices } });
        }

        // Redirect back to credentials page with success
        return reply.redirect(
          `${dashboardUrl}/credentials?oauth_success=true&service=google&email=${encodeURIComponent(userInfo.email)}`
        );
      } catch (err) {
        console.error('OAuth callback error:', err);
        return reply.redirect(`${dashboardUrl}/credentials?oauth_error=internal_error`);
      }
    }
  );

  /**
   * Onboarding bot: Generate a signed JWT setup link for a Telegram user
   */
  app.post('/api/onboarding/auth/setup-link', async (request, reply) => {
    if (!validateOnboardingApiKey(request)) {
      return reply.code(401).send({ error: { code: 'UNAUTHORIZED', message: 'Invalid API key' } });
    }

    const body = request.body as { telegramUserId?: number };
    if (!body?.telegramUserId) {
      return reply.code(400).send({ error: { code: 'INVALID_REQUEST', message: 'telegramUserId is required' } });
    }

    // Find linked user by telegram_user_id
    const userResult = await client.execute({
      sql: `SELECT id, email FROM users WHERE telegram_user_id = ?`,
      args: [String(body.telegramUserId)],
    });

    // Also look up the Gmail credential for email via account_name prefix
    const credResult = await client.execute({
      sql: `SELECT account_email FROM credentials WHERE account_name LIKE ? ORDER BY created_at DESC LIMIT 1`,
      args: [`[tg:${body.telegramUserId}]%`],
    });

    const email = (userResult.rows[0]?.email as string | undefined)
      ?? (credResult.rows[0]?.account_email as string | undefined);

    if (!email) {
      return reply.code(404).send({ error: { code: 'NOT_FOUND', message: 'No linked account for this Telegram user' } });
    }

    const userId = userResult.rows[0]?.id as string | undefined;

    const payload = {
      telegramUserId: body.telegramUserId,
      email,
      userId,
      type: 'setup',
    };

    const token = jwt.sign(payload, config.sessionSecret, { expiresIn: '24h' });
    const url = `${config.dashboardUrl}/setup?token=${token}`;
    const expiresAt = new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString();

    return { url, expiresAt };
  });

  /**
   * Onboarding bot: Get deployment status
   */
  app.get<{ Params: { deploymentId: string } }>(
    '/api/onboarding/deployments/:deploymentId/status',
    async (request, reply) => {
      if (!validateOnboardingApiKey(request)) {
        return reply.code(401).send({ error: { code: 'UNAUTHORIZED', message: 'Invalid API key' } });
      }

      const { deploymentId } = request.params;
      const result = await client.execute({
        sql: `SELECT id, agent_id, status, fly_app_name, updated_at FROM deployed_agents WHERE id = ?`,
        args: [deploymentId],
      });

      if (result.rows.length === 0) {
        return reply.code(404).send({ error: { code: 'NOT_FOUND', message: 'Deployment not found' } });
      }

      const row = result.rows[0];
      return {
        deploymentId: row.id,
        status: row.status,
        agentId: row.agent_id,
        appName: row.fly_app_name,
        updatedAt: row.updated_at,
      };
    }
  );

  // DELETE /api/onboarding/users/:telegramUserId/credentials — clear credentials for a Telegram user (dev/reset use)
  app.delete('/api/onboarding/users/:telegramUserId/credentials', async (request, reply) => {
    if (!validateOnboardingApiKey(request)) {
      return reply.code(401).send({ error: { code: 'UNAUTHORIZED', message: 'Invalid API key' } });
    }
    const { telegramUserId } = request.params as { telegramUserId: string };
    await client.execute({
      sql: `DELETE FROM credentials WHERE account_name LIKE ?`,
      args: [`[tg:${telegramUserId}]%`],
    });
    return { ok: true };
  });

  // ========================================================================
  // OAuth - Microsoft (Outlook Mail, Outlook Calendar)
  // ========================================================================

  const MICROSOFT_BASE_SCOPES = ['openid', 'profile', 'email', 'offline_access', 'User.Read'];

  /**
   * Initiate Microsoft OAuth flow
   * Accepts optional `services` query param (comma-separated) to request specific scopes.
   * Example: /api/oauth/microsoft?services=outlook_mail,outlook_calendar
   */
  app.get('/api/oauth/microsoft', async (request, reply) => {
    if (!config.microsoftClientId || !config.microsoftRedirectUri) {
      return reply.code(500).send({
        error: {
          code: 'CONFIG_ERROR',
          message: 'Microsoft OAuth is not configured. Set MICROSOFT_CLIENT_ID and MICROSOFT_REDIRECT_URI in .env file.',
        },
      });
    }

    const userId = getUserId(request);
    const query = request.query as { services?: string; reconnect?: string; approvalId?: string };

    // Build scopes from requested services
    let serviceScopes: string[] = [];
    let requestedServices: string[] = [];

    try {
      const { serviceDefinitions } = await import('@reins/servers');
      const msServices = serviceDefinitions.filter((d) => (d.category as string) === 'microsoft');

      if (query.services) {
        requestedServices = query.services.split(',').map((s) => s.trim());
        for (const svcType of requestedServices) {
          const def = msServices.find((d) => d.type === svcType);
          if (def?.auth.oauthScopes) {
            serviceScopes.push(...def.auth.oauthScopes);
          }
        }
      }

      // Default: request all Microsoft service scopes
      if (serviceScopes.length === 0) {
        requestedServices = msServices.map((d) => d.type);
        for (const def of msServices) {
          if (def.auth.oauthScopes) {
            serviceScopes.push(...def.auth.oauthScopes);
          }
        }
      }
    } catch {
      // Fallback if registry unavailable
      serviceScopes = [
        'https://graph.microsoft.com/User.Read',
        'https://graph.microsoft.com/Mail.Read',
        'https://graph.microsoft.com/Mail.ReadWrite',
        'https://graph.microsoft.com/Mail.Send',
        'https://graph.microsoft.com/Calendars.Read',
        'https://graph.microsoft.com/Calendars.ReadWrite',
      ];
      requestedServices = ['outlook_mail', 'outlook_calendar'];
    }

    const allScopes = [...new Set([...MICROSOFT_BASE_SCOPES, ...serviceScopes])];

    // Generate state token for CSRF protection
    const state = nanoid(32);
    await storePendingOAuthFlow(state, {
      service: 'microsoft',
      userId,
      grantedServices: requestedServices,
      reconnectCredentialId: query.reconnect || undefined,
      reauthApprovalId: query.approvalId || undefined,
    });

    const tenantId = config.microsoftTenantId || 'common';
    const params = new URLSearchParams({
      client_id: config.microsoftClientId,
      redirect_uri: config.microsoftRedirectUri,
      response_type: 'code',
      scope: allScopes.join(' '),
      state,
      response_mode: 'query',
    });

    const authUrl = `https://login.microsoftonline.com/${tenantId}/oauth2/v2.0/authorize?${params.toString()}`;

    return { data: { authUrl, state } };
  });

  /**
   * Microsoft OAuth callback
   */
  app.get<{ Querystring: { code?: string; state?: string; error?: string; error_description?: string } }>(
    '/api/oauth/microsoft/callback',
    async (request, reply) => {
      const { code, state, error, error_description } = request.query;
      const dashboardUrl = config.dashboardUrl;

      if (error) {
        return reply.redirect(`${dashboardUrl}/credentials?oauth_error=${encodeURIComponent(error_description || error)}`);
      }

      if (!code || !state) {
        return reply.redirect(`${dashboardUrl}/credentials?oauth_error=missing_params`);
      }

      const pendingFlow = await getPendingOAuthFlow(state);
      if (!pendingFlow) {
        return reply.redirect(`${dashboardUrl}/credentials?oauth_error=invalid_state`);
      }

      await deletePendingOAuthFlow(state);

      if (!config.microsoftClientId || !config.microsoftClientSecret || !config.microsoftRedirectUri) {
        return reply.redirect(`${dashboardUrl}/credentials?oauth_error=config_error`);
      }

      try {
        const tenantId = config.microsoftTenantId || 'common';

        // Exchange code for tokens
        const tokenResponse = await fetch(`https://login.microsoftonline.com/${tenantId}/oauth2/v2.0/token`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
          body: new URLSearchParams({
            client_id: config.microsoftClientId!,
            client_secret: config.microsoftClientSecret!,
            code,
            grant_type: 'authorization_code',
            redirect_uri: config.microsoftRedirectUri,
          }),
        });

        if (!tokenResponse.ok) {
          const errorData = await tokenResponse.json().catch(() => ({}));
          console.error('Microsoft token exchange failed:', errorData);
          return reply.redirect(`${dashboardUrl}/credentials?oauth_error=token_exchange_failed`);
        }

        const tokens = await tokenResponse.json() as {
          access_token: string;
          refresh_token?: string;
          expires_in: number;
          token_type: string;
        };

        // Fetch user info from Microsoft Graph
        const userInfoResponse = await fetch('https://graph.microsoft.com/v1.0/me?$select=displayName,mail,userPrincipalName', {
          headers: { Authorization: `Bearer ${tokens.access_token}` },
        });

        if (!userInfoResponse.ok) {
          return reply.redirect(`${dashboardUrl}/credentials?oauth_error=userinfo_failed`);
        }

        const userInfo = await userInfoResponse.json() as {
          mail?: string;
          userPrincipalName: string;
          displayName?: string;
        };

        const email = userInfo.mail || userInfo.userPrincipalName;
        const expiresAt = new Date(Date.now() + tokens.expires_in * 1000);

        const tokenData = {
          accessToken: tokens.access_token,
          refreshToken: tokens.refresh_token,
          expiresAt,
          tokenType: tokens.token_type,
        };

        const grantedServices = pendingFlow.grantedServices ?? ['outlook_mail', 'outlook_calendar'];

        if (pendingFlow.reconnectCredentialId) {
          await credentialVault.update(pendingFlow.reconnectCredentialId, tokenData);
          await credentialVault.updateGrantedServices(pendingFlow.reconnectCredentialId, grantedServices);

          // Auto-resolve the reauth approval if one was associated with this OAuth flow
          if (pendingFlow.reauthApprovalId) {
            try {
              await approvalQueue.approve(pendingFlow.reauthApprovalId, 'Re-authenticated via OAuth');
            } catch (approvalErr) {
              console.warn('[oauth] Could not auto-approve reauth approval:', approvalErr);
            }
          }

          return reply.redirect(
            `${dashboardUrl}/credentials?oauth_success=true&service=microsoft&email=${encodeURIComponent(email)}&reconnected=true`
          );
        }

        // Store new credential
        const credId = await credentialVault.storeOAuth({
          serviceId: 'microsoft',
          accountEmail: email,
          accountName: userInfo.displayName,
          userId: pendingFlow.userId,
          grantedServices,
          data: tokenData,
        });

        // Auto-link to agents
        for (const svc of grantedServices) {
          await autoLinkCredential(svc, credId);
        }

        return reply.redirect(
          `${dashboardUrl}/credentials?oauth_success=true&service=microsoft&email=${encodeURIComponent(email)}`
        );
      } catch (err) {
        console.error('Microsoft OAuth callback error:', err);
        return reply.redirect(`${dashboardUrl}/credentials?oauth_error=internal_error`);
      }
    }
  );

  // ========================================================================
  // Approvals
  // ========================================================================

  app.get('/api/approvals', async (request) => {
    const query = request.query as { agentId?: string };
    const session = getSession(request);
    const userId = session?.userId ?? '';

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

    // Build a scoped query that applies user ownership filter in SQL,
    // before pagination, so LIMIT/OFFSET work correctly.
    const scopedAgentId = filter.agentId && userAgentIds.includes(filter.agentId)
      ? filter.agentId
      : null;

    // If the user has no agents and no specific agentId filter, return empty result fast.
    if (userAgentIds.length === 0 && !scopedAgentId) {
      return {
        data: [],
        pagination: { total: 0, limit: filter.limit, offset: filter.offset, hasMore: false },
      };
    }

    let whereSql: string;
    const whereArgs: (string | number)[] = [];

    if (scopedAgentId) {
      whereSql = `WHERE agent_id = ?`;
      whereArgs.push(scopedAgentId);
    } else {
      whereSql = `WHERE (agent_id IS NULL OR agent_id IN (${userAgentIds.map(() => '?').join(',')}))`;
      whereArgs.push(...userAgentIds);
    }

    if (filter.eventType) {
      whereSql += ` AND event_type = ?`;
      whereArgs.push(filter.eventType);
    }
    if (filter.tool) {
      whereSql += ` AND tool = ?`;
      whereArgs.push(filter.tool);
    }
    if (filter.result) {
      whereSql += ` AND result = ?`;
      whereArgs.push(filter.result);
    }
    if (filter.startDate) {
      whereSql += ` AND timestamp >= ?`;
      whereArgs.push(filter.startDate.toISOString());
    }
    if (filter.endDate) {
      whereSql += ` AND timestamp <= ?`;
      whereArgs.push(filter.endDate.toISOString());
    }

    // Count total matching rows (without pagination)
    const countResult = await client.execute({
      sql: `SELECT COUNT(*) as count FROM audit_log ${whereSql}`,
      args: whereArgs,
    });
    const total = Number(countResult.rows[0]?.count ?? 0);

    // Fetch the page
    const dataResult = await client.execute({
      sql: `SELECT * FROM audit_log ${whereSql} ORDER BY timestamp DESC LIMIT ? OFFSET ?`,
      args: [...whereArgs, filter.limit, filter.offset],
    });

    // Map raw rows to AuditEntry shape
    const entries = dataResult.rows.map((row: any) => ({
      id: row.id,
      timestamp: row.timestamp,
      eventType: row.event_type,
      agentId: row.agent_id ?? undefined,
      tool: row.tool ?? undefined,
      arguments: row.arguments_json ? JSON.parse(row.arguments_json) : undefined,
      result: row.result ?? undefined,
      durationMs: row.duration_ms ?? undefined,
      metadata: row.metadata_json ? JSON.parse(row.metadata_json) : undefined,
    }));

    // Build agent name lookup
    const agentIds = [...new Set(entries.map((e: any) => e.agentId).filter(Boolean))];
    const agentNameMap: Record<string, string> = {};
    if (agentIds.length > 0) {
      const agentRows = await client.execute({
        sql: `SELECT id, name FROM agents WHERE id IN (${agentIds.map(() => '?').join(',')})`,
        args: agentIds,
      });
      for (const row of agentRows.rows) {
        agentNameMap[row.id as string] = row.name as string;
      }
    }

    const enrichedEntries = entries.map((e: any) => ({
      ...e,
      agentName: e.agentId ? agentNameMap[e.agentId] || null : null,
    }));

    return {
      data: enrichedEntries,
      pagination: {
        total,
        limit: filter.limit,
        offset: filter.offset,
        hasMore: filter.offset + filter.limit < total,
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

      // For tools/call, use SSE (text/event-stream) so periodic keep-alive
      // comments prevent Cloudflare's 100s proxy timeout from killing the
      // connection while the user resolves an approval (up to 5 minutes).
      // The MCP Streamable HTTP spec allows SSE responses to POST requests;
      // the official MCP SDK client handles both content-types.
      if (body.method === 'tools/call') {
        reply.raw.writeHead(200, {
          'Content-Type': 'text/event-stream',
          'Cache-Control': 'no-cache',
          'Connection': 'keep-alive',
          'X-Accel-Buffering': 'no', // disable nginx/Cloudflare response buffering
        });

        // Send keep-alive SSE comments every 25s (well under Cloudflare's 100s limit)
        const keepAlive = setInterval(() => {
          reply.raw.write(': keep-alive\n\n');
        }, 25000);

        try {
          const response = await handleMCPRequest(agentId, body);
          // MCP Streamable HTTP SSE format: event name + data line
          reply.raw.write(`event: message\ndata: ${JSON.stringify(response)}\n\n`);
        } finally {
          clearInterval(keepAlive);
          reply.raw.end();
        }
        return;
      }

      // All other MCP methods (initialize, tools/list, ping, etc.) — plain JSON
      const response = await handleMCPRequest(agentId, body);
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
  // ============================================================================
  // Provisioning error classification + reauth approvals
  // ============================================================================

  type ReauthProvider = 'anthropic' | 'openai-codex' | 'openai' | 'minimax' | 'fly' | 'unknown';

  function classifyProvisionError(err: unknown, modelProvider?: string): {
    isAuth: boolean;
    provider: ReauthProvider;
    hint: string;
  } {
    const msg = (err instanceof Error ? err.message : String(err)).toLowerCase();

    const authPatterns = [
      'unauthorized', 'authentication', 'invalid.*key', 'invalid.*token',
      'expired', '401', '403', 'forbidden', 'permission denied',
      'invalid_api_key', 'invalid_request_error', 'sk-ant', 'oat01',
    ];
    const isAuth = authPatterns.some((p) => new RegExp(p).test(msg));

    let provider: ReauthProvider = 'unknown';
    if (isAuth) {
      if (modelProvider === 'openai-codex' || /codex/.test(msg)) {
        provider = 'openai-codex';
      } else if (modelProvider === 'openai' || /openai/.test(msg)) {
        provider = 'openai';
      } else if (modelProvider === 'minimax' || /minimax/.test(msg)) {
        provider = 'minimax';
      } else if (modelProvider === 'anthropic' || /anthropic|claude/.test(msg)) {
        provider = 'anthropic';
      } else if (/fly\.io|fly api/.test(msg)) {
        provider = 'fly';
      } else {
        provider = modelProvider as ReauthProvider ?? 'unknown';
      }
    } else if (/fly\.io|fly api/.test(msg)) {
      provider = 'fly';
    }

    const hints: Record<ReauthProvider, string> = {
      'anthropic': 'Your Claude setup token may have expired. Run `claude setup-token` and reconnect.',
      'openai-codex': 'Your OpenAI credentials have expired. Reconnect via the OpenAI device flow.',
      'openai': 'Your OpenAI API key may be invalid or expired. Please update your OpenAI API key.',
      'minimax': 'Your MiniMax API key may be invalid or expired. Please update your MiniMax API key.',
      'fly': 'Fly.io authentication failed. Check your FLY_API_TOKEN.',
      'unknown': 'Provisioning failed. Please re-authenticate and try again.',
    };

    return { isAuth, provider, hint: hints[provider] };
  }

  async function createReauthApproval(
    agentId: string,
    deploymentId: string,
    reauthProvider: ReauthProvider,
    hint: string,
    errorMessage: string,
  ): Promise<string> {
    const { id: approvalId, isNew, emailThrottled } = await approvalQueue.submitReauth(
      agentId,
      reauthProvider,
      `${hint}\n\nError: ${errorMessage}`,
      { deploymentId },
      7 * 24 * 60 * 60 * 1000,
    );

    if (isNew) {
      console.log(`[reauth] Created reauth approval ${approvalId} for agent ${agentId} (provider: ${reauthProvider})`);
    } else {
      console.log(`[reauth] Reusing existing reauth approval ${approvalId} for agent ${agentId}${emailThrottled ? ' (email throttled)' : ''}`);
    }

    if (!emailThrottled) {
      try {
        const agentRow = await client.execute({
          sql: `SELECT a.name, u.email FROM agents a JOIN users u ON u.id = a.user_id WHERE a.id = ?`,
          args: [agentId],
        });
        if (agentRow.rows.length > 0) {
          const { name: agentName, email } = agentRow.rows[0] as { name: string; email: string };
          await sendReauthEmail({
            to: email,
            agentName,
            provider: reauthProvider,
            hint,
            approvalId,
            dashboardUrl: config.dashboardUrl,
          });
          await approvalQueue.markEmailSent(approvalId);
        }
      } catch (emailErr) {
        console.warn('[reauth] Failed to send email notification:', emailErr);
      }
    }

    return approvalId;
  }

  // Agent Deployment (Fly.io / Docker provisioning)
  // ========================================================================

  /**
   * Create a manual (BYO) agent — no container provisioned.
   * Just creates the agent + a deployed_agents record with is_manual=1 and status=running.
   * The user copies the MCP URL and configures their own agent runtime.
   */
  app.post('/api/agents/create-manual', async (request, reply) => {
    const userId = getUserId(request);
    const body = request.body as {
      name: string;
      description?: string;
      soulMd?: string;
    };

    if (!body.name?.trim()) {
      return reply.code(400).send({ error: { code: 'INVALID_INPUT', message: 'Agent name is required' } });
    }

    const agentId = nanoid();
    const deploymentId = nanoid();
    const gatewayToken = nanoid(32);
    const now = new Date().toISOString();

    // Create agent record
    await client.execute({
      sql: `INSERT INTO agents (id, user_id, name, description, status, created_at, updated_at)
            VALUES (?, ?, ?, ?, 'active', ?, ?)`,
      args: [agentId, userId, body.name.trim(), body.description || null, now, now],
    });

    // Create deployment record — no fly app, no machine, is_manual=1
    await client.execute({
      sql: `INSERT INTO deployed_agents
              (id, agent_id, status, gateway_token, soul_md, is_manual, created_at, updated_at)
            VALUES (?, ?, 'running', ?, ?, 1, ?, ?)`,
      args: [deploymentId, agentId, gatewayToken, body.soulMd || null, now, now],
    });

    return reply.code(201).send({
      data: {
        id: agentId,
        name: body.name.trim(),
        status: 'active',
        deployment: {
          id: deploymentId,
          status: 'running',
          isManual: true,
          gatewayToken,
        },
      },
    });
  });

  /**
   * Combined create + deploy in one step.
   * Creates an agent record and immediately provisions it.
   */
  app.post('/api/agents/create-and-deploy', async (request, reply) => {
    const body = request.body as {
      name: string;
      description?: string;
      telegramToken?: string;
      telegramUserId?: string;
      modelProvider?: string;
      modelName?: string;
      soulMd?: string;
      region?: string;
      openaiApiKey?: string;
      telegramGroups?: provider.TelegramGroup[];
      modelCredentials?: string;
      mcpServers?: string;
      runtime?: 'openclaw' | 'hermes';
      onboardingTelegramUserId?: number;
      initialPrompt?: string;
    };

    // Dual auth: API key (onboarding bot) or session
    let userId: string;
    if (validateOnboardingApiKey(request) && body.onboardingTelegramUserId) {
      // Onboarding flow: look up or create user by telegram user ID
      const existing = await client.execute({
        sql: `SELECT id FROM users WHERE telegram_user_id = ?`,
        args: [String(body.onboardingTelegramUserId)],
      });
      if (existing.rows.length > 0) {
        userId = existing.rows[0].id as string;
      } else {
        // Create a placeholder user; they'll set their password via setup-link
        const credResult = await client.execute({
          sql: `SELECT account_email FROM credentials WHERE account_name LIKE ? LIMIT 1`,
          args: [`[tg:${body.onboardingTelegramUserId}]%`],
        });
        const email = (credResult.rows[0]?.account_email as string | undefined) ?? `telegram_${body.onboardingTelegramUserId}@agenthelm.local`;

        // Check if a user with this email already exists (e.g. from a prior SSO login)
        const byEmail = await client.execute({
          sql: `SELECT id FROM users WHERE email = ?`,
          args: [email],
        });
        if (byEmail.rows.length > 0) {
          // Link the existing user to this Telegram ID and reuse it
          userId = byEmail.rows[0].id as string;
          await client.execute({
            sql: `UPDATE users SET telegram_user_id = ?, updated_at = ? WHERE id = ?`,
            args: [String(body.onboardingTelegramUserId), new Date().toISOString(), userId],
          });
        } else {
          const newUserId = nanoid();
          const now2 = new Date().toISOString();
          const passwordHash = await (await import('bcryptjs')).default.hash(nanoid(32), 10);
          await client.execute({
            sql: `INSERT INTO users (id, email, name, password_hash, role, status, telegram_user_id, created_at, updated_at) VALUES (?, ?, ?, ?, 'user', 'active', ?, ?, ?)`,
            args: [newUserId, email, body.name.trim(), passwordHash, String(body.onboardingTelegramUserId), now2, now2],
          });
          userId = newUserId;
        }
      }
      // Sync notify_chat_id from applicants → users.telegram_chat_id so that
      // approval notifications route to the user via @AgentHelmApprovalsBot
      try {
        const notifyResult = await client.execute({
          sql: `SELECT notify_chat_id FROM applicants WHERE telegram_user_id = ?`,
          args: [body.onboardingTelegramUserId],
        });
        const notifyChatId = notifyResult.rows[0]?.notify_chat_id as string | null;
        if (notifyChatId) {
          await client.execute({
            sql: `UPDATE users SET telegram_chat_id = ?, updated_at = ? WHERE id = ?`,
            args: [notifyChatId, new Date().toISOString(), userId],
          });
          console.log(`[create-and-deploy] linked telegram_chat_id=${notifyChatId} for user ${userId}`);
        }
      } catch (err) {
        console.warn('[create-and-deploy] could not sync notify_chat_id:', err instanceof Error ? err.message : err);
      }
      // Claim Telegram-originated credentials: associate them with the resolved user
      // so they appear on the dashboard's Credentials page.
      try {
        await client.execute({
          sql: `UPDATE credentials SET user_id = ? WHERE account_name LIKE ? AND user_id IS NULL`,
          args: [userId, `[tg:${body.onboardingTelegramUserId}]%`],
        });
      } catch (err) {
        console.warn('[create-and-deploy] could not claim telegram credentials:', err instanceof Error ? err.message : err);
      }
    } else {
      const session = getSession(request);
      if (!session) {
        return reply.code(401).send({ error: { code: 'UNAUTHORIZED', message: 'Not authenticated' } });
      }
      userId = session.userId;
    }

    // Validate telegram group chat IDs (must be numeric) and topic prompts
    if (body.telegramGroups) {
      for (const g of body.telegramGroups) {
        if (!/^-?\d+$/.test(g.chatId)) {
          return reply.code(400).send({ error: { code: 'VALIDATION_ERROR', message: `Invalid chatId "${g.chatId}": must be a numeric Telegram chat ID (e.g. -1001234567890)` } });
        }
        if (g.topicPrompts) {
          if (g.topicPrompts.length > 50) {
            return reply.code(400).send({ error: { code: 'VALIDATION_ERROR', message: `Too many topic prompts for chat ${g.chatId}: max 50` } });
          }
          for (const tp of g.topicPrompts) {
            if (!Number.isInteger(tp.threadId) || tp.threadId <= 0) {
              return reply.code(400).send({ error: { code: 'VALIDATION_ERROR', message: `Invalid threadId ${tp.threadId}: must be a positive integer` } });
            }
            if (!tp.prompt || tp.prompt.trim().length === 0) {
              return reply.code(400).send({ error: { code: 'VALIDATION_ERROR', message: `Topic prompt for threadId ${tp.threadId} must not be empty` } });
            }
            if (tp.prompt.length > 50000) {
              return reply.code(400).send({ error: { code: 'VALIDATION_ERROR', message: `Topic prompt for threadId ${tp.threadId} exceeds 50,000 character limit` } });
            }
          }
        }
      }
    }

    if (!body?.name?.trim()) {
      return reply.code(400).send({ error: { code: 'VALIDATION_ERROR', message: 'name is required' } });
    }

    // Shared bot mode: use platform token when no user token provided
    const isSharedBot = !body?.telegramToken?.trim() && !!config.sharedBotToken;
    if (!isSharedBot && !body?.telegramToken?.trim()) {
      return reply.code(400).send({ error: { code: 'VALIDATION_ERROR', message: 'telegramToken is required (or enable shared bot mode)' } });
    }
    const effectiveTelegramToken = isSharedBot ? config.sharedBotToken! : body.telegramToken;

    // Normalize empty strings to null
    const telegramUserId = body.telegramUserId?.trim() || null;
    const openaiApiKey = body.openaiApiKey?.trim() || null;

    if (isSharedBot && !telegramUserId) {
      return reply.code(400).send({
        error: { code: 'MISSING_TELEGRAM_USER_ID', message: 'Telegram User ID is required for shared bot agents.' },
      });
    }

    // Shared bot: enforce one-per-user limit — second agent must use their own token
    if (isSharedBot && telegramUserId) {
      const existing = await client.execute({
        sql: `SELECT id FROM deployed_agents WHERE telegram_user_id = ? AND is_shared_bot = 1 LIMIT 1`,
        args: [telegramUserId],
      });
      if (existing.rows.length > 0) {
        return reply.code(400).send({
          error: {
            code: 'SHARED_BOT_LIMIT_REACHED',
            message: 'You already have an agent on the shared bot. Provide your own Telegram bot token to create another.',
          },
        });
      }
    }

    // Resolve bot username via getMe (validates custom tokens; shared bot: non-fatal)
    let botUsername: string | undefined;
    try {
      const tgRes = await fetch(`https://api.telegram.org/bot${effectiveTelegramToken}/getMe`);
      const tgData = await tgRes.json() as { ok: boolean; result?: { username?: string } };
      if (!tgData.ok && !isSharedBot) {
        return reply.code(400).send({ error: { code: 'VALIDATION_ERROR', message: 'Invalid Telegram bot token' } });
      }
      botUsername = tgData.result?.username;
    } catch {
      if (!isSharedBot) {
        return reply.code(400).send({ error: { code: 'VALIDATION_ERROR', message: 'Failed to validate Telegram token' } });
      }
      // shared bot: getMe failure is non-fatal, username stays undefined
    }

    // Reject deploys with an already-expired Codex token
    if (body.modelProvider === 'openai-codex' && body.modelCredentials) {
      if (isCodexTokenExpired(body.modelCredentials)) {
        return reply.code(400).send({
          error: {
            code: 'CODEX_TOKEN_EXPIRED',
            message: 'The OpenAI Codex token has expired. Please re-authenticate before deploying.',
          },
        });
      }
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
    const webhookRelaySecret = nanoid(32);
    const now = new Date().toISOString();

    // Resolve model name — ensure it matches the selected provider
    const resolvedModelName = (() => {
      const mp = body.modelProvider ?? 'anthropic';
      const mn = body.modelName?.trim() ?? '';
      if (mp === 'openai-codex') {
        // Reject Claude model names for OpenAI provider
        return mn && !mn.startsWith('claude-') ? mn : 'gpt-5.4';
      }
      if (mp === 'minimax') {
        return mn || 'MiniMax-M2.7';
      }
      if (mp === 'openai') {
        return mn || 'gpt-4.1';
      }
      // Reject OpenAI model names for Anthropic provider
      return mn && mn.startsWith('claude-') ? mn : 'claude-sonnet-4-5';
    })();

    // Create agent record
    await client.execute({
      sql: `INSERT INTO agents (id, user_id, name, description, status, created_at, updated_at) VALUES (?, ?, ?, ?, 'active', ?, ?)`,
      args: [agentId, userId, body.name.trim(), body.description?.trim() ?? null, now, now],
    });

    // Build MCP configs
    const reinsUrl = config.publicUrl || config.dashboardUrl;
    const mcpConfigs = [
      { name: 'reins', url: `${reinsUrl}/mcp/${agentId}`, transport: 'http' },
      ...userMcpServers,
    ];

    // For shared bot, use the configured webhook secret instead of a per-deployment one
    const effectiveWebhookSecret = isSharedBot
      ? (config.sharedBotWebhookSecret ?? webhookRelaySecret)
      : webhookRelaySecret;

    try {
      const result = await provider.provision({
        instanceId: deploymentId,
        telegramToken: effectiveTelegramToken,
        telegramUserId: telegramUserId ?? undefined,
        mcpConfigs,
        gatewayToken,
        soulMd: body.soulMd,
        modelProvider: body.modelProvider,
        modelName: resolvedModelName,
        region: body.region,
        openaiApiKey: openaiApiKey ?? undefined,
        telegramGroups: body.telegramGroups,
        modelCredentials: body.modelCredentials,
        webhookRelaySecret: effectiveWebhookSecret,
        runtime: body.runtime ?? 'openclaw',
        initialPrompt: body.initialPrompt,
        isSharedBot,
      });

      const telegramGroupsJson = body.telegramGroups && body.telegramGroups.length > 0
        ? JSON.stringify(body.telegramGroups)
        : null;

      // openclaw_webhook_url = the machine's port-8443 endpoint that Reins forwards updates TO.
      // Hermes mirrors the path from TELEGRAM_WEBHOOK_URL on its own webhook server — so the
      // forwarding URL must use the same path that was registered with Telegram.
      const isHermesRuntime = (body.runtime ?? 'openclaw') === 'hermes';
      const openclawWebhookUrl = result.appName
        ? isHermesRuntime
          ? isSharedBot
            ? `https://${result.appName}.fly.dev:8443/api/webhooks/shared-bot`
            : `https://${result.appName}.fly.dev:8443/api/webhooks/agent-bot/${deploymentId}`
          : `https://${result.appName}.fly.dev:8443/telegram-webhook`
        : null;

      await client.execute({
        sql: `INSERT INTO deployed_agents (id, agent_id, fly_app_name, fly_machine_id, status, management_url, telegram_token, telegram_bot_username, telegram_user_id, soul_md, model_provider, model_name, region, gateway_token, openai_api_key, telegram_groups_json, model_credentials, mcp_config_json, openclaw_webhook_url, webhook_relay_secret, runtime, initial_prompt, is_shared_bot, fly_volume_id, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        args: [
          deploymentId, agentId,
          result.appName, result.machineId, 'running', result.managementUrl,
          effectiveTelegramToken, botUsername ?? null, telegramUserId,
          body.soulMd ?? null,
          body.modelProvider ?? 'anthropic', resolvedModelName,
          body.region ?? 'iad', gatewayToken,
          openaiApiKey, telegramGroupsJson,
          body.modelCredentials ?? null,
          body.mcpServers ?? null,
          openclawWebhookUrl, effectiveWebhookSecret,
          body.runtime ?? 'openclaw',
          body.initialPrompt ?? null,
          isSharedBot ? 1 : 0,
          result.volumeId ?? null,
          now, now,
        ],
      });

      // Auto-connect Gmail, Calendar, and Drive for onboarding users
      if (body.onboardingTelegramUserId && validateOnboardingApiKey(request)) {
        try {
          const credResult2 = await client.execute({
            sql: `SELECT id FROM credentials WHERE account_name LIKE ? LIMIT 1`,
            args: [`[tg:${body.onboardingTelegramUserId}]%`],
          });
          if (credResult2.rows.length > 0) {
            const credentialId = credResult2.rows[0].id as string;
            for (const serviceType of ['gmail', 'calendar', 'drive']) {
              try {
                await createServiceInstance(agentId, serviceType, undefined, credentialId);
              } catch (svcErr) {
                console.warn(`[create-and-deploy] auto-connect ${serviceType} failed:`, svcErr instanceof Error ? svcErr.message : svcErr);
              }
            }
          }
        } catch (err) {
          console.error('[create-and-deploy] service auto-connect failed:', err instanceof Error ? err.message : err);
        }
      }

      getPostHog()?.capture({ distinctId: userId, event: 'agent_created', properties: { runtime: body.runtime ?? 'openclaw', modelProvider: body.modelProvider ?? 'anthropic', source: 'onboarding' } });
      getPostHog()?.capture({ distinctId: userId, event: 'agent_deployed', properties: { runtime: body.runtime ?? 'openclaw', region: body.region ?? 'iad' } });

      return reply.code(201).send({
        data: {
          id: agentId,
          name: body.name.trim(),
          status: 'active',
          botUsername,
          deployment: {
            deploymentId,
            status: 'running',
            appName: result.appName,
            machineId: result.machineId,
            managementUrl: result.managementUrl,
            runtime: body.runtime ?? 'openclaw',
          },
        },
      });
    } catch (err) {
      console.error('[create-and-deploy] provision failed:', err instanceof Error ? err.stack : err);
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
      const { isAuth, provider, hint } = classifyProvisionError(err, body.modelProvider);
      let approvalId: string | undefined;
      if (isAuth) {
        approvalId = await createReauthApproval(agentId, deploymentId, provider, hint, message);
        console.warn(`[deploy] Auth failure for agent ${agentId}, created reauth approval ${approvalId}`);
      }
      return reply.code(500).send({
        error: {
          code: isAuth ? 'AUTH_FAILED' : 'DEPLOY_FAILED',
          message: isAuth ? hint : `Deployment failed: ${message}`,
          details: { approvalId, provider, deploymentId },
        },
      });
    }
  });

  /**
   * Deploy an agent — provision on Fly.io or local Docker.
   * Generates MCP config pointing back to this Reins instance for policy enforcement.
   */
  app.post<{ Params: { id: string } }>('/api/agents/:id/deploy', async (request, reply) => {
    const { id } = request.params;
    const deployUserId = getUserId(request);

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
      runtime?: 'openclaw' | 'hermes';
    };

    if (!body?.telegramToken) {
      return reply.code(400).send({
        error: { code: 'VALIDATION_ERROR', message: 'telegramToken is required' },
      });
    }

    const deploymentId = nanoid();
    const gatewayToken = nanoid(32);
    const webhookRelaySecret = nanoid(32);
    const now = new Date().toISOString();

    // Fetch bot username for dashboard display
    let deployBotUsername: string | null = null;
    try {
      const tgRes = await fetch(`https://api.telegram.org/bot${body.telegramToken}/getMe`);
      const tgData = await tgRes.json() as { ok: boolean; result?: { username?: string } };
      if (tgData.ok) deployBotUsername = tgData.result?.username ?? null;
    } catch { /* non-fatal */ }

    // Build MCP config that routes through Reins proxy for policy enforcement.
    // REINS_PUBLIC_URL takes precedence (for when backend URL differs from dashboard).
    const reinsUrl = config.publicUrl || config.dashboardUrl;
    const mcpConfigs = [
      {
        name: 'reins',
        url: `${reinsUrl}/mcp/${id}`,
        transport: 'http',
      },
    ];

    const resolvedModelProvider = body.modelProvider ?? 'anthropic';
    const resolvedModelName = (() => {
      const mp = resolvedModelProvider;
      const mn = body.modelName?.trim() ?? '';
      if (mp === 'openai-codex') {
        return mn && !mn.startsWith('claude-') ? mn : 'gpt-5.4';
      }
      if (mp === 'minimax') {
        return mn || 'MiniMax-M2.7';
      }
      if (mp === 'openai') {
        return mn || 'gpt-4.1';
      }
      return mn && mn.startsWith('claude-') ? mn : 'claude-sonnet-4-5';
    })();

    try {
      const result = await provider.provision({
        instanceId: deploymentId,
        telegramToken: body.telegramToken,
        telegramUserId: body.telegramUserId,
        mcpConfigs,
        gatewayToken,
        soulMd: body.soulMd,
        modelProvider: resolvedModelProvider,
        modelName: resolvedModelName,
        region: body.region,
        webhookRelaySecret,
        runtime: body.runtime ?? 'openclaw',
      });

      // Webhook relay: Hermes uses /api/webhooks/agent-bot/:id; OpenClaw uses /telegram-webhook
      // Both runtimes bind on 8787; Fly exposes 8443→8787
      const isHermesRt = (body.runtime ?? 'openclaw') === 'hermes';
      const openclawWebhookUrl = result.appName
        ? isHermesRt
          ? `https://${result.appName}.fly.dev:8443/api/webhooks/agent-bot/${deploymentId}`
          : `https://${result.appName}.fly.dev:8443/telegram-webhook`
        : null;

      await client.execute({
        sql: `INSERT INTO deployed_agents (id, agent_id, fly_app_name, fly_machine_id, status, management_url, telegram_token, telegram_bot_username, telegram_user_id, soul_md, model_provider, model_name, region, gateway_token, openclaw_webhook_url, webhook_relay_secret, runtime, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        args: [
          deploymentId,
          id,
          result.appName,
          result.machineId,
          'running',
          result.managementUrl,
          body.telegramToken,
          deployBotUsername,
          body.telegramUserId ?? null,
          body.soulMd ?? null,
          resolvedModelProvider,
          resolvedModelName,
          body.region ?? 'iad',
          gatewayToken,
          openclawWebhookUrl, webhookRelaySecret,
          body.runtime ?? 'openclaw',
          now,
          now,
        ],
      });

      // Update agent status to active
      await client.execute({
        sql: `UPDATE agents SET status = 'active', updated_at = ? WHERE id = ?`,
        args: [now, id],
      });

      getPostHog()?.capture({ distinctId: deployUserId, event: 'agent_deployed', properties: { runtime: body.runtime ?? 'openclaw', region: body.region ?? 'iad' } });

      return reply.code(201).send({
        data: {
          deploymentId,
          agentId: id,
          status: 'running',
          appName: result.appName,
          machineId: result.machineId,
          managementUrl: result.managementUrl,
          runtime: body.runtime ?? 'openclaw',
        },
      });
    } catch (err) {
      // Store failed deployment
      await client.execute({
        sql: `INSERT INTO deployed_agents (id, agent_id, status, gateway_token, created_at, updated_at) VALUES (?, ?, 'error', ?, ?, ?)`,
        args: [deploymentId, id, gatewayToken, now, now],
      });
      const message = err instanceof Error ? err.message : 'Unknown error';
      const { isAuth, provider, hint } = classifyProvisionError(err, body.modelProvider);
      let approvalId: string | undefined;
      if (isAuth) {
        approvalId = await createReauthApproval(id, deploymentId, provider, hint, message);
        console.warn(`[deploy] Auth failure for agent ${id}, created reauth approval ${approvalId}`);
      }
      return reply.code(500).send({
        error: {
          code: isAuth ? 'AUTH_FAILED' : 'DEPLOY_FAILED',
          message: isAuth ? hint : `Deployment failed: ${message}`,
          details: { approvalId, provider, deploymentId },
        },
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
        isManual: deployment.is_manual === 1 || deployment.is_manual === true,
        runtime: deployment.runtime,
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

    // Mask OpenAI API key
    const maskedOpenaiApiKey = deployment?.openai_api_key ? '***' : null;

    // Parse telegram groups
    let telegramGroups: provider.TelegramGroup[] | null = null;
    if (deployment?.telegram_groups_json) {
      try {
        telegramGroups = JSON.parse(deployment.telegram_groups_json as string);
      } catch { /* ignore */ }
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
          telegramBotUsername: deployment.telegram_bot_username ?? null,
          telegramUserId: deployment.telegram_user_id,
          openaiApiKey: maskedOpenaiApiKey,
          telegramGroups: telegramGroups ?? [],
          soulMd: deployment.soul_md,
          modelProvider: deployment.model_provider,
          modelName: deployment.model_name,
          region: deployment.region,
          mcpConfigJson: deployment.mcp_config_json,
          runtime: deployment.runtime,
          isManual: deployment.is_manual === 1 || deployment.is_manual === true,
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
        const reinsUrl = config.publicUrl || config.dashboardUrl;
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
            // Only re-inject initial prompt if agent hasn't completed first-run setup
            initialPrompt: !deployment.has_onboarded ? deployment.initial_prompt as string | undefined : undefined,
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
   * Restart a running agent deployment (soft restart, no config change)
   */
  app.post<{ Params: { id: string } }>('/api/agents/:id/restart', async (request, reply) => {
    const { id } = request.params;
    const deployment = await getActiveDeployment(id);
    if (!deployment) {
      return reply.code(404).send({ error: { code: 'NOT_FOUND', message: 'No active deployment found' } });
    }

    try {
      await provider.restart(
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
        error: { code: 'RESTART_FAILED', message },
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
      openaiApiKey?: string | null;
      telegramGroups?: provider.TelegramGroup[];
      modelCredentials?: string;
    };

    // Validate telegram group chat IDs (must be numeric) and topic prompts
    if (body.telegramGroups) {
      for (const g of body.telegramGroups) {
        if (!/^-?\d+$/.test(g.chatId)) {
          return reply.code(400).send({ error: { code: 'VALIDATION_ERROR', message: `Invalid chatId "${g.chatId}": must be a numeric Telegram chat ID` } });
        }
        if (g.topicPrompts) {
          if (g.topicPrompts.length > 50) {
            return reply.code(400).send({ error: { code: 'VALIDATION_ERROR', message: `Too many topic prompts for chat ${g.chatId}: max 50` } });
          }
          for (const tp of g.topicPrompts) {
            if (!Number.isInteger(tp.threadId) || tp.threadId <= 0) {
              return reply.code(400).send({ error: { code: 'VALIDATION_ERROR', message: `Invalid threadId ${tp.threadId}: must be a positive integer` } });
            }
            if (!tp.prompt || tp.prompt.trim().length === 0) {
              return reply.code(400).send({ error: { code: 'VALIDATION_ERROR', message: `Topic prompt for threadId ${tp.threadId} must not be empty` } });
            }
            if (tp.prompt.length > 50000) {
              return reply.code(400).send({ error: { code: 'VALIDATION_ERROR', message: `Topic prompt for threadId ${tp.threadId} exceeds 50,000 character limit` } });
            }
          }
        }
      }
    }

    // Reject redeploy with an already-expired Codex token
    const redeployProvider = body?.modelProvider || deployment.model_provider as string;
    const redeployCreds = body?.modelCredentials || deployment.model_credentials as string | undefined;
    if (redeployProvider === 'openai-codex' && redeployCreds && isCodexTokenExpired(redeployCreds)) {
      return reply.code(400).send({
        error: {
          code: 'CODEX_TOKEN_EXPIRED',
          message: 'The OpenAI Codex token has expired. Please re-authenticate before redeploying.',
        },
      });
    }

    const reinsUrl = config.publicUrl || config.dashboardUrl;
    const mcpConfigs = [
      { name: 'reins', url: `${reinsUrl}/mcp/${id}`, transport: 'http' },
    ];

    const redeployModelProvider = (body?.modelProvider || deployment.model_provider as string) ?? 'anthropic';
    const redeployModelName = (() => {
      const mp = redeployModelProvider;
      const mn = (body?.modelName || deployment.model_name as string)?.trim() ?? '';
      if (mp === 'openai-codex') {
        return mn && !mn.startsWith('claude-') ? mn : 'gpt-5.4';
      }
      if (mp === 'minimax') {
        return mn || 'MiniMax-M2.7';
      }
      if (mp === 'openai') {
        return mn || 'gpt-4.1';
      }
      return mn && mn.startsWith('claude-') ? mn : 'claude-sonnet-4-5';
    })();

    try {
      const newModelCredentials = body?.modelCredentials || deployment.model_credentials as string | undefined;

      // Resolve openaiApiKey: body wins (including null to clear), else keep DB value
      const newOpenaiApiKey = body && 'openaiApiKey' in body
        ? body.openaiApiKey ?? null
        : deployment.openai_api_key as string | null | undefined;

      // Resolve telegramGroups: body wins (empty array = clear groups), else keep DB value
      let newTelegramGroups: provider.TelegramGroup[] | null = null;
      if (body && 'telegramGroups' in body && body.telegramGroups !== undefined) {
        newTelegramGroups = body.telegramGroups ?? null;
      } else if (deployment.telegram_groups_json) {
        try { newTelegramGroups = JSON.parse(deployment.telegram_groups_json as string); } catch { /* ignore */ }
      }

      const { managementUrl, newMachineId } = await provider.redeploy(
        deployment.fly_app_name as string,
        deployment.fly_machine_id as string,
        {
          instanceId: deployment.id as string,
          telegramToken: (body?.telegramToken || deployment.telegram_token) as string,
          telegramUserId: body?.telegramUserId || deployment.telegram_user_id as string | undefined,
          mcpConfigs,
          gatewayToken: deployment.gateway_token as string,
          soulMd: body?.soulMd || deployment.soul_md as string | undefined,
          modelProvider: redeployModelProvider,
          modelName: redeployModelName,
          openaiApiKey: newOpenaiApiKey ?? undefined,
          telegramGroups: newTelegramGroups ?? undefined,
          modelCredentials: newModelCredentials,
          webhookRelaySecret: deployment.webhook_relay_secret as string | undefined,
          runtime: ((deployment.runtime as string | undefined) ?? 'openclaw') as 'openclaw' | 'hermes',
          volumeId: (deployment.fly_volume_id as string | undefined) ?? undefined,
          isSharedBot: !!(deployment.is_shared_bot as number | undefined),
        }
      );

      const newTelegramGroupsJson = newTelegramGroups && newTelegramGroups.length > 0
        ? JSON.stringify(newTelegramGroups)
        : null;

      const now = new Date().toISOString();
      await client.execute({
        sql: `UPDATE deployed_agents SET status = 'running', management_url = ?, fly_machine_id = COALESCE(?, fly_machine_id), telegram_token = COALESCE(?, telegram_token), telegram_user_id = COALESCE(?, telegram_user_id), soul_md = COALESCE(?, soul_md), model_provider = ?, model_name = ?, openai_api_key = CASE WHEN ? THEN ? ELSE openai_api_key END, telegram_groups_json = CASE WHEN ? THEN ? ELSE telegram_groups_json END, model_credentials = COALESCE(?, model_credentials), updated_at = ? WHERE id = ?`,
        args: [
          managementUrl,
          newMachineId ?? null,
          body?.telegramToken ?? null,
          body?.telegramUserId ?? null,
          body?.soulMd ?? null,
          redeployModelProvider,
          redeployModelName,
          (body && 'openaiApiKey' in body) ? 1 : 0,
          newOpenaiApiKey ?? null,
          (body && 'telegramGroups' in body) ? 1 : 0,
          newTelegramGroupsJson,
          body?.modelCredentials ?? null,
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
   * Live-edit runtime settings (telegram groups + OpenAI API key) without a full image redeploy.
   * For Fly agents: updates DB + env vars, then triggers a container restart (~30s).
   * For Docker agents: returns 409 (not supported).
   *
   * Body fields are all optional. Omitted fields = no change.
   * openaiApiKey: null = clear the key. openaiApiKey: "***" = no change.
   * telegramGroups: [] = clear all groups.
   */
  app.put<{ Params: { id: string } }>('/api/agents/:id/settings', async (request, reply) => {
    const { id } = request.params;
    const deployment = await getActiveDeployment(id);
    if (!deployment) {
      return reply.code(404).send({ error: { code: 'NOT_FOUND', message: 'No active deployment found' } });
    }

    const body = request.body as {
      telegramGroups?: provider.TelegramGroup[];
      openaiApiKey?: string | null;
    };

    // Validate telegram group chat IDs and topic prompts
    if (body.telegramGroups) {
      for (const g of body.telegramGroups) {
        if (!/^-?\d+$/.test(g.chatId)) {
          return reply.code(400).send({ error: { code: 'VALIDATION_ERROR', message: `Invalid chatId "${g.chatId}": must be a numeric Telegram chat ID` } });
        }
        if (g.topicPrompts) {
          if (g.topicPrompts.length > 50) {
            return reply.code(400).send({ error: { code: 'VALIDATION_ERROR', message: `Too many topic prompts for chat ${g.chatId}: max 50` } });
          }
          for (const tp of g.topicPrompts) {
            if (!Number.isInteger(tp.threadId) || tp.threadId <= 0) {
              return reply.code(400).send({ error: { code: 'VALIDATION_ERROR', message: `Invalid threadId ${tp.threadId}: must be a positive integer` } });
            }
            if (!tp.prompt || tp.prompt.trim().length === 0) {
              return reply.code(400).send({ error: { code: 'VALIDATION_ERROR', message: `Topic prompt for threadId ${tp.threadId} must not be empty` } });
            }
            if (tp.prompt.length > 50000) {
              return reply.code(400).send({ error: { code: 'VALIDATION_ERROR', message: `Topic prompt for threadId ${tp.threadId} exceeds 50,000 character limit` } });
            }
          }
        }
      }
    }

    // Compute what actually changed
    const hasGroupsUpdate = 'telegramGroups' in body;
    const hasKeyUpdate = 'openaiApiKey' in body && body.openaiApiKey !== '***';

    if (!hasGroupsUpdate && !hasKeyUpdate) {
      return reply.code(200).send({ data: { changed: false } });
    }

    // Resolve new values
    const newTelegramGroupsJson = hasGroupsUpdate
      ? (body.telegramGroups && body.telegramGroups.length > 0 ? JSON.stringify(body.telegramGroups) : null)
      : undefined;

    const newOpenaiApiKey = hasKeyUpdate
      ? (body.openaiApiKey ?? null)
      : undefined;

    // Check if the values are actually different from DB to avoid a no-op restart
    const currentGroupsJson = (deployment.telegram_groups_json as string | null) ?? null;
    const currentOpenaiApiKey = (deployment.openai_api_key as string | null) ?? null;

    const groupsChanged = hasGroupsUpdate && newTelegramGroupsJson !== currentGroupsJson;
    const keyChanged = hasKeyUpdate && newOpenaiApiKey !== currentOpenaiApiKey;

    if (!groupsChanged && !keyChanged) {
      return reply.code(200).send({ data: { changed: false } });
    }

    // Build DB update
    const setClauses: string[] = ['updated_at = ?'];
    const setArgs: (string | null)[] = [new Date().toISOString()];

    if (groupsChanged) {
      setClauses.unshift('telegram_groups_json = ?');
      setArgs.unshift(newTelegramGroupsJson ?? null);
    }
    if (keyChanged) {
      setClauses.unshift('openai_api_key = ?');
      setArgs.unshift(newOpenaiApiKey ?? null);
    }

    await client.execute({
      sql: `UPDATE deployed_agents SET ${setClauses.join(', ')} WHERE id = ?`,
      args: [...setArgs, deployment.id as string],
    });

    // Trigger Fly env update + restart (if Fly agent)
    if (deployment.fly_app_name && deployment.fly_machine_id) {
      const envUpdates: Record<string, string | undefined> = {};
      if (groupsChanged) {
        envUpdates.TELEGRAM_GROUPS_JSON = newTelegramGroupsJson ?? undefined;
      }
      if (keyChanged) {
        envUpdates.OPENAI_API_KEY = newOpenaiApiKey ?? undefined;
      }

      try {
        await provider.updateEnv(
          deployment.fly_app_name as string,
          deployment.fly_machine_id as string,
          envUpdates
        );
      } catch (err: unknown) {
        // Roll back DB change on Fly failure
        await client.execute({
          sql: `UPDATE deployed_agents SET telegram_groups_json = ?, openai_api_key = ?, updated_at = ? WHERE id = ?`,
          args: [currentGroupsJson, currentOpenaiApiKey, new Date().toISOString(), deployment.id as string],
        });

        const code = (err as { code?: string }).code;
        if (code === 'LIVE_EDIT_NOT_SUPPORTED') {
          return reply.code(409).send({
            error: {
              code: 'LIVE_EDIT_NOT_SUPPORTED_FOR_DOCKER',
              message: 'Live settings edit is not supported for Docker-provisioned agents. Use redeploy instead.',
              fallback: 'redeploy',
            },
          });
        }

        const message = err instanceof Error ? err.message : 'Unknown error';
        return reply.code(500).send({ error: { code: 'UPDATE_ENV_FAILED', message } });
      }

      return reply.code(200).send({ data: { changed: true, restarted: true } });
    }

    // No Fly machine — DB-only update
    return reply.code(200).send({ data: { changed: true, restarted: false } });
  });

  // ─── Topic Prompts endpoints ──────────────────────────────────────────────

  /**
   * GET /api/agents/:id/topic-prompts
   * Returns the full telegram_groups_json parsed as { groups: TelegramGroup[] }.
   * Authenticates via session OR x-reins-agent-secret header matching deployment gateway_token.
   */
  app.get<{ Params: { id: string } }>('/api/agents/:id/topic-prompts', async (request, reply) => {
    const { id } = request.params;

    // Auth: session OR agent secret
    const agentSecret = (request.headers as Record<string, string | undefined>)['x-reins-agent-secret'];
    const session = getSession(request);

    if (!session && !agentSecret) {
      return reply.code(401).send({ error: { code: 'UNAUTHORIZED', message: 'Not authenticated' } });
    }

    // Look up deployed agent — accept either agent_id or deployment id (INSTANCE_USER_ID)
    let result = await client.execute({
      sql: `SELECT id, telegram_groups_json, gateway_token FROM deployed_agents WHERE agent_id = ? AND status NOT IN ('destroyed', 'error') ORDER BY created_at DESC LIMIT 1`,
      args: [id],
    });
    if (result.rows.length === 0) {
      result = await client.execute({
        sql: `SELECT id, telegram_groups_json, gateway_token FROM deployed_agents WHERE id = ? AND status NOT IN ('destroyed', 'error') LIMIT 1`,
        args: [id],
      });
    }

    if (result.rows.length === 0) {
      return reply.code(404).send({ error: { code: 'NOT_FOUND', message: 'No active deployment found' } });
    }

    const deployment = result.rows[0];

    // Validate agent secret if no session
    if (!session) {
      if (agentSecret !== (deployment.gateway_token as string)) {
        return reply.code(401).send({ error: { code: 'UNAUTHORIZED', message: 'Invalid agent secret' } });
      }
    }

    let groups: provider.TelegramGroup[] = [];
    if (deployment.telegram_groups_json) {
      try {
        groups = JSON.parse(deployment.telegram_groups_json as string) as provider.TelegramGroup[];
      } catch {
        groups = [];
      }
    }

    return reply.code(200).send({ groups });
  });

  /**
   * PUT /api/agents/:id/topic-prompts
   * Upserts (or deletes) a topic prompt for a specific thread in a group.
   * Body: { chatId: string, threadId: number, instruction: string }
   * Empty instruction = delete the entry.
   * Authenticates via session OR x-reins-agent-secret header matching deployment gateway_token.
   */
  app.put<{ Params: { id: string } }>('/api/agents/:id/topic-prompts', async (request, reply) => {
    const { id } = request.params;

    // Auth: session OR agent secret
    const agentSecret = (request.headers as Record<string, string | undefined>)['x-reins-agent-secret'];
    const session = getSession(request);

    if (!session && !agentSecret) {
      return reply.code(401).send({ error: { code: 'UNAUTHORIZED', message: 'Not authenticated' } });
    }

    const body = request.body as { chatId?: string; threadId?: number; instruction?: string };

    // Validate body
    if (!body?.chatId || !/^-?\d+$/.test(body.chatId)) {
      return reply.code(400).send({ error: { code: 'VALIDATION_ERROR', message: 'chatId must be a numeric Telegram chat ID' } });
    }
    if (!Number.isInteger(body.threadId) || (body.threadId as number) <= 0) {
      return reply.code(400).send({ error: { code: 'VALIDATION_ERROR', message: 'threadId must be a positive integer' } });
    }
    if (typeof body.instruction !== 'string') {
      return reply.code(400).send({ error: { code: 'VALIDATION_ERROR', message: 'instruction must be a string' } });
    }

    const { chatId, threadId, instruction } = body as { chatId: string; threadId: number; instruction: string };

    // Look up deployed agent
    const result = await client.execute({
      sql: `SELECT id, telegram_groups_json, gateway_token, fly_app_name, fly_machine_id FROM deployed_agents WHERE agent_id = ? AND status NOT IN ('destroyed', 'error') ORDER BY created_at DESC LIMIT 1`,
      args: [id],
    });

    if (result.rows.length === 0) {
      return reply.code(404).send({ error: { code: 'NOT_FOUND', message: 'No active deployment found' } });
    }

    const deployment = result.rows[0];

    // Validate agent secret if no session
    if (!session) {
      if (agentSecret !== (deployment.gateway_token as string)) {
        return reply.code(401).send({ error: { code: 'UNAUTHORIZED', message: 'Invalid agent secret' } });
      }
    }

    // Parse existing groups
    let groups: provider.TelegramGroup[] = [];
    if (deployment.telegram_groups_json) {
      try {
        groups = JSON.parse(deployment.telegram_groups_json as string) as provider.TelegramGroup[];
      } catch {
        groups = [];
      }
    }

    // Find the group
    const groupIdx = groups.findIndex((g) => g.chatId === chatId);
    if (groupIdx === -1) {
      return reply.code(404).send({ error: { code: 'NOT_FOUND', message: `Group ${chatId} not found or not approved` } });
    }

    const group = { ...groups[groupIdx] };
    const topicPrompts: (provider.TopicPrompt & { updatedAt?: string; updatedBy?: string })[] = (group.topicPrompts as (provider.TopicPrompt & { updatedAt?: string; updatedBy?: string })[]) ?? [];

    const updatedBy = agentSecret && !session ? 'agent' : 'ui';
    const updatedAt = new Date().toISOString();

    if (instruction === '') {
      // Delete the entry
      group.topicPrompts = topicPrompts.filter((tp) => tp.threadId !== threadId) as provider.TopicPrompt[];
    } else {
      // Upsert
      const existingIdx = topicPrompts.findIndex((tp) => tp.threadId === threadId);
      if (existingIdx === -1) {
        // Check max 50 limit before adding
        if (topicPrompts.length >= 50) {
          return reply.code(400).send({ error: { code: 'VALIDATION_ERROR', message: 'Maximum 50 topic prompts per group' } });
        }
        topicPrompts.push({ threadId, prompt: instruction, updatedAt, updatedBy });
      } else {
        topicPrompts[existingIdx] = { threadId, prompt: instruction, updatedAt, updatedBy };
      }
      group.topicPrompts = topicPrompts as provider.TopicPrompt[];
    }

    groups[groupIdx] = group;

    const newGroupsJson = JSON.stringify(groups);
    const currentGroupsJson = deployment.telegram_groups_json as string | null;

    // Save back to DB
    await client.execute({
      sql: `UPDATE deployed_agents SET telegram_groups_json = ?, updated_at = ? WHERE id = ?`,
      args: [newGroupsJson, updatedAt, deployment.id as string],
    });

    // Trigger Fly env update + restart (if Fly agent)
    if (deployment.fly_app_name && deployment.fly_machine_id) {
      try {
        await provider.updateEnv(
          deployment.fly_app_name as string,
          deployment.fly_machine_id as string,
          { TELEGRAM_GROUPS_JSON: newGroupsJson }
        );
      } catch (err: unknown) {
        // Roll back DB change on Fly failure
        await client.execute({
          sql: `UPDATE deployed_agents SET telegram_groups_json = ?, updated_at = ? WHERE id = ?`,
          args: [currentGroupsJson, updatedAt, deployment.id as string],
        });

        const code = (err as { code?: string }).code;
        if (code === 'LIVE_EDIT_NOT_SUPPORTED') {
          return reply.code(409).send({
            error: {
              code: 'LIVE_EDIT_NOT_SUPPORTED_FOR_DOCKER',
              message: 'Live settings edit is not supported for Docker-provisioned agents. Use redeploy instead.',
              fallback: 'redeploy',
            },
          });
        }

        const message = err instanceof Error ? err.message : 'Unknown error';
        return reply.code(500).send({ error: { code: 'UPDATE_ENV_FAILED', message } });
      }

      return reply.code(200).send({ ok: true, threadId, chatId, restarted: true });
    }

    // No Fly machine — DB-only update
    return reply.code(200).send({ ok: true, threadId, chatId, restarted: false });
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

  /**
   * Get logs for a deployed agent
   */
  app.get<{ Params: { id: string }; Querystring: { next_token?: string } }>(
    '/api/agents/:id/logs',
    async (request, reply) => {
      const { id } = request.params;
      const deployment = await getActiveDeployment(id);
      if (!deployment?.fly_app_name) {
        return reply.code(404).send({ error: { code: 'NOT_FOUND', message: 'No active deployment found' } });
      }

      try {
        const result = await provider.getLogs(
          deployment.fly_app_name as string,
          request.query.next_token
        );
        return { data: result };
      } catch (err) {
        const message = err instanceof Error ? err.message : 'Unknown error';
        return reply.code(500).send({ error: { code: 'LOGS_FAILED', message } });
      }
    }
  );

  /**
   * SSE stream of live logs for a deployed agent.
   * Polls Fly getAppLogs every 2s.
   */
  app.get<{ Params: { id: string } }>(
    '/api/agents/:id/logs/stream',
    async (request, reply) => {
      const { id } = request.params;
      const deployment = await getActiveDeployment(id);
      if (!deployment?.fly_app_name) {
        return reply.code(404).send({ error: { code: 'NOT_FOUND', message: 'No active deployment found' } });
      }

      const appName = deployment.fly_app_name as string;

      reply.raw.setHeader('Content-Type', 'text/event-stream');
      reply.raw.setHeader('Cache-Control', 'no-cache');
      reply.raw.setHeader('Connection', 'keep-alive');
      reply.raw.setHeader('X-Accel-Buffering', 'no');
      reply.raw.flushHeaders();

      const send = (line: string) => {
        // Escape newlines within the log line for SSE
        const escaped = line.replace(/\n/g, '\\n');
        reply.raw.write(`data: ${escaped}\n\n`);
      };

      // Poll Fly logs every 2 seconds
      let nextToken: string | undefined;
      let stopped = false;

      request.raw.on('close', () => { stopped = true; });

      const poll = async () => {
        if (stopped) return;
        try {
          const result = await provider.getLogs(appName, nextToken);
          nextToken = result.nextToken;
          for (const entry of result.logs) {
            send(`[${entry.timestamp}] ${entry.message}`);
          }
        } catch { /* ignore transient errors */ }
        if (!stopped) setTimeout(poll, 2000);
      };

      poll();

      // Keep-alive ping every 15s
      const keepAlive = setInterval(() => {
        if (!reply.raw.destroyed) reply.raw.write(': ping\n\n');
        else clearInterval(keepAlive);
      }, 15000);
      request.raw.on('close', () => clearInterval(keepAlive));

      // Return hijacked response
      return reply;
    }
  );

  /**
   * Get the current management URL for a deployed agent.
   * For local Docker this resolves the current dynamic port.
   */
  app.get<{ Params: { id: string } }>(
    '/api/agents/:id/management-url',
    async (request, reply) => {
      const { id } = request.params;
      const deployment = await getActiveDeployment(id);
      if (!deployment?.fly_app_name) {
        return reply.code(404).send({ error: { code: 'NOT_FOUND', message: 'No active deployment found' } });
      }

      try {
        const url = await provider.getManagementUrl(
          deployment.fly_app_name as string,
          deployment.gateway_token as string,
          deployment.runtime as string | undefined
        );
        return { data: { url } };
      } catch (err) {
        const message = err instanceof Error ? err.message : 'Unknown error';
        return reply.code(500).send({ error: { code: 'URL_FAILED', message } });
      }
    }
  );

  // ========================================================================
  // OpenAI Device Flow Authentication
  // ========================================================================

  /**
   * OpenAI Codex device flow — start or poll.
   * action: "start" initiates the flow, "poll" checks for completion.
   */
  app.post('/api/auth/openai-device', async (request, reply) => {
    const body = request.body as { action: string; deviceAuthId?: string; userCode?: string };

    if (body.action === 'start') {
      // Step 1: Request user code from OpenAI
      try {
        const res = await fetch(
          `${OPENAI_AUTH_BASE}/api/accounts/deviceauth/usercode`,
          {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ client_id: OPENAI_CLIENT_ID }),
          }
        );

        if (!res.ok) {
          return reply.code(res.status).send({
            error: { code: 'DEVICE_FLOW_ERROR', message: 'Device code flow not available' },
          });
        }

        const data = await res.json() as Record<string, unknown>;
        return {
          data: {
            deviceAuthId: data.device_auth_id,
            userCode: data.user_code || data.usercode,
            interval: parseInt(String(data.interval)) || 5,
            verificationUrl: `${OPENAI_AUTH_BASE}/codex/device`,
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
      const { deviceAuthId, userCode } = body;
      if (!deviceAuthId || !userCode) {
        return reply.code(400).send({
          error: { code: 'VALIDATION_ERROR', message: 'deviceAuthId and userCode are required' },
        });
      }

      // Step 2: Poll for authorization code
      try {
        const pollRes = await fetch(
          `${OPENAI_AUTH_BASE}/api/accounts/deviceauth/token`,
          {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              device_auth_id: deviceAuthId,
              user_code: userCode,
            }),
          }
        );

        if (pollRes.status === 403 || pollRes.status === 404) {
          return { data: { status: 'pending' } };
        }

        if (!pollRes.ok) {
          const errText = await pollRes.text().catch(() => '');
          console.error(`OpenAI device auth poll failed: ${pollRes.status} ${errText}`);
          return reply.code(pollRes.status).send({
            error: { code: 'AUTH_FAILED', message: `Authorization failed: ${pollRes.status}` },
          });
        }

        const pollData = await pollRes.json() as { authorization_code: string; code_verifier: string };

        // Step 3: Exchange authorization code for tokens
        const tokenRes = await fetch(`${OPENAI_AUTH_BASE}/oauth/token`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
          body: new URLSearchParams({
            grant_type: 'authorization_code',
            code: pollData.authorization_code,
            redirect_uri: `${OPENAI_AUTH_BASE}/deviceauth/callback`,
            client_id: OPENAI_CLIENT_ID,
            code_verifier: pollData.code_verifier,
          }),
        });

        if (!tokenRes.ok) {
          const errText = await tokenRes.text().catch(() => '');
          console.error(`OpenAI token exchange failed: ${tokenRes.status} ${errText}`);
          return reply.code(500).send({
            error: { code: 'TOKEN_EXCHANGE_FAILED', message: `Token exchange failed: ${tokenRes.status}` },
          });
        }

        const tokens = await tokenRes.json() as Record<string, unknown>;
        return {
          data: {
            status: 'complete',
            tokens: JSON.stringify({
              access_token: tokens.access_token,
              id_token: tokens.id_token,
              refresh_token: tokens.refresh_token,
            }),
          },
        };
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

  /**
   * Trigger a redeploy for an agent if it has an active, non-stopped deployment.
   * Used to pick up provisioning changes (MCP_CONFIG baked into env vars).
   * Fire-and-forget: call without await and catch errors separately.
   */
  async function autoRedeployIfDeployed(agentId: string): Promise<void> {
    const deployment = await getActiveDeployment(agentId);
    if (!deployment || deployment.status === 'stopped') return;

    const reinsUrl = config.publicUrl || config.dashboardUrl;
    const mcpConfigs: object[] = [
      { name: 'reins', url: `${reinsUrl}/mcp/${agentId}`, transport: 'http' },
    ];
    if (deployment.mcp_config_json) {
      try {
        const userServers = JSON.parse(deployment.mcp_config_json as string);
        if (Array.isArray(userServers)) mcpConfigs.push(...userServers);
      } catch { /* ignore malformed json */ }
    }

    const { newMachineId: autoNewMachineId } = await provider.redeploy(
      deployment.fly_app_name as string,
      deployment.fly_machine_id as string,
      {
        instanceId: deployment.id as string,
        telegramToken: deployment.telegram_token as string,
        telegramUserId: deployment.telegram_user_id as string | undefined,
        mcpConfigs,
        gatewayToken: deployment.gateway_token as string,
        soulMd: deployment.soul_md as string | undefined,
        modelProvider: deployment.model_provider as string | undefined,
        modelName: deployment.model_name as string | undefined,
        openaiApiKey: deployment.openai_api_key as string | undefined,
        modelCredentials: deployment.model_credentials as string | undefined,
        volumeId: (deployment.fly_volume_id as string | undefined) ?? undefined,
        webhookRelaySecret: deployment.webhook_relay_secret as string | undefined,
        runtime: ((deployment.runtime as string | undefined) ?? 'openclaw') as 'openclaw' | 'hermes',
        isSharedBot: !!(deployment.is_shared_bot as number | undefined),
      }
    );

    await client.execute({
      sql: `UPDATE deployed_agents SET status = 'running', fly_machine_id = COALESCE(?, fly_machine_id), updated_at = ? WHERE id = ?`,
      args: [autoNewMachineId ?? null, new Date().toISOString(), deployment.id as string],
    });
  }

  // ============================================================================
  // Backup Routes
  // ============================================================================

  // List all backups
  app.get('/api/backups', async (request, reply) => {
    const session = getSession(request);
    if (!session) return reply.status(401).send({ error: 'Unauthorized' });

    const backups = await listBackups();
    return reply.send({ backups });
  });

  // Trigger a manual backup
  app.post('/api/backups', async (request, reply) => {
    const session = getSession(request);
    if (!session) return reply.status(401).send({ error: 'Unauthorized' });

    const metadata = await performBackup();
    return reply.status(201).send({ backup: metadata });
  });

  // Restore from a specific backup
  app.post('/api/backups/:id/restore', async (request, reply) => {
    const session = getSession(request);
    if (!session) return reply.status(401).send({ error: 'Unauthorized' });

    const { id } = request.params as { id: string };
    if (!/^[\w\-:.]+$/.test(id)) {
      return reply.status(400).send({ error: 'Invalid backup ID' });
    }

    try {
      const result = await restoreBackup(id);
      return reply.send({ ok: true, ...result });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return reply.status(500).send({ error: message });
    }
  });

  // Download a specific backup by ID
  app.get('/api/backups/:id', async (request, reply) => {
    const session = getSession(request);
    if (!session) return reply.status(401).send({ error: 'Unauthorized' });

    const { id } = request.params as { id: string };
    // Basic path traversal guard
    if (!/^[\w\-:.]+$/.test(id)) {
      return reply.status(400).send({ error: 'Invalid backup ID' });
    }

    const backup = await getBackup(id);
    if (!backup) return reply.status(404).send({ error: 'Backup not found' });

    reply
      .header('Content-Type', 'application/json')
      .header('Content-Disposition', `attachment; filename="backup-${id}.json"`)
      .send(JSON.stringify(backup, null, 2));
  });

  // =========================================================================
  // Telegram notification link/unlink
  // =========================================================================

  // Generate a one-time deep-link code so the user can connect their Telegram
  app.post('/api/telegram/link', async (request, reply) => {
    const session = getSession(request);
    if (!session) return reply.status(401).send({ error: 'Unauthorized' });

    if (!telegramNotifier.isConfigured()) {
      return reply.status(503).send({ error: 'Telegram notifications are not configured on this server.' });
    }

    try {
      const { code, url } = await telegramNotifier.createLinkCode(session.userId);
      const expiresAt = new Date(Date.now() + 10 * 60 * 1000).toISOString();
      return reply.send({ code, url, expiresAt });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return reply.status(500).send({ error: message });
    }
  });

  // Disconnect the current user's Telegram
  app.delete('/api/telegram/link', async (request, reply) => {
    const session = getSession(request);
    if (!session) return reply.status(401).send({ error: 'Unauthorized' });

    await telegramNotifier.unlinkUser(session.userId);
    return reply.send({ ok: true });
  });

  // Telegram webhook — unauthenticated but gated by secret_token header
  app.post('/api/webhooks/telegram', async (request, reply) => {
    const expectedSecret = config.reisTelegramWebhookSecret;
    if (expectedSecret) {
      const receivedSecret = request.headers['x-telegram-bot-api-secret-token'];
      if (receivedSecret !== expectedSecret) {
        return reply.status(401).send({ error: 'Invalid secret token' });
      }
    }

    // Always return 200 — Telegram retries on non-2xx
    try {
      await telegramNotifier.handleUpdate(request.body as unknown as Parameters<typeof telegramNotifier.handleUpdate>[0]);
    } catch (err) {
      console.error('Telegram webhook handler error:', err);
    }
    return reply.send({ ok: true });
  });

  // ========================================================================
  // Public config endpoint (no auth)
  // ========================================================================

  app.get('/api/config/public', async (_request, reply) => {
    return reply.send({ sharedBotEnabled: !!config.sharedBotToken });
  });

  // ========================================================================
  // Shared bot webhook — routes messages to deployed agents by telegram_user_id
  // ========================================================================

  // Rate-limit map: userId → last "no agent" reply timestamp
  const sharedBotNoAgentLastSent = new Map<string, number>();

  app.post('/api/webhooks/shared-bot', async (request, reply) => {
    // Always return 200 immediately — Telegram retries on non-2xx
    reply.send({ ok: true });

    if (!config.sharedBotToken) return;

    // Verify secret token
    if (config.sharedBotWebhookSecret) {
      const receivedSecret = request.headers['x-telegram-bot-api-secret-token'];
      if (receivedSecret !== config.sharedBotWebhookSecret) return;
    }

    const body = request.body as Record<string, unknown>;

    // Extract sender user ID from various update types
    function extractTelegramUserId(update: Record<string, unknown>): string | null {
      const msg = (update.message ?? update.edited_message ?? update.channel_post ?? update.edited_channel_post) as Record<string, unknown> | undefined;
      if (msg?.from) return String((msg.from as Record<string, unknown>).id);
      const cq = update.callback_query as Record<string, unknown> | undefined;
      if (cq?.from) return String((cq.from as Record<string, unknown>).id);
      const mcm = update.my_chat_member as Record<string, unknown> | undefined;
      if (mcm?.from) return String((mcm.from as Record<string, unknown>).id);
      const inlineQuery = update.inline_query as Record<string, unknown> | undefined;
      if (inlineQuery?.from) return String((inlineQuery.from as Record<string, unknown>).id);
      return null;
    }

    // Skip non-private chats (shared bot is DM-only)
    const msgOrCq = (body.message ?? body.edited_message ?? body.callback_query) as Record<string, unknown> | undefined;
    const chat = msgOrCq?.chat as Record<string, unknown> | undefined;
    if (chat && chat.type !== 'private') return;

    const telegramUserId = extractTelegramUserId(body);
    if (!telegramUserId) return;

    // Look up most recent running shared-bot deployment for this user
    const depResult = await client.execute({
      sql: `SELECT da.id, da.agent_id, da.openclaw_webhook_url, da.webhook_relay_secret
            FROM deployed_agents da
            WHERE da.telegram_user_id = ? AND da.is_shared_bot = 1 AND da.status = 'running'
            ORDER BY da.created_at DESC LIMIT 1`,
      args: [telegramUserId],
    });

    if (depResult.rows.length === 0) {
      // Unknown user — send a rate-limited reply (1 per hour)
      const now = Date.now();
      const lastSent = sharedBotNoAgentLastSent.get(telegramUserId) ?? 0;
      if (now - lastSent > 3600_000) {
        sharedBotNoAgentLastSent.set(telegramUserId, now);
        // Send only on direct messages
        if (chat?.type === 'private') {
          const chatId = (chat as Record<string, unknown>).id;
          fetch(`https://api.telegram.org/bot${config.sharedBotToken}/sendMessage`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ chat_id: chatId, text: "I don't have an agent set up for you yet. Visit the platform to get started." }),
          }).catch(() => {});
        }
      }
      return;
    }

    const dep = depResult.rows[0];
    const deploymentId = dep.id as string;
    const agentId = dep.agent_id as string;
    const openclawUrl = dep.openclaw_webhook_url as string | null;
    const relaySecret = dep.webhook_relay_secret as string | null;

    // Intercept my_chat_member events
    if (body.my_chat_member) {
      handleMyChatMember(deploymentId, agentId, body.my_chat_member as Parameters<typeof handleMyChatMember>[2]).catch((err) =>
        console.error(`[shared-bot-relay] handleMyChatMember error for ${deploymentId}:`, err)
      );
    }

    // Forward to the agent machine
    if (openclawUrl) {
      forwardToOpenclaw(deploymentId, openclawUrl, body, relaySecret ?? undefined).catch((err) =>
        console.error(`[shared-bot-relay] forwardToOpenclaw error for ${deploymentId}:`, err)
      );
    }
  });

  /**
   * Per-agent bot relay webhook — receives Telegram updates for a deployed agent's bot,
   * forwards them to OpenClaw, and intercepts my_chat_member events for group detection.
   *
   * Unauthenticated (Telegram cannot authenticate), secured by:
   * - deploymentId in the path (nanoid, unguessable)
   * - X-Telegram-Bot-Api-Secret-Token header matched against webhook_relay_secret in DB
   */
  app.post<{ Params: { deploymentId: string } }>(
    '/api/webhooks/agent-bot/:deploymentId',
    async (request, reply) => {
      // Always return 200 immediately — Telegram retries on non-2xx
      reply.send({ ok: true });

      const { deploymentId } = request.params;

      // Look up deployment
      const depResult = await client.execute({
        sql: `SELECT da.id, da.agent_id, da.openclaw_webhook_url, da.webhook_relay_secret
              FROM deployed_agents da
              WHERE da.id = ?`,
        args: [deploymentId],
      });
      if (depResult.rows.length === 0) return;

      const dep = depResult.rows[0];

      // Verify secret token
      const expectedSecret = dep.webhook_relay_secret as string | null;
      if (expectedSecret) {
        const receivedSecret = request.headers['x-telegram-bot-api-secret-token'];
        if (receivedSecret !== expectedSecret) {
          // Silently drop — don't log in case of scanner noise
          return;
        }
      }

      const agentId = dep.agent_id as string;
      const openclawUrl = dep.openclaw_webhook_url as string | null;

      const body = request.body as Record<string, unknown>;

      // Debug: log update type
      const updateKeys = Object.keys(body).filter(k => k !== 'update_id');
      console.info(`[webhook-relay] Update received for ${deploymentId}: ${updateKeys.join(', ') || 'empty'}`);

      // Intercept my_chat_member events before forwarding
      if (body.my_chat_member) {
        handleMyChatMember(deploymentId, agentId, body.my_chat_member as Parameters<typeof handleMyChatMember>[2]).catch((err) =>
          console.error(`[webhook-relay] handleMyChatMember error for ${deploymentId}:`, err)
        );
      }

      // Forward to OpenClaw (include the shared webhook secret so OpenClaw accepts the request)
      if (openclawUrl) {
        const relaySecret = dep.webhook_relay_secret as string | null;
        forwardToOpenclaw(deploymentId, openclawUrl, body, relaySecret ?? undefined).catch((err) =>
          console.error(`[webhook-relay] forwardToOpenclaw error for ${deploymentId}:`, err)
        );
      }
    }
  );

  // =========================================================================
  // Memory System API
  // Supports two auth modes:
  //   1. Dashboard session (cookie-based, for frontend)
  //   2. Gateway token via x-reins-agent-secret header (for MCP server on agent machines)
  // =========================================================================

  /**
   * Resolve user_id from either session or gateway token.
   * Returns null if neither is present / valid.
   */
  async function resolveMemoryUserId(request: any): Promise<string | null> {
    // Try session first
    const session = getSession(request);
    if (session) return session.userId;

    // Try gateway token
    const agentSecret = request.headers['x-reins-agent-secret'] as string | undefined;
    if (!agentSecret) return null;

    const depResult = await client.execute({
      sql: `SELECT da.agent_id, a.user_id
            FROM deployed_agents da
            JOIN agents a ON a.id = da.agent_id
            WHERE da.gateway_token = ? AND da.status NOT IN ('destroyed', 'error')
            LIMIT 1`,
      args: [agentSecret],
    });
    if (depResult.rows.length === 0) return null;
    return depResult.rows[0].user_id as string;
  }

  // -------------------------------------------------------------------------
  // GET /api/memory/root — get or create the user's memory root entry
  // -------------------------------------------------------------------------
  app.get('/api/memory/root', async (request, reply) => {
    const userId = await resolveMemoryUserId(request);
    if (!userId) return reply.status(401).send({ error: 'Unauthorized' });

    const rootId = await ensureMemoryRoot(userId);
    const result = await client.execute({
      sql: `SELECT id, type, title, content, created_at, updated_at FROM memory_entries WHERE id = ?`,
      args: [rootId],
    });
    return reply.send({ data: result.rows[0] });
  });

  // -------------------------------------------------------------------------
  // GET /api/memory/entries — list/search entries
  // -------------------------------------------------------------------------
  app.get('/api/memory/entries', async (request, reply) => {
    const userId = await resolveMemoryUserId(request);
    if (!userId) return reply.status(401).send({ error: 'Unauthorized' });

    const { q, type, parent_id, limit: lim = '50' } = request.query as Record<string, string>;
    const maxLimit = Math.min(parseInt(lim, 10) || 50, 200);

    let rows;
    if (q) {
      const result = await client.execute({
        sql: `SELECT id, user_id, type, title, content, created_at, updated_at
              FROM memory_entries
              WHERE user_id = ? AND is_deleted = false
                AND search_vector @@ plainto_tsquery('english', ?)
                ${type ? `AND type = '${type.replace(/'/g, "''")}'` : ''}
              ORDER BY ts_rank(search_vector, plainto_tsquery('english', ?)) DESC
              LIMIT ?`,
        args: [userId, q, q, maxLimit],
      });
      rows = result.rows;
    } else if (parent_id) {
      const result = await client.execute({
        sql: `SELECT e.id, e.type, e.title, e.content, e.created_at, e.updated_at
              FROM memory_entries e
              JOIN memory_branches b ON b.entry_id = e.id
              WHERE e.user_id = ? AND e.is_deleted = false AND b.parent_entry_id = ?
                ${type ? `AND e.type = '${type.replace(/'/g, "''")}'` : ''}
              ORDER BY b.position ASC, e.title ASC
              LIMIT ?`,
        args: [userId, parent_id, maxLimit],
      });
      rows = result.rows;
    } else {
      const result = await client.execute({
        sql: `SELECT id, type, title, content, created_at, updated_at
              FROM memory_entries
              WHERE user_id = ? AND is_deleted = false
                ${type ? `AND type = '${type.replace(/'/g, "''")}'` : ''}
              ORDER BY updated_at DESC
              LIMIT ?`,
        args: [userId, maxLimit],
      });
      rows = result.rows;
    }

    return reply.send({ data: rows });
  });

  // -------------------------------------------------------------------------
  // POST /api/memory/entries — create entry
  // -------------------------------------------------------------------------
  app.post('/api/memory/entries', async (request, reply) => {
    const userId = await resolveMemoryUserId(request);
    if (!userId) return reply.status(401).send({ error: 'Unauthorized' });

    const body = request.body as Record<string, unknown>;
    const title = (body.title as string | undefined)?.trim();
    if (!title) return reply.status(400).send({ error: 'title is required' });

    const type = (body.type as string | undefined) ?? 'note';
    const content = (body.content as string | undefined) ?? null;
    const parentId = (body.parent_id as string | undefined) ?? null;

    const id = nanoid();
    const now = new Date().toISOString();

    await client.execute({
      sql: `INSERT INTO memory_entries (id, user_id, type, title, content, is_deleted, created_at, updated_at)
            VALUES (?, ?, ?, ?, ?, false, ?, ?)`,
      args: [id, userId, type, title, content, now, now],
    });

    // Create branch record
    const branchId = nanoid();
    let position = 0;
    if (parentId) {
      const posResult = await client.execute({
        sql: `SELECT COALESCE(MAX(position), -1) + 1 AS next_pos FROM memory_branches WHERE parent_entry_id = ?`,
        args: [parentId],
      });
      position = (posResult.rows[0]?.next_pos as number) ?? 0;
    }
    await client.execute({
      sql: `INSERT INTO memory_branches (id, entry_id, parent_entry_id, position, is_expanded) VALUES (?, ?, ?, ?, false)`,
      args: [branchId, id, parentId, position],
    });

    // Handle initial attributes
    const attributes = body.attributes as Array<{ type: string; name: string; value: string }> | undefined;
    if (attributes?.length) {
      for (const attr of attributes) {
        await client.execute({
          sql: `INSERT INTO memory_attributes (id, entry_id, type, name, value, position, is_deleted, created_at)
                VALUES (?, ?, ?, ?, ?, 0, false, ?)`,
          args: [nanoid(), id, attr.type, attr.name, attr.value, now],
        });
      }
    }

    await updateLinkIndex(id, userId, content);

    return reply.status(201).send({ data: { id, userId, type, title, content, createdAt: now, updatedAt: now } });
  });

  // -------------------------------------------------------------------------
  // GET /api/memory/entries/:id — get entry with attributes and backlinks
  // -------------------------------------------------------------------------
  app.get<{ Params: { id: string } }>('/api/memory/entries/:id', async (request, reply) => {
    const userId = await resolveMemoryUserId(request);
    if (!userId) return reply.status(401).send({ error: 'Unauthorized' });

    const { id } = request.params;

    const entryResult = await client.execute({
      sql: `SELECT id, user_id, type, title, content, created_at, updated_at
            FROM memory_entries WHERE id = ? AND user_id = ? AND is_deleted = false`,
      args: [id, userId],
    });
    if (entryResult.rows.length === 0) return reply.status(404).send({ error: 'Not found' });

    const entry = entryResult.rows[0];

    const attrsResult = await client.execute({
      sql: `SELECT id, type, name, value, position FROM memory_attributes
            WHERE entry_id = ? AND is_deleted = false ORDER BY position ASC, created_at ASC`,
      args: [id],
    });

    const backlinksResult = await client.execute({
      sql: `SELECT e.id, e.title, e.type, ml.context
            FROM memory_links ml
            JOIN memory_entries e ON e.id = ml.source_id
            WHERE ml.target_id = ? AND e.is_deleted = false AND e.user_id = ?`,
      args: [id, userId],
    });

    const branchResult = await client.execute({
      sql: `SELECT parent_entry_id FROM memory_branches WHERE entry_id = ? LIMIT 1`,
      args: [id],
    });

    return reply.send({
      data: {
        ...entry,
        attributes: attrsResult.rows,
        backlinks: backlinksResult.rows,
        parentId: branchResult.rows[0]?.parent_entry_id ?? null,
      },
    });
  });

  // -------------------------------------------------------------------------
  // PUT /api/memory/entries/:id — update entry
  // -------------------------------------------------------------------------
  app.put<{ Params: { id: string } }>('/api/memory/entries/:id', async (request, reply) => {
    const userId = await resolveMemoryUserId(request);
    if (!userId) return reply.status(401).send({ error: 'Unauthorized' });

    const { id } = request.params;
    const body = request.body as Record<string, unknown>;

    const existing = await client.execute({
      sql: `SELECT id, type FROM memory_entries WHERE id = ? AND user_id = ? AND is_deleted = false`,
      args: [id, userId],
    });
    if (existing.rows.length === 0) return reply.status(404).send({ error: 'Not found' });

    // Root index is read-only from dashboard sessions — only the agent (gateway token) may update it
    if (existing.rows[0].type === 'index' && getSession(request)) {
      return reply.status(403).send({ error: 'Root index can only be updated by the agent' });
    }

    const now = new Date().toISOString();
    const fields: string[] = [];
    const args: unknown[] = [];

    if (body.title !== undefined) { fields.push('title = ?'); args.push((body.title as string).trim()); }
    if (body.content !== undefined) { fields.push('content = ?'); args.push(body.content); }
    if (body.type !== undefined) { fields.push('type = ?'); args.push(body.type); }
    fields.push('updated_at = ?'); args.push(now);
    args.push(id);

    await client.execute({
      sql: `UPDATE memory_entries SET ${fields.join(', ')} WHERE id = ?`,
      args,
    });

    if (body.content !== undefined) {
      await updateLinkIndex(id, userId, body.content as string | null);
    }

    const updated = await client.execute({
      sql: `SELECT id, user_id, type, title, content, created_at, updated_at FROM memory_entries WHERE id = ?`,
      args: [id],
    });
    return reply.send({ data: updated.rows[0] });
  });

  // -------------------------------------------------------------------------
  // DELETE /api/memory/entries/:id — soft delete
  // -------------------------------------------------------------------------
  app.delete<{ Params: { id: string } }>('/api/memory/entries/:id', async (request, reply) => {
    const userId = await resolveMemoryUserId(request);
    if (!userId) return reply.status(401).send({ error: 'Unauthorized' });

    const { id } = request.params;
    await client.execute({
      sql: `UPDATE memory_entries SET is_deleted = true, updated_at = ? WHERE id = ? AND user_id = ?`,
      args: [new Date().toISOString(), id, userId],
    });
    return reply.send({ ok: true });
  });

  // -------------------------------------------------------------------------
  // GET /api/memory/tree — full tree for sidebar
  // -------------------------------------------------------------------------
  app.get('/api/memory/tree', async (request, reply) => {
    const userId = await resolveMemoryUserId(request);
    if (!userId) return reply.status(401).send({ error: 'Unauthorized' });

    await ensureMemoryRoot(userId);

    const entries = await client.execute({
      sql: `SELECT e.id, e.type, e.title, b.parent_entry_id, b.position, b.is_expanded
            FROM memory_entries e
            LEFT JOIN memory_branches b ON b.entry_id = e.id
            WHERE e.user_id = ? AND e.is_deleted = false
            ORDER BY b.parent_entry_id NULLS FIRST, b.position ASC, e.title ASC`,
      args: [userId],
    });

    return reply.send({ data: entries.rows });
  });

  // -------------------------------------------------------------------------
  // GET /api/memory/graph — nodes + edges for D3 graph view
  // -------------------------------------------------------------------------
  app.get('/api/memory/graph', async (request, reply) => {
    const userId = await resolveMemoryUserId(request);
    if (!userId) return reply.status(401).send({ error: 'Unauthorized' });

    const entries = await client.execute({
      sql: `SELECT id, type, title FROM memory_entries WHERE user_id = ? AND is_deleted = false`,
      args: [userId],
    });

    const links = await client.execute({
      sql: `SELECT ml.source_id, ml.target_id
            FROM memory_links ml
            JOIN memory_entries s ON s.id = ml.source_id
            JOIN memory_entries t ON t.id = ml.target_id
            WHERE s.user_id = ? AND s.is_deleted = false AND t.is_deleted = false`,
      args: [userId],
    });

    // Relation edges from attributes
    const relations = await client.execute({
      sql: `SELECT ma.entry_id AS source_id, ma.value AS target_id, ma.name
            FROM memory_attributes ma
            JOIN memory_entries e ON e.id = ma.entry_id
            WHERE e.user_id = ? AND e.is_deleted = false
              AND ma.type = 'relation' AND ma.is_deleted = false`,
      args: [userId],
    });

    const nodes = entries.rows.map((e) => ({
      id: e.id,
      type: e.type,
      title: e.title,
    }));

    const edges = [
      ...links.rows.map((l) => ({ source: l.source_id, target: l.target_id, kind: 'link' })),
      ...relations.rows.map((r) => ({ source: r.source_id, target: r.target_id, kind: r.name })),
    ];

    return reply.send({ data: { nodes, edges } });
  });

  // -------------------------------------------------------------------------
  // POST /api/memory/entries/:id/attributes — add attribute
  // -------------------------------------------------------------------------
  app.post<{ Params: { id: string } }>('/api/memory/entries/:id/attributes', async (request, reply) => {
    const userId = await resolveMemoryUserId(request);
    if (!userId) return reply.status(401).send({ error: 'Unauthorized' });

    const { id } = request.params;
    const body = request.body as Record<string, unknown>;
    const type = body.type as string;
    const name = body.name as string;
    const value = body.value as string;

    if (!type || !name || !value) return reply.status(400).send({ error: 'type, name, value required' });
    if (!['label', 'relation'].includes(type)) return reply.status(400).send({ error: 'type must be label or relation' });

    const ownerCheck = await client.execute({
      sql: `SELECT id FROM memory_entries WHERE id = ? AND user_id = ? AND is_deleted = false`,
      args: [id, userId],
    });
    if (ownerCheck.rows.length === 0) return reply.status(404).send({ error: 'Entry not found' });

    const attrId = nanoid();
    const now = new Date().toISOString();
    await client.execute({
      sql: `INSERT INTO memory_attributes (id, entry_id, type, name, value, position, is_deleted, created_at)
            VALUES (?, ?, ?, ?, ?, 0, false, ?)`,
      args: [attrId, id, type, name, value, now],
    });

    return reply.status(201).send({ data: { id: attrId, entryId: id, type, name, value } });
  });

  // -------------------------------------------------------------------------
  // DELETE /api/memory/attributes/:attrId — remove attribute
  // -------------------------------------------------------------------------
  app.delete<{ Params: { attrId: string } }>('/api/memory/attributes/:attrId', async (request, reply) => {
    const userId = await resolveMemoryUserId(request);
    if (!userId) return reply.status(401).send({ error: 'Unauthorized' });

    const { attrId } = request.params;

    // Verify ownership via joined query
    const check = await client.execute({
      sql: `SELECT ma.id FROM memory_attributes ma
            JOIN memory_entries e ON e.id = ma.entry_id
            WHERE ma.id = ? AND e.user_id = ?`,
      args: [attrId, userId],
    });
    if (check.rows.length === 0) return reply.status(404).send({ error: 'Attribute not found' });

    await client.execute({
      sql: `UPDATE memory_attributes SET is_deleted = true WHERE id = ?`,
      args: [attrId],
    });
    return reply.send({ ok: true });
  });

  // -------------------------------------------------------------------------
  // GET /api/memory/dream — compact manifest for dream process
  // -------------------------------------------------------------------------
  app.get('/api/memory/dream', async (request, reply) => {
    const userId = await resolveMemoryUserId(request);
    if (!userId) return reply.status(401).send({ error: 'Unauthorized' });

    const entries = await getDreamManifest(userId);
    return reply.send({ data: entries });
  });

  // -------------------------------------------------------------------------
  // PUT /api/memory/entries/:id/parent — reparent entry (dream reorganization)
  // -------------------------------------------------------------------------
  app.put<{ Params: { id: string } }>('/api/memory/entries/:id/parent', async (request, reply) => {
    const userId = await resolveMemoryUserId(request);
    if (!userId) return reply.status(401).send({ error: 'Unauthorized' });

    const { id } = request.params;
    const body = request.body as { parent_id?: string | null };
    const newParentId = body.parent_id ?? null;

    const result = await setEntryParent(id, userId, newParentId);
    if ('error' in result) {
      const status = result.error === 'Entry not found' ? 404 : 400;
      return reply.status(status).send({ error: result.error });
    }
    return reply.send({ data: result });
  });
};
