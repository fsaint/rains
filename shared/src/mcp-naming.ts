/**
 * MCP naming — single source of truth for the server name and the built-in
 * tool names.
 *
 * Every agent is an external MCP client (claude.ai, Claude Desktop, Claude
 * Code, Cowork, or any other MCP client). Those clients namespace tools with
 * a prefix of their own that the backend cannot know, so the bare tool name
 * is the only spelling that is still correct after the client adds it.
 */

/** Name of the Helm MCP server, as reported in the initialize handshake. */
export const MCP_SERVER_NAME = 'helm';

/**
 * Built-in tools served directly by the agent endpoint rather than by a
 * downstream service server.
 */
export const BUILTIN_TOOLS = {
  getResult: 'get_result',
  whoami: 'whoami',
} as const;

/**
 * Tool names accepted on `tools/call` but no longer advertised on `tools/list`.
 * Kept because user-authored skills may name the old tool in prose.
 */
const LEGACY_TOOL_ALIASES: Record<string, string> = {
  reins_get_result: BUILTIN_TOOLS.getResult,
};

/**
 * Map a possibly-legacy tool name to its canonical form. Unknown names pass
 * through untouched so downstream service-tool routing is unaffected.
 */
export function canonicalToolName(toolName: string): string {
  return LEGACY_TOOL_ALIASES[toolName] ?? toolName;
}

/**
 * The name the model actually sees and must type. Bare: the client adds its
 * own prefix. Use this for any tool name embedded in text the model reads —
 * instructions, skill bodies, approval prompts.
 */
export function modelVisibleToolName(toolName: string): string {
  return toolName;
}

/**
 * `{{tool:NAME}}` — the token skill authors write instead of hardcoding a
 * tool name. Resolved at serve time so stored content survives renames.
 */
const TOOL_TOKEN_PATTERN = /\{\{tool:([A-Za-z0-9_]+)\}\}/g;

/**
 * Replace every `{{tool:NAME}}` in `text` with the name the model sees.
 * Malformed tokens (`{{tool:}}`, `{{ tool:x }}`) do not match and are left
 * verbatim, so an authoring mistake shows up in the text.
 */
export function resolveToolTokens(text: string): string {
  if (!text) return text;
  return text.replace(TOOL_TOKEN_PATTERN, (_match, toolName: string) =>
    modelVisibleToolName(canonicalToolName(toolName))
  );
}

/**
 * `{{skill:SLUG}}` — how one skill points at another. Slugs are kebab-case;
 * anything else is left verbatim. A reference is a pointer, not a grant.
 */
const SKILL_TOKEN_PATTERN = /\{\{skill:([a-z0-9-]+)\}\}/g;

/** Tool an agent calls to read a skill body. */
const SKILL_FETCH_TOOL = 'skills_get';

/**
 * Replace every `{{skill:SLUG}}` with an instruction naming both the skill and
 * the tool that opens it.
 */
export function resolveSkillTokens(text: string): string {
  if (!text) return text;
  const fetchTool = modelVisibleToolName(SKILL_FETCH_TOOL);
  return text.replace(
    SKILL_TOKEN_PATTERN,
    (_match, slug: string) => `the \`${slug}\` skill (open it with ${fetchTool})`
  );
}

