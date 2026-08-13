/**
 * Skill Authoring MCP Server Handlers
 *
 * Write counterparts to the read-only `skills` server, for an architect agent
 * that maintains skills for its owner's other agents.
 *
 * Like the skills and memory servers, these call the Reins backend API with the
 * agent's gateway token rather than importing the database — @reins/servers has
 * no DB dependency, and the same handler code runs both in-process in the
 * backend and on the agent's own machine.
 *
 * Authorization is not decided here. The backend scopes every write to the
 * calling agent's owner, and reaching these tools at all requires the
 * skill-authoring service to be enabled on that agent.
 */

import type { ServerContext, ToolResult } from '../common/types.js';

function getApiBase(): string {
  return (process.env.REINS_API_URL ?? 'https://app.helm.mom').replace(/\/$/, '');
}

function getGatewayToken(context: ServerContext): string {
  return context.gatewayToken ?? process.env.REINS_GATEWAY_TOKEN ?? '';
}

async function authoringFetch(
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

interface SkillSummary {
  id: string;
  slug: string;
  name: string;
  description: string;
  requiredServices: string[];
  version?: string | null;
  isSystem?: boolean;
}

/**
 * List the owner's skills, with ids — the read the write tools depend on, since
 * update and assign address a skill by id.
 */
export async function handleListAuthoredSkills(
  _args: Record<string, unknown>,
  context: ServerContext
): Promise<ToolResult> {
  try {
    // /api/skill-library, not the dashboard's /api/skills — the latter resolves
    // its caller from a session, which a gateway token does not have.
    const res = await authoringFetch(context, '/api/skill-library');
    if (!res.ok) return toError(res, 'Could not list skills');

    const json = await res.json() as { data: SkillSummary[] };
    const skills = json.data ?? [];

    return {
      success: true,
      data: {
        skills: skills.map((s) => ({
          id: s.id,
          slug: s.slug,
          name: s.name,
          description: s.description,
          requires: s.requiredServices,
          ...(s.version ? { version: s.version } : {}),
          // Platform skills are readable but not writable by any agent.
          ...(s.isSystem ? { read_only: true } : {}),
        })),
      },
    };
  } catch (err) {
    return { success: false, error: err instanceof Error ? err.message : String(err) };
  }
}

export async function handleCreateSkill(
  args: Record<string, unknown>,
  context: ServerContext
): Promise<ToolResult> {
  const name = nonEmptyString(args.name);
  const description = nonEmptyString(args.description);
  const body = nonEmptyString(args.body);
  if (!name) return { success: false, error: 'name is required' };
  if (!description) return { success: false, error: 'description is required — it is the only text an agent sees before loading the skill' };
  if (!body) return { success: false, error: 'body is required' };

  try {
    const res = await authoringFetch(context, '/api/agent-skills', {
      method: 'POST',
      body: JSON.stringify({
        name,
        description,
        body,
        requiredServices: Array.isArray(args.requires) ? args.requires : [],
        ...(typeof args.slug === 'string' ? { slug: args.slug } : {}),
        ...(typeof args.version === 'string' ? { version: args.version } : {}),
      }),
    });
    if (!res.ok) return toError(res, 'Could not create the skill');

    const json = await res.json() as { data: { id: string; slug: string } };
    return {
      success: true,
      data: {
        ...json.data,
        next_step: 'Assign it to an agent with skill_authoring_assign — a skill has no effect until it is attached.',
      },
    };
  } catch (err) {
    return { success: false, error: err instanceof Error ? err.message : String(err) };
  }
}

export async function handleUpdateSkill(
  args: Record<string, unknown>,
  context: ServerContext
): Promise<ToolResult> {
  const id = nonEmptyString(args.skill_id);
  const name = nonEmptyString(args.name);
  const description = nonEmptyString(args.description);
  const body = nonEmptyString(args.body);
  if (!id) return { success: false, error: 'skill_id is required. Call skill_authoring_list to see ids.' };
  if (!name || !description || !body) {
    return {
      success: false,
      // The endpoint replaces the whole row, so a partial update would blank
      // whatever was omitted.
      error: 'name, description and body are all required — update replaces the whole skill, so send the full text even for a small edit.',
    };
  }

  try {
    const res = await authoringFetch(context, `/api/agent-skills/id/${encodeURIComponent(id)}`, {
      method: 'PUT',
      body: JSON.stringify({
        name,
        description,
        body,
        ...(Array.isArray(args.requires) ? { requiredServices: args.requires } : {}),
        ...(typeof args.version === 'string' ? { version: args.version } : {}),
      }),
    });
    if (res.status === 404) {
      return {
        success: false,
        error: `No skill with id "${id}" belongs to your owner. Platform skills cannot be edited by an agent.`,
      };
    }
    if (!res.ok) return toError(res, 'Could not update the skill');

    const json = await res.json() as { data: { id: string; slug: string } };
    return { success: true, data: json.data };
  } catch (err) {
    return { success: false, error: err instanceof Error ? err.message : String(err) };
  }
}

async function setAssignment(
  args: Record<string, unknown>,
  context: ServerContext,
  attached: boolean
): Promise<ToolResult> {
  const agentId = nonEmptyString(args.agent_id);
  const skillId = nonEmptyString(args.skill_id);
  if (!agentId) return { success: false, error: 'agent_id is required' };
  if (!skillId) return { success: false, error: 'skill_id is required' };

  try {
    const res = await authoringFetch(
      context,
      `/api/agent-skills/assign/${encodeURIComponent(agentId)}`,
      { method: 'POST', body: JSON.stringify({ skillId, attached }) }
    );
    if (res.status === 404) {
      return {
        success: false,
        error: `No such agent or skill belonging to your owner (agent "${agentId}", skill "${skillId}").`,
      };
    }
    if (!res.ok) return toError(res, attached ? 'Could not assign the skill' : 'Could not unassign the skill');

    const json = await res.json() as { data: unknown };
    return { success: true, data: json.data };
  } catch (err) {
    return { success: false, error: err instanceof Error ? err.message : String(err) };
  }
}

export async function handleAssignSkill(
  args: Record<string, unknown>,
  context: ServerContext
): Promise<ToolResult> {
  return setAssignment(args, context, true);
}

export async function handleUnassignSkill(
  args: Record<string, unknown>,
  context: ServerContext
): Promise<ToolResult> {
  return setAssignment(args, context, false);
}
