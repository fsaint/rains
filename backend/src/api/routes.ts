import { FastifyInstance, FastifyPluginAsync, FastifyRequest } from 'fastify';
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
  isServiceEnabledForAgent,
  enableDefaultServices,
  listEnabledServiceTypes,
  listOpenMcpAgents,
  userHasAdminAgent,
  ServiceCombinationError,
  UnauthenticatedEndpointsOpenError,
  ADMIN_SERVICE_TYPE,
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
import { getSession, requireAdmin, type SessionPayload } from '../auth/index.js';
import { getPostHog } from '../analytics/posthog.js';
import { sendReauthEmail } from '../services/email.js';
import {
  estimateCost,
  currentBillingPeriod,
  checkSpendCap,
  markSoftStopped,
  markAlerted80,
  resetSpendCap,
  notifySpend80,
  notifySoftStop,
} from '../services/spend.js';
import { performBackup, listBackups, getBackup, restoreBackup } from '../services/agent-backup.js';
import { createUpload, getUpload, MAX_UPLOAD_BYTES } from '../services/agent-uploads.js';
import { isCodexTokenExpired } from '../services/token-monitor.js';
import { forwardToOpenclaw, handleMyChatMember } from '../services/agent-bot-relay.js';
import {
  parseWikilinkRefs,
  updateLinkIndex,
  updateTagIndex,
  ensureMemoryRoot,
  getDreamManifest,
  setEntryParent,
  resolveOrCreate,
  parseTransclusions,
  lookupEntryByTitleOrAlias,
  replaceSection,
} from '../services/memory.js';
import {
  resolveMemoryContext,
  listUserScopes,
  getAgentScopeGrants,
  setAgentScopeGrants,
  pickScope,
  isRejection,
  type MemoryContext,
} from '../services/memory-scopes.js';
import {
  verifyAccessToken,
  listAgentTokens,
  revokeAccessToken,
  type McpPrincipal,
} from '../mcp/oauth/tokens.js';
import {
  parseRequiredServices,
  resolveAvailability,
  resolveAssignedSkill,
  buildSetupNotice,
  compareSkillVersion,
  loadSkillVersionManifest,
} from '../services/skills.js';
import * as provider from '../providers/index.js';
import Stripe from 'stripe';
import {
  getSubscription,
  upsertSubscription,
  applyGracePeriod,
  clearGrace,
  cancelSubscription,
  checkDeployGate,
} from '../services/billing.js';
import { listModelConfigs, upsertModelConfig, deleteModelConfig } from '../services/model-router.js';
import { nanoid } from 'nanoid';
import jwt from 'jsonwebtoken';
import {
  CreateAgentSchema,
  UpdateAgentSchema,
  CreatePolicySchema,
  UpdatePolicySchema,
  CreateCredentialSchema,
  ApprovalDecisionSchema,
  RequestChangesSchema,
  AuditFilterSchema,
  MCP_SERVER_NAME,
  LEGACY_MCP_SERVER_NAME,
  resolveToolTokens,
  resolveSkillTokens,
  deploymentRuntime,
  type AgentRuntime,
} from '@reins/shared';

async function registerAgentBotWebhook(
  telegramToken: string,
  deploymentId: string,
  webhookRelaySecret: string | null,
  reinsUrl: string,
): Promise<void> {
  const webhookUrl = `${reinsUrl}/api/webhooks/agent-bot/${deploymentId}`;
  const params: Record<string, string> = { url: webhookUrl };
  if (webhookRelaySecret) params.secret_token = webhookRelaySecret;
  try {
    const res = await fetch(`https://api.telegram.org/bot${telegramToken}/setWebhook`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(params),
    });
    const data = await res.json() as { ok: boolean };
    if (!data.ok) console.warn(`[deploy] setWebhook failed for ${deploymentId}: ${JSON.stringify(data)}`);
    else console.info(`[deploy] Telegram webhook set for deployment ${deploymentId}`);
  } catch (err) {
    console.warn(`[deploy] setWebhook error for ${deploymentId}:`, err);
  }
}

/**
 * Key an agent's entry in a client MCP config: `reins-<kebab name>`.
 * Leading/trailing separators are stripped so a name like " My Agent! "
 * yields `reins-my-agent`, never `reins--my-agent-`; an empty name falls
 * back to `reins-agent`.
 */
export function mcpServerKey(agentName: string): string {
  const slug = agentName
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
  return `reins-${slug || 'agent'}`;
}

/** Hermeneutix project list — also the endpoint an API token is validated against. */
const HERMENEUTIX_PROJECTS_URL = 'https://hermeneutix.btv.pw/api/mobile/projects/';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

/**
 * Check a per-instance `config` body before it is stored.
 *
 * The column is generic JSON; the shape belongs to the service, and this is
 * the one place it is enforced — the service layer stores whatever it is
 * given. Returns a message for the 400, or null when the config is fine.
 * Null and undefined are always fine (undefined leaves it alone on PUT,
 * null clears it).
 */
function validateInstanceConfig(serviceType: string, config: unknown): string | null {
  if (config === undefined || config === null) return null;
  if (!isPlainObject(config)) return 'config must be an object or null';

  if (serviceType === 'hermeneutix') {
    const allowed = ['projectId', 'projectName'];
    const unknown = Object.keys(config).filter((k) => !allowed.includes(k));
    if (unknown.length > 0) return `config has unsupported keys for hermeneutix: ${unknown.join(', ')}`;
    if (typeof config.projectId !== 'string' || !UUID_RE.test(config.projectId)) {
      return 'config.projectId must be a project UUID';
    }
    if (config.projectName !== undefined && typeof config.projectName !== 'string') {
      return 'config.projectName must be a string';
    }
  }

  return null;
}

export const apiRoutes: FastifyPluginAsync = async (app: FastifyInstance) => {
  // Helper to get userId from authenticated request
  function getUserId(request: any): string {
    return (request.session as SessionPayload).userId;
  }

  /**
   * The platform's own MCP server entry for an agent's MCP_CONFIG.
   *
   * `name` becomes the namespace prefix on every tool the model sees
   * (`helm__gmail_search`), so it must stay in one place — every deploy and
   * redeploy path builds this, and a missed site silently strands that agent
   * on the old tool names.
   */
  function buildPlatformMcpConfig(agentId: string) {
    const reinsUrl = config.publicUrl || config.dashboardUrl;
    return { name: MCP_SERVER_NAME, url: `${reinsUrl}/mcp/${agentId}`, transport: 'http' };
  }

  // Helper to validate onboarding bot API key
  function validateOnboardingApiKey(request: any): boolean {
    const auth = request.headers.authorization as string | undefined;
    return !!config.onboardingApiKey && auth === `Bearer ${config.onboardingApiKey}`;
  }

  const OPENAI_AUTH_BASE = 'https://auth.openai.com';
  const OPENAI_CLIENT_ID = 'app_EMoamEEZ73f0CkXaXp7hrann';

  function getStripe(): Stripe {
    const key = process.env.STRIPE_SECRET_KEY;
    if (!key) throw new Error('STRIPE_SECRET_KEY not set');
    return new Stripe(key, { apiVersion: '2026-04-22.dahlia' });
  }

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
        const [credsResult, deployResult] = await Promise.all([
          client.execute({
            sql: `SELECT credential_id FROM agent_credentials WHERE agent_id = ?`,
            args: [agent.id as string],
          }),
          client.execute({
            sql: `SELECT telegram_bot_username, status FROM deployed_agents WHERE agent_id = ? AND status NOT IN ('destroyed', 'error') ORDER BY created_at DESC LIMIT 1`,
            args: [agent.id as string],
          }),
        ]);

        const deployment = deployResult.rows[0];
        return {
          id: agent.id,
          name: agent.name,
          description: agent.description,
          policyId: agent.policy_id,
          status: agent.status,
          credentials: credsResult.rows.map((c) => c.credential_id),
          createdAt: agent.created_at,
          updatedAt: agent.updated_at,
          telegramBotUsername: deployment?.telegram_bot_username ?? null,
          deploymentStatus: deployment?.status ?? null,
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
  /**
   * MCP client tokens for one agent, and the switch that closes the
   * unauthenticated endpoint.
   *
   * `lastUsedAt` is the point of the list: it is what tells an owner whether
   * turning off the old URL will break something they forgot about.
   */
  app.get<{ Params: { id: string } }>('/api/agents/:id/mcp-tokens', async (request, reply) => {
    const userId = getUserId(request);
    if (!(await userOwnsAgent(userId, request.params.id))) {
      return reply.code(404).send(agentNotFound);
    }

    const deployment = await client.execute({
      sql: `SELECT allow_unauthenticated FROM deployed_agents
            WHERE agent_id = ? AND status NOT IN ('destroyed', 'error')
            ORDER BY created_at DESC LIMIT 1`,
      args: [request.params.id],
    });

    return {
      data: {
        tokens: await listAgentTokens(request.params.id),
        allowUnauthenticated: deployment.rows[0]?.allow_unauthenticated !== false,
      },
    };
  });

  app.delete<{ Params: { id: string; tokenId: string } }>(
    '/api/agents/:id/mcp-tokens/:tokenId',
    async (request, reply) => {
      const userId = getUserId(request);
      if (!(await userOwnsAgent(userId, request.params.id))) {
        return reply.code(404).send(agentNotFound);
      }
      const revoked = await revokeAccessToken(request.params.tokenId, request.params.id);
      if (!revoked) return reply.code(404).send({ error: { code: 'NOT_FOUND', message: 'Token not found' } });
      return { data: { revoked: true } };
    }
  );

  /**
   * Open or close the unauthenticated endpoint for this agent.
   *
   * Reversible on purpose. An owner who closes it and then finds a client they
   * had forgotten must be able to reopen it themselves rather than raise a
   * ticket — which is also why the audit trail records both directions.
   */
  app.put<{ Params: { id: string } }>('/api/agents/:id/mcp-unauthenticated', async (request, reply) => {
    const userId = getUserId(request);
    if (!(await userOwnsAgent(userId, request.params.id))) {
      return reply.code(404).send(agentNotFound);
    }
    const body = request.body as { allowed?: unknown };
    if (typeof body.allowed !== 'boolean') {
      return reply.code(400).send({
        error: { code: 'VALIDATION_ERROR', message: 'allowed must be a boolean' },
      });
    }

    // The latch. Enabling helm-admin requires every agent on the account to be
    // closed; without this that is a one-time formality — close everything,
    // enable the admin agent, re-open — and the admin agent regains the ability
    // to grant a peer access and then drive it by id.
    if (body.allowed && (await userHasAdminAgent(userId))) {
      return reply.code(409).send({
        error: {
          code: 'ADMIN_AGENT_EXISTS',
          message:
            'You have an agent with Helm Admin, which can change what your agents are allowed to do. ' +
            'Re-opening an unauthenticated endpoint would let it grant access to this agent and then use it directly. ' +
            'Remove Helm Admin from that agent first.',
        },
      });
    }

    await client.execute({
      sql: `UPDATE deployed_agents SET allow_unauthenticated = ?, updated_at = ?
            WHERE agent_id = ? AND status NOT IN ('destroyed', 'error')`,
      args: [body.allowed, new Date().toISOString(), request.params.id],
    });

    await auditLogger.log({
      eventType: 'policy_change',
      result: 'success',
      agentId: request.params.id,
      metadata: {
        kind: 'mcp_unauthenticated_access',
        allowed: body.allowed,
        changedBy: userId,
      },
    });

    return { data: { allowUnauthenticated: body.allowed } };
  });

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

    // MCP JSON config snippets for different clients.
    //
    // Claude Code's remote transport is "http" — it recognises only
    // http | sse | stdio, and skips any other type with
    // `unknown MCP server type "..."`, which is a warning buried in
    // `claude mcp list` rather than a visible failure. "url" was silently
    // dropping this server for everyone who pasted the snippet.
    const claudeCodeConfig = {
      "mcpServers": {
        [mcpServerKey(agent.name as string)]: {
          "type": "http",
          "url": mcpUrl,
        },
      },
    };

    const openaiClawConfig = {
      "mcpServers": [
        {
          "name": mcpServerKey(agent.name as string),
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
    await enableDefaultServices(id);

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

  /**
   * Tear an agent down completely: its machine, then every row that references
   * it. Ownership is the caller's to check before calling this.
   *
   * Shared by the dashboard's DELETE /api/agents/:id and the admin MCP's
   * destroy tool, so the two cannot drift into deleting different sets of rows
   * — which is exactly how orphans accumulate.
   *
   * Memory *entries* are deliberately kept: they live in the owner's scope, not
   * the agent's, and destroying an agent should not destroy what it wrote down.
   */
  async function destroyAgentCompletely(id: string): Promise<void> {
    await mcpProxy.disconnectAgent(id);

    // Destroy Fly.io deployment if one exists
    const deployResult = await client.execute({
      sql: `SELECT fly_app_name, fly_machine_id FROM deployed_agents WHERE agent_id = ? AND status NOT IN ('destroyed', 'error')`,
      args: [id],
    });
    for (const dep of deployResult.rows) {
      if (dep.fly_app_name && dep.fly_machine_id) {
        try {
          await provider.destroy(dep.fly_app_name as string, dep.fly_machine_id as string, id);
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
    // Scope grants outlived the agent until now. Harmless in itself — nanoids
    // are never reused — but destruction is reachable from an agent as of this
    // change, so it is the wrong moment to keep leaving rows behind.
    await client.execute({
      sql: `DELETE FROM agent_memory_scopes WHERE agent_id = ?`,
      args: [id],
    });
    await client.execute({
      sql: `DELETE FROM agents WHERE id = ?`,
      args: [id],
    });
  }

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

    await destroyAgentCompletely(id);

    await auditLogger.logAgentEvent(id, 'deleted');
    getPostHog()?.capture({ distinctId: userId, event: 'agent_destroyed', properties: { agentId: id } });

    return reply.code(204).send();
  });

  // ========================================================================
  // Agent Model Configuration
  // ========================================================================

  app.get('/api/agents/:id/models', async (request, reply) => {
    if (!requireAdmin(request, reply)) return;

    const { id } = request.params as { id: string };
    const configs = await listModelConfigs(id);
    return reply.send(configs);
  });

  app.put(
    '/api/agents/:id/models',
    async (request, reply) => {
      if (!requireAdmin(request, reply)) return;

      const { id } = request.params as { id: string };
      const { provider, modelName, role, apiKey } = request.body as {
        provider: string;
        modelName: string;
        role: string;
        apiKey: string;
      };

      if (!['anthropic', 'openai', 'minimax', 'google'].includes(provider)) {
        return reply.status(400).send({ error: 'Invalid provider' });
      }
      if (!['strong', 'weak'].includes(role)) {
        return reply.status(400).send({ error: 'role must be strong or weak' });
      }
      if (!modelName || !apiKey) {
        return reply.status(400).send({ error: 'modelName and apiKey are required' });
      }

      await upsertModelConfig({
        agentId: id,
        provider: provider as any,
        modelName,
        role: role as any,
        apiKey,
      });

      const configs = await listModelConfigs(id);
      return reply.send(configs);
    }
  );

  app.delete(
    '/api/agents/:id/models/:configId',
    async (request, reply) => {
      if (!requireAdmin(request, reply)) return;

      const { id, configId } = request.params as { id: string; configId: string };
      await deleteModelConfig(configId, id);
      return reply.send({ ok: true });
    }
  );

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
    Body: { serviceType: string; label?: string; credentialId?: string; config?: Record<string, unknown> | null };
  }>('/api/permissions/:agentId/instances', async (request, reply) => {
    const { agentId } = request.params;
    const { serviceType, label, credentialId, config: instanceConfig } = request.body;

    if (!serviceType || !validServiceTypes.includes(serviceType)) {
      return reply.code(400).send({
        error: { code: 'INVALID_SERVICE', message: `Invalid service type: ${serviceType}` },
      });
    }

    const configError = validateInstanceConfig(serviceType, instanceConfig);
    if (configError) {
      return reply.code(400).send({ error: { code: 'VALIDATION_ERROR', message: configError } });
    }

    let instance, created;
    try {
      ({ instance, created } = await createServiceInstance(agentId, serviceType, label, credentialId, instanceConfig ?? undefined));
    } catch (err) {
      if (sendPermissionConflict(err, reply)) return;
      throw err;
    }
    if (created) {
      autoRedeployIfDeployed(agentId).catch((err) =>
        console.error('[autoRedeploy] Failed after instance create:', err)
      );
    }
    return { data: instance };
  });

  /**
   * GET /api/permissions/:agentId/hermeneutix/projects?credentialId=<id>
   *
   * The projects a Hermeneutix account can see, for the dashboard's project
   * picker when scoping an instance. The credential must be a hermeneutix
   * account belonging to the agent's owner; with no credentialId the agent's
   * default hermeneutix instance supplies it. The agent itself is looked up
   * under the session user, like the other agent routes.
   */
  app.get<{ Params: { agentId: string }; Querystring: { credentialId?: string } }>(
    '/api/permissions/:agentId/hermeneutix/projects',
    async (request, reply) => {
      const { agentId } = request.params;
      const userId = getUserId(request);

      const agentResult = await client.execute({
        sql: `SELECT id, user_id FROM agents WHERE id = ? AND user_id = ?`,
        args: [agentId, userId],
      });
      if (agentResult.rows.length === 0) {
        return reply.code(404).send({ error: { code: 'NOT_FOUND', message: 'Agent not found' } });
      }
      const ownerId = agentResult.rows[0].user_id as string;

      let credentialId = request.query.credentialId?.trim() || undefined;
      if (!credentialId) {
        const inst = await client.execute({
          sql: `SELECT credential_id FROM agent_service_instances
                WHERE agent_id = ? AND service_type = 'hermeneutix' AND enabled = true AND credential_id IS NOT NULL
                ORDER BY is_default DESC, created_at ASC LIMIT 1`,
          args: [agentId],
        });
        credentialId = (inst.rows[0]?.credential_id as string | undefined) ?? undefined;
      }
      if (!credentialId) {
        return reply.code(400).send({
          error: { code: 'VALIDATION_ERROR', message: 'credentialId is required: this agent has no Hermeneutix account linked' },
        });
      }

      const credResult = await client.execute({
        sql: `SELECT id, service_id, user_id FROM credentials WHERE id = ?`,
        args: [credentialId],
      });
      const cred = credResult.rows[0];
      if (!cred) {
        return reply.code(404).send({ error: { code: 'NOT_FOUND', message: 'Credential not found' } });
      }
      if (cred.service_id !== 'hermeneutix' || cred.user_id !== ownerId) {
        return reply.code(403).send({
          error: { code: 'FORBIDDEN', message: "Credential is not a Hermeneutix account of this agent's owner" },
        });
      }

      const token = await credentialVault.getValidAccessToken(credentialId);
      if (!token) {
        return reply.code(401).send({ error: { code: 'INVALID_TOKEN', message: 'Hermeneutix token is missing or expired' } });
      }

      let res: Response;
      try {
        res = await fetch(HERMENEUTIX_PROJECTS_URL, { headers: { Authorization: `Token ${token}` } });
      } catch {
        return reply.code(502).send({ error: { code: 'SERVER_ERROR', message: 'Could not reach Hermeneutix API' } });
      }
      if (res.status === 401 || res.status === 403) {
        return reply.code(401).send({ error: { code: 'INVALID_TOKEN', message: 'Hermeneutix rejected the API token' } });
      }
      if (!res.ok) {
        return reply.code(502).send({ error: { code: 'SERVER_ERROR', message: `Hermeneutix API returned ${res.status}` } });
      }

      // Upstream answers { projects: [...] }; tolerate a bare array too.
      let body: unknown;
      try {
        body = await res.json();
      } catch {
        return reply.code(502).send({ error: { code: 'SERVER_ERROR', message: 'Hermeneutix API returned malformed JSON' } });
      }
      const list = Array.isArray(body)
        ? body
        : isPlainObject(body) && Array.isArray(body.projects)
          ? body.projects
          : null;
      if (!list) {
        return reply.code(502).send({ error: { code: 'SERVER_ERROR', message: 'Hermeneutix API returned an unexpected shape' } });
      }

      const data = list
        .filter(isPlainObject)
        .filter((p) => p.id !== undefined && p.id !== null)
        .map((p) => ({ id: String(p.id), name: typeof p.name === 'string' ? p.name : String(p.id) }));
      return { data };
    }
  );

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
   * Update instance (label, credential, enabled, config).
   *
   * `config` is validated against the instance's service type; null clears
   * it, omitting it leaves it alone. A config change is read at call time by
   * the MCP endpoint, so unlike `enabled` it does not need a redeploy.
   */
  app.put<{
    Params: { instanceId: string };
    Body: { label?: string; credentialId?: string; enabled?: boolean; config?: Record<string, unknown> | null };
  }>('/api/permissions/instances/:instanceId', async (request, reply) => {
    const { label, credentialId, enabled, config: instanceConfig } = request.body ?? {};
    const updates: Parameters<typeof updateServiceInstance>[1] = {};
    if (label !== undefined) updates.label = label;
    if (credentialId !== undefined) updates.credentialId = credentialId;
    if (enabled !== undefined) updates.enabled = enabled;

    if (instanceConfig !== undefined) {
      const existing = await getInstanceConfig(request.params.instanceId);
      if (!existing) {
        return reply.code(404).send({
          error: { code: 'NOT_FOUND', message: 'Instance not found' },
        });
      }
      const configError = validateInstanceConfig(existing.serviceType, instanceConfig);
      if (configError) {
        return reply.code(400).send({ error: { code: 'VALIDATION_ERROR', message: configError } });
      }
      updates.config = instanceConfig;
    }

    const result = await updateServiceInstance(request.params.instanceId, updates);
    if (!result) {
      return reply.code(404).send({
        error: { code: 'NOT_FOUND', message: 'Instance not found' },
      });
    }
    // Enabling/disabling a service changes what's in MCP_CONFIG — trigger redeploy
    if (enabled !== undefined) {
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

      try {
        await setServiceAccess(agentId, serviceType, enabled);
      } catch (err) {
        if (sendPermissionConflict(err, reply)) return;
        throw err;
      }
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

      try {
        await setPermissionLevel(agentId, serviceType, level);
      } catch (err) {
        if (sendPermissionConflict(err, reply)) return;
        throw err;
      }
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
      parsed.data.data,
      getUserId(request)
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
      const res = await fetch(HERMENEUTIX_PROJECTS_URL, {
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

  app.post('/api/credentials/pipedrive', async (request, reply) => {
    const body = request.body as { token?: string; companydomain?: string } | undefined;
    if (!body?.token) {
      return reply.code(400).send({ error: { code: 'VALIDATION_ERROR', message: 'token is required' } });
    }
    if (!body?.companydomain) {
      return reply.code(400).send({ error: { code: 'VALIDATION_ERROR', message: 'companydomain is required' } });
    }

    // Strip any accidental .pipedrive.com suffix the user may have pasted
    const domain = body.companydomain.replace(/\.pipedrive\.com.*$/, '');

    const userId = getUserId(request);

    // Validate by fetching the authenticated user's profile
    let userName = 'Unknown';
    let companyName = domain;
    try {
      const res = await fetch(`https://${domain}.pipedrive.com/api/v1/users/me`, {
        headers: { 'x-api-token': body.token },
      });
      if (!res.ok) {
        return reply.code(401).send({ error: { code: 'INVALID_TOKEN', message: 'Invalid Pipedrive credentials' } });
      }
      const json = await res.json() as { data?: { name?: string; company_name?: string; email?: string } };
      userName = json.data?.name ?? userName;
      companyName = json.data?.company_name ?? companyName;
    } catch {
      return reply.code(502).send({ error: { code: 'SERVER_ERROR', message: 'Could not reach Pipedrive API' } });
    }

    const credId = await credentialVault.storeOAuth({
      serviceId: 'pipedrive',
      accountEmail: userName,
      userId,
      grantedServices: ['pipedrive'],
      data: {
        accessToken: body.token,
        companydomain: domain,
      } as any,
    });

    await autoLinkCredential('pipedrive', credId);

    return reply.code(201).send({ data: { id: credId, serviceId: 'pipedrive', userName, companyName } });
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
   * Union of the Google scopes the named services declare (all Google services
   * when none are named), plus the base identity scopes.
   *
   * The definitions in @reins/servers are the single source of truth — the
   * dashboard flow, the onboarding-bot link, and any future flow must agree,
   * or a credential minted by one flow fails scope checks under another.
   */
  async function googleScopesFor(services?: string[]): Promise<{ scopes: string[]; services: string[] }> {
    let serviceScopes: string[] = [];
    let requestedServices: string[] = [];

    try {
      const { serviceDefinitions } = await import('@reins/servers');
      const googleServices = serviceDefinitions.filter((d) => d.category === 'google');

      if (services && services.length > 0) {
        requestedServices = services;
        for (const svcType of services) {
          const def = googleServices.find((d) => d.type === svcType);
          if (def?.auth.oauthScopes) {
            serviceScopes.push(...def.auth.oauthScopes);
          }
        }
      }

      if (serviceScopes.length === 0) {
        requestedServices = googleServices.map((d) => d.type);
        for (const def of googleServices) {
          if (def.auth.oauthScopes) {
            serviceScopes.push(...def.auth.oauthScopes);
          }
        }
      }
    } catch {
      // Fallback if registry unavailable — keep in sync with the definitions.
      serviceScopes = [
        'https://www.googleapis.com/auth/gmail.readonly',
        'https://www.googleapis.com/auth/gmail.compose',
        'https://www.googleapis.com/auth/gmail.modify',
        'https://www.googleapis.com/auth/gmail.send',
        'https://www.googleapis.com/auth/drive',
        'https://www.googleapis.com/auth/calendar.events',
        'https://www.googleapis.com/auth/calendar.readonly',
      ];
      requestedServices = ['gmail', 'drive', 'calendar'];
    }

    return {
      scopes: [...new Set([...GOOGLE_BASE_SCOPES, ...serviceScopes])],
      services: requestedServices,
    };
  }

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

    // Build scopes from requested services (definitions are the source of truth)
    const requested = query.services ? query.services.split(',').map((s) => s.trim()) : undefined;
    const { scopes: allScopes, services: requestedServices } = await googleScopesFor(requested);

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
      scope: (await googleScopesFor(['gmail', 'calendar', 'drive'])).scopes.join(' '),
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

        // Build token data — preserve existing refresh token if Google omits it (e.g. reconnect)
        let existingRefreshToken: string | undefined;
        if (pendingFlow.reconnectCredentialId && !tokens.refresh_token) {
          const existing = await credentialVault.retrieve(pendingFlow.reconnectCredentialId);
          existingRefreshToken = (existing?.data as { refreshToken?: string } | undefined)?.refreshToken;
        }

        const tokenData = {
          accessToken: tokens.access_token,
          refreshToken: tokens.refresh_token ?? existingRefreshToken,
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

        // Preserve existing refresh token if Microsoft omits it (reconnect path)
        let existingRefreshToken: string | undefined;
        if (pendingFlow.reconnectCredentialId && !tokens.refresh_token) {
          const existing = await credentialVault.retrieve(pendingFlow.reconnectCredentialId);
          existingRefreshToken = (existing?.data as { refreshToken?: string } | undefined)?.refreshToken;
        }

        const tokenData = {
          accessToken: tokens.access_token,
          refreshToken: tokens.refresh_token ?? existingRefreshToken,
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

  /**
   * Confirm the session user owns the agent this approval belongs to.
   *
   * Approvals are addressed by an unguessable nanoid, but that is not an
   * authorization boundary — without this check any authenticated user could
   * read or decide any approval by id.
   */
  const ownsApproval = async (request: FastifyRequest, approvalId: string): Promise<boolean> => {
    const session = getSession(request);
    if (!session?.userId) return false;

    const result = await client.execute({
      sql: `SELECT 1 FROM approvals a
            JOIN agents ag ON ag.id = a.agent_id
            WHERE a.id = ? AND ag.user_id = ?
            LIMIT 1`,
      args: [approvalId, session.userId],
    });
    return result.rows.length > 0;
  };

  const notFound = { error: { code: 'NOT_FOUND', message: 'Approval not found' } };

  app.get<{ Params: { id: string } }>('/api/approvals/:id', async (request, reply) => {
    const { id } = request.params;

    // 404 rather than 403 — do not confirm the existence of other users' approvals.
    if (!(await ownsApproval(request, id))) {
      return reply.code(404).send(notFound);
    }

    const approval = await approvalQueue.get(id);
    if (!approval) {
      return reply.code(404).send(notFound);
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

    if (!(await ownsApproval(request, id))) {
      return reply.code(404).send(notFound);
    }

    const success = await approvalQueue.approve(id, approver, parsed.data.comment);
    if (!success) {
      return reply.code(404).send({ error: { code: 'NOT_FOUND', message: 'Approval not found or already resolved' } });
    }

    const approval = await approvalQueue.get(id);

    // Audit the resolution — approvalId links back to the tool_call 'pending' row
    if (approval) {
      auditLogger.logApproval(approval.agentId, approval.tool, 'success', approver, id).catch(() => {});
    }

    return { data: approval };
  });

  app.post<{ Params: { id: string } }>('/api/approvals/:id/reject', async (request, reply) => {
    const { id } = request.params;
    const body = request.body as { reason?: string };

    const session = getSession(request);
    const approver = session?.email ?? 'dashboard-user';

    if (!(await ownsApproval(request, id))) {
      return reply.code(404).send(notFound);
    }

    const success = await approvalQueue.reject(id, approver, body.reason ?? 'Rejected');
    if (!success) {
      return reply.code(404).send({ error: { code: 'NOT_FOUND', message: 'Approval not found or already resolved' } });
    }

    const approval = await approvalQueue.get(id);

    if (approval) {
      auditLogger.logApproval(approval.agentId, approval.tool, 'blocked', approver, id).catch(() => {});
    }

    return { data: approval };
  });

  /**
   * Send a request back to the agent with free-text feedback instead of
   * approving or denying it. The agent revises the arguments and resubmits.
   */
  app.post<{ Params: { id: string } }>('/api/approvals/:id/request-changes', async (request, reply) => {
    const { id } = request.params;
    const parsed = RequestChangesSchema.safeParse(request.body);

    if (!parsed.success) {
      return reply.code(400).send({ error: { code: 'VALIDATION_ERROR', message: parsed.error.message } });
    }

    const session = getSession(request);
    const requester = session?.email ?? 'dashboard-user';

    if (!(await ownsApproval(request, id))) {
      return reply.code(404).send(notFound);
    }

    const outcome = await approvalQueue.requestChanges(id, requester, parsed.data.feedback);

    if (outcome === 'cap_reached') {
      return reply.code(409).send({
        error: {
          code: 'REVISION_LIMIT_REACHED',
          message: 'This request has already been revised the maximum number of times. Approve or deny it.',
        },
      });
    }

    if (outcome === 'not_pending') {
      return reply.code(404).send({ error: { code: 'NOT_FOUND', message: 'Approval not found or already resolved' } });
    }

    const approval = await approvalQueue.get(id);

    if (approval) {
      auditLogger.logApproval(approval.agentId, approval.tool, 'blocked', requester, id).catch(() => {});
    }

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

  /**
   * Export audit log as CSV — same filters as /api/audit, capped at 10,000 rows.
   * Returns Content-Disposition: attachment so browsers download immediately.
   */
  app.get('/api/audit/export.csv', async (request, reply) => {
    const query = request.query as Record<string, string>;
    const userId = getUserId(request);

    const userAgents = await client.execute({
      sql: `SELECT id FROM agents WHERE user_id = ?`,
      args: [userId],
    });
    const userAgentIds = userAgents.rows.map((r) => r.id as string);

    if (userAgentIds.length === 0) {
      reply.header('Content-Type', 'text/csv');
      reply.header('Content-Disposition', 'attachment; filename="audit-log.csv"');
      return 'id,timestamp,event_type,agent_id,tool,result,duration_ms,metadata\n';
    }

    const scopedAgentId = query.agentId && userAgentIds.includes(query.agentId) ? query.agentId : null;

    let whereSql = scopedAgentId
      ? `WHERE agent_id = ?`
      : `WHERE (agent_id IS NULL OR agent_id IN (${userAgentIds.map(() => '?').join(',')}))`;
    const whereArgs: (string | number)[] = scopedAgentId ? [scopedAgentId] : [...userAgentIds];

    if (query.eventType) { whereSql += ` AND event_type = ?`; whereArgs.push(query.eventType); }
    if (query.tool)      { whereSql += ` AND tool = ?`;       whereArgs.push(query.tool); }
    if (query.result)    { whereSql += ` AND result = ?`;     whereArgs.push(query.result); }
    if (query.startDate) { whereSql += ` AND timestamp >= ?`; whereArgs.push(query.startDate); }
    if (query.endDate)   { whereSql += ` AND timestamp <= ?`; whereArgs.push(query.endDate); }

    const rows = await client.execute({
      sql: `SELECT id, timestamp, event_type, agent_id, tool, result, duration_ms, metadata_json
            FROM audit_log ${whereSql} ORDER BY timestamp DESC LIMIT 10000`,
      args: whereArgs,
    });

    const escape = (v: unknown) => {
      if (v == null) return '';
      const s = String(v).replace(/"/g, '""');
      return s.includes(',') || s.includes('"') || s.includes('\n') ? `"${s}"` : s;
    };

    const lines = [
      'id,timestamp,event_type,agent_id,tool,result,duration_ms,metadata',
      ...rows.rows.map((r: any) =>
        [r.id, r.timestamp, r.event_type, r.agent_id, r.tool, r.result, r.duration_ms, r.metadata_json]
          .map(escape).join(',')
      ),
    ];

    reply.header('Content-Type', 'text/csv');
    reply.header('Content-Disposition', 'attachment; filename="audit-log.csv"');
    return lines.join('\n');
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
   * Authenticate a request to /mcp/:agentId.
   *
   * Three outcomes, and the middle one is the whole migration story:
   *
   *  - A valid Bearer token for this agent → authenticated.
   *  - No token at all → served exactly as before, *while* this deployment
   *    still allows it. That flag defaults true and is only ever cleared by
   *    the owner, so no existing agent changes behaviour.
   *  - A token that does not verify → 401, always, even where no token was
   *    required. Falling back to unauthenticated would hide a misconfigured
   *    client from the person who set it up.
   */
  async function authenticateMcp(
    request: any,
    agentId: string
  ): Promise<{ ok: true; principal: McpPrincipal | null } | { ok: false; reason: string }> {
    const header = request.headers?.authorization as string | undefined;
    const bearer = header?.match(/^Bearer\s+(.+)$/i)?.[1];

    if (bearer) {
      const principal = await verifyAccessToken(bearer);
      if (!principal) return { ok: false, reason: 'invalid_token' };
      // A token is minted for one agent. Presenting it to another is a
      // failure, not a fallback.
      if (principal.agentId !== agentId) return { ok: false, reason: 'invalid_token' };
      return { ok: true, principal };
    }

    const row = await client.execute({
      sql: `SELECT allow_unauthenticated FROM deployed_agents
            WHERE agent_id = ? AND status NOT IN ('destroyed', 'error')
            ORDER BY created_at DESC LIMIT 1`,
      args: [agentId],
    });
    // No deployment row: leave it to handleMCPRequest, which owns the
    // agent-not-found response shape.
    if (row.rows.length === 0) return { ok: true, principal: null };
    if (row.rows[0].allow_unauthenticated === false) return { ok: false, reason: 'token_required' };
    return { ok: true, principal: null };
  }

  /**
   * Fixed-window rate limit for the MCP endpoint.
   *
   * There is no rate limiting anywhere else in this codebase, and the endpoint
   * runs real side effects against live accounts — while unauthenticated URLs
   * keep working, this is the only brake on one that leaks.
   *
   * In-memory, matching the existing throttle further down this file. That
   * means it resets on restart and is per-process, which is correct only while
   * fly.toml pins max_machines_running = 1; revisit if that ever changes.
   */
  const MCP_RATE_WINDOW_MS = 60_000;
  const MCP_RATE_MAX = 240; // 4/second sustained — far above any real client
  const mcpRateBuckets = new Map<string, { count: number; resetAt: number }>();

  function checkMcpRate(key: string): boolean {
    const now = Date.now();
    const bucket = mcpRateBuckets.get(key);
    if (!bucket || now >= bucket.resetAt) {
      mcpRateBuckets.set(key, { count: 1, resetAt: now + MCP_RATE_WINDOW_MS });
      // Opportunistic sweep so the map cannot grow without bound.
      if (mcpRateBuckets.size > 5000) {
        for (const [k, v] of mcpRateBuckets) if (now >= v.resetAt) mcpRateBuckets.delete(k);
      }
      return true;
    }
    bucket.count += 1;
    return bucket.count <= MCP_RATE_MAX;
  }

  /** RFC 9728: tells a client where to go and get a token. */
  function mcpUnauthorized(reply: any, agentId: string, reason: string) {
    const base = (config.publicUrl || config.dashboardUrl || '').replace(/\/$/, '');
    return reply
      .code(401)
      .header(
        'WWW-Authenticate',
        `Bearer realm="helm", error="${reason}", ` +
          `resource_metadata="${base}/.well-known/oauth-protected-resource/mcp/${agentId}"`
      )
      .send({
        jsonrpc: '2.0',
        id: null,
        error: {
          code: -32000,
          message:
            reason === 'invalid_token'
              ? 'Invalid or expired access token'
              : 'This agent requires an access token. Connect a client from the Helm dashboard.',
        },
      });
  }

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

      // Authenticate before anything writes to the socket. On the SSE branch
      // below the 200 header goes out before the handler runs, so a rejection
      // decided later would ship as a 200 stream containing an error.
      const auth = await authenticateMcp(request, agentId);
      if (!auth.ok) return mcpUnauthorized(reply, agentId, auth.reason);

      if (!checkMcpRate(auth.principal?.tokenId ?? `agent:${agentId}`)) {
        return reply.code(429).send({
          jsonrpc: '2.0',
          id: null,
          error: { code: -32029, message: 'Rate limit exceeded' },
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
      const auth = await authenticateMcp(request, request.params.agentId);
      if (!auth.ok) return mcpUnauthorized(reply, request.params.agentId, auth.reason);

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
    async (request, reply) => {
      const auth = await authenticateMcp(request, request.params.agentId);
      if (!auth.ok) return mcpUnauthorized(reply, request.params.agentId, auth.reason);
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
      // Check Fly first — a Fly 401 always means the platform token, regardless of modelProvider.
      if (/fly\.io|fly api/i.test(msg)) {
        provider = 'fly';
      } else if (modelProvider === 'openai-codex' || /codex/.test(msg)) {
        provider = 'openai-codex';
      } else if (modelProvider === 'openai' || /openai/.test(msg)) {
        provider = 'openai';
      } else if (modelProvider === 'minimax' || /minimax/.test(msg)) {
        provider = 'minimax';
      } else if (modelProvider === 'anthropic' || /anthropic|claude/.test(msg)) {
        provider = 'anthropic';
      } else {
        provider = modelProvider as ReauthProvider ?? 'unknown';
      }
    } else if (/fly\.io|fly api/i.test(msg)) {
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

    // Create deployment record — no fly app, no machine, is_manual=1.
    // Born closed: the MCP URL alone does not reach this agent; a client has
    // to authenticate (OAuth) first. The owner can open it from the dashboard.
    await client.execute({
      sql: `INSERT INTO deployed_agents
              (id, agent_id, status, gateway_token, soul_md, is_manual, allow_unauthenticated, mcp_server_name, created_at, updated_at)
            VALUES (?, ?, 'running', ?, ?, 1, false, ?, ?, ?)`,
      args: [deploymentId, agentId, gatewayToken, body.soulMd || null, MCP_SERVER_NAME, now, now],
    });

    await enableDefaultServices(agentId);

    return reply.code(201).send({
      data: {
        id: agentId,
        name: body.name.trim(),
        status: 'active',
        acceptsUnauthenticatedMcp: false,
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

      // Subscription gate — only for dashboard users (onboarding bot bypasses this)
      const gate = await checkDeployGate(userId);
      if (!gate.allowed) {
        const msg = gate.reason === 'no_subscription'
          ? 'A subscription is required to deploy agents. Visit /pricing to subscribe.'
          : gate.reason === 'lapsed'
          ? 'Your subscription has lapsed. Please renew to deploy agents.'
          : 'Your subscription is inactive. Please renew at /billing.';
        return reply.code(402).send({ error: msg, reason: gate.reason });
      }
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

    // Shared bot mode: use platform token when no user token provided.
    // Bind the trimmed token once: the guard below tested the trimmed value
    // while the token actually sent on was body.telegramToken, so a pasted
    // token with surrounding whitespace passed validation and then went into
    // the api.telegram.org URL verbatim.
    const providedToken = body?.telegramToken?.trim();
    const isSharedBot = !providedToken && !!config.sharedBotToken;
    if (!isSharedBot && !providedToken) {
      return reply.code(400).send({ error: { code: 'VALIDATION_ERROR', message: 'telegramToken is required (or enable shared bot mode)' } });
    }
    const effectiveTelegramToken = isSharedBot ? config.sharedBotToken! : providedToken!;

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
        sql: `SELECT id FROM deployed_agents WHERE telegram_user_id = ? AND is_shared_bot = 1 AND status NOT IN ('destroyed', 'error') LIMIT 1`,
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
        return mn || 'MiniMax-M3';
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
      buildPlatformMcpConfig(agentId),
      ...userMcpServers,
    ];

    // For shared bot, use the configured webhook secret instead of a per-deployment one
    const effectiveWebhookSecret = isSharedBot
      ? (config.sharedBotWebhookSecret ?? webhookRelaySecret)
      : webhookRelaySecret;

    // Fire-and-forget: tell the user deployment has started via the approvals bot.
    // Fires immediately (before the ~2min provision call), so they know it's in progress.
    if (body.onboardingTelegramUserId && config.sharedBotToken) {
      client.execute({
        sql: `SELECT notify_chat_id FROM applicants WHERE telegram_user_id = ? LIMIT 1`,
        args: [body.onboardingTelegramUserId],
      }).then(r => {
        const chatId = r.rows[0]?.notify_chat_id as string | null;
        if (chatId) {
          fetch(`https://api.telegram.org/bot${config.sharedBotToken}/sendMessage`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ chat_id: chatId, text: '⏳ Deploying your agent — it will be ready in about 2 minutes.' }),
          }).catch(() => {});
        }
      }).catch(() => {});
    }

    try {
      const result = await provider.provision({
        instanceId: deploymentId,
        agentId,
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
        sql: `INSERT INTO deployed_agents (id, agent_id, fly_app_name, fly_machine_id, status, management_url, telegram_token, telegram_bot_username, telegram_user_id, soul_md, model_provider, model_name, region, gateway_token, openai_api_key, telegram_groups_json, model_credentials, mcp_config_json, openclaw_webhook_url, webhook_relay_secret, runtime, initial_prompt, is_shared_bot, fly_volume_id, mcp_server_name, allow_unauthenticated, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, false, ?, ?)`,
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
          MCP_SERVER_NAME,
          now, now,
        ],
      });

      await enableDefaultServices(agentId);

      // Register Telegram webhook for user-owned bots (non-fatal)
      if (!isSharedBot && effectiveTelegramToken) {
        await registerAgentBotWebhook(effectiveTelegramToken, deploymentId, effectiveWebhookSecret, reinsUrl);
      }

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
    const mcpConfigs = [
      buildPlatformMcpConfig(id),
    ];

    const resolvedModelProvider = body.modelProvider ?? 'anthropic';
    const resolvedModelName = (() => {
      const mp = resolvedModelProvider;
      const mn = body.modelName?.trim() ?? '';
      if (mp === 'openai-codex') {
        return mn && !mn.startsWith('claude-') ? mn : 'gpt-5.4';
      }
      if (mp === 'minimax') {
        return mn || 'MiniMax-M3';
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
        sql: `INSERT INTO deployed_agents (id, agent_id, fly_app_name, fly_machine_id, status, management_url, telegram_token, telegram_bot_username, telegram_user_id, soul_md, model_provider, model_name, region, gateway_token, openclaw_webhook_url, webhook_relay_secret, runtime, mcp_server_name, allow_unauthenticated, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, false, ?, ?)`,
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
          MCP_SERVER_NAME,
          now,
          now,
        ],
      });

      // Update agent status to active
      await client.execute({
        sql: `UPDATE agents SET status = 'active', updated_at = ? WHERE id = ?`,
        args: [now, id],
      });

      // Register Telegram webhook for user-owned bots (non-fatal)
      if (body.telegramToken) {
        const reinsUrl = config.publicUrl || config.dashboardUrl;
        await registerAgentBotWebhook(body.telegramToken, deploymentId, webhookRelaySecret, reinsUrl);
      }

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
        const mcpConfigs = [
          buildPlatformMcpConfig(id),
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
          sql: `UPDATE deployed_agents SET status = 'running', mcp_server_name = ?, updated_at = ? WHERE id = ?`,
          args: [MCP_SERVER_NAME, new Date().toISOString(), deployment.id as string],
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
    if (body?.telegramGroups) {
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

    const mcpConfigs = [
      buildPlatformMcpConfig(id),
    ];

    const redeployModelProvider = (body?.modelProvider || deployment.model_provider as string) ?? 'anthropic';
    const redeployModelName = (() => {
      const mp = redeployModelProvider;
      const mn = (body?.modelName || deployment.model_name as string)?.trim() ?? '';
      if (mp === 'openai-codex') {
        return mn && !mn.startsWith('claude-') ? mn : 'gpt-5.4';
      }
      if (mp === 'minimax') {
        return mn || 'MiniMax-M3';
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
        sql: `UPDATE deployed_agents SET status = 'running', management_url = ?, fly_machine_id = COALESCE(?, fly_machine_id), telegram_token = COALESCE(?, telegram_token), telegram_user_id = COALESCE(?, telegram_user_id), soul_md = COALESCE(?, soul_md), model_provider = ?, model_name = ?, openai_api_key = CASE WHEN ? THEN ? ELSE openai_api_key END, telegram_groups_json = CASE WHEN ? THEN ? ELSE telegram_groups_json END, model_credentials = COALESCE(?, model_credentials), mcp_server_name = ?, updated_at = ? WHERE id = ?`,
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
          MCP_SERVER_NAME,
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
        deployment.fly_machine_id as string,
        id
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
   * Usage webhook — receives token usage reports from deployed agents.
   * Accepts two formats:
   *   OpenClaw: { userId: string, inputTokens: number, outputTokens: number }
   *   Hermes:   { instanceId: string, tokens: number, source: 'hermes' }
   *             where tokens is an estimated total (input+output combined)
   */
  app.post('/api/webhooks/usage', async (request) => {
    const body = request.body as Record<string, unknown>;

    // Normalise both formats to a common shape
    const deploymentId = (body?.userId ?? body?.instanceId) as string | undefined;
    let inputTokens: number;
    let outputTokens: number;

    if (body?.source === 'hermes' && typeof body?.tokens === 'number') {
      // Hermes sends an estimated total; split 40/60 input/output (typical chat ratio)
      const total = body.tokens as number;
      inputTokens  = Math.round(total * 0.4);
      outputTokens = Math.round(total * 0.6);
    } else {
      inputTokens  = Number(body?.inputTokens  ?? 0);
      outputTokens = Number(body?.outputTokens ?? 0);
    }

    if (!deploymentId || (inputTokens === 0 && outputTokens === 0)) {
      return { ok: true };
    }

    // Look up agent and model for this deployment
    const deployment = await client.execute({
      sql: `SELECT agent_id, model_provider, model_name FROM deployed_agents WHERE id = ?`,
      args: [deploymentId],
    });

    if (deployment.rows.length === 0) return { ok: true };

    const agentId       = deployment.rows[0].agent_id       as string;
    const modelProvider = deployment.rows[0].model_provider as string | null;
    const modelName     = deployment.rows[0].model_name     as string | null;
    const now           = new Date().toISOString();
    const bp            = currentBillingPeriod();

    const totalCost = estimateCost(inputTokens, outputTokens, modelProvider, modelName);

    await client.execute({
      sql: `INSERT INTO spend_records
              (agent_id, service_id, amount, currency, input_tokens, output_tokens, billing_period, recorded_at)
            VALUES (?, 'llm', ?, 'USD', ?, ?, ?, ?)`,
      args: [agentId, totalCost, inputTokens, outputTokens, bp, now],
    });

    // Enforce spend caps asynchronously — don't block the response
    setImmediate(async () => {
      try {
        const cap = await checkSpendCap(client, agentId);
        if (cap.shouldSoftStop) {
          await markSoftStopped(client, agentId);
          await notifySoftStop(client, config, agentId);
        } else if (cap.shouldAlert80) {
          await markAlerted80(client, agentId);
          await notifySpend80(client, config, agentId, cap.percentUsed);
        }
      } catch (err) {
        console.warn('[spend] cap enforcement error (non-fatal):', err instanceof Error ? err.message : err);
      }
    });

    return { ok: true };
  });

  /**
   * Reset spend cap soft-stop for an agent (user raises their budget or resets)
   */
  app.post('/api/agents/:agentId/spend/reset', async (request, reply) => {
    const session = await getSession(request);
    if (!session) return reply.code(401).send({ error: 'Unauthorized' });

    const { agentId } = request.params as { agentId: string };

    // Verify ownership
    const ownership = await client.execute({
      sql: `SELECT id FROM agents WHERE id = ? AND user_id = ?`,
      args: [agentId, session.userId],
    });
    if (ownership.rows.length === 0) return reply.code(403).send({ error: 'Forbidden' });

    await resetSpendCap(client, agentId);
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

    const mcpConfigs: object[] = [
      buildPlatformMcpConfig(agentId),
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
      sql: `UPDATE deployed_agents SET status = 'running', fly_machine_id = COALESCE(?, fly_machine_id), mcp_server_name = ?, updated_at = ? WHERE id = ?`,
      args: [autoNewMachineId ?? null, MCP_SERVER_NAME, new Date().toISOString(), deployment.id as string],
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
  // ============================================================================
  // Admin — Agent Fleet View
  // ============================================================================

  // Joined view of agents + deployed_agents for admin tools and scripts.
  // Accepts either an admin session cookie or Authorization: Bearer <REINS_ADMIN_API_KEY>.
  app.get('/api/admin/agents', async (request, reply) => {
    if (!requireAdmin(request, reply)) return;

    const result = await client.execute(`
      SELECT
        a.id,
        a.name,
        a.status AS agent_status,
        da.id            AS deployment_id,
        da.fly_app_name,
        da.fly_machine_id,
        da.fly_volume_id,
        da.status        AS deployment_status,
        da.runtime,
        da.is_shared_bot,
        da.region,
        da.telegram_user_id,
        da.model_provider,
        da.model_name,
        da.management_url,
        da.created_at    AS deployed_at,
        da.updated_at    AS deployment_updated_at
      FROM agents a
      LEFT JOIN deployed_agents da ON da.agent_id = a.id
        AND da.status NOT IN ('destroyed', 'error')
      ORDER BY a.name, da.created_at DESC
    `);

    return { data: result.rows };
  });

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

  // Onboarding bot webhook relay — Telegram → backend → local onboarding service
  // Used in dev (tunnel only covers 5001; onboarding runs on 3001)
  app.post('/telegram', async (request, reply) => {
    const expectedSecret = config.onboardingBotWebhookSecret;
    if (expectedSecret) {
      const received = request.headers['x-telegram-bot-api-secret-token'];
      if (received !== expectedSecret) return reply.status(401).send({ error: 'Invalid secret token' });
    }
    const target = config.onboardingBotWebhookUrl;
    if (!target) return reply.status(503).send({ error: 'Onboarding service not configured' });
    try {
      await fetch(`${target}/telegram`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(request.body),
      });
    } catch (err) {
      console.error('[telegram-relay] forward failed:', err);
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
   * Resolve the agent and its owner from an x-reins-agent-secret gateway token.
   * Single validator shared by every agent-authenticated route.
   */
  async function resolveAgentFromGatewayToken(
    request: any
  ): Promise<{ agentId: string; userId: string; runtime: AgentRuntime; serverName: string } | null> {
    const agentSecret = request.headers['x-reins-agent-secret'] as string | undefined;
    if (!agentSecret) return null;

    const depResult = await client.execute({
      sql: `SELECT da.agent_id, da.runtime, da.mcp_server_name, da.is_manual, a.user_id
            FROM deployed_agents da
            JOIN agents a ON a.id = da.agent_id
            WHERE da.gateway_token = ? AND da.status NOT IN ('destroyed', 'error')
            LIMIT 1`,
      args: [agentSecret],
    });
    if (depResult.rows.length === 0) return null;

    return {
      agentId: depResult.rows[0].agent_id as string,
      userId: depResult.rows[0].user_id as string,
      // Decides how tool names are rendered back to this agent. A manual row
      // (claude.ai / Desktop / Code connect through their own client) resolves
      // to 'external' and gets bare names — the client adds its own prefix,
      // which the backend cannot know. Legacy null runtime means openclaw.
      runtime: deploymentRuntime(depResult.rows[0]),
      // The name baked into this machine's MCP_CONFIG, not MCP_SERVER_NAME —
      // they differ for any agent not yet redeployed after a rename.
      serverName: (depResult.rows[0].mcp_server_name as string | null) || LEGACY_MCP_SERVER_NAME,
    };
  }

  /**
   * Resolve the caller's memory scopes, from either a session or a gateway
   * token. Returns null if neither is present or valid.
   *
   * Replaces the old resolveMemoryUserId, which resolved an agent's token to
   * its owner and then discarded the agent identity — the reason every agent a
   * user owns shared one vault. Scope grants are keyed on that identity.
   *
   * Every user has exactly one scope until scopes become creatable, so routes
   * switching to this see identical behaviour — that is the point: the schema
   * and the resolver ship and are verified before any semantics change.
   */
  async function resolveMemoryScopeContext(request: any): Promise<MemoryContext | null> {
    return resolveMemoryContext(
      getSession(request) ?? null,
      () => resolveAgentFromGatewayToken(request)
    );
  }

  // -------------------------------------------------------------------------
  // Agent uploads — short-lived blobs an agent POSTs from its own container.
  //
  // Lets an agent attach a file it generated without the bytes passing through
  // the model's context. Raw octet-stream rather than multipart: there is one
  // file, its metadata fits in the query string, and multipart would mean a new
  // dependency (@fastify/multipart is not installed).
  // -------------------------------------------------------------------------

  // Scoped parser — registering it does not change how any other route parses.
  app.addContentTypeParser(
    'application/octet-stream',
    { parseAs: 'buffer' },
    (_request, body, done) => {
      done(null, body);
    }
  );

  app.post(
    '/api/agent-uploads',
    // Route-level, NEVER global. app.ts creates Fastify with no bodyLimit, so
    // the 1 MiB default applies to every route — including POST /mcp/:agentId,
    // which is exempt from the auth guard, and POST /api/auth/login. Raising it
    // globally on a 512 MB single-machine VM would turn every unauthenticated
    // endpoint into a memory-exhaustion lever against the one process holding
    // all decrypted OAuth tokens.
    { bodyLimit: MAX_UPLOAD_BYTES },
    async (request, reply) => {
      const agent = await resolveAgentFromGatewayToken(request);
      if (!agent) return reply.status(401).send({ error: 'Unauthorized' });

      const query = request.query as { filename?: string; mimeType?: string };
      const body = request.body;
      if (!Buffer.isBuffer(body) || body.length === 0) {
        return reply.status(400).send({
          error: 'Request body must be the raw file bytes with Content-Type: application/octet-stream',
        });
      }

      try {
        const upload = await createUpload({
          agentId: agent.agentId,
          userId: agent.userId,
          filename: query.filename ?? 'upload.bin',
          mimeType: query.mimeType ?? 'application/octet-stream',
          data: body,
        });
        return reply.status(201).send({ data: upload });
      } catch (error) {
        return reply.status(400).send({ error: (error as Error).message });
      }
    }
  );

  // Read back by the Gmail attachment resolver, which runs in the backend but
  // in the @reins/servers package and so goes through the API rather than
  // importing the db directly.
  app.get('/api/agent-uploads/:id', async (request, reply) => {
    const agent = await resolveAgentFromGatewayToken(request);
    if (!agent) return reply.status(401).send({ error: 'Unauthorized' });

    const { id } = request.params as { id: string };
    const upload = await getUpload(id, agent.agentId);
    if (!upload) return reply.status(404).send({ error: 'Upload not found or expired' });

    return reply
      .header('content-type', upload.mimeType)
      .header('content-length', String(upload.sizeBytes))
      .header('x-upload-filename', encodeURIComponent(upload.filename))
      .send(upload.data);
  });

  // =========================================================================
  // Skills
  //
  // Two audiences share this data:
  //   - the dashboard (session cookie) authors and assigns skills
  //   - the agent (x-reins-agent-secret) reads them via the skills MCP server
  //
  // Unlike memory, which scopes per user, skills scope per *agent* — so the
  // agent-facing routes use resolveAgentFromGatewayToken directly and there is
  // deliberately no session fallback (a session carries no agentId).
  // =========================================================================

  const SKILL_BODY_MAX = 64 * 1024;

  /** Shape a DB row for the dashboard. `user_id IS NULL` is the only system marker. */
  function mapSkillRow(row: Record<string, unknown>) {
    return {
      id: row.id as string,
      slug: row.slug as string,
      name: row.name as string,
      description: row.description as string,
      body: row.body as string,
      requiredServices: parseRequiredServices(row.required_services),
      version: (row.version as string | null) ?? null,
      isSystem: row.user_id === null,
      // Provenance of the current content; only meaningful on system rows.
      source: ((row.source as string | null) ?? 'admin') as 'template' | 'admin',
      autoAssign: Boolean(row.auto_assign),
      enabled: Boolean(row.enabled),
      createdAt: row.created_at as string,
      updatedAt: row.updated_at as string,
    };
  }

  function slugify(value: string): string {
    return value
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .slice(0, 64)
      .replace(/^-+|-+$/g, '');
  }

  /**
   * Validate a create/update payload. Returns an error message, or null.
   * Service types are checked against the live registry so a skill can never
   * depend on something that doesn't exist.
   */
  function validateSkillPayload(body: {
    name?: unknown;
    description?: unknown;
    body?: unknown;
    requiredServices?: unknown;
    version?: unknown;
  }): string | null {
    if (body.version !== undefined && body.version !== null && typeof body.version !== 'string') {
      return 'version must be a string';
    }
    if (typeof body.name !== 'string' || body.name.trim() === '') return 'name is required';
    if (typeof body.description !== 'string') return 'description is required';
    if (typeof body.body !== 'string' || body.body.trim() === '') return 'body is required';
    if (body.body.length > SKILL_BODY_MAX) {
      return `body exceeds ${SKILL_BODY_MAX} bytes — the whole body is sent to the agent on every read`;
    }
    if (body.requiredServices !== undefined) {
      if (!Array.isArray(body.requiredServices)) return 'requiredServices must be an array';
      for (const s of body.requiredServices) {
        if (typeof s !== 'string' || !validServiceTypes.includes(s)) {
          return `Unknown service type: ${String(s)}`;
        }
      }
    }
    return null;
  }

  /** A skill the session user may read: their own, or any system skill. */
  async function getReadableSkill(id: string, userId: string) {
    const result = await client.execute({
      sql: `SELECT * FROM skills WHERE id = ? AND (user_id = ? OR user_id IS NULL) LIMIT 1`,
      args: [id, userId],
    });
    return result.rows[0] ?? null;
  }

  const skillNotFound = { error: { code: 'NOT_FOUND', message: 'Skill not found' } };

  /**
   * What `source` should read after an update.
   *
   * Editing a template-seeded platform skill takes it out of the seeder's hands
   * — that is the mechanism that stops the next deploy reverting the edit. But
   * only a *content* change counts. PUT /api/skills/:id is also how an admin
   * toggles `enabled` or `autoAssign`, and detaching a stock skill from upstream
   * fixes because someone disabled it for an afternoon is a surprise with a
   * multi-deploy tail.
   *
   * A no-op for user-owned rows, which read 'admin' either way.
   */
  function nextSkillSource(
    existing: Record<string, unknown>,
    next: { name: string; description: string; body: string; requiredServices: string }
  ): string {
    const contentChanged =
      next.name !== existing.name ||
      next.description !== existing.description ||
      next.body !== existing.body ||
      next.requiredServices !== JSON.stringify(parseRequiredServices(existing.required_services));
    return contentChanged ? 'admin' : ((existing.source as string | null) ?? 'admin');
  }

  // --- Dashboard audience ---------------------------------------------------

  app.get('/api/skills', async (request) => {
    const userId = getUserId(request);

    const [skillRows, assignments] = await Promise.all([
      client.execute({
        sql: `SELECT * FROM skills WHERE user_id = ? OR user_id IS NULL ORDER BY user_id NULLS FIRST, name`,
        args: [userId],
      }),
      client.execute({
        sql: `SELECT ask.skill_id, ask.agent_id FROM agent_skills ask
              JOIN agents a ON a.id = ask.agent_id
              WHERE a.user_id = ?`,
        args: [userId],
      }),
    ]);

    const bySkill = new Map<string, string[]>();
    for (const row of assignments.rows) {
      const skillId = row.skill_id as string;
      if (!bySkill.has(skillId)) bySkill.set(skillId, []);
      bySkill.get(skillId)!.push(row.agent_id as string);
    }

    return {
      data: skillRows.rows.map((row) => ({
        ...mapSkillRow(row),
        assignedAgentIds: bySkill.get(row.id as string) ?? [],
      })),
    };
  });

  app.post('/api/skills', async (request, reply) => {
    const userId = getUserId(request);
    const body = request.body as {
      name?: string; description?: string; body?: string;
      requiredServices?: string[]; slug?: string; isSystem?: boolean;
      version?: string;
    };

    // Only admins may author platform-wide skills.
    if (body.isSystem && !requireAdmin(request, reply)) return;

    const invalid = validateSkillPayload(body);
    if (invalid) {
      return reply.code(400).send({ error: { code: 'VALIDATION_ERROR', message: invalid } });
    }

    const slug = slugify(body.slug || body.name!);
    if (!slug) {
      return reply.code(400).send({ error: { code: 'VALIDATION_ERROR', message: 'Could not derive a slug from name' } });
    }

    const id = body.isSystem ? slug : nanoid();
    const ownerId = body.isSystem ? null : userId;

    try {
      await client.execute({
        sql: `INSERT INTO skills (id, user_id, slug, name, description, body, required_services, version, source, created_at, updated_at)
              VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'admin', now(), now())`,
        args: [id, ownerId, slug, body.name!.trim(), body.description!, body.body!,
               JSON.stringify(body.requiredServices ?? []),
               (body.version as string | undefined) ?? null],
      });
    } catch (err) {
      // 23505 = unique_violation. Anything else is a real failure and must not
      // be reported to the user as a naming collision.
      if ((err as { code?: string })?.code === '23505') {
        return reply.code(409).send({
          error: { code: 'DUPLICATE_SLUG', message: `You already have a skill with the slug "${slug}"` },
        });
      }
      throw err;
    }

    // Skill bodies are instructions the agent will follow, so changes to them
    // belong in the same audit trail as policy changes.
    await auditLogger.log({
      eventType: 'policy_change',
      result: 'success',
      metadata: { kind: 'skill', action: 'created', skillId: id, slug, changedBy: userId },
    });

    const row = await getReadableSkill(id, userId);
    return reply.code(201).send({ data: row ? mapSkillRow(row) : null });
  });

  app.get<{ Params: { id: string } }>('/api/skills/:id', async (request, reply) => {
    const userId = getUserId(request);
    const row = await getReadableSkill(request.params.id, userId);
    if (!row) return reply.code(404).send(skillNotFound);
    return { data: mapSkillRow(row) };
  });

  app.put<{ Params: { id: string } }>('/api/skills/:id', async (request, reply) => {
    const userId = getUserId(request);
    const { id } = request.params;
    const body = request.body as {
      name?: string; description?: string; body?: string;
      requiredServices?: string[]; enabled?: boolean; autoAssign?: boolean;
      version?: string;
    };

    const existing = await getReadableSkill(id, userId);
    if (!existing) return reply.code(404).send(skillNotFound);
    // System skills are readable by everyone but writable only by admins.
    if (existing.user_id === null && !requireAdmin(request, reply)) return;

    const invalid = validateSkillPayload(body);
    if (invalid) {
      return reply.code(400).send({ error: { code: 'VALIDATION_ERROR', message: invalid } });
    }

    const nextRequiredServices = JSON.stringify(
      body.requiredServices ?? parseRequiredServices(existing.required_services)
    );

    await client.execute({
      sql: `UPDATE skills SET name = ?, description = ?, body = ?, required_services = ?,
                  enabled = ?, auto_assign = ?, version = ?, source = ?, updated_at = now()
            WHERE id = ?`,
      args: [
        body.name!.trim(), body.description!, body.body!,
        nextRequiredServices,
        body.enabled ?? Boolean(existing.enabled),
        body.autoAssign ?? Boolean(existing.auto_assign),
        // Omitting version keeps the stamped one — a dashboard edit must not
        // silently un-version a skill the installer placed.
        body.version ?? ((existing.version as string | null) ?? null),
        nextSkillSource(existing, {
          name: body.name!.trim(), description: body.description!,
          body: body.body!, requiredServices: nextRequiredServices,
        }),
        id,
      ],
    });

    await auditLogger.log({
      eventType: 'policy_change',
      result: 'success',
      metadata: { kind: 'skill', action: 'updated', skillId: id, slug: existing.slug, changedBy: userId },
    });

    const row = await getReadableSkill(id, userId);
    return { data: row ? mapSkillRow(row) : null };
  });

  app.delete<{ Params: { id: string } }>('/api/skills/:id', async (request, reply) => {
    const userId = getUserId(request);
    const { id } = request.params;

    const existing = await getReadableSkill(id, userId);
    if (!existing) return reply.code(404).send(skillNotFound);
    if (existing.user_id === null && !requireAdmin(request, reply)) return;

    // agent_skills rows go with it via ON DELETE CASCADE.
    await client.execute({ sql: `DELETE FROM skills WHERE id = ?`, args: [id] });

    await auditLogger.log({
      eventType: 'policy_change',
      result: 'success',
      metadata: { kind: 'skill', action: 'deleted', skillId: id, slug: existing.slug, changedBy: userId },
    });

    return { data: { deleted: true } };
  });

  // --- Assignment (dashboard, agent-ownership-guarded) ----------------------

  /** 404 rather than 403 — an agent id is not an authorization boundary. */
  async function userOwnsAgent(userId: string, agentId: string): Promise<boolean> {
    const result = await client.execute({
      sql: `SELECT 1 FROM agents WHERE id = ? AND user_id = ? LIMIT 1`,
      args: [agentId, userId],
    });
    return result.rows.length > 0;
  }

  async function ownsAgent(request: any, agentId: string): Promise<boolean> {
    return userOwnsAgent(getUserId(request), agentId);
  }

  const agentNotFound = { error: { code: 'NOT_FOUND', message: 'Agent not found' } };

  /**
   * Turn a refusal from the permissions guard into a 409 the dashboard can act
   * on, and return true. Returns false for anything else, so callers rethrow.
   *
   * 409 rather than 403: the request is well-formed and the caller is allowed to
   * make it — it conflicts with the account's current state, which the payload
   * describes precisely enough for the UI to offer the fix.
   */
  function sendPermissionConflict(err: unknown, reply: any): boolean {
    // `details` rather than top-level fields: that is the envelope the frontend
    // ApiError already carries through, so the UI gets these without a client
    // change and without a second error shape to keep in sync.
    if (err instanceof ServiceCombinationError) {
      reply.code(409).send({
        error: {
          code: err.code,
          message: err.message,
          // What the owner would have to turn off to proceed.
          details: { conflicting: err.conflicting, serviceType: err.serviceType },
        },
      });
      return true;
    }
    if (err instanceof UnauthenticatedEndpointsOpenError) {
      reply.code(409).send({
        error: {
          code: err.code,
          message: err.message,
          details: { openAgents: err.openAgents },
        },
      });
      return true;
    }
    return false;
  }

  app.get<{ Params: { id: string } }>('/api/agents/:id/skills', async (request, reply) => {
    const { id } = request.params;
    if (!(await ownsAgent(request, id))) return reply.code(404).send(agentNotFound);

    const result = await client.execute({
      sql: `SELECT s.* FROM skills s
            JOIN agent_skills ask ON ask.skill_id = s.id
            WHERE ask.agent_id = ? ORDER BY s.name`,
      args: [id],
    });

    const mapped = result.rows.map(mapSkillRow);
    const availability = await resolveAvailability(id, mapped);

    return {
      data: mapped.map((s) => ({
        ...s,
        available: availability.get(s.id)?.available ?? true,
        missingServices: availability.get(s.id)?.missingServices ?? [],
      })),
    };
  });

  app.put<{ Params: { id: string } }>('/api/agents/:id/skills', async (request, reply) => {
    const { id } = request.params;
    const userId = getUserId(request);
    if (!(await ownsAgent(request, id))) return reply.code(404).send(agentNotFound);

    const body = request.body as { skillIds?: unknown };
    if (!Array.isArray(body.skillIds)) {
      return reply.code(400).send({ error: { code: 'VALIDATION_ERROR', message: 'skillIds must be an array' } });
    }
    const skillIds = body.skillIds.filter((s): s is string => typeof s === 'string');

    // Every id must be readable by this user, so nobody can attach someone
    // else's skill to their own agent.
    const readable: Array<{ id: string; slug: string; name: string; requiredServices: string[] }> = [];
    for (const skillId of skillIds) {
      const row = await getReadableSkill(skillId, userId);
      if (!row) return reply.code(404).send(skillNotFound);
      readable.push({
        id: row.id as string,
        slug: row.slug as string,
        name: row.name as string,
        requiredServices: parseRequiredServices(row.required_services),
      });
    }

    // Dependencies must be satisfied *before* a skill can be attached. (Once
    // attached, a later disconnect only marks it unavailable — see
    // services/skills.ts — so the user never silently loses assignments.)
    const availability = await resolveAvailability(id, readable);
    const blocked = readable
      .map((s) => ({ skill: s, missing: availability.get(s.id)?.missingServices ?? [] }))
      .filter((entry) => entry.missing.length > 0);

    if (blocked.length > 0) {
      return reply.code(409).send({
        error: {
          code: 'MISSING_SERVICES',
          message: blocked
            .map((b) => `"${b.skill.name}" needs ${b.missing.join(', ')}, not connected to this agent`)
            .join('; '),
          details: blocked.map((b) => ({ skillId: b.skill.id, missingServices: b.missing })),
        },
      });
    }

    await client.execute({ sql: `DELETE FROM agent_skills WHERE agent_id = ?`, args: [id] });
    for (const skill of readable) {
      await client.execute({
        sql: `INSERT INTO agent_skills (agent_id, skill_id, created_at) VALUES (?, ?, now())
              ON CONFLICT DO NOTHING`,
        args: [id, skill.id],
      });
    }

    return { data: readable.map((s) => ({ id: s.id, slug: s.slug })) };
  });

  app.delete<{ Params: { id: string; skillId: string } }>(
    '/api/agents/:id/skills/:skillId',
    async (request, reply) => {
      const { id, skillId } = request.params;
      if (!(await ownsAgent(request, id))) return reply.code(404).send(agentNotFound);

      await client.execute({
        sql: `DELETE FROM agent_skills WHERE agent_id = ? AND skill_id = ?`,
        args: [id, skillId],
      });
      return { data: { removed: true } };
    }
  );

  // --- Architect audience (gateway token, skill-authoring service) -----------
  //
  // Write counterparts to /api/agent-skills, for an agent running the
  // skill-authoring service. Authenticated as the *agent*, then scoped to its
  // owner: an agent may touch its owner's skills and no one else's.
  //
  // System skills (user_id IS NULL) are reachable, but only through two
  // independent gates that enabling this service does not confer: the caller
  // must pass `scope: "system"` explicitly, and the agent's *owner* must hold
  // users.role = 'admin' (isAdminUser, not requireAdmin — see the note there).
  // Neither gate is something an agent can grant itself.
  //
  // Reaching these routes at all requires the skill-authoring service to be
  // enabled on that agent. That enablement is the whole privilege boundary;
  // see the note in servers/src/skill-authoring/definition.ts.
  //
  // The boundary is enforced *here*, not only in the MCP endpoint: every deployed
  // agent has its own gateway token and REINS_API_URL in its environment, so an
  // agent that is merely denied the tools could otherwise call these routes
  // directly. Skill bodies are instructions other agents follow.

  /**
   * 403 rather than 404: the caller is a valid agent of a real owner, it simply
   * is not an architect. Nothing about another user is revealed by saying so.
   */
  /**
   * Is this agent's owner a Helm admin, by database role?
   *
   * The role half of requireAdmin() with neither of its two credentials. A
   * gateway token carries no session cookie, so requireAdmin() cannot be reused
   * here — and must not be: it also accepts REINS_ADMIN_API_KEY, a human
   * operator credential that an agent presenting an Authorization header would
   * otherwise launder into platform-wide authorship.
   *
   * Checks status as well as role, matching the session lookup in
   * backend/src/auth/index.ts: a suspended admin must not keep writing skills
   * every account loads, through an agent token that is still live.
   */
  async function isAdminUser(userId: string): Promise<boolean> {
    const result = await client.execute({
      sql: `SELECT 1 FROM users WHERE id = ? AND role = 'admin' AND status = 'active' LIMIT 1`,
      args: [userId],
    });
    return result.rows.length > 0;
  }

  type SkillScope = 'user' | 'system';

  /**
   * Resolve the `scope` argument on an architect write. Returns null once it has
   * already sent the refusal.
   *
   * Explicit, and defaulting to 'user'. Scope is deliberately never inferred
   * from the target row: an architect that names a platform skill id by mistake
   * gets a 404, not a platform-wide edit — and the owner's approval prompt would
   * have read as an ordinary skill edit either way. The opt-in *is* the safety
   * property.
   */
  async function resolveSkillScope(
    raw: unknown,
    userId: string,
    reply: any
  ): Promise<SkillScope | null> {
    if (raw === undefined || raw === null || raw === 'user') return 'user';
    if (raw !== 'system') {
      reply.code(400).send({
        error: { code: 'VALIDATION_ERROR', message: 'scope must be "user" or "system"' },
      });
      return null;
    }
    if (!(await isAdminUser(userId))) {
      reply.code(403).send({
        error: {
          code: 'ADMIN_REQUIRED',
          message:
            'Only an agent whose owner is a Helm admin may write platform skills. ' +
            'Omit scope, or pass "user", to write a skill for this account.',
        },
      });
      return null;
    }
    return 'system';
  }

  async function requireSkillAuthoring(agentId: string, reply: any): Promise<boolean> {
    if (await isServiceEnabledForAgent(agentId, 'skill-authoring')) return true;
    reply.code(403).send({
      error: {
        code: 'SERVICE_NOT_ENABLED',
        message: 'The skill-authoring service is not enabled on this agent.',
      },
    });
    return false;
  }

  /**
   * The owner's whole skill library, for an architect agent.
   *
   * Distinct from GET /api/agent-skills, which returns only what is assigned to
   * the calling agent — authoring needs the ids of skills it has not been given,
   * including ones assigned to no agent at all.
   *
   * Bodies are omitted, matching /api/agent-skills: the list is for picking an id,
   * and one body at a time is pulled via /api/agent-skills/:slug. The
   * assignedAgentIds aggregate that the dashboard's /api/skills computes is left
   * out too — an agent has no use for it, and it would name the owner's other agents.
   */
  app.get('/api/skill-library', async (request, reply) => {
    const agent = await resolveAgentFromGatewayToken(request);
    if (!agent) return reply.status(401).send({ error: 'Unauthorized' });
    if (!(await requireSkillAuthoring(agent.agentId, reply))) return;

    // Resolved once for the list rather than per row: whether a platform skill
    // is read-only is a fact about the *caller*, not about the skill.
    const canEditSystem = await isAdminUser(agent.userId);

    const result = await client.execute({
      sql: `SELECT * FROM skills WHERE user_id = ? OR user_id IS NULL
            ORDER BY user_id NULLS FIRST, name`,
      args: [agent.userId],
    });

    return {
      data: result.rows.map((row) => {
        const { body: _body, ...rest } = mapSkillRow(row);
        return {
          ...rest,
          scope: rest.isSystem ? ('system' as const) : ('user' as const),
          readOnly: rest.isSystem && !canEditSystem,
        };
      }),
    };
  });

  /**
   * One skill's full source, for an architect agent.
   *
   * Distinct from GET /api/agent-skills/:slug in the two ways that matter to an
   * author:
   *
   *  - **No assignment check.** That route serves only what is assigned to the
   *    caller, which is the right rule for an agent *using* a skill and the
   *    wrong one for an agent maintaining the library. An author has to read
   *    what it does not run.
   *  - **No token rendering, and no availability gating.** That route resolves
   *    {{tool:…}} and {{skill:…}} into the reading agent's runtime names. An
   *    author would then write those rendered names back on update, baking one
   *    runtime's spelling into the stored body and breaking the skill for the
   *    other. This returns the body exactly as stored. For the same reason the
   *    `available` / `missingServices` fields are omitted rather than reported
   *    as false: an architect holds none of the services a skill requires, so
   *    they would be noise on every read.
   *
   * Addressable by id or slug: ids come from skill_authoring_list, and slugs
   * come from the {{skill:its-slug}} references inside skill bodies, which is
   * exactly what an author follows when reading around a skill.
   */
  app.get<{ Params: { idOrSlug: string } }>('/api/skill-library/:idOrSlug', async (request, reply) => {
    const agent = await resolveAgentFromGatewayToken(request);
    if (!agent) return reply.status(401).send({ error: 'Unauthorized' });
    if (!(await requireSkillAuthoring(agent.agentId, reply))) return;

    const { idOrSlug } = request.params;
    // Same visibility as the list: the owner's own skills plus platform ones,
    // which are readable so an author can model new work on them even though
    // getWritableSkill refuses to let them be edited.
    const result = await client.execute({
      sql: `SELECT * FROM skills
            WHERE (id = ? OR slug = ?) AND (user_id = ? OR user_id IS NULL)
            ORDER BY user_id NULLS LAST
            LIMIT 1`,
      args: [idOrSlug, idOrSlug, agent.userId],
    });

    if (result.rows.length === 0) {
      return reply.status(404).send({
        error: `No skill with id or slug "${idOrSlug}" exists on this account.`,
        code: 'SKILL_NOT_FOUND',
      });
    }

    const skill = mapSkillRow(result.rows[0]);
    return {
      data: {
        ...skill,
        // `scope` names the argument that reaches this row; `readOnly` answers
        // whether this caller may use it. They are different questions now that
        // an admin owner's architect can write platform skills, and saying both
        // here saves an author discovering the answer only when a write fails.
        scope: skill.isSystem ? ('system' as const) : ('user' as const),
        readOnly: skill.isSystem && !(await isAdminUser(agent.userId)),
      },
    };
  });

  /** A skill this owner may write: their own only, never a system skill. */
  async function getWritableSkill(id: string, userId: string) {
    const result = await client.execute({
      sql: `SELECT * FROM skills WHERE id = ? AND user_id = ? LIMIT 1`,
      args: [id, userId],
    });
    return result.rows[0] ?? null;
  }

  /** A platform skill. Only reached once resolveSkillScope has cleared 'system'. */
  async function getSystemSkill(id: string) {
    const result = await client.execute({
      sql: `SELECT * FROM skills WHERE id = ? AND user_id IS NULL LIMIT 1`,
      args: [id],
    });
    return result.rows[0] ?? null;
  }

  /**
   * A 404 on a user-scoped write is worth one extra lookup: if the id names a
   * platform skill, say so and name the argument that reaches it. Nothing leaks
   * — every account can already read every platform skill via /api/skill-library
   * — and the alternative is an architect retrying a well-formed call forever.
   *
   * 409 rather than 403: the request conflicts with state the payload can fix,
   * and the caller may well be allowed once it does.
   */
  async function scopeRequiredIfSystem(id: string, reply: any): Promise<boolean> {
    const system = await getSystemSkill(id);
    if (!system) return false;
    reply.code(409).send({
      error: {
        code: 'SCOPE_REQUIRED',
        message:
          `"${system.slug as string}" is a platform skill. Pass scope:"system" to change it — ` +
          'which requires your owner to be a Helm admin.',
      },
    });
    return true;
  }

  app.post('/api/agent-skills', async (request, reply) => {
    const agent = await resolveAgentFromGatewayToken(request);
    if (!agent) return reply.status(401).send({ error: 'Unauthorized' });
    if (!(await requireSkillAuthoring(agent.agentId, reply))) return;

    const body = request.body as {
      name?: string; description?: string; body?: string;
      requiredServices?: string[]; slug?: string; version?: string;
      scope?: string;
    };

    // Authorization before shape: a non-admin owner must not learn which payload
    // field is malformed on a platform write it could never have made.
    const scope = await resolveSkillScope(body.scope, agent.userId, reply);
    if (!scope) return;

    const invalid = validateSkillPayload(body);
    if (invalid) {
      return reply.code(400).send({ error: { code: 'VALIDATION_ERROR', message: invalid } });
    }

    const slug = slugify(body.slug || body.name!);
    if (!slug) {
      return reply.code(400).send({ error: { code: 'VALIDATION_ERROR', message: 'Could not derive a slug from name' } });
    }

    // Mirrors the dashboard's POST /api/skills and the seeder: a platform
    // skill's id *is* its slug, which is what lets seedSystemSkills() update in
    // place rather than duplicate.
    const id = scope === 'system' ? slug : nanoid();
    const ownerId = scope === 'system' ? null : agent.userId;

    try {
      await client.execute({
        sql: `INSERT INTO skills (id, user_id, slug, name, description, body, required_services, version, source, created_at, updated_at)
              VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'admin', now(), now())`,
        args: [id, ownerId, slug, body.name!.trim(), body.description!, body.body!,
               JSON.stringify(body.requiredServices ?? []), body.version ?? null],
      });
    } catch (err) {
      // 23505 covers both the primary key (system rows, where id = slug) and the
      // partial unique indexes on slug.
      if ((err as { code?: string })?.code === '23505') {
        return reply.code(409).send({
          error: {
            code: 'DUPLICATE_SLUG',
            message: scope === 'system'
              ? `A platform skill with the slug "${slug}" already exists`
              : `A skill with the slug "${slug}" already exists`,
          },
        });
      }
      throw err;
    }

    // Same trail as a dashboard edit: a skill body is an instruction another
    // agent will follow, and this one was written by an agent.
    await auditLogger.log({
      eventType: 'policy_change',
      result: 'success',
      metadata: { kind: 'skill', action: 'created', skillId: id, slug, scope, changedBy: agent.userId, byAgent: agent.agentId },
    });

    return reply.code(201).send({ data: { id, slug, scope } });
  });

  app.put<{ Params: { id: string } }>('/api/agent-skills/id/:id', async (request, reply) => {
    const agent = await resolveAgentFromGatewayToken(request);
    if (!agent) return reply.status(401).send({ error: 'Unauthorized' });
    if (!(await requireSkillAuthoring(agent.agentId, reply))) return;

    const body = request.body as {
      name?: string; description?: string; body?: string;
      requiredServices?: string[]; version?: string; scope?: string;
    };

    const scope = await resolveSkillScope(body.scope, agent.userId, reply);
    if (!scope) return;

    const existing = scope === 'system'
      ? await getSystemSkill(request.params.id)
      : await getWritableSkill(request.params.id, agent.userId);
    if (!existing) {
      // Signpost rather than stonewall when the miss is only about scope.
      if (scope === 'user' && (await scopeRequiredIfSystem(request.params.id, reply))) return;
      return reply.code(404).send(skillNotFound);
    }

    const invalid = validateSkillPayload(body);
    if (invalid) {
      return reply.code(400).send({ error: { code: 'VALIDATION_ERROR', message: invalid } });
    }

    const nextRequiredServices = JSON.stringify(
      body.requiredServices ?? parseRequiredServices(existing.required_services)
    );

    await client.execute({
      sql: `UPDATE skills SET name = ?, description = ?, body = ?, required_services = ?,
                  version = ?, source = ?, updated_at = now()
            WHERE id = ?`,
      args: [
        body.name!.trim(), body.description!, body.body!,
        nextRequiredServices,
        body.version ?? ((existing.version as string | null) ?? null),
        nextSkillSource(existing, {
          name: body.name!.trim(), description: body.description!,
          body: body.body!, requiredServices: nextRequiredServices,
        }),
        request.params.id,
      ],
    });

    await auditLogger.log({
      eventType: 'policy_change',
      result: 'success',
      metadata: {
        kind: 'skill', action: 'updated', skillId: request.params.id,
        slug: existing.slug, scope, changedBy: agent.userId, byAgent: agent.agentId,
      },
    });

    return { data: { id: request.params.id, slug: existing.slug as string, scope } };
  });

  /**
   * Attach or detach one skill on one of the owner's agents.
   *
   * Deliberately not modelled on PUT /api/agents/:id/skills, which replaces the
   * whole set: an agent submitting only the skill it just wrote would silently
   * unassign every other skill on the target. This reads, merges, and writes one
   * row.
   */
  /**
   * Delete one of the owner's skills, or — with scope=system and an admin owner
   * — a platform skill.
   *
   * Scope travels as a query parameter rather than a body: a DELETE with a JSON
   * payload needs the client to set Content-Type and Fastify to have a body
   * parser wired for the method, and both ends of this call are ours.
   */
  app.delete<{ Params: { id: string }; Querystring: { scope?: string } }>(
    '/api/agent-skills/id/:id',
    async (request, reply) => {
      const agent = await resolveAgentFromGatewayToken(request);
      if (!agent) return reply.status(401).send({ error: 'Unauthorized' });
      if (!(await requireSkillAuthoring(agent.agentId, reply))) return;

      const scope = await resolveSkillScope(request.query.scope, agent.userId, reply);
      if (!scope) return;

      const { id } = request.params;
      const existing = scope === 'system'
        ? await getSystemSkill(id)
        : await getWritableSkill(id, agent.userId);
      if (!existing) {
        if (scope === 'user' && (await scopeRequiredIfSystem(id, reply))) return;
        return reply.code(404).send(skillNotFound);
      }

      // Stated as a number rather than a phrase: "removes it from every agent"
      // is easy to nod through, "removes it from 34 agents" is not.
      const attached = await client.execute({
        sql: `SELECT count(*) AS n FROM agent_skills WHERE skill_id = ?`,
        args: [id],
      });
      const detachedFrom = Number(attached.rows[0]?.n ?? 0);

      // agent_skills rows go with it via ON DELETE CASCADE.
      await client.execute({ sql: `DELETE FROM skills WHERE id = ?`, args: [id] });

      await auditLogger.log({
        eventType: 'policy_change',
        result: 'success',
        metadata: {
          kind: 'skill', action: 'deleted', skillId: id, slug: existing.slug, scope,
          detachedFrom, changedBy: agent.userId, byAgent: agent.agentId,
        },
      });

      return {
        data: {
          id, slug: existing.slug as string, deleted: true, detachedFrom,
          // Platform skills are re-created from templates/skills/ on every boot.
          // Deleting one only sticks if no template ships for its slug — which
          // this process cannot know, so it states the condition rather than
          // guessing at it.
          ...(existing.user_id === null ? { reseeds: true } : {}),
        },
      };
    }
  );

  app.post<{ Params: { agentId: string } }>('/api/agent-skills/assign/:agentId', async (request, reply) => {
    const agent = await resolveAgentFromGatewayToken(request);
    if (!agent) return reply.status(401).send({ error: 'Unauthorized' });
    if (!(await requireSkillAuthoring(agent.agentId, reply))) return;

    const target = request.params.agentId;
    // 404 rather than 403 — an agent id is not an authorization boundary.
    if (!(await userOwnsAgent(agent.userId, target))) return reply.code(404).send(agentNotFound);

    const body = request.body as { skillId?: unknown; attached?: unknown };
    if (typeof body.skillId !== 'string') {
      return reply.code(400).send({ error: { code: 'VALIDATION_ERROR', message: 'skillId is required' } });
    }
    const attach = body.attached !== false;

    // Readable, not writable: attaching a platform skill to your own agent is
    // not a privileged act, and the dashboard has always allowed it — PUT
    // /api/agents/:id/skills resolves the same set through getReadableSkill.
    // The write scope here also made *un*assigning one impossible, since the
    // detach branch sits below this lookup: a platform skill the dashboard
    // attached could never be detached by the architect managing that agent.
    const skill = await getReadableSkill(body.skillId, agent.userId);
    if (!skill) return reply.code(404).send(skillNotFound);

    if (!attach) {
      await client.execute({
        sql: `DELETE FROM agent_skills WHERE agent_id = ? AND skill_id = ?`,
        args: [target, body.skillId],
      });
      return { data: { agentId: target, skillId: body.skillId, attached: false } };
    }

    // Dependencies must be satisfied before attaching, same rule the dashboard
    // enforces — a skill needing a service the target lacks is refused here
    // rather than surfacing as a broken skill later.
    const requiredServices = parseRequiredServices(skill.required_services);
    const availability = await resolveAvailability(target, [{ id: skill.id as string, requiredServices }]);
    const missing = availability.get(skill.id as string)?.missingServices ?? [];
    if (missing.length > 0) {
      return reply.code(409).send({
        error: {
          code: 'MISSING_SERVICES',
          message: `"${skill.name}" needs ${missing.join(', ')}, not connected to that agent`,
          details: [{ skillId: skill.id, missingServices: missing }],
        },
      });
    }

    await client.execute({
      sql: `INSERT INTO agent_skills (agent_id, skill_id, created_at) VALUES (?, ?, now())
            ON CONFLICT DO NOTHING`,
      args: [target, body.skillId],
    });

    await auditLogger.log({
      eventType: 'policy_change',
      result: 'success',
      metadata: {
        kind: 'skill', action: 'assigned', skillId: body.skillId, slug: skill.slug,
        targetAgentId: target, changedBy: agent.userId, byAgent: agent.agentId,
      },
    });

    return { data: { agentId: target, skillId: body.skillId, attached: true } };
  });

  // --- Agent audience (gateway token only) ----------------------------------

  /**
   * Skills this agent can see: exactly what was explicitly assigned to it.
   *
   * This set is the exposure boundary in both directions — it is what
   * `skills_list` returns and the only thing `skills_get` will serve. A freshly
   * provisioned agent therefore starts empty on purpose; the setup notice tells
   * it so rather than a stock skill appearing unasked.
   */
  async function listAgentSkills(agentId: string) {
    const result = await client.execute({
      // Explicit assignment only. The auto_assign UNION that used to be here
      // handed every system skill to every agent, which defeats per-agent
      // selection; auto_assign is now inert (settable via the API, read by
      // nothing).
      sql: `SELECT s.* FROM skills s
            JOIN agent_skills ask ON ask.skill_id = s.id
            WHERE ask.agent_id = ? AND s.enabled = true
            ORDER BY s.name`,
      args: [agentId],
    });

    const mapped = result.rows.map(mapSkillRow);
    const availability = await resolveAvailability(agentId, mapped);
    return mapped.map((s) => ({
      ...s,
      available: availability.get(s.id)?.available ?? true,
      missingServices: availability.get(s.id)?.missingServices ?? [],
    }));
  }

  app.get('/api/agent-skills', async (request, reply) => {
    const agent = await resolveAgentFromGatewayToken(request);
    if (!agent) return reply.status(401).send({ error: 'Unauthorized' });

    const query = request.query as { include_unavailable?: string };
    const includeUnavailable = query.include_unavailable !== 'false';

    let skills = await listAgentSkills(agent.agentId);
    if (!includeUnavailable) skills = skills.filter((s) => s.available);

    const manifest = await loadSkillVersionManifest();
    // Computed over the unfiltered set: hiding unavailable skills must not hide
    // that setup is incomplete.
    const setupNotice = buildSetupNotice(skills, manifest);

    // Bodies are omitted here on purpose — the list is advisory and the agent
    // pulls one body at a time via /:slug.
    return {
      data: skills.map(({ body: _body, ...rest }) => ({
        ...rest,
        ...compareSkillVersion(rest.slug, rest.version, manifest),
        description: resolveSkillTokens(
          resolveToolTokens(rest.description ?? '', agent.runtime, agent.serverName),
          agent.runtime,
          agent.serverName
        ),
      })),
      ...(setupNotice ? { setupNotice } : {}),
    };
  });

  /**
   * The owner's whole library, read-only, for ANY agent.
   *
   * Distinct from /api/agent-skills (what is assigned to you) and from
   * /api/skill-library (authoring: gated on skill-authoring, carries editing
   * metadata). This is for an agent that suspects its owner already has a
   * playbook it was not given: names and one-liners only, with an
   * assignedToMe flag, never a body — the assignment boundary enforced at
   * /api/agent-skills/:slug is unchanged.
   */
  app.get('/api/skill-catalog', async (request, reply) => {
    const agent = await resolveAgentFromGatewayToken(request);
    if (!agent) return reply.status(401).send({ error: 'Unauthorized' });

    const result = await client.execute({
      sql: `SELECT s.id, s.slug, s.name, s.description, s.user_id, s.required_services,
                   EXISTS (SELECT 1 FROM agent_skills ask
                           WHERE ask.skill_id = s.id AND ask.agent_id = ?) AS assigned_to_me
            FROM skills s
            WHERE s.enabled = true AND (s.user_id = ? OR s.user_id IS NULL)
            ORDER BY s.user_id NULLS FIRST, s.name`,
      args: [agent.agentId, agent.userId],
    });

    const render = (text: string) =>
      resolveSkillTokens(
        resolveToolTokens(text ?? '', agent.runtime, agent.serverName),
        agent.runtime,
        agent.serverName
      );

    return {
      data: result.rows.map((row) => ({
        id: row.id as string,
        slug: row.slug as string,
        name: row.name as string,
        description: render(String(row.description ?? '')),
        scope: row.user_id === null ? ('system' as const) : ('user' as const),
        requiredServices: parseRequiredServices(row.required_services),
        assignedToMe: row.assigned_to_me === true || row.assigned_to_me === 1,
      })),
    };
  });

  /**
   * Skills that exist for this owner — used only to distinguish "not assigned to
   * you" from "no such skill", never to serve one. Scoped to the owner so the
   * distinction cannot reveal another user's slugs.
   */
  async function loadReferenceCandidates(ownerUserId: string) {
    const result = await client.execute({
      sql: `SELECT * FROM skills WHERE enabled = true AND (user_id IS NULL OR user_id = ?)`,
      args: [ownerUserId],
    });
    return result.rows.map(mapSkillRow);
  }

  /**
   * Tag rows with the owner id the reachability resolver compares on.
   *
   * Candidates are already scoped to system ∪ owner, so `isSystem` is enough to
   * recover it — no need to widen any response shape with a raw user_id.
   */
  function withOwnerScope<T extends { isSystem: boolean }>(skills: T[], ownerUserId: string) {
    return skills.map((s) => ({ ...s, userId: s.isSystem ? null : ownerUserId }));
  }

  app.get<{ Params: { slug: string } }>('/api/agent-skills/:slug', async (request, reply) => {
    const agent = await resolveAgentFromGatewayToken(request);
    if (!agent) return reply.status(401).send({ error: 'Unauthorized' });

    const { slug } = request.params;
    type Candidate = ReturnType<typeof mapSkillRow> & { userId: string | null };
    const assigned: Candidate[] = withOwnerScope(
      await listAgentSkills(agent.agentId),
      agent.userId
    );

    let outcome = resolveAssignedSkill<Candidate>(slug, assigned);
    if (!outcome.reachable) {
      // Only to tell "you don't have it" from "it doesn't exist" — this load
      // never widens what is served.
      const known: Candidate[] = withOwnerScope(
        await loadReferenceCandidates(agent.userId),
        agent.userId
      );
      outcome = resolveAssignedSkill<Candidate>(slug, assigned, known);
    }

    if (!outcome.reachable) {
      // A typo and a missing assignment need different fixes, so they get
      // different answers.
      return reply.status(404).send({
        error: outcome.reason === 'not_found'
          ? `No skill with slug "${slug}" exists.`
          : `Skill "${slug}" exists but is not assigned to you. Ask your owner to assign it.`,
        code: outcome.reason === 'not_found' ? 'SKILL_NOT_FOUND' : 'SKILL_NOT_REACHABLE',
      });
    }

    const skill = outcome.skill;
    const availability = (await resolveAvailability(agent.agentId, [skill])).get(skill.id);

    // Resolve tokens here rather than in the skills MCP server: this is the one
    // place that knows the requesting agent's runtime and deployed server name,
    // and the two runtimes render tool names differently.
    const render = (text: string) =>
      resolveSkillTokens(
        resolveToolTokens(text ?? '', agent.runtime, agent.serverName),
        agent.runtime,
        agent.serverName
      );

    return {
      data: {
        ...skill,
        available: availability?.available ?? true,
        missingServices: availability?.missingServices ?? [],
        description: render(skill.description),
        body: render(skill.body),
      },
    };
  });

  // =========================================================================
  // Agent Admin — /api/agent-admin/*
  //
  // For an agent holding helm-admin, which organizes its owner's other agents.
  //
  // Everything here is scoped to the calling agent's owner, resolved from its
  // gateway token. As with skill-authoring, the boundary is enforced at these
  // routes and not only in the MCP endpoint: every deployed agent has its own
  // gateway token and REINS_API_URL in its environment, so an agent merely
  // denied the tools could otherwise call these directly.
  //
  // What is deliberately absent matters as much as what is here. There is no
  // route to read a gateway token, a credential, or an MCP URL; no route to
  // create or destroy an agent; and no route to re-open an unauthenticated
  // endpoint — that one is session-only by design, because it is the latch
  // holding this whole arrangement together.
  // =========================================================================

  async function requireHelmAdmin(agentId: string, reply: any): Promise<boolean> {
    if (await isServiceEnabledForAgent(agentId, ADMIN_SERVICE_TYPE)) return true;
    reply.code(403).send({
      error: {
        code: 'SERVICE_NOT_ENABLED',
        message: 'The helm-admin service is not enabled on this agent.',
      },
    });
    return false;
  }

  /** Resolve the calling admin agent, or send the right refusal. Null means handled. */
  async function resolveAdminCaller(request: any, reply: any) {
    const agent = await resolveAgentFromGatewayToken(request);
    if (!agent) {
      reply.status(401).send({ error: 'Unauthorized' });
      return null;
    }
    if (!(await requireHelmAdmin(agent.agentId, reply))) return null;
    return agent;
  }

  /**
   * A target agent belonging to this owner, or null after sending a 404.
   *
   * 404 rather than 403 for someone else's agent: an admin agent must not be
   * able to probe which ids exist on other accounts.
   */
  async function resolveAdminTarget(agentId: string, userId: string, reply: any) {
    const result = await client.execute({
      sql: `SELECT * FROM agents WHERE id = ? AND user_id = ? LIMIT 1`,
      args: [agentId, userId],
    });
    if (result.rows.length === 0) {
      reply.code(404).send(agentNotFound);
      return null;
    }
    return result.rows[0];
  }

  /**
   * helm-admin is not grantable through this API, in either direction.
   *
   * Granting it would let an admin agent mint more admin agents. Revoking it is
   * the first half of "remove admin from that agent, then re-open its endpoint"
   * — the exact sequence the latch exists to prevent. Both stay in the
   * dashboard, where a human is present.
   */
  /**
   * Which service a tool belongs to, from the registry rather than the caller.
   *
   * The model is not asked for it. It would sometimes get the pairing wrong,
   * and a mismatched (serviceType, toolName) writes a permission row that never
   * matches anything at evaluation time — a permission that silently does
   * nothing, which is worse than one that is refused.
   */
  async function resolveToolServiceType(toolName: string): Promise<string | null> {
    const { getServiceTypeFromToolName } = await import('@reins/servers');
    return getServiceTypeFromToolName(toolName);
  }

  function rejectAdminServiceType(serviceType: string, reply: any): boolean {
    if (serviceType !== ADMIN_SERVICE_TYPE) return false;
    reply.code(403).send({
      error: {
        code: 'SERVICE_NOT_GRANTABLE',
        message:
          'Helm Admin cannot be granted or removed from here. Change it in the dashboard, where your owner is present.',
      },
    });
    return true;
  }

  app.get('/api/agent-admin/agents', async (request, reply) => {
    const agent = await resolveAdminCaller(request, reply);
    if (!agent) return;

    const result = await client.execute({
      sql: `SELECT a.id, a.name, a.description, a.status, a.created_at,
                   d.status AS deployment_status, d.runtime, d.is_manual
            FROM agents a
            LEFT JOIN LATERAL (
              SELECT da.status, da.runtime, da.is_manual
              FROM deployed_agents da
              WHERE da.agent_id = a.id AND da.status NOT IN ('destroyed', 'error')
              ORDER BY da.created_at DESC LIMIT 1
            ) d ON true
            WHERE a.user_id = ?
            ORDER BY a.name`,
      args: [agent.userId],
    });

    const agentsOut = await Promise.all(
      result.rows.map(async (row) => ({
        id: row.id as string,
        name: row.name as string,
        description: (row.description as string | null) ?? null,
        status: row.status as string,
        runtime: (row.runtime as string | null) ?? null,
        isManual: row.is_manual === true || row.is_manual === 1,
        deploymentStatus: (row.deployment_status as string | null) ?? null,
        services: await listEnabledServiceTypes(row.id as string),
        // So the model can explain why a grant will be refused, instead of
        // proposing one and reporting a failure it did not anticipate.
        isSelf: row.id === agent.agentId,
      }))
    );

    return { data: agentsOut };
  });

  /**
   * Create an agent, closed from the moment it exists.
   *
   * Uses the create-manual shape — an agents row plus a deployed_agents row —
   * rather than POST /api/agents, which writes only the former. That matters:
   * listOpenMcpAgents counts an agent with no live deployment row as open, and
   * rightly so, since authenticateMcp serves those requests and credentials
   * resolve by agent rather than by deployment. An agent created the other way
   * could never then be granted anything, because every grant would hit the
   * per-target open-endpoint check.
   *
   * allow_unauthenticated is set false explicitly, as it is on every creation
   * path now: an agent is never born reachable by whoever learns its id. The
   * owner can open a dashboard-created agent later; one created by an agent
   * has no such switch offered to it.
   */
  app.post('/api/agent-admin/agents', async (request, reply) => {
    const agent = await resolveAdminCaller(request, reply);
    if (!agent) return;

    const body = request.body as { name?: unknown; description?: unknown };
    const name = typeof body.name === 'string' ? body.name.trim() : '';
    if (!name) {
      return reply.code(400).send({
        error: { code: 'VALIDATION_ERROR', message: 'name is required' },
      });
    }

    const agentId = nanoid();
    const deploymentId = nanoid();
    const gatewayToken = nanoid(32);
    const now = new Date().toISOString();

    await client.execute({
      sql: `INSERT INTO agents (id, user_id, name, description, status, created_at, updated_at)
            VALUES (?, ?, ?, ?, 'active', ?, ?)`,
      args: [agentId, agent.userId, name, typeof body.description === 'string' ? body.description : null, now, now],
    });

    await client.execute({
      sql: `INSERT INTO deployed_agents
              (id, agent_id, status, gateway_token, is_manual, allow_unauthenticated, mcp_server_name, created_at, updated_at)
            VALUES (?, ?, 'running', ?, 1, false, ?, ?, ?)`,
      args: [deploymentId, agentId, gatewayToken, MCP_SERVER_NAME, now, now],
    });

    await enableDefaultServices(agentId);

    await auditLogger.logAgentEvent(agentId, 'created', {
      name,
      createdByAgent: agent.agentId,
    });

    return reply.code(201).send({
      data: {
        id: agentId,
        name,
        description: typeof body.description === 'string' ? body.description : null,
        status: 'active',
        // Stated back so the model can tell the owner what it made, and does
        // not have to guess whether the agent is configurable yet.
        acceptsUnauthenticatedMcp: false,
      },
    });
  });

  /**
   * Destroy an agent. Irreversible: the Fly machine goes, and seven tables are
   * hard-deleted. Memory entries survive — they belong to the owner's scope,
   * not to the agent.
   */
  app.delete<{ Params: { agentId: string } }>('/api/agent-admin/agents/:agentId', async (request, reply) => {
    const agent = await resolveAdminCaller(request, reply);
    if (!agent) return;

    const target = await resolveAdminTarget(request.params.agentId, agent.userId, reply);
    if (!target) return;

    // Deleting your own caller mid-call, and taking the account's only admin
    // agent with it. Nothing good is on the other side of allowing this.
    if (request.params.agentId === agent.agentId) {
      return reply.code(403).send({
        error: {
          code: 'CANNOT_DESTROY_SELF',
          message: 'An admin agent cannot destroy itself. Do it from the dashboard.',
        },
      });
    }

    // Same reasoning as rejectAdminServiceType: removing Helm Admin from an
    // agent is the first half of undoing the latch that keeps unauthenticated
    // endpoints closed, and destruction removes it rather more thoroughly.
    if (await isServiceEnabledForAgent(request.params.agentId, ADMIN_SERVICE_TYPE)) {
      return reply.code(403).send({
        error: {
          code: 'CANNOT_DESTROY_ADMIN_AGENT',
          message:
            `${target.name} has Helm Admin. Destroying it from here would remove that boundary without your owner present. Do it from the dashboard.`,
        },
      });
    }

    await destroyAgentCompletely(request.params.agentId);

    await auditLogger.logAgentEvent(request.params.agentId, 'deleted', {
      name: target.name,
      destroyedByAgent: agent.agentId,
    });

    return { data: { id: request.params.agentId, name: target.name, destroyed: true } };
  });

  app.put<{ Params: { agentId: string; toolName: string } }>(
    '/api/agent-admin/agents/:agentId/tools/:toolName',
    async (request, reply) => {
      const agent = await resolveAdminCaller(request, reply);
      if (!agent) return;

      const target = await resolveAdminTarget(request.params.agentId, agent.userId, reply);
      if (!target) return;

      const { permission } = request.body as { permission?: string };
      const allowed: ToolPermission[] = ['allow', 'require_approval', 'block'];
      if (!permission || !allowed.includes(permission as ToolPermission)) {
        return reply.code(400).send({
          error: { code: 'VALIDATION_ERROR', message: `permission must be one of: ${allowed.join(', ')}` },
        });
      }

      const serviceType = await resolveToolServiceType(request.params.toolName);
      if (!serviceType) {
        return reply.code(400).send({
          error: { code: 'UNKNOWN_TOOL', message: `Not a known tool: ${request.params.toolName}` },
        });
      }
      if (rejectAdminServiceType(serviceType, reply)) return;

      // 'allow' widens reach exactly as a service grant does, so it takes the
      // same check. 'block' and 'require_approval' only narrow.
      if (permission === 'allow') {
        const open = await listOpenMcpAgents(agent.userId);
        if (open.some((a) => a.id === request.params.agentId)) {
          return reply.code(409).send({
            error: {
              code: 'TARGET_ACCEPTS_UNAUTHENTICATED_MCP',
              message: `${target.name} still accepts unauthenticated MCP calls. Ask your owner to close its unauthenticated endpoint first.`,
            },
          });
        }
      }

      await setToolPermission(
        request.params.agentId,
        serviceType,
        request.params.toolName,
        permission as ToolPermission
      );

      await auditLogger.log({
        eventType: 'policy_change',
        result: 'success',
        agentId: request.params.agentId,
        metadata: {
          kind: 'tool_permission',
          toolName: request.params.toolName,
          serviceType,
          permission,
          changedByAgent: agent.agentId,
        },
      });

      return { data: { agentId: request.params.agentId, toolName: request.params.toolName, serviceType, permission } };
    }
  );

  app.delete<{ Params: { agentId: string; toolName: string } }>(
    '/api/agent-admin/agents/:agentId/tools/:toolName',
    async (request, reply) => {
      const agent = await resolveAdminCaller(request, reply);
      if (!agent) return;

      const target = await resolveAdminTarget(request.params.agentId, agent.userId, reply);
      if (!target) return;

      const serviceType = await resolveToolServiceType(request.params.toolName);
      if (!serviceType) {
        return reply.code(400).send({
          error: { code: 'UNKNOWN_TOOL', message: `Not a known tool: ${request.params.toolName}` },
        });
      }
      if (rejectAdminServiceType(serviceType, reply)) return;

      await resetToolPermission(request.params.agentId, serviceType, request.params.toolName);

      await auditLogger.log({
        eventType: 'policy_change',
        result: 'success',
        agentId: request.params.agentId,
        metadata: {
          kind: 'tool_permission_reset',
          toolName: request.params.toolName,
          serviceType,
          changedByAgent: agent.agentId,
        },
      });

      return { data: { agentId: request.params.agentId, toolName: request.params.toolName, serviceType, reset: true } };
    }
  );

  app.get<{ Params: { agentId: string } }>('/api/agent-admin/agents/:agentId', async (request, reply) => {
    const agent = await resolveAdminCaller(request, reply);
    if (!agent) return;

    const target = await resolveAdminTarget(request.params.agentId, agent.userId, reply);
    if (!target) return;

    const services = await listEnabledServiceTypes(target.id as string);
    const withLevels = await Promise.all(
      services.map(async (serviceType) => ({
        serviceType,
        level: await getPermissionLevel(target.id as string, serviceType),
      }))
    );

    const openAgents = await listOpenMcpAgents(agent.userId);

    return {
      data: {
        id: target.id,
        name: target.name,
        description: target.description ?? null,
        status: target.status,
        services: withLevels,
        // Surfaced because it decides whether a grant to this agent is allowed.
        acceptsUnauthenticatedMcp: openAgents.some((a) => a.id === target.id),
      },
    };
  });

  app.get('/api/agent-admin/services', async (request, reply) => {
    const agent = await resolveAdminCaller(request, reply);
    if (!agent) return;

    const { serviceDefinitions: defs } = await import('@reins/servers');
    return {
      data: {
        services: defs
          // Not offered, because it cannot be granted from here anyway.
          .filter((d) => d.type !== ADMIN_SERVICE_TYPE)
          .map((d) => ({
            serviceType: d.type,
            name: d.name,
            description: d.description,
            requiresCredential: d.auth.required,
          })),
      },
    };
  });

  app.patch<{ Params: { agentId: string } }>('/api/agent-admin/agents/:agentId', async (request, reply) => {
    const agent = await resolveAdminCaller(request, reply);
    if (!agent) return;

    const target = await resolveAdminTarget(request.params.agentId, agent.userId, reply);
    if (!target) return;

    const body = request.body as { name?: unknown; description?: unknown; status?: unknown };
    const updates: string[] = ['updated_at = ?'];
    const args: (string | null)[] = [new Date().toISOString()];

    if (typeof body.name === 'string') {
      if (body.name.trim() === '') {
        return reply.code(400).send({
          error: { code: 'VALIDATION_ERROR', message: 'name cannot be empty' },
        });
      }
      updates.push('name = ?');
      args.push(body.name.trim());
    }
    if (typeof body.description === 'string') {
      updates.push('description = ?');
      args.push(body.description.trim() === '' ? null : body.description);
    }
    if (typeof body.status === 'string') {
      const allowed = ['active', 'paused', 'inactive'];
      if (!allowed.includes(body.status)) {
        return reply.code(400).send({
          error: { code: 'VALIDATION_ERROR', message: `status must be one of: ${allowed.join(', ')}` },
        });
      }
      updates.push('status = ?');
      args.push(body.status);
    }

    if (updates.length === 1) {
      return reply.code(400).send({
        error: { code: 'VALIDATION_ERROR', message: 'Nothing to change: pass name, description, or status' },
      });
    }

    args.push(request.params.agentId, agent.userId);
    await client.execute({
      sql: `UPDATE agents SET ${updates.join(', ')} WHERE id = ? AND user_id = ?`,
      args,
    });

    await auditLogger.log({
      eventType: 'policy_change',
      result: 'success',
      agentId: request.params.agentId,
      metadata: { kind: 'agent_metadata', changedByAgent: agent.agentId, fields: Object.keys(body) },
    });

    const updated = await client.execute({
      sql: `SELECT id, name, description, status FROM agents WHERE id = ? AND user_id = ?`,
      args: [request.params.agentId, agent.userId],
    });
    return { data: updated.rows[0] };
  });

  app.post<{ Params: { agentId: string } }>('/api/agent-admin/agents/:agentId/services', async (request, reply) => {
    const agent = await resolveAdminCaller(request, reply);
    if (!agent) return;

    const target = await resolveAdminTarget(request.params.agentId, agent.userId, reply);
    if (!target) return;

    const { serviceType } = request.body as { serviceType?: string };
    if (!serviceType || !validServiceTypes.includes(serviceType)) {
      return reply.code(400).send({
        error: { code: 'INVALID_SERVICE', message: `Invalid service type: ${serviceType}` },
      });
    }
    if (rejectAdminServiceType(serviceType, reply)) return;

    // The account-wide precondition is checked when helm-admin is enabled, but
    // agents created afterwards start with no deployment row and are therefore
    // open. Granting capability to one of those would hand it to anyone holding
    // its id, so the check is repeated per grant rather than trusted from setup.
    const open = await listOpenMcpAgents(agent.userId);
    if (open.some((a) => a.id === request.params.agentId)) {
      return reply.code(409).send({
        error: {
          code: 'TARGET_ACCEPTS_UNAUTHENTICATED_MCP',
          message:
            `${target.name} still accepts unauthenticated MCP calls, so anyone with its id could use what you grant it. ` +
            'Ask your owner to close its unauthenticated endpoint first.',
        },
      });
    }

    try {
      await createServiceInstance(request.params.agentId, serviceType);
    } catch (err) {
      if (sendPermissionConflict(err, reply)) return;
      throw err;
    }

    await auditLogger.log({
      eventType: 'policy_change',
      result: 'success',
      agentId: request.params.agentId,
      metadata: { kind: 'service_enabled', serviceType, changedByAgent: agent.agentId },
    });

    return { data: { agentId: request.params.agentId, serviceType, enabled: true } };
  });

  app.delete<{ Params: { agentId: string; serviceType: string } }>(
    '/api/agent-admin/agents/:agentId/services/:serviceType',
    async (request, reply) => {
      const agent = await resolveAdminCaller(request, reply);
      if (!agent) return;

      const target = await resolveAdminTarget(request.params.agentId, agent.userId, reply);
      if (!target) return;

      if (rejectAdminServiceType(request.params.serviceType, reply)) return;

      await setPermissionLevel(request.params.agentId, request.params.serviceType, 'none');

      await auditLogger.log({
        eventType: 'policy_change',
        result: 'success',
        agentId: request.params.agentId,
        metadata: {
          kind: 'service_disabled',
          serviceType: request.params.serviceType,
          changedByAgent: agent.agentId,
        },
      });

      return { data: { agentId: request.params.agentId, serviceType: request.params.serviceType, enabled: false } };
    }
  );

  app.put<{ Params: { agentId: string; serviceType: string } }>(
    '/api/agent-admin/agents/:agentId/services/:serviceType/level',
    async (request, reply) => {
      const agent = await resolveAdminCaller(request, reply);
      if (!agent) return;

      const target = await resolveAdminTarget(request.params.agentId, agent.userId, reply);
      if (!target) return;

      if (rejectAdminServiceType(request.params.serviceType, reply)) return;

      const { level } = request.body as { level?: string };
      const allowed = ['none', 'read', 'full'];
      if (!level || !allowed.includes(level)) {
        return reply.code(400).send({
          error: { code: 'VALIDATION_ERROR', message: `level must be one of: ${allowed.join(', ')}` },
        });
      }

      // Raising a level widens reach exactly as a grant does, so it carries the
      // same open-endpoint check. 'none' only narrows and is always permitted.
      if (level !== 'none') {
        const open = await listOpenMcpAgents(agent.userId);
        if (open.some((a) => a.id === request.params.agentId)) {
          return reply.code(409).send({
            error: {
              code: 'TARGET_ACCEPTS_UNAUTHENTICATED_MCP',
              message: `${target.name} still accepts unauthenticated MCP calls. Ask your owner to close its unauthenticated endpoint first.`,
            },
          });
        }
      }

      try {
        await setPermissionLevel(request.params.agentId, request.params.serviceType, level as PermissionLevel);
      } catch (err) {
        if (sendPermissionConflict(err, reply)) return;
        throw err;
      }

      await auditLogger.log({
        eventType: 'policy_change',
        result: 'success',
        agentId: request.params.agentId,
        metadata: {
          kind: 'permission_level',
          serviceType: request.params.serviceType,
          level,
          changedByAgent: agent.agentId,
        },
      });

      return { data: { agentId: request.params.agentId, serviceType: request.params.serviceType, level } };
    }
  );

  // -------------------------------------------------------------------------
  // GET /api/memory/root — the root index of every scope the caller can reach
  //
  // The response is a superset of what it used to be: the top-level fields are
  // still the default scope's root, exactly as before, with `scopes[]` added
  // alongside. Agents running the older MEMORY_POLICY.md see no change.
  //
  // Deliberately not polymorphic on scope count — a response that changes shape
  // the day a user adds a second scope is a prompt bug that only surfaces in
  // production.
  // -------------------------------------------------------------------------
  app.get('/api/memory/root', async (request, reply) => {
    const memCtx = await resolveMemoryScopeContext(request);
    if (!memCtx) return reply.status(401).send({ error: 'Unauthorized' });
    const userId = memCtx.userId;

    const requested = (request.query as Record<string, string>).scope;
    const picked = pickScope(memCtx, requested, 'read');
    if (isRejection(picked)) return reply.status(picked.status).send(picked.body);

    const wanted = memCtx.scopes.filter((s) => picked.scopeIds.includes(s.id));

    const roots = [];
    for (const scope of wanted) {
      const rootId = await ensureMemoryRoot(userId, scope.id);
      const result = await client.execute({
        sql: `SELECT id, type, title, content, created_at, updated_at, version FROM memory_entries WHERE id = ?`,
        args: [rootId],
      });
      const row = result.rows[0] as Record<string, unknown> | undefined;
      if (row) roots.push({ ...row, scope: scope.slug, scope_name: scope.name });
    }

    const primary = roots.find((r) => r.scope === memCtx.scopes.find((s) => s.isDefault)?.slug) ?? roots[0];

    return reply.send({
      data: {
        ...primary,
        default_scope: memCtx.scopes.find((s) => s.isDefault)?.slug ?? null,
        scopes: roots,
      },
    });
  });

  // -------------------------------------------------------------------------
  // GET /api/memory/entries — list/search entries
  // -------------------------------------------------------------------------
  app.get('/api/memory/entries', async (request, reply) => {
    const memCtx = await resolveMemoryScopeContext(request);
    if (!memCtx) return reply.status(401).send({ error: 'Unauthorized' });

    const { q, title, type, parent_id, limit: lim = '50', tag, since, order, scope } = request.query as Record<string, string>;
    const maxLimit = Math.min(parseInt(lim, 10) || 50, 200);

    // No scope given spans everything the caller can reach; naming one narrows.
    const picked = pickScope(memCtx, scope, 'read');
    if (isRejection(picked)) return reply.status(picked.status).send(picked.body);
    const scopeIn = picked.scopeIds.map(() => '?').join(', ');

    let rows;
    if (title) {
      // Exact lookup, deliberately not ts_rank: memory_get resolves titles
      // through here, and a ranked search can push the exact match past the
      // limit for a common title — "not found" for an entry that exists.
      const needle = title.trim();
      const result = await client.execute({
        sql: `SELECT e.id, e.user_id, e.type, e.title, e.content, e.created_at, e.updated_at, e.version,
                     s.slug AS scope, s.name AS scope_name
              FROM memory_entries e
              JOIN memory_scopes s ON s.id = e.scope_id
              WHERE e.scope_id IN (${scopeIn}) AND e.is_deleted = false
                AND LOWER(e.title) = LOWER(?)
                ${type ? `AND e.type = ?` : ''}
              ORDER BY s.is_default DESC, s.name ASC, e.type ASC
              LIMIT ?`,
        args: type
          ? [...picked.scopeIds, needle, type, maxLimit]
          : [...picked.scopeIds, needle, maxLimit],
      });
      rows = result.rows;
    } else if (q) {
      const result = await client.execute({
        sql: `SELECT e.id, e.user_id, e.type, e.title, e.content, e.created_at, e.updated_at, e.version,
                     s.slug AS scope, s.name AS scope_name
              FROM memory_entries e
              JOIN memory_scopes s ON s.id = e.scope_id
              WHERE e.scope_id IN (${scopeIn}) AND e.is_deleted = false
                AND e.search_vector @@ plainto_tsquery('english', ?)
                ${type ? `AND e.type = ?` : ''}
              ORDER BY ts_rank(e.search_vector, plainto_tsquery('english', ?)) DESC
              LIMIT ?`,
        args: type
          ? [...picked.scopeIds, q, type, q, maxLimit]
          : [...picked.scopeIds, q, q, maxLimit],
      });
      rows = result.rows;
    } else if (parent_id) {
      const result = await client.execute({
        sql: `SELECT e.id, e.type, e.title, e.content, e.created_at, e.updated_at, e.version,
                     s.slug AS scope, s.name AS scope_name
              FROM memory_entries e
              JOIN memory_scopes s ON s.id = e.scope_id
              JOIN memory_branches b ON b.entry_id = e.id
              WHERE e.scope_id IN (${scopeIn}) AND e.is_deleted = false AND b.parent_entry_id = ?
                ${type ? `AND e.type = ?` : ''}
              ORDER BY b.position ASC, e.title ASC
              LIMIT ?`,
        args: type
          ? [...picked.scopeIds, parent_id, type, maxLimit]
          : [...picked.scopeIds, parent_id, maxLimit],
      });
      rows = result.rows;
    } else {
      const args: unknown[] = [];

      let fromClause = 'FROM memory_entries e JOIN memory_scopes s ON s.id = e.scope_id';
      if (tag) {
        fromClause += ' JOIN memory_tags mt ON mt.entry_id = e.id AND mt.tag = ?';
        args.push(tag);
      }

      let whereClause = `WHERE e.scope_id IN (${scopeIn}) AND e.is_deleted = false`;
      args.push(...picked.scopeIds);

      if (type) {
        whereClause += ` AND e.type = ?`;
        args.push(type);
      }

      if (since) {
        whereClause += ` AND e.updated_at >= ?`;
        args.push(since);
      }

      // Whitelist, never interpolate: `order` reaches ORDER BY, which takes no
      // bound parameter.
      const orderCol = order === 'created' ? 'e.created_at' : order === 'title' ? 'e.title' : 'e.updated_at';
      const orderDir = order === 'title' ? 'ASC' : 'DESC';

      args.push(maxLimit);
      const result = await client.execute({
        sql: `SELECT e.id, e.type, e.title, e.content, e.created_at, e.updated_at, e.version,
                     s.slug AS scope, s.name AS scope_name
              ${fromClause}
              ${whereClause}
              ORDER BY ${orderCol} ${orderDir}
              LIMIT ?`,
        args,
      });
      rows = result.rows;
    }

    return reply.send({ data: rows });
  });

  // -------------------------------------------------------------------------
  // POST /api/memory/entries — create entry
  // -------------------------------------------------------------------------
  app.post('/api/memory/entries', async (request, reply) => {
    const memCtx = await resolveMemoryScopeContext(request);
    if (!memCtx) return reply.status(401).send({ error: 'Unauthorized' });
    const userId = memCtx.userId;

    const body = request.body as Record<string, unknown>;
    const title = (body.title as string | undefined)?.trim();
    if (!title) return reply.status(400).send({ error: 'title is required' });

    const type = (body.type as string | undefined) ?? 'note';
    const content = (body.content as string | undefined) ?? null;
    const parentId = (body.parent_id as string | undefined) ?? null;
    const requestedScope = (body.scope as string | undefined) ?? null;

    // Write-scope precedence: an explicit scope, else the parent's scope, else
    // the caller's default. Inheriting from the parent is what makes "create
    // this under that entry" do the obvious thing without the model having to
    // reason about scopes at all.
    const picked = pickScope(memCtx, requestedScope, 'write');
    if (isRejection(picked)) return reply.status(picked.status).send(picked.body);
    let scopeId = picked.scopeIds[0];

    if (parentId) {
      const parentRow = await client.execute({
        sql: `SELECT scope_id FROM memory_entries WHERE id = ? AND is_deleted = false LIMIT 1`,
        args: [parentId],
      });
      if (parentRow.rows.length === 0) {
        return reply.status(404).send({ error: 'Parent entry not found' });
      }
      const parentScopeId = parentRow.rows[0].scope_id as string;
      if (!memCtx.scopeIds.includes(parentScopeId)) {
        return reply.status(404).send({ error: 'Parent entry not found' });
      }
      if (requestedScope && parentScopeId !== scopeId) {
        // Never silently pick one — the caller asked for two different things.
        return reply.status(409).send({
          error: 'The requested scope and the parent entry are in different scopes.',
          code: 'SCOPE_CONFLICT',
        });
      }
      scopeId = parentScopeId;
    }

    // Idempotent: an exact, alias, or close-enough title match returns the
    // existing entry instead of a duplicate. MEMORY_POLICY.md tells agents to
    // branch on `created`, so this must be honest.
    const { row, created } = await resolveOrCreate({ userId, scopeId, type, title, content });

    const scopeSlug = memCtx.scopes.find((s) => s.id === scopeId)?.slug ?? null;

    // If an existing entry was matched (exact/alias/fuzzy), return it immediately
    if (!created) {
      return reply.status(200).send({
        data: {
          id: row.id,
          userId: row.user_id,
          scope: scopeSlug,
          type: row.type,
          title: row.title,
          content: row.content,
          createdAt: row.created_at,
          updatedAt: row.updated_at,
          version: row.version,
        },
      });
    }

    const { id } = row;
    const now = row.created_at;

    // Create branch record for newly inserted entry
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
      sql: `INSERT INTO memory_branches (id, entry_id, parent_entry_id, scope_id, position, is_expanded)
            VALUES (?, ?, ?, ?, ?, false)`,
      args: [branchId, id, parentId, scopeId, position],
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

    await updateLinkIndex(id, scopeId, content);
    await updateTagIndex(id, content);

    return reply.status(201).send({
      data: { id, userId, scope: scopeSlug, type, title, content, createdAt: now, updatedAt: now, version: 1 },
    });
  });

  // -------------------------------------------------------------------------
  // GET /api/memory/entries/:id — get entry with attributes and backlinks
  // -------------------------------------------------------------------------
  app.get<{ Params: { id: string } }>('/api/memory/entries/:id', async (request, reply) => {
    const memCtx = await resolveMemoryScopeContext(request);
    if (!memCtx) return reply.status(401).send({ error: 'Unauthorized' });

    const { id } = request.params;
    const scopeIn = memCtx.scopeIds.map(() => '?').join(', ');

    // Scope-filtered, not merely user-filtered: an entry outside the caller's
    // grants is a 404, indistinguishable from one that does not exist.
    const entryResult = await client.execute({
      sql: `SELECT e.id, e.user_id, e.scope_id, e.type, e.title, e.content, e.created_at, e.updated_at, e.version,
                   s.slug AS scope, s.name AS scope_name
            FROM memory_entries e
            JOIN memory_scopes s ON s.id = e.scope_id
            WHERE e.id = ? AND e.scope_id IN (${scopeIn}) AND e.is_deleted = false`,
      args: [id, ...memCtx.scopeIds],
    });
    if (entryResult.rows.length === 0) return reply.status(404).send({ error: 'Not found' });

    const entry = entryResult.rows[0];
    const entryScopeId = entry.scope_id as string;

    const attrsResult = await client.execute({
      sql: `SELECT id, type, name, value, position FROM memory_attributes
            WHERE entry_id = ? AND is_deleted = false ORDER BY position ASC, created_at ASC`,
      args: [id],
    });

    // Backlinks stay inside the entry's own scope. memory_links cannot hold a
    // cross-scope row, but filtering here too means a legacy row from before the
    // constraint cannot leak a title across the partition.
    const backlinksResult = await client.execute({
      sql: `SELECT e.id, e.title, e.type, ml.context
            FROM memory_links ml
            JOIN memory_entries e ON e.id = ml.source_id
            WHERE ml.target_id = ? AND e.is_deleted = false AND e.scope_id = ?`,
      args: [id, entryScopeId],
    });

    const branchResult = await client.execute({
      sql: `SELECT parent_entry_id FROM memory_branches WHERE entry_id = ? LIMIT 1`,
      args: [id],
    });

    const tagsResult = await client.execute({
      sql: `SELECT tag FROM memory_tags WHERE entry_id = ? ORDER BY tag ASC`,
      args: [id],
    });
    const tags = tagsResult.rows.map((r) => r.tag as string);

    // Resolve [[wikilinks]] in the content to entry IDs for clickable rendering.
    // Scoped to the entry's own scope, matching updateLinkIndex: a link to a
    // title that exists only in another scope stays unresolved, because from
    // inside this scope that entry does not exist.
    const wikilinkRefs = parseWikilinkRefs((entry.content as string | null) ?? '');
    const referencedTitles = [...new Set(wikilinkRefs.map((r) => r.title))];
    const resolvedLinks: Record<string, string> = {};
    if (referencedTitles.length > 0) {
      const placeholders = referencedTitles.map(() => '?').join(', ');
      const titleRows = await client.execute({
        sql: `SELECT id, title FROM memory_entries
              WHERE scope_id = ? AND is_deleted = false AND title IN (${placeholders})`,
        args: [entryScopeId, ...referencedTitles],
      });
      for (const r of titleRows.rows) {
        resolvedLinks[r.title as string] = r.id as string;
      }
      // Fall back to alias resolution for any unresolved titles
      const unresolved = referencedTitles.filter((t) => !(t in resolvedLinks));
      if (unresolved.length > 0) {
        const aliasPlaceholders = unresolved.map(() => '?').join(', ');
        const aliasRows = await client.execute({
          sql: `SELECT e.id, a.value AS alias
                FROM memory_attributes a
                JOIN memory_entries e ON e.id = a.entry_id
                WHERE e.scope_id = ? AND a.name = 'alias' AND a.is_deleted = false
                  AND a.value IN (${aliasPlaceholders})`,
          args: [entryScopeId, ...unresolved],
        });
        for (const r of aliasRows.rows) {
          resolvedLinks[r.alias as string] = r.id as string;
        }
      }
    }

    const resolvedHeadings: Record<string, string | null> = {};
    for (const ref of wikilinkRefs) {
      if (ref.title in resolvedLinks && ref.heading) {
        resolvedHeadings[ref.title] = ref.heading;
      }
    }

    // Resolve ![[Title]] transclusions (max depth 2, cycle-safe)
    const transRefs = parseTransclusions((entry.content as string | null) ?? '');
    const transclusions: Record<string, { id: string; title: string; content: string }> = {};
    const seen = new Set<string>([id]);
    const transclusionScopeId: string = entryScopeId;

    if (transRefs.length > 0) {
      async function resolveTransclusion(title: string, depth: number): Promise<void> {
        if (depth > 2 || title in transclusions) return;
        const target = await lookupEntryByTitleOrAlias(transclusionScopeId, title);
        if (!target || seen.has(target.id)) return;
        seen.add(target.id);
        transclusions[title] = { id: target.id, title: target.title, content: target.content ?? '' };
        // Recurse into nested transclusions
        const nested = parseTransclusions(target.content ?? '');
        for (const sub of nested) await resolveTransclusion(sub, depth + 1);
      }
      for (const t of transRefs) await resolveTransclusion(t, 0);
    }

    return reply.send({
      data: {
        ...entry,
        attributes: attrsResult.rows,
        backlinks: backlinksResult.rows,
        parentId: branchResult.rows[0]?.parent_entry_id ?? null,
        resolvedLinks,
        resolvedHeadings,
        tags,
        transclusions,
      },
    });
  });

  // -------------------------------------------------------------------------
  // GET /api/memory/tags — list all distinct tags with counts
  // -------------------------------------------------------------------------
  app.get('/api/memory/tags', async (request, reply) => {
    const memCtx = await resolveMemoryScopeContext(request);
    if (!memCtx) return reply.status(401).send({ error: 'Unauthorized' });

    const picked = pickScope(memCtx, (request.query as Record<string, string>).scope, 'read');
    if (isRejection(picked)) return reply.status(picked.status).send(picked.body);
    const scopeIn = picked.scopeIds.map(() => '?').join(', ');

    const result = await client.execute({
      sql: `SELECT mt.tag, COUNT(*) AS count
            FROM memory_tags mt
            JOIN memory_entries e ON e.id = mt.entry_id
            WHERE e.scope_id IN (${scopeIn}) AND e.is_deleted = false
            GROUP BY mt.tag
            ORDER BY COUNT(*) DESC, mt.tag ASC`,
      args: picked.scopeIds,
    });

    return reply.send({ data: result.rows.map((r) => ({ tag: r.tag as string, count: Number(r.count) })) });
  });

  // -------------------------------------------------------------------------
  // PUT /api/memory/entries/:id — update entry
  // -------------------------------------------------------------------------
  app.put<{ Params: { id: string } }>('/api/memory/entries/:id', async (request, reply) => {
    const memCtx = await resolveMemoryScopeContext(request);
    if (!memCtx) return reply.status(401).send({ error: 'Unauthorized' });

    const { id } = request.params;
    const body = request.body as Record<string, unknown>;
    const scopeIn = memCtx.scopeIds.map(() => '?').join(', ');

    const existing = await client.execute({
      sql: `SELECT id, type, scope_id, title, content, version FROM memory_entries
            WHERE id = ? AND scope_id IN (${scopeIn}) AND is_deleted = false`,
      args: [id, ...memCtx.scopeIds],
    });
    if (existing.rows.length === 0) return reply.status(404).send({ error: 'Not found' });
    const entryScopeId = existing.rows[0].scope_id as string;

    // Moving an entry between scopes is a separate, deliberate operation — an
    // entry's scope is a fact about it, not a field to patch.
    if (body.scope !== undefined || body.scope_id !== undefined) {
      return reply.status(400).send({
        error: 'Use PUT /api/memory/entries/:id/scope to move an entry between scopes.',
        code: 'SCOPE_NOT_PATCHABLE',
      });
    }

    // Root index is read-only from dashboard sessions — only the agent (gateway token) may update it
    if (existing.rows[0].type === 'index' && getSession(request)) {
      return reply.status(403).send({ error: 'Root index can only be updated by the agent' });
    }

    // Optional optimistic-concurrency token. The predicate is built
    // conditionally rather than as `(? IS NULL OR version = ?)`: postgres.js
    // sends untyped params and Postgres cannot type a bare $n IS NULL.
    const rawIfVersion = body.if_version;
    const ifVersion = rawIfVersion === undefined || rawIfVersion === null ? null : Number(rawIfVersion);
    if (ifVersion !== null && (!Number.isInteger(ifVersion) || ifVersion < 1)) {
      return reply.status(400).send({ error: 'if_version must be a positive integer', code: 'INVALID_VERSION' });
    }

    // Exactly one way to change content per call. `append` and `section`
    // exist so a 20k-character index never has to be resent whole to add one
    // line — each full resend is a chance to silently drop a section.
    const contentOps = (['content', 'append', 'section'] as const).filter((k) => body[k] !== undefined);
    if (contentOps.length > 1) {
      return reply.status(400).send({ error: 'Pass only one of content, append, section.', code: 'CONFLICTING_CONTENT_OPS' });
    }
    if (body.append !== undefined && typeof body.append !== 'string') {
      return reply.status(400).send({ error: 'append must be a string', code: 'INVALID_APPEND' });
    }
    const section = body.section as { heading?: unknown; text?: unknown; mode?: unknown } | undefined;
    if (section !== undefined) {
      const modeOk = section?.mode === undefined || section?.mode === 'replace' || section?.mode === 'append';
      if (
        typeof section !== 'object' || section === null ||
        typeof section.heading !== 'string' || !section.heading.trim() ||
        typeof section.text !== 'string' || !modeOk
      ) {
        return reply.status(400).send({
          error: 'section needs { heading: string, text: string, mode?: "replace" | "append" }',
          code: 'INVALID_SECTION',
        });
      }
    }

    const now = new Date().toISOString();
    const applied = contentOps[0] ?? null;
    let sectionCreated = false;
    let current = existing.rows[0] as { title: string; content: string | null; version: number };

    // Compute-and-CAS: partial ops are computed in JS against the version just
    // read and the UPDATE is pinned to it, so a concurrent write can never be
    // absorbed into a stale base. Without if_version an append/section retries
    // against the fresh content; with it, the caller asked to be refused.
    const maxAttempts = ifVersion !== null ? 1 : 3;
    for (let attempt = 0; ; attempt++) {
      let nextContent: string | null | undefined;
      if (body.content !== undefined) {
        nextContent = body.content as string | null;
      } else if (typeof body.append === 'string') {
        const base = (current.content ?? '').replace(/\n+$/, '');
        nextContent = (base ? base + '\n' : '') + (body.append as string).replace(/\n+$/, '') + '\n';
      } else if (section) {
        const editResult = replaceSection(
          current.content ?? '',
          section.heading as string,
          section.text as string,
          (section.mode as 'replace' | 'append' | undefined) ?? 'replace'
        );
        if ('error' in editResult) {
          return reply.status(404).send({
            error:
              `No section "${section.heading}" in "${current.title}". ` +
              `Headings: ${editResult.headings.join(', ') || '(none)'}. Use mode "append" to create it.`,
            code: 'SECTION_NOT_FOUND',
            headings: editResult.headings,
          });
        }
        nextContent = editResult.content;
        sectionCreated = editResult.created;
      }

      const fields: string[] = [];
      const args: unknown[] = [];
      if (body.title !== undefined) { fields.push('title = ?'); args.push((body.title as string).trim()); }
      if (nextContent !== undefined) { fields.push('content = ?'); args.push(nextContent); }
      if (body.type !== undefined) { fields.push('type = ?'); args.push(body.type); }
      fields.push('version = version + 1', 'updated_at = ?'); args.push(now);

      // The write re-asserts scope reachability itself: the SELECT above is
      // advisory, and last-writer-wins between it and this statement was how a
      // concurrent edit vanished without an error.
      args.push(id, ...memCtx.scopeIds, ifVersion ?? current.version);
      const updateResult = await client.execute({
        sql: `UPDATE memory_entries SET ${fields.join(', ')} WHERE id = ? AND scope_id IN (${scopeIn}) AND is_deleted = false AND version = ?`,
        args,
      });

      if (updateResult.rowsAffected > 0) {
        if (nextContent !== undefined) {
          await updateLinkIndex(id, entryScopeId, nextContent);
          await updateTagIndex(id, nextContent);
        }
        break;
      }

      if (attempt >= maxAttempts - 1) {
        const cur = await client.execute({
          sql: `SELECT version, updated_at FROM memory_entries WHERE id = ?`,
          args: [id],
        });
        const row = cur.rows[0] as { version?: number; updated_at?: string } | undefined;
        const reason = ifVersion !== null
          ? `you passed if_version ${ifVersion}, it is now version ${row?.version ?? 'unknown'}`
          : `it kept changing while your ${applied ?? 'update'} was being applied (now version ${row?.version ?? 'unknown'})`;
        return reply.status(409).send({
          error:
            `Entry changed since you read it: ${reason} (updated ${row?.updated_at ?? 'unknown'}). ` +
            'Re-read it with memory_get and apply your change to the current content.',
          code: 'VERSION_CONFLICT',
          current_version: row?.version ?? null,
          updated_at: row?.updated_at ?? null,
        });
      }

      const re = await client.execute({
        sql: `SELECT title, content, version FROM memory_entries WHERE id = ? AND is_deleted = false`,
        args: [id],
      });
      if (re.rows.length === 0) return reply.status(404).send({ error: 'Not found' });
      current = { ...current, ...(re.rows[0] as { title: string; content: string | null; version: number }) };
    }

    const updated = await client.execute({
      sql: `SELECT id, user_id, type, title, content, created_at, updated_at, version FROM memory_entries WHERE id = ?`,
      args: [id],
    });
    return reply.send({
      data: {
        ...(updated.rows[0] as Record<string, unknown>),
        ...(applied ? { applied } : {}),
        ...(sectionCreated ? { section_created: true } : {}),
      },
    });
  });

  // -------------------------------------------------------------------------
  // DELETE /api/memory/entries/:id — soft delete
  // -------------------------------------------------------------------------
  app.delete<{ Params: { id: string } }>('/api/memory/entries/:id', async (request, reply) => {
    const memCtx = await resolveMemoryScopeContext(request);
    if (!memCtx) return reply.status(401).send({ error: 'Unauthorized' });

    const { id } = request.params;
    const scopeIn = memCtx.scopeIds.map(() => '?').join(', ');

    // A scope's root index anchors its tree; deleting it would orphan the scope.
    const isRoot = await client.execute({
      sql: `SELECT id FROM memory_scopes WHERE root_entry_id = ? LIMIT 1`,
      args: [id],
    });
    if (isRoot.rows.length > 0) {
      return reply.status(400).send({
        error: "A scope's index entry cannot be deleted. Delete or archive the scope instead.",
        code: 'CANNOT_DELETE_ROOT',
      });
    }

    await client.execute({
      sql: `UPDATE memory_entries SET is_deleted = true, updated_at = ?
            WHERE id = ? AND scope_id IN (${scopeIn})`,
      args: [new Date().toISOString(), id, ...memCtx.scopeIds],
    });
    return reply.send({ ok: true });
  });

  // -------------------------------------------------------------------------
  // GET /api/memory/tree — full tree for sidebar
  // -------------------------------------------------------------------------
  app.get('/api/memory/tree', async (request, reply) => {
    const memCtx = await resolveMemoryScopeContext(request);
    if (!memCtx) return reply.status(401).send({ error: 'Unauthorized' });
    const userId = memCtx.userId;

    const picked = pickScope(memCtx, (request.query as Record<string, string>).scope, 'read');
    if (isRejection(picked)) return reply.status(picked.status).send(picked.body);

    // Each reachable scope needs its root before the tree can render it.
    for (const scopeId of picked.scopeIds) {
      await ensureMemoryRoot(userId, scopeId);
    }

    const scopeIn = picked.scopeIds.map(() => '?').join(', ');
    const entries = await client.execute({
      sql: `SELECT e.id, e.type, e.title, b.parent_entry_id, b.position, b.is_expanded,
                   s.slug AS scope, s.name AS scope_name
            FROM memory_entries e
            JOIN memory_scopes s ON s.id = e.scope_id
            LEFT JOIN memory_branches b ON b.entry_id = e.id
            WHERE e.scope_id IN (${scopeIn}) AND e.is_deleted = false
            ORDER BY s.name ASC, b.parent_entry_id NULLS FIRST, b.position ASC, e.title ASC`,
      args: picked.scopeIds,
    });

    return reply.send({ data: entries.rows });
  });

  // -------------------------------------------------------------------------
  // GET /api/memory/graph — nodes + edges for D3 graph view
  // -------------------------------------------------------------------------
  app.get('/api/memory/graph', async (request, reply) => {
    const memCtx = await resolveMemoryScopeContext(request);
    if (!memCtx) return reply.status(401).send({ error: 'Unauthorized' });

    const picked = pickScope(memCtx, (request.query as Record<string, string>).scope, 'read');
    if (isRejection(picked)) return reply.status(picked.status).send(picked.body);
    const scopeIn = picked.scopeIds.map(() => '?').join(', ');

    const entries = await client.execute({
      sql: `SELECT e.id, e.type, e.title, s.slug AS scope
            FROM memory_entries e
            JOIN memory_scopes s ON s.id = e.scope_id
            WHERE e.scope_id IN (${scopeIn}) AND e.is_deleted = false`,
      args: picked.scopeIds,
    });

    const links = await client.execute({
      sql: `SELECT ml.source_id, ml.target_id
            FROM memory_links ml
            JOIN memory_entries s ON s.id = ml.source_id
            JOIN memory_entries t ON t.id = ml.target_id
            WHERE s.scope_id IN (${scopeIn}) AND s.is_deleted = false AND t.is_deleted = false
              AND t.scope_id = s.scope_id`,
      args: picked.scopeIds,
    });

    // Relation edges from attributes. Unlike branches and links these cannot be
    // constrained in the database — a relation's target lives in a polymorphic
    // `value TEXT` that no foreign key can reference — so the same-scope rule is
    // enforced by this join. Any legacy cross-scope relation is dropped rather
    // than drawn.
    const relations = await client.execute({
      sql: `SELECT ma.entry_id AS source_id, ma.value AS target_id, ma.name
            FROM memory_attributes ma
            JOIN memory_entries e ON e.id = ma.entry_id
            JOIN memory_entries t ON t.id = ma.value AND t.scope_id = e.scope_id
            WHERE e.scope_id IN (${scopeIn}) AND e.is_deleted = false
              AND t.is_deleted = false
              AND ma.type = 'relation' AND ma.is_deleted = false`,
      args: picked.scopeIds,
    });

    const nodes = entries.rows.map((e) => ({
      id: e.id,
      type: e.type,
      title: e.title,
      scope: e.scope,
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
    const memCtx = await resolveMemoryScopeContext(request);
    if (!memCtx) return reply.status(401).send({ error: 'Unauthorized' });

    const { id } = request.params;
    const body = request.body as Record<string, unknown>;
    const type = body.type as string;
    const name = body.name as string;
    const value = body.value as string;

    if (!type || !name || !value) return reply.status(400).send({ error: 'type, name, value required' });
    if (!['label', 'relation'].includes(type)) return reply.status(400).send({ error: 'type must be label or relation' });

    const scopeIn = memCtx.scopeIds.map(() => '?').join(', ');
    const ownerCheck = await client.execute({
      sql: `SELECT id, scope_id FROM memory_entries
            WHERE id = ? AND scope_id IN (${scopeIn}) AND is_deleted = false`,
      args: [id, ...memCtx.scopeIds],
    });
    if (ownerCheck.rows.length === 0) return reply.status(404).send({ error: 'Entry not found' });

    // A relation points at another entry by id, and that entry must live in the
    // same scope. This is the one cross-scope rule with no database constraint
    // behind it: `value` is polymorphic — a label's value is arbitrary text —
    // so no foreign key can be declared on it.
    if (type === 'relation') {
      const target = await client.execute({
        sql: `SELECT scope_id FROM memory_entries WHERE id = ? AND is_deleted = false LIMIT 1`,
        args: [value],
      });
      if (target.rows.length === 0) {
        return reply.status(404).send({ error: 'Relation target not found' });
      }
      if ((target.rows[0].scope_id as string) !== (ownerCheck.rows[0].scope_id as string)) {
        return reply.status(409).send({
          error: 'A relation cannot cross scopes — the target lives in a different scope.',
          code: 'CROSS_SCOPE_RELATION',
        });
      }
    }

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
    const memCtx = await resolveMemoryScopeContext(request);
    if (!memCtx) return reply.status(401).send({ error: 'Unauthorized' });

    const { attrId } = request.params;

    // Verify reachability via joined query
    const scopeIn = memCtx.scopeIds.map(() => '?').join(', ');
    const check = await client.execute({
      sql: `SELECT ma.id FROM memory_attributes ma
            JOIN memory_entries e ON e.id = ma.entry_id
            WHERE ma.id = ? AND e.scope_id IN (${scopeIn})`,
      args: [attrId, ...memCtx.scopeIds],
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
    const memCtx = await resolveMemoryScopeContext(request);
    if (!memCtx) return reply.status(401).send({ error: 'Unauthorized' });

    const picked = pickScope(memCtx, (request.query as Record<string, string>).scope, 'read');
    if (isRejection(picked)) return reply.status(picked.status).send(picked.body);

    const entries = await getDreamManifest(picked.scopeIds);
    return reply.send({ data: entries });
  });

  // -------------------------------------------------------------------------
  // PUT /api/memory/entries/:id/parent — reparent entry (dream reorganization)
  // -------------------------------------------------------------------------
  app.put<{ Params: { id: string } }>('/api/memory/entries/:id/parent', async (request, reply) => {
    const memCtx = await resolveMemoryScopeContext(request);
    if (!memCtx) return reply.status(401).send({ error: 'Unauthorized' });

    const { id } = request.params;
    const body = request.body as { parent_id?: string | null };
    const newParentId = body.parent_id ?? null;

    const result = await setEntryParent(id, memCtx.scopeIds, newParentId);
    if ('error' in result) {
      const status = result.error === 'Entry not found' ? 404 : 400;
      return reply.status(status).send({ error: result.error });
    }
    return reply.send({ data: result });
  });

  // -------------------------------------------------------------------------
  // Scopes
  //
  // A scope is a hard partition of one user's vault. Reads and writes are
  // covered above; these manage the scopes themselves.
  // -------------------------------------------------------------------------

  /** Lowercase kebab, and never a word the query layer treats as special. */
  const RESERVED_SCOPE_SLUGS = new Set(['all', 'none']);

  function slugifyScope(value: string): string {
    return value
      .toLowerCase()
      .trim()
      .replace(/[^a-z0-9]+/g, '-')
      .slice(0, 48)
      .replace(/^-+|-+$/g, '');
  }

  // GET /api/memory/scopes — what the caller can reach, with entry counts.
  // Serves both the dashboard and the agents' memory_list_scopes.
  app.get('/api/memory/scopes', async (request, reply) => {
    const memCtx = await resolveMemoryScopeContext(request);
    if (!memCtx) return reply.status(401).send({ error: 'Unauthorized' });

    const includeArchived =
      memCtx.isSession && (request.query as Record<string, string>).include_archived === 'true';

    const visible = includeArchived
      ? await listUserScopes(memCtx.userId, { includeArchived: true })
      : memCtx.scopes;
    if (visible.length === 0) return reply.send({ data: [] });

    const placeholders = visible.map(() => '?').join(', ');
    const counts = await client.execute({
      sql: `SELECT scope_id, COUNT(*) AS count FROM memory_entries
            WHERE scope_id IN (${placeholders}) AND is_deleted = false
            GROUP BY scope_id`,
      args: visible.map((s) => s.id),
    });
    const byScope = new Map(counts.rows.map((r) => [r.scope_id as string, Number(r.count)]));

    return reply.send({
      data: visible.map((s) => ({
        id: s.id,
        slug: s.slug,
        name: s.name,
        description: s.description,
        is_default: s.isDefault,
        archived_at: s.archivedAt,
        entry_count: byScope.get(s.id) ?? 0,
      })),
    });
  });

  // POST /api/memory/scopes — create one. Reachable by agents as well as the
  // dashboard, so it carries the guardrails an agent needs: provenance, a cap,
  // and a near-duplicate check, since a fragmented vault has no undo.
  app.post('/api/memory/scopes', async (request, reply) => {
    const memCtx = await resolveMemoryScopeContext(request);
    if (!memCtx) return reply.status(401).send({ error: 'Unauthorized' });

    const body = request.body as Record<string, unknown>;
    const name = (body.name as string | undefined)?.trim();
    if (!name) return reply.status(400).send({ error: 'name is required' });

    const slug = slugifyScope((body.slug as string | undefined) || name);
    if (!slug) return reply.status(400).send({ error: 'Could not derive a slug from name' });
    if (RESERVED_SCOPE_SLUGS.has(slug)) {
      return reply.status(400).send({ error: `"${slug}" is reserved and cannot be a scope slug` });
    }

    const all = await listUserScopes(memCtx.userId, { includeArchived: true });
    if (all.length >= 50) {
      return reply.status(409).send({
        error: 'Scope limit reached (50). Archive one you no longer use.',
        code: 'SCOPE_LIMIT',
      });
    }
    const clash = all.find((s) => s.slug === slug);
    if (clash) {
      return reply.status(409).send({
        error: `A scope with the slug "${slug}" already exists.`,
        code: 'DUPLICATE_SCOPE',
      });
    }
    // Near-duplicate check, so an agent cannot quietly split a vault into
    // "acme" and "acme-corp" that neither it nor the user will reconcile.
    const similar = await client.execute({
      sql: `SELECT slug FROM memory_scopes
            WHERE user_id = ? AND similarity(slug, ?) > 0.7 LIMIT 1`,
      args: [memCtx.userId, slug],
    });
    if (similar.rows.length > 0) {
      return reply.status(409).send({
        error: `"${similar.rows[0].slug}" already covers this. Use it, or pick a clearly different name.`,
        code: 'SIMILAR_SCOPE',
      });
    }

    const id = nanoid();
    const now = new Date().toISOString();
    await client.execute({
      sql: `INSERT INTO memory_scopes
              (id, user_id, slug, name, description, is_default, is_system,
               created_by_agent_id, created_at, updated_at)
            VALUES (?, ?, ?, ?, ?, false, false, ?, ?, ?)`,
      args: [
        id, memCtx.userId, slug, name,
        (body.description as string | undefined) ?? null,
        memCtx.agentId, now, now,
      ],
    });

    // A scope without a root has no tree to hang anything from.
    await ensureMemoryRoot(memCtx.userId, id);

    return reply.status(201).send({
      data: { id, slug, name, description: (body.description as string | undefined) ?? null },
    });
  });

  /** Scope CRUD beyond creation is the user's, not an agent's. */
  async function requireScopeOwner(memCtx: MemoryContext, scopeId: string, reply: any) {
    if (!memCtx.isSession) {
      reply.status(403).send({ error: 'Only the account owner can manage scopes' });
      return null;
    }
    const row = await client.execute({
      sql: `SELECT id, slug, name, is_system, is_default, archived_at
            FROM memory_scopes WHERE id = ? AND user_id = ? LIMIT 1`,
      args: [scopeId, memCtx.userId],
    });
    if (row.rows.length === 0) {
      reply.status(404).send({ error: 'Scope not found' });
      return null;
    }
    return row.rows[0] as Record<string, unknown>;
  }

  app.put<{ Params: { id: string } }>('/api/memory/scopes/:id', async (request, reply) => {
    const memCtx = await resolveMemoryScopeContext(request);
    if (!memCtx) return reply.status(401).send({ error: 'Unauthorized' });

    const scope = await requireScopeOwner(memCtx, request.params.id, reply);
    if (!scope) return;

    const body = request.body as Record<string, unknown>;
    const now = new Date().toISOString();

    if (body.archived !== undefined && scope.is_system) {
      return reply.status(409).send({ error: 'The default scope cannot be archived' });
    }
    if (body.is_default === false && scope.is_default) {
      return reply.status(409).send({
        error: 'Choose another scope as the default rather than clearing this one',
      });
    }

    // One default per user is a database invariant, so the swap is two
    // statements: clear, then set.
    if (body.is_default === true) {
      await client.execute({
        sql: `UPDATE memory_scopes SET is_default = false, updated_at = ? WHERE user_id = ? AND is_default`,
        args: [now, memCtx.userId],
      });
      await client.execute({
        sql: `UPDATE memory_scopes SET is_default = true, updated_at = ? WHERE id = ?`,
        args: [now, request.params.id],
      });
    }

    const fields: string[] = [];
    const args: unknown[] = [];
    if (body.name !== undefined) { fields.push('name = ?'); args.push((body.name as string).trim()); }
    if (body.description !== undefined) { fields.push('description = ?'); args.push(body.description); }
    if (body.slug !== undefined) {
      const slug = slugifyScope(body.slug as string);
      if (!slug || RESERVED_SCOPE_SLUGS.has(slug)) {
        return reply.status(400).send({ error: 'Invalid slug' });
      }
      fields.push('slug = ?'); args.push(slug);
    }
    if (body.archived !== undefined) {
      fields.push('archived_at = ?'); args.push(body.archived ? now : null);
    }

    if (fields.length > 0) {
      fields.push('updated_at = ?'); args.push(now);
      args.push(request.params.id);
      await client.execute({
        sql: `UPDATE memory_scopes SET ${fields.join(', ')} WHERE id = ?`,
        args,
      });
    }

    const updated = await client.execute({
      sql: `SELECT id, slug, name, description, is_default, archived_at FROM memory_scopes WHERE id = ?`,
      args: [request.params.id],
    });
    return reply.send({ data: updated.rows[0] });
  });

  // DELETE /api/memory/scopes/:id
  //
  // There is deliberately no purge option. Nothing else in this system hard
  // deletes memory — memory_delete is a soft delete and is permission-blocked —
  // so a single endpoint that can vaporise a vault is not worth the convenience.
  app.delete<{ Params: { id: string } }>('/api/memory/scopes/:id', async (request, reply) => {
    const memCtx = await resolveMemoryScopeContext(request);
    if (!memCtx) return reply.status(401).send({ error: 'Unauthorized' });

    const scope = await requireScopeOwner(memCtx, request.params.id, reply);
    if (!scope) return;

    if (scope.is_system) {
      return reply.status(409).send({
        error: 'The default scope cannot be deleted.',
        code: 'CANNOT_DELETE_DEFAULT',
      });
    }

    const query = request.query as Record<string, string>;
    const now = new Date().toISOString();

    if (query.archive === 'true') {
      await client.execute({
        sql: `UPDATE memory_scopes SET archived_at = ?, updated_at = ? WHERE id = ?`,
        args: [now, now, request.params.id],
      });
      return reply.send({ data: { archived: true } });
    }

    const countResult = await client.execute({
      sql: `SELECT COUNT(*) AS count FROM memory_entries WHERE scope_id = ? AND is_deleted = false`,
      args: [request.params.id],
    });
    const entryCount = Number(countResult.rows[0]?.count ?? 0);

    if (entryCount > 0 && !query.reassign_to) {
      return reply.status(409).send({
        error: `This scope still holds ${entryCount} entries. Archive it, or pass reassign_to to move them.`,
        code: 'SCOPE_NOT_EMPTY',
        entry_count: entryCount,
      });
    }

    if (query.reassign_to) {
      const target = await requireScopeOwner(memCtx, query.reassign_to, reply);
      if (!target) return;
      // Entries, branches and links all carry scope_id and must move together,
      // or the composite foreign keys will reject the update.
      for (const table of ['memory_entries', 'memory_branches', 'memory_links']) {
        await client.execute({
          sql: `UPDATE ${table} SET scope_id = ? WHERE scope_id = ?`,
          args: [query.reassign_to, request.params.id],
        });
      }
    }

    await client.execute({
      sql: `UPDATE memory_scopes SET root_entry_id = NULL WHERE id = ?`,
      args: [request.params.id],
    });
    await client.execute({
      sql: `DELETE FROM memory_scopes WHERE id = ?`,
      args: [request.params.id],
    });
    return reply.send({ data: { deleted: true, reassigned: query.reassign_to ?? null } });
  });

  // PUT /api/memory/entries/:id/scope — move one entry between scopes.
  //
  // Session only. Moving is the one operation that crosses the partition, so it
  // is a deliberate human act; agents re-file by creating in the right scope.
  app.put<{ Params: { id: string } }>('/api/memory/entries/:id/scope', async (request, reply) => {
    const memCtx = await resolveMemoryScopeContext(request);
    if (!memCtx) return reply.status(401).send({ error: 'Unauthorized' });
    if (!memCtx.isSession) {
      return reply.status(403).send({ error: 'Only the account owner can move an entry between scopes' });
    }

    const target = pickScope(memCtx, (request.body as Record<string, unknown>).scope as string, 'write');
    if (isRejection(target)) return reply.status(target.status).send(target.body);
    const targetScopeId = target.scopeIds[0];

    const { id } = request.params;
    const scopeIn = memCtx.scopeIds.map(() => '?').join(', ');
    const entry = await client.execute({
      sql: `SELECT id, scope_id FROM memory_entries
            WHERE id = ? AND scope_id IN (${scopeIn}) AND is_deleted = false`,
      args: [id, ...memCtx.scopeIds],
    });
    if (entry.rows.length === 0) return reply.status(404).send({ error: 'Not found' });
    if ((entry.rows[0].scope_id as string) === targetScopeId) {
      return reply.send({ data: { moved: false } });
    }

    const isRoot = await client.execute({
      sql: `SELECT id FROM memory_scopes WHERE root_entry_id = ? LIMIT 1`,
      args: [id],
    });
    if (isRoot.rows.length > 0) {
      return reply.status(400).send({ error: "A scope's index entry cannot be moved" });
    }

    const now = new Date().toISOString();
    await client.execute({
      sql: `UPDATE memory_entries SET scope_id = ?, updated_at = ? WHERE id = ?`,
      args: [targetScopeId, now, id],
    });
    // The entry leaves its subtree behind rather than dragging children across
    // the partition: it re-enters the new scope at the root.
    await client.execute({
      sql: `UPDATE memory_branches SET scope_id = ?, parent_entry_id = NULL WHERE entry_id = ?`,
      args: [targetScopeId, id],
    });
    // Its links pointed at entries in the old scope and cannot survive the move.
    await client.execute({ sql: `DELETE FROM memory_links WHERE source_id = ? OR target_id = ?`, args: [id, id] });

    const moved = await client.execute({
      sql: `SELECT content FROM memory_entries WHERE id = ?`,
      args: [id],
    });
    await updateLinkIndex(id, targetScopeId, (moved.rows[0]?.content as string | null) ?? null);

    return reply.send({ data: { moved: true, scope: targetScopeId } });
  });

  // -------------------------------------------------------------------------
  // Per-agent scope grants
  //
  // Zero rows means every scope the owner has. Grants narrow; they do not
  // enable — whether the agent sees memory tools at all is the separate
  // question of the memory service being enabled on it.
  // -------------------------------------------------------------------------

  app.get<{ Params: { agentId: string } }>(
    '/api/permissions/:agentId/memory/scopes',
    async (request, reply) => {
      const userId = getUserId(request);
      if (!(await userOwnsAgent(userId, request.params.agentId))) {
        return reply.code(404).send(agentNotFound);
      }

      const grants = await getAgentScopeGrants(request.params.agentId, userId);
      const all = await listUserScopes(userId);

      return reply.send({
        data: {
          mode: grants.mode,
          defaultScopeId: grants.defaultScopeId,
          grantedScopeIds: grants.scopes.map((s) => s.id),
          availableScopes: all.map((s) => ({
            id: s.id, slug: s.slug, name: s.name, is_default: s.isDefault,
          })),
        },
      });
    }
  );

  app.put<{ Params: { agentId: string } }>(
    '/api/permissions/:agentId/memory/scopes',
    async (request, reply) => {
      const userId = getUserId(request);
      if (!(await userOwnsAgent(userId, request.params.agentId))) {
        return reply.code(404).send(agentNotFound);
      }

      const body = request.body as { mode?: string; scopeIds?: unknown; defaultScopeId?: unknown };

      if (body.mode === 'all') {
        await setAgentScopeGrants(request.params.agentId, userId, null);
        return reply.send({ data: { mode: 'all' } });
      }

      if (!Array.isArray(body.scopeIds) || body.scopeIds.length === 0) {
        return reply.code(400).send({
          error: { code: 'VALIDATION_ERROR', message: 'scopeIds must be a non-empty array' },
        });
      }
      const scopeIds = body.scopeIds.filter((s): s is string => typeof s === 'string');
      const defaultScopeId = typeof body.defaultScopeId === 'string' ? body.defaultScopeId : scopeIds[0];
      if (!scopeIds.includes(defaultScopeId)) {
        return reply.code(400).send({
          error: { code: 'VALIDATION_ERROR', message: 'defaultScopeId must be one of scopeIds' },
        });
      }

      await setAgentScopeGrants(request.params.agentId, userId, { scopeIds, defaultScopeId });
      const grants = await getAgentScopeGrants(request.params.agentId, userId);
      return reply.send({
        data: {
          mode: grants.mode,
          defaultScopeId: grants.defaultScopeId,
          grantedScopeIds: grants.scopes.map((s) => s.id),
        },
      });
    }
  );

  // ========================================================================
  // Billing endpoints
  // ========================================================================

  app.get('/api/billing/status', async (request, reply) => {
    const session = getSession(request);
    if (!session) return reply.code(401).send({ error: 'Unauthorized' });
    if (process.env.BYPASS_BILLING === 'true') {
      return reply.send({ data: { subscribed: true, plan: 'byok', status: 'active' } });
    }
    const sub = await getSubscription(session.userId);
    if (!sub) return reply.send({ data: { subscribed: false } });
    const withinGrace = sub.status === 'past_due' && !!sub.graceUntil && new Date(sub.graceUntil) > new Date();
    return reply.send({
      data: {
        subscribed: sub.status === 'active' || withinGrace,
        plan: sub.plan,
        status: sub.status,
        currentPeriodEnd: sub.currentPeriodEnd,
        graceUntil: sub.graceUntil,
      },
    });
  });

  app.post('/api/billing/checkout', async (request, reply) => {
    const session = getSession(request);
    if (!session) return reply.code(401).send({ error: 'Unauthorized' });
    const body = request.body as { plan: 'byok' | 'managed'; successUrl: string; cancelUrl: string };
    if (body.plan !== 'byok' && body.plan !== 'managed') {
      return reply.code(400).send({ error: 'plan must be byok or managed' });
    }
    const priceId = body.plan === 'byok'
      ? process.env.STRIPE_BYOK_PRICE_ID
      : process.env.STRIPE_MANAGED_PRICE_ID;
    if (!priceId) return reply.code(500).send({ error: `STRIPE_${body.plan.toUpperCase()}_PRICE_ID not configured` });

    const existingSub = await getSubscription(session.userId);
    const userRow = await client.execute({ sql: `SELECT email FROM users WHERE id = ?`, args: [session.userId] });
    const userEmail = userRow.rows[0]?.email as string | undefined;

    const stripe = getStripe();
    const checkoutSession = await stripe.checkout.sessions.create({
      mode: 'subscription',
      line_items: [{ price: priceId, quantity: 1 }],
      ...(existingSub?.stripeCustomerId
        ? { customer: existingSub.stripeCustomerId }
        : { customer_email: userEmail }),
      client_reference_id: session.userId,
      success_url: body.successUrl,
      cancel_url: body.cancelUrl,
      metadata: { userId: session.userId, plan: body.plan },
      subscription_data: { metadata: { userId: session.userId, plan: body.plan } },
    });

    return reply.send({ data: { url: checkoutSession.url } });
  });

  app.post('/api/billing/portal', async (request, reply) => {
    const session = getSession(request);
    if (!session) return reply.code(401).send({ error: 'Unauthorized' });
    const body = request.body as { returnUrl: string };
    const sub = await getSubscription(session.userId);
    if (!sub) return reply.code(404).send({ error: 'No subscription found' });
    const stripe = getStripe();
    const portalSession = await stripe.billingPortal.sessions.create({
      customer: sub.stripeCustomerId,
      return_url: body.returnUrl,
    });
    return reply.send({ data: { url: portalSession.url } });
  });

  // Stripe webhook — raw body required for signature verification
  app.register(async (instance) => {
    instance.addContentTypeParser('application/json', { parseAs: 'buffer' }, (_req, body, done) => {
      done(null, body);
    });

    instance.post('/api/webhooks/stripe', async (request, reply) => {
      const sig = request.headers['stripe-signature'] as string;
      const webhookSecret = process.env.STRIPE_WEBHOOK_SECRET;
      if (!webhookSecret) return reply.code(500).send({ error: 'STRIPE_WEBHOOK_SECRET not set' });

      let event: Stripe.Event;
      try {
        const stripe = getStripe();
        event = stripe.webhooks.constructEvent(request.body as Buffer, sig, webhookSecret);
      } catch (err) {
        return reply.code(400).send({ error: `Webhook signature verification failed: ${err instanceof Error ? err.message : err}` });
      }

      try {
        switch (event.type) {
          case 'checkout.session.completed': {
            const cs = event.data.object as Stripe.Checkout.Session;
            if (cs.mode !== 'subscription') break;
            const userId = cs.metadata?.userId ?? cs.client_reference_id;
            const plan = (cs.metadata?.plan ?? 'byok') as 'byok' | 'managed';
            if (!userId) { console.warn('[stripe-webhook] checkout.session.completed missing userId'); break; }
            const stripe2 = getStripe();
            const stripeSub = await stripe2.subscriptions.retrieve(cs.subscription as string);
            const periodEnd = stripeSub.items.data[0]?.current_period_end ?? 0;
            await upsertSubscription({
              userId,
              stripeCustomerId: cs.customer as string,
              stripeSubscriptionId: cs.subscription as string,
              plan,
              status: 'active',
              currentPeriodEnd: new Date(periodEnd * 1000).toISOString(),
            });
            break;
          }
          case 'invoice.payment_succeeded': {
            const inv = event.data.object as Stripe.Invoice;
            const subIdSucceeded = inv.parent?.subscription_details?.subscription;
            const subIdSucceededStr = typeof subIdSucceeded === 'string' ? subIdSucceeded : subIdSucceeded?.id;
            if (subIdSucceededStr) await clearGrace(subIdSucceededStr);
            break;
          }
          case 'invoice.payment_failed': {
            const inv = event.data.object as Stripe.Invoice;
            const subIdFailed = inv.parent?.subscription_details?.subscription;
            const subIdFailedStr = typeof subIdFailed === 'string' ? subIdFailed : subIdFailed?.id;
            if (subIdFailedStr) {
              await applyGracePeriod(subIdFailedStr);
              console.warn(`[stripe-webhook] payment failed for sub ${subIdFailedStr} — grace period started`);
            }
            break;
          }
          case 'customer.subscription.deleted': {
            const stripeSub = event.data.object as Stripe.Subscription;
            await cancelSubscription(stripeSub.id);
            break;
          }
          default:
            break;
        }
      } catch (err) {
        console.error('[stripe-webhook] handler error:', err instanceof Error ? err.stack : err);
        return reply.code(500).send({ error: 'Handler error' });
      }

      return reply.send({ received: true });
    });
  });
};
