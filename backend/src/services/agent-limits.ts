/**
 * Owner-set limits, gathered once for the MCP to announce.
 *
 * A restricted agent has three ways to learn what its owner allows, and they
 * all read from here so they cannot disagree:
 *
 *   - `initialize` returns renderAgentLimits() as the MCP `instructions`.
 *   - `tools/list` appends describeToolLimit() to each limited service's tools.
 *   - `whoami` returns the AgentLimits object itself.
 *
 * Without this an agent discovers its limits one refusal at a time, and a
 * model that meets a refusal it was never warned about tends to retry around
 * it — different arguments, another tool, a sibling account. Saying it up
 * front, and saying that refusals are by design, is what stops that.
 *
 * Only restrictions appear. An agent that may reach everything gets null, and
 * the surfaces above then add nothing at all.
 */

import { db } from '../db/index.js';
import { agents, agentServiceInstances } from '../db/schema.js';
import { eq, and } from 'drizzle-orm';
import { parseInstanceConfig, getDrivePathConfig, type DrivePathConfig } from './permissions.js';
import { getAgentScopeGrants } from './memory-scopes.js';

export interface AgentLimits {
  /** Present only when the agent's memory grants are restricted. */
  memory?: { scopes: Array<{ slug: string; name: string; isDefault: boolean }> };
  /** One entry per enabled Hermeneutix instance pinned to a project. */
  hermeneutix?: Array<{ projectId: string; projectName?: string }>;
  /** Present when the Drive default is not write, or any folder rule exists. */
  drive?: DrivePathConfig;
}

/**
 * What one agent may reach, or null when nothing is restricted.
 */
export async function getAgentLimits(agentId: string): Promise<AgentLimits | null> {
  const [agent] = await db.select().from(agents).where(eq(agents.id, agentId));
  if (!agent) return null;

  const limits: AgentLimits = {};

  if (agent.userId) {
    const grants = await getAgentScopeGrants(agentId, agent.userId);
    if (grants.mode === 'restricted') {
      limits.memory = {
        scopes: grants.scopes.map((s) => ({ slug: s.slug, name: s.name, isDefault: s.isDefault })),
      };
    }
  }

  const instances = await db
    .select()
    .from(agentServiceInstances)
    .where(and(eq(agentServiceInstances.agentId, agentId), eq(agentServiceInstances.enabled, true)));
  const pins: NonNullable<AgentLimits['hermeneutix']> = [];
  for (const inst of instances) {
    if (inst.serviceType !== 'hermeneutix' || !inst.enabled) continue;
    const config = parseInstanceConfig(inst.config);
    const projectId = config?.projectId;
    if (typeof projectId !== 'string' || projectId === '') continue;
    const projectName = config?.projectName;
    pins.push(typeof projectName === 'string' && projectName !== '' ? { projectId, projectName } : { projectId });
  }
  if (pins.length > 0) limits.hermeneutix = pins;

  const drive = await getDrivePathConfig(agentId);
  if (drive.defaultLevel !== 'write' || drive.rules.length > 0) {
    limits.drive = { defaultLevel: drive.defaultLevel, rules: drive.rules };
  }

  return Object.keys(limits).length > 0 ? limits : null;
}

// ── Rendering ────────────────────────────────────────────────────────────────

const scopeList = (scopes: NonNullable<AgentLimits['memory']>['scopes']) =>
  scopes.map((s) => (s.isDefault ? `${s.slug} (default)` : s.slug)).join(', ');

const projectLabel = (p: { projectId: string; projectName?: string }, withId: boolean) =>
  p.projectName ? (withId ? `"${p.projectName}" (${p.projectId})` : `"${p.projectName}"`) : p.projectId;

const ruleLabel = (r: DrivePathConfig['rules'][number]) =>
  r.label ? `${r.label} (${r.folderId})` : r.folderId;

const driveDefaultSentence: Record<DrivePathConfig['defaultLevel'], string> = {
  blocked: 'folders not listed are blocked.',
  read: 'folders not listed are read-only.',
  write: 'folders are writable unless listed.',
};

/**
 * The block an agent reads on initialize. Fixed order, one line per service,
 * and a pointer to whoami for the structured form.
 */
export function renderAgentLimits(limits: AgentLimits): string {
  const lines = ["Limits set by this agent's owner (refusals are by design; do not retry around them):"];

  if (limits.memory) {
    lines.push(`- Memory: you can reach scope(s) ${scopeList(limits.memory.scopes)}. Others are refused.`);
  }
  if (limits.hermeneutix && limits.hermeneutix.length > 0) {
    const noun = limits.hermeneutix.length === 1 ? 'project' : 'projects';
    const list = limits.hermeneutix.map((p) => projectLabel(p, true)).join(', ');
    lines.push(`- Hermeneutix: limited to ${noun} ${list}; project_id is filled in for you.`);
  }
  if (limits.drive) {
    const rules = limits.drive.rules.map((r) => `${ruleLabel(r)}: ${r.permission}`).join('; ');
    lines.push(`- Drive: ${driveDefaultSentence[limits.drive.defaultLevel]}${rules ? ` ${rules}.` : ''}`);
  }

  lines.push('Call whoami for the machine-readable version.');
  return lines.join('\n');
}

/** Keep a tool-description suffix short: models read hundreds of these. */
const MAX_SUFFIX = 150;

function clamp(items: string[], render: (kept: string[], more: number) => string): string {
  let kept = items.length;
  let text = render(items, 0);
  while (text.length > MAX_SUFFIX && kept > 1) {
    kept -= 1;
    text = render(items.slice(0, kept), items.length - kept);
  }
  return text;
}

/**
 * The suffix `tools/list` appends to one tool's description, or null when the
 * tool's service is not limited. Drive gets one only under a blocked default,
 * or a read-only default with folder rules — the two cases where the tool's
 * plain description would mislead.
 */
export function describeToolLimit(toolName: string, limits: AgentLimits): string | null {
  if (toolName.startsWith('memory_') && limits.memory) {
    const scopes = limits.memory.scopes.map((s) => (s.isDefault ? `${s.slug} (default)` : s.slug));
    return clamp(scopes, (kept, more) =>
      ` Scopes you can reach: ${kept.join(', ')}${more > 0 ? ` and ${more} more` : ''}.`
    );
  }

  if (toolName.startsWith('hermeneutix_') && limits.hermeneutix && limits.hermeneutix.length > 0) {
    const noun = limits.hermeneutix.length === 1 ? 'project' : 'projects';
    const labels = limits.hermeneutix.map((p) => projectLabel(p, false));
    return clamp(labels, (kept, more) =>
      ` Limited to ${noun} ${kept.join(', ')}${more > 0 ? ` and ${more} more` : ''}; project_id is filled in.`
    );
  }

  if (toolName.startsWith('drive_') && limits.drive) {
    const { defaultLevel, rules } = limits.drive;
    const labels = rules.map((r) => `${r.label ?? r.folderId} (${r.permission})`);
    if (defaultLevel === 'blocked') {
      if (labels.length === 0) return ' Drive access is blocked for this agent.';
      return clamp(labels, (kept, more) =>
        ` Limited to Drive folder(s) ${kept.join(', ')}${more > 0 ? ` and ${more} more` : ''}; files elsewhere are refused.`
      );
    }
    if (defaultLevel === 'read' && labels.length > 0) {
      return clamp(labels, (kept, more) =>
        ` Drive is read-only except folder(s) ${kept.join(', ')}${more > 0 ? ` and ${more} more` : ''}.`
      );
    }
    return null;
  }

  return null;
}
