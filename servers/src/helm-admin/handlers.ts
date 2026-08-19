/**
 * Helm Admin MCP Server Handlers
 *
 * For an agent that organizes its owner's other agents: naming them, describing
 * what each is for, and managing what each can reach.
 *
 * Like the skills, skill-authoring and memory servers, these call the Reins
 * backend API with the agent's gateway token rather than importing the database
 * — @reins/servers has no DB dependency, and the same handler code runs both
 * in-process in the backend and on the agent's own machine.
 *
 * Authorization is not decided here, and deliberately so. The backend scopes
 * every read and write to the calling agent's owner, refuses service
 * combinations that would let an agent grant itself capability, and gates every
 * write behind the owner's approval. A handler that looked safe here while the
 * backend was permissive would be worthless.
 */

import type { ServerContext, ToolResult } from '../common/types.js';

function getApiBase(): string {
  return (process.env.REINS_API_URL ?? 'https://app.helm.mom').replace(/\/$/, '');
}

function getGatewayToken(context: ServerContext): string {
  return context.gatewayToken ?? process.env.REINS_GATEWAY_TOKEN ?? '';
}

async function adminFetch(
  context: ServerContext,
  path: string,
  options: RequestInit = {}
): Promise<Response> {
  const token = getGatewayToken(context);
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    ...(options.headers as Record<string, string> ?? {}),
  };
  if (token) {
    headers['x-reins-agent-secret'] = token;
  }

  return fetch(`${getApiBase()}${path}`, { ...options, headers });
}

/**
 * Turn a non-2xx into a ToolResult the model can act on.
 *
 * Three envelope shapes reach here, and the order below is what tells them apart:
 *   1. the app's own errors, `{error: {code, message}}` — the message is the point;
 *   2. Fastify's defaults, `{statusCode, error: "Internal Server Error", message}` —
 *      where `error` is only the status text and `message` carries the diagnosis;
 *   3. terse routes, `{error: "Unauthorized"}` — a bare string and all there is.
 *
 * Reading `error` before `message` would collapse every case-2 failure to
 * "Internal Server Error" and throw the actual cause away.
 */
async function toError(res: Response, fallback: string): Promise<ToolResult> {
  const body = await res.json().catch(() => ({})) as { error?: unknown; message?: unknown };
  const detail =
    (body.error as { message?: string } | undefined)?.message ??
    (typeof body.message === 'string' ? body.message : undefined) ??
    (typeof body.error === 'string' ? body.error : undefined);
  return { success: false, error: detail ?? `${fallback} (HTTP ${res.status})` };
}

/** Non-empty string, or null. Callers phrase their own error. */
function nonEmptyString(value: unknown): string | null {
  return typeof value === 'string' && value.trim() !== '' ? value : null;
}

interface AgentSummary {
  id: string;
  name: string;
  description: string | null;
  status: string;
  runtime?: string | null;
  isManual?: boolean;
  services?: string[];
  deploymentStatus?: string | null;
}

// ── Reads ────────────────────────────────────────────────────────────────────

export async function handleListAgents(
  _args: Record<string, unknown>,
  context: ServerContext
): Promise<ToolResult> {
  try {
    const res = await adminFetch(context, '/api/agent-admin/agents');
    if (!res.ok) return toError(res, 'Could not list agents');

    const json = await res.json() as { data: AgentSummary[] };
    return { success: true, data: { agents: json.data ?? [] } };
  } catch (err) {
    return { success: false, error: err instanceof Error ? err.message : String(err) };
  }
}

export async function handleGetAgent(
  args: Record<string, unknown>,
  context: ServerContext
): Promise<ToolResult> {
  const agentId = nonEmptyString(args.agentId);
  if (!agentId) return { success: false, error: 'agentId is required' };

  try {
    const res = await adminFetch(context, `/api/agent-admin/agents/${encodeURIComponent(agentId)}`);
    if (!res.ok) return toError(res, 'Could not read that agent');

    const json = await res.json() as { data: unknown };
    return { success: true, data: json.data };
  } catch (err) {
    return { success: false, error: err instanceof Error ? err.message : String(err) };
  }
}

export async function handleListServices(
  _args: Record<string, unknown>,
  context: ServerContext
): Promise<ToolResult> {
  try {
    const res = await adminFetch(context, '/api/agent-admin/services');
    if (!res.ok) return toError(res, 'Could not list services');

    const json = await res.json() as { data: unknown };
    return { success: true, data: json.data };
  } catch (err) {
    return { success: false, error: err instanceof Error ? err.message : String(err) };
  }
}

// ── Writes (each requires the owner's approval) ───────────────────────────────

/** Shared PATCH for the metadata tools, which differ only in the field. */
async function patchAgent(
  context: ServerContext,
  agentId: string,
  body: Record<string, unknown>,
  failure: string
): Promise<ToolResult> {
  try {
    const res = await adminFetch(context, `/api/agent-admin/agents/${encodeURIComponent(agentId)}`, {
      method: 'PATCH',
      body: JSON.stringify(body),
    });
    if (!res.ok) return toError(res, failure);

    const json = await res.json() as { data: unknown };
    return { success: true, data: json.data };
  } catch (err) {
    return { success: false, error: err instanceof Error ? err.message : String(err) };
  }
}

export async function handleRenameAgent(
  args: Record<string, unknown>,
  context: ServerContext
): Promise<ToolResult> {
  const agentId = nonEmptyString(args.agentId);
  const name = nonEmptyString(args.name);
  if (!agentId) return { success: false, error: 'agentId is required' };
  if (!name) return { success: false, error: 'name is required' };

  return patchAgent(context, agentId, { name }, 'Could not rename that agent');
}

export async function handleSetDescription(
  args: Record<string, unknown>,
  context: ServerContext
): Promise<ToolResult> {
  const agentId = nonEmptyString(args.agentId);
  if (!agentId) return { success: false, error: 'agentId is required' };
  // An empty description is meaningful — it clears one — so this accepts '' and
  // only rejects a missing or non-string value.
  if (typeof args.description !== 'string') {
    return { success: false, error: 'description is required (pass an empty string to clear it)' };
  }

  return patchAgent(context, agentId, { description: args.description }, 'Could not set the description');
}

export async function handleSetStatus(
  args: Record<string, unknown>,
  context: ServerContext
): Promise<ToolResult> {
  const agentId = nonEmptyString(args.agentId);
  const status = nonEmptyString(args.status);
  if (!agentId) return { success: false, error: 'agentId is required' };
  if (!status) return { success: false, error: 'status is required' };

  return patchAgent(context, agentId, { status }, 'Could not set the status');
}

export async function handleEnableService(
  args: Record<string, unknown>,
  context: ServerContext
): Promise<ToolResult> {
  const agentId = nonEmptyString(args.agentId);
  const serviceType = nonEmptyString(args.serviceType);
  if (!agentId) return { success: false, error: 'agentId is required' };
  if (!serviceType) return { success: false, error: 'serviceType is required' };

  try {
    const res = await adminFetch(context, `/api/agent-admin/agents/${encodeURIComponent(agentId)}/services`, {
      method: 'POST',
      body: JSON.stringify({ serviceType }),
    });
    if (!res.ok) return toError(res, 'Could not enable that service');

    const json = await res.json() as { data: unknown };
    return { success: true, data: json.data };
  } catch (err) {
    return { success: false, error: err instanceof Error ? err.message : String(err) };
  }
}

export async function handleDisableService(
  args: Record<string, unknown>,
  context: ServerContext
): Promise<ToolResult> {
  const agentId = nonEmptyString(args.agentId);
  const serviceType = nonEmptyString(args.serviceType);
  if (!agentId) return { success: false, error: 'agentId is required' };
  if (!serviceType) return { success: false, error: 'serviceType is required' };

  try {
    const res = await adminFetch(
      context,
      `/api/agent-admin/agents/${encodeURIComponent(agentId)}/services/${encodeURIComponent(serviceType)}`,
      { method: 'DELETE' }
    );
    if (!res.ok) return toError(res, 'Could not disable that service');

    return { success: true, data: { agentId, serviceType, enabled: false } };
  } catch (err) {
    return { success: false, error: err instanceof Error ? err.message : String(err) };
  }
}

export async function handleSetPermissionLevel(
  args: Record<string, unknown>,
  context: ServerContext
): Promise<ToolResult> {
  const agentId = nonEmptyString(args.agentId);
  const serviceType = nonEmptyString(args.serviceType);
  const level = nonEmptyString(args.level);
  if (!agentId) return { success: false, error: 'agentId is required' };
  if (!serviceType) return { success: false, error: 'serviceType is required' };
  if (!level) return { success: false, error: 'level is required' };

  try {
    const res = await adminFetch(
      context,
      `/api/agent-admin/agents/${encodeURIComponent(agentId)}/services/${encodeURIComponent(serviceType)}/level`,
      { method: 'PUT', body: JSON.stringify({ level }) }
    );
    if (!res.ok) return toError(res, 'Could not set the permission level');

    const json = await res.json() as { data: unknown };
    return { success: true, data: json.data };
  } catch (err) {
    return { success: false, error: err instanceof Error ? err.message : String(err) };
  }
}
