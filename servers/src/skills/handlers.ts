/**
 * Skills MCP Server Handlers
 *
 * Each handler calls the Reins backend API (/api/agent-skills*) using the
 * agent's gateway token for authentication. Like the memory server, these
 * deliberately go through the HTTP API rather than importing the database —
 * see the note at backend/src/api/routes.ts.
 */

import type { ServerContext, ToolResult } from '../common/types.js';

function getApiBase(): string {
  return (process.env.REINS_API_URL ?? 'https://app.helm.mom').replace(/\/$/, '');
}

function getGatewayToken(context: ServerContext): string {
  return context.gatewayToken ?? process.env.REINS_GATEWAY_TOKEN ?? '';
}

async function skillsFetch(
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

  return fetch(`${getApiBase()}${path}`, {
    ...options,
    headers,
  });
}

interface SkillSummary {
  slug: string;
  name: string;
  description: string;
  requiredServices: string[];
  available: boolean;
  missingServices: string[];
  /** Stamped by the installer; absent for hand-authored dashboard skills. */
  version?: string | null;
  latestVersion?: string | null;
  updateAvailable?: boolean;
}

interface SkillDetail extends SkillSummary {
  body: string;
}

export async function handleListSkills(
  args: Record<string, unknown>,
  context: ServerContext
): Promise<ToolResult> {
  try {
    // Default true: a skill whose service was disconnected still comes back,
    // flagged, so the agent can tell the user what to reconnect instead of
    // silently losing the capability.
    const includeUnavailable = args.include_unavailable !== false;
    const path = `/api/agent-skills?include_unavailable=${includeUnavailable ? 'true' : 'false'}`;

    const res = await skillsFetch(context, path);
    if (!res.ok) {
      return { success: false, error: `Skills API returned ${res.status}` };
    }
    const json = await res.json() as { data: SkillSummary[]; setupNotice?: string };
    const skills = json.data ?? [];
    // Setup state is computed server-side (it needs the published manifest),
    // so it is relayed rather than re-derived here.
    const setup = json.setupNotice ? { setup: json.setupNotice } : {};

    if (skills.length === 0) {
      return {
        success: true,
        data: {
          skills: [],
          note: 'No skills are assigned to you. Your owner can add them in the Reins dashboard under Skills.',
          ...setup,
        },
      };
    }

    return {
      success: true,
      data: {
        skills: skills.map((s) => ({
          slug: s.slug,
          name: s.name,
          description: s.description,
          requires: s.requiredServices,
          available: s.available,
          ...(s.available ? {} : { missing_services: s.missingServices }),
          ...(s.version ? { version: s.version } : {}),
          ...(s.updateAvailable ? { update_available: true, latest_version: s.latestVersion } : {}),
        })),
        next_step: 'Call skills_get with a slug to read the full instructions before acting.',
        ...setup,
      },
    };
  } catch (err) {
    return { success: false, error: err instanceof Error ? err.message : String(err) };
  }
}

export async function handleGetSkill(
  args: Record<string, unknown>,
  context: ServerContext
): Promise<ToolResult> {
  const slug = typeof args.slug === 'string' ? args.slug.trim() : '';
  if (!slug) {
    return { success: false, error: 'slug is required. Call skills_list to see available slugs.' };
  }

  try {
    const res = await skillsFetch(context, `/api/agent-skills/${encodeURIComponent(slug)}`);

    if (res.status === 404) {
      // Three outcomes hide behind one status. A typo is fixed by listing; a
      // skill that exists but is neither assigned nor referenced is an owner
      // action, and telling the agent to list would send it in circles.
      const body = await res.json().catch(() => ({})) as { code?: string; error?: string };
      if (body.code === 'SKILL_NOT_REACHABLE') {
        return {
          success: false,
          error:
            body.error ??
            `Skill "${slug}" exists but is not assigned to you. Ask your owner to enable it in the Reins dashboard (Skills).`,
        };
      }
      return {
        success: false,
        error: `No skill with slug "${slug}" is assigned to you. Call skills_list to see what is available.`,
      };
    }
    if (!res.ok) {
      return { success: false, error: `Skills API returned ${res.status}` };
    }

    const json = await res.json() as { data: SkillDetail };
    const skill = json.data;

    return {
      success: true,
      data: {
        slug: skill.slug,
        name: skill.name,
        description: skill.description,
        instructions: skill.body,
        ...(skill.available
          ? {}
          : {
              unavailable_services: skill.missingServices,
              blocked_notice:
                `This skill needs ${skill.missingServices.join(', ')}, which ${skill.missingServices.length === 1 ? 'is' : 'are'} ` +
                `not connected to you. Tell the user to connect ${skill.missingServices.length === 1 ? 'it' : 'them'} in the Reins ` +
                `dashboard (Agents -> your agent -> Services). Do not improvise a workaround.`,
            }),
      },
    };
  } catch (err) {
    return { success: false, error: err instanceof Error ? err.message : String(err) };
  }
}
