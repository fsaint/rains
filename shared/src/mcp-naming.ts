/**
 * MCP naming — single source of truth for the server name, the namespace
 * separator, and the built-in tool names.
 *
 * The server name is not cosmetic: MCP clients namespace every tool as
 * `<server><separator><tool>`, so this value is what the model actually types
 * when it calls a tool. Changing it changes the agent-facing API.
 */

/** Name of the Reins-provided MCP server, as injected into MCP_CONFIG. */
export const MCP_SERVER_NAME = 'helm';

/** Separator MCP clients place between server name and tool name. */
export const TOOL_NAMESPACE_SEPARATOR = '__';

/** Agent runtimes that consume the MCP server. */
export type AgentRuntime = 'openclaw' | 'hermes';

/**
 * Built-in tools served directly by the agent endpoint rather than by a
 * downstream service server.
 */
export const BUILTIN_TOOLS = {
  getResult: 'get_result',
  markOnboarded: 'mark_onboarded',
} as const;

/**
 * Tool names accepted on `tools/call` but no longer advertised on `tools/list`.
 *
 * Kept indefinitely: agent machines bake the old server name into MCP_CONFIG at
 * deploy time, and user-authored skills may name the old tools in prose we
 * cannot rewrite.
 */
const LEGACY_TOOL_ALIASES: Record<string, string> = {
  reins_get_result: BUILTIN_TOOLS.getResult,
  reins__mark_onboarded: BUILTIN_TOOLS.markOnboarded,
};

/**
 * Map a possibly-legacy tool name to its canonical form. Unknown names pass
 * through untouched so downstream service-tool routing is unaffected.
 */
export function canonicalToolName(toolName: string): string {
  return LEGACY_TOOL_ALIASES[toolName] ?? toolName;
}

/**
 * The name the model actually sees and must type, for a given runtime.
 *
 * The two runtimes namespace differently, verified against their source:
 *
 * - OpenClaw  `<server>__<tool>`        → `helm__gmail_search`
 * - Hermes    `mcp__<server>__<tool>`   → `mcp__helm__gmail_search`
 *   (hermes-agent `tools/mcp_tool.py` → `mcp_prefixed_tool_name`, which uses the
 *   `mcp__` convention shared with Claude Code and Codex)
 *
 * Use this for any tool name embedded in text the model reads — instructions,
 * skill bodies, approval prompts. Using the bare server-side name there is a
 * real bug: the model cannot call a tool by a name that is not in its list.
 *
 * Note: Hermes sanitizes each component with `[^A-Za-z0-9_] -> _`, so keeping
 * `MCP_SERVER_NAME` free of hyphens is what keeps the two runtimes' server
 * components identical.
 */
export function modelVisibleToolName(
  toolName: string,
  runtime: AgentRuntime = 'openclaw',
  serverName: string = MCP_SERVER_NAME
): string {
  const namespaced = `${serverName}${TOOL_NAMESPACE_SEPARATOR}${toolName}`;
  return runtime === 'hermes' ? `mcp${TOOL_NAMESPACE_SEPARATOR}${namespaced}` : namespaced;
}

/**
 * Server name to assume for a deployment row that predates the column.
 *
 * The prefix a running agent sees comes from the MCP_CONFIG baked into its
 * machine at deploy time, NOT from MCP_SERVER_NAME here — so between a backend
 * deploy and that agent's redeploy the two disagree. Rendering the current
 * constant into text an old agent reads names a tool it does not have.
 */
export const LEGACY_MCP_SERVER_NAME = 'reins';

/**
 * `{{tool:NAME}}` — the token skill authors write instead of hardcoding a
 * prefix.
 *
 * Skills are stored once but served to both runtimes, which namespace
 * differently, so a literal `helm__gmail_search` in a skill body is wrong on
 * Hermes and `gmail_search` is wrong on both. Authors write
 * `{{tool:gmail_search}}` and this resolves it per-agent at serve time — which
 * also means the stored content survives the next rename untouched.
 */
const TOOL_TOKEN_PATTERN = /\{\{tool:([A-Za-z0-9_]+)\}\}/g;

/**
 * Replace every `{{tool:NAME}}` in `text` with the name the model sees.
 *
 * Malformed tokens (`{{tool:}}`, `{{ tool:x }}`) do not match and are left
 * verbatim, so an authoring mistake shows up in the text rather than silently
 * rendering as nothing.
 */
export function resolveToolTokens(
  text: string,
  runtime: AgentRuntime = 'openclaw',
  serverName: string = MCP_SERVER_NAME
): string {
  if (!text) return text;
  return text.replace(TOOL_TOKEN_PATTERN, (_match, toolName: string) =>
    modelVisibleToolName(canonicalToolName(toolName), runtime, serverName)
  );
}
