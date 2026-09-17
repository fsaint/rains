# Phase 1: Remove the Deployed-Agent Runtime — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Strip the Fly.io agent runtime, the Telegram onboarding bot, and everything that only served a machine, leaving Helm as an MCP gateway plus memory and skills, with every agent a single `agents` row.

**Architecture:** The `deployed_agents` table folds into `agents` (two columns move: `gateway_token`, `allow_unauthenticated`), every MCP-layer reader switches to `agents`, and all agents render tool names as the `external` runtime does today (bare names). Runtime-only services, routes, pages, packages, scripts, docs, and tests are deleted. The subscription gate on MCP tool calls is rewired to the owner lookup that actually matches, which makes it live for the first time.

**Tech Stack:** Node 20 / TypeScript / Fastify / postgres.js (`sql` tagged templates in `backend/src/db/index.ts`, `client.execute({ sql, args })` elsewhere) / Drizzle schema mirrors / Vitest / React 18 + TanStack Query + Tailwind / Playwright.

**Spec:** `docs/superpowers/specs/2026-09-16-mcp-only-enrollment-trials-design.md`, Phase 1 (sections 1.1 to 1.6).

## Global Constraints

- Work on branch `feat/mcp-only`, cut from `main`. Never run `fly deploy`, `fly secrets set`, or anything that touches a Fly app. Production cleanup (spec section 1.6) is manual and outside this plan.
- `main` is green: typecheck clean, every workspace's tests pass. Any failure you see is yours. Do not excuse a failure as pre-existing.
- Every task ends with `npm run typecheck` and the affected workspace's tests green, then a commit. Commit messages follow conventional commits (`refactor(backend): ...`, `feat(db): ...`, `chore: ...`) and end with the two attribution lines given in the session's system reminder.
- Agents with no live `deployed_agents` row become closed (`allow_unauthenticated = false`). Agents with a live row keep that row's value. This is the user's explicit decision.
- All agents are the `external` runtime: tool names render bare, with no server prefix.
- Keep `max_machines_running = 1` in the root `fly.toml`. Keep the `x-reins-agent-secret` bypass in the auth guard (`backend/src/auth/index.ts:572`). Keep `services/agent-uploads.ts`, `services/agent-limits.ts`, the browser MCP server, and `agenthelm-core`'s own `fly.toml` and `Dockerfile`.
- Test commands: backend `cd backend && npx vitest run <file>`; frontend `cd frontend && npx vitest run <file>`; shared `cd shared && npx vitest run <file>`; whole repo `npm test` and `npm run typecheck` from the root. Build shared first when the backend cannot resolve `@reins/shared`: `npm run build --workspace=shared --workspace=servers`.

---

## File map

| Area | Delete | Create | Modify |
|---|---|---|---|
| DB | `deployed_agents`, `agent_model_configs`, `initial_prompt_templates`, `spend_records` DDL | `backend/src/db/migrate-deployed-agents.ts` (+ test) | `backend/src/db/index.ts`, `backend/src/db/schema.ts` |
| Shared | | | `shared/src/mcp-naming.ts` (+ test) |
| MCP layer | | | `backend/src/mcp/agent-endpoint.ts` (+ test) |
| Routes | 30 runtime routes and 6 helpers in `backend/src/api/routes.ts` | | `backend/src/api/routes.ts`, six route test suites |
| Services | `providers/`, `fly-lifecycle-monitor.ts`, `agent-bot-relay.ts`, `model-router.ts`, `agent-backup.ts`, `spend.ts`, `dream.ts` (+ tests) | | `token-monitor.ts`, `billing.ts` (+ test), `permissions.ts`, `email.ts`, `notifications/telegram.ts`, `notifications/approval-format.ts`, `notifications/handlers.ts`, `index.ts`, `config/index.ts`, `config/*.yaml` |
| Onboarding | `onboarding/` | | `package.json`, `.github/workflows/deploy.yml`, `.github/workflows/ci.yml` |
| Frontend | `DeploymentPanel.tsx`, `LogViewer.tsx` (+ test), `LogsPanel.tsx`, `ChatModal.tsx`, `CodexDeviceFlow.tsx`, `pages/Backups.tsx`, `pages/Agents.tsx` | `components/McpAccessSection.tsx` | `api/client.ts`, `pages/AgentNew.tsx` (+ test), `pages/AgentDetail.tsx`, `pages/Permissions.tsx`, `pages/Login.tsx`, `components/ReauthModal.tsx`, `components/ReauthApprovalCard.tsx`, `App.tsx` |
| Infra & docs | `docker/`, `admin/`, `shared/BOOTSTRAP.md`, 5 scripts, `tests/image-test/`, `tests/integration/`, 4 skills, 6 docs | | `CLAUDE.md`, `TESTING.md`, `README.md`, `docs/MEMORY.md`, `docs/architecture/MCP_TOOL_INJECTION.md`, `docs/ops/LOCAL_DEV_SETUP.md`, `docs/ops/PROD_SETUP.md`, `docs/MULTI_AGENT_SETUP.md`, `e2e/user-journey.spec.ts` |

Task order matters: the column fold (Task 2) lands before any reader switches (Tasks 3 to 5), and the table drop (Task 9) lands after the last reader is gone.

---

### Task 1: Branch and baseline

**Files:** none

- [ ] **Step 1: Cut the branch**

```bash
cd /Users/fsaint/git/reins
git checkout main && git pull --ff-only
git checkout -b feat/mcp-only
```

- [ ] **Step 2: Confirm the baseline is green**

```bash
npm run build --workspace=shared --workspace=servers
npm run typecheck
npm test
```

Expected: every workspace passes. If anything fails, stop and report it; do not continue on a red baseline.

---

### Task 2: Fold `deployed_agents` columns into `agents`

**Files:**
- Create: `backend/src/db/migrate-deployed-agents.ts`
- Create: `backend/src/db/migrate-deployed-agents.test.ts`
- Modify: `backend/src/db/index.ts` (after the `allow_unauthenticated SET DEFAULT false` statement, currently line 785)
- Modify: `backend/src/db/schema.ts:20-31` (`agents` table)

**Interfaces:**
- Produces: `agents.gateway_token TEXT`, `agents.allow_unauthenticated BOOLEAN NOT NULL DEFAULT false`; `migrateDeployedAgents(exec)` where `exec` is `{ execute(q: { sql: string; args: unknown[] } | string): Promise<{ rows: Record<string, unknown>[] }> }`; Drizzle `agents.gatewayToken`, `agents.allowUnauthenticated`.

- [ ] **Step 1: Write the failing test**

`backend/src/db/migrate-deployed-agents.test.ts`:

```ts
import { describe, it, expect, vi } from 'vitest';
import { migrateDeployedAgents } from './migrate-deployed-agents.js';

function fakeExec(nullTokenIds: string[], tableExists = true) {
  const calls: Array<{ sql: string; args: unknown[] }> = [];
  const execute = vi.fn(async (q: { sql: string; args: unknown[] } | string) => {
    const sql = typeof q === 'string' ? q : q.sql;
    const args = typeof q === 'string' ? [] : q.args;
    calls.push({ sql, args });
    if (sql.includes('to_regclass')) return { rows: [{ exists: tableExists }] };
    if (sql.includes('WHERE gateway_token IS NULL')) return { rows: nullTokenIds.map((id) => ({ id })) };
    return { rows: [] };
  });
  return { execute, calls };
}

describe('migrateDeployedAgents', () => {
  it('copies the newest live deployment row onto each agent, then fills missing tokens', async () => {
    const db = fakeExec(['a-no-row']);
    await migrateDeployedAgents(db);

    const copy = db.calls.find((c) => c.sql.includes('DISTINCT ON (agent_id)'));
    expect(copy, 'expected the fold UPDATE').toBeDefined();
    expect(copy!.sql).toContain("status NOT IN ('destroyed', 'error')");
    expect(copy!.sql).toContain('a.gateway_token IS NULL');

    const fill = db.calls.filter((c) => c.sql.startsWith('UPDATE agents SET gateway_token = ?'));
    expect(fill).toHaveLength(1);
    expect(fill[0].args[1]).toBe('a-no-row');
    expect(String(fill[0].args[0])).toHaveLength(32);
  });

  it('never opens an agent that had no live row: the fill writes only the token', async () => {
    const db = fakeExec(['a-no-row']);
    await migrateDeployedAgents(db);
    const fill = db.calls.find((c) => c.sql.startsWith('UPDATE agents SET gateway_token = ?'));
    expect(fill!.sql).not.toContain('allow_unauthenticated');
  });

  it('skips the copy when deployed_agents is already gone, but still fills tokens', async () => {
    const db = fakeExec(['a-1'], false);
    await migrateDeployedAgents(db);
    expect(db.calls.some((c) => c.sql.includes('DISTINCT ON (agent_id)'))).toBe(false);
    expect(db.calls.some((c) => c.sql.startsWith('UPDATE agents SET gateway_token = ?'))).toBe(true);
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

```bash
cd backend && npx vitest run src/db/migrate-deployed-agents.test.ts
```

Expected: FAIL, cannot find module `./migrate-deployed-agents.js`.

- [ ] **Step 3: Write the migration module**

`backend/src/db/migrate-deployed-agents.ts`:

```ts
import { nanoid } from 'nanoid';

interface Exec {
  execute(q: { sql: string; args: unknown[] } | string): Promise<{ rows: Record<string, unknown>[] }>;
}

/**
 * One-time fold of deployed_agents into agents.
 *
 * Each agent takes gateway_token and allow_unauthenticated from its newest
 * deployment row that is neither destroyed nor errored. Agents with no such
 * row keep the column default (closed) and get a fresh gateway token, so an
 * agent id is never a credential by accident. Idempotent: the copy only
 * touches agents whose gateway_token is still null, and the table check
 * makes the whole thing a no-op once deployed_agents has been dropped.
 */
export async function migrateDeployedAgents(db: Exec): Promise<void> {
  const exists = await db.execute({
    sql: `SELECT to_regclass('public.deployed_agents') IS NOT NULL AS exists`,
    args: [],
  });
  if (exists.rows[0]?.exists === true) {
    await db.execute({
      sql: `UPDATE agents a
            SET gateway_token = d.gateway_token,
                allow_unauthenticated = d.allow_unauthenticated
            FROM (
              SELECT DISTINCT ON (agent_id) agent_id, gateway_token, allow_unauthenticated
              FROM deployed_agents
              WHERE status NOT IN ('destroyed', 'error')
              ORDER BY agent_id, created_at DESC
            ) d
            WHERE d.agent_id = a.id AND a.gateway_token IS NULL`,
      args: [],
    });
  }

  const missing = await db.execute({
    sql: `SELECT id FROM agents WHERE gateway_token IS NULL`,
    args: [],
  });
  for (const row of missing.rows) {
    await db.execute({
      sql: `UPDATE agents SET gateway_token = ? WHERE id = ?`,
      args: [nanoid(32), row.id as string],
    });
  }
}
```

- [ ] **Step 4: Wire it into `initializeDatabase`**

In `backend/src/db/index.ts`, add the import at the top:

```ts
import { migrateDeployedAgents } from './migrate-deployed-agents.js';
```

Directly after the line `await sql\`ALTER TABLE deployed_agents ALTER COLUMN allow_unauthenticated SET DEFAULT false\`;` insert:

```ts
  // Agents carry their own MCP credential state now. Columns first, then the
  // one-time copy out of deployed_agents (see migrate-deployed-agents.ts).
  await sql`ALTER TABLE agents ADD COLUMN IF NOT EXISTS gateway_token TEXT`;
  await sql`ALTER TABLE agents ADD COLUMN IF NOT EXISTS allow_unauthenticated BOOLEAN NOT NULL DEFAULT false`;
  await migrateDeployedAgents(client);
```

`client` is the `{ execute }` wrapper already exported from this file; confirm with `grep -n "export const client\|export { client" backend/src/db/index.ts`.

- [ ] **Step 5: Mirror the columns in Drizzle**

In `backend/src/db/schema.ts`, inside `export const agents = pgTable('agents', { ... })`, add after `status`:

```ts
  gatewayToken: text('gateway_token'),
  // False by default: an agent id is not a credential. The owner opens it
  // from the dashboard, and the helm-admin latch can refuse that.
  allowUnauthenticated: boolean('allow_unauthenticated').default(false).notNull(),
```

`boolean` is already imported in that file (used by `deployedAgents`).

- [ ] **Step 6: Run the test and typecheck**

```bash
cd backend && npx vitest run src/db/migrate-deployed-agents.test.ts && cd .. && npm run typecheck
```

Expected: PASS, typecheck clean.

- [ ] **Step 7: Commit**

```bash
git add backend/src/db/migrate-deployed-agents.ts backend/src/db/migrate-deployed-agents.test.ts backend/src/db/index.ts backend/src/db/schema.ts
git commit -m "feat(db): fold gateway_token and allow_unauthenticated onto agents"
```

---

### Task 3: Collapse MCP naming to the external runtime

**Files:**
- Modify: `shared/src/mcp-naming.ts`
- Modify: `shared/src/mcp-naming.test.ts`

**Interfaces:**
- Produces: `modelVisibleToolName(toolName: string): string`, `resolveToolTokens(text: string): string`, `resolveSkillTokens(text: string): string`, `canonicalToolName`, `MCP_SERVER_NAME`, `BUILTIN_TOOLS = { getResult, whoami }`. Removed: `AgentRuntime`, `deploymentRuntime`, `LEGACY_MCP_SERVER_NAME`, `TOOL_NAMESPACE_SEPARATOR`, `BUILTIN_TOOLS.markOnboarded`, the `reins__mark_onboarded` alias.

- [ ] **Step 1: Rewrite the test file**

Replace `shared/src/mcp-naming.test.ts` with:

```ts
import { describe, it, expect } from 'vitest';
import {
  BUILTIN_TOOLS,
  MCP_SERVER_NAME,
  canonicalToolName,
  modelVisibleToolName,
  resolveSkillTokens,
  resolveToolTokens,
} from './mcp-naming.js';

describe('canonicalToolName', () => {
  it('maps the pre-rename get_result name to its canonical form', () => {
    expect(canonicalToolName('reins_get_result')).toBe(BUILTIN_TOOLS.getResult);
  });

  it('passes service tool names through untouched', () => {
    expect(canonicalToolName('gmail_search')).toBe('gmail_search');
  });

  it('no longer knows mark_onboarded', () => {
    expect(canonicalToolName('reins__mark_onboarded')).toBe('reins__mark_onboarded');
    expect('markOnboarded' in BUILTIN_TOOLS).toBe(false);
  });
});

describe('modelVisibleToolName', () => {
  it('renders the bare tool name — the client adds its own prefix', () => {
    expect(modelVisibleToolName('gmail_search')).toBe('gmail_search');
  });

  it('keeps the server name free of hyphens for clients that sanitize it', () => {
    expect(MCP_SERVER_NAME).not.toContain('-');
  });
});

describe('resolveToolTokens', () => {
  it('resolves every occurrence bare', () => {
    expect(resolveToolTokens('run {{tool:gmail_search}} then {{tool:drive_search}}'))
      .toBe('run gmail_search then drive_search');
  });

  it('resolves legacy tool names inside tokens to the canonical name', () => {
    expect(resolveToolTokens('{{tool:reins_get_result}}')).toBe(BUILTIN_TOOLS.getResult);
  });

  it('leaves malformed tokens verbatim so authoring mistakes stay visible', () => {
    expect(resolveToolTokens('{{tool:}} and {{ tool:x }}')).toBe('{{tool:}} and {{ tool:x }}');
  });

  it('leaves text without tokens untouched', () => {
    expect(resolveToolTokens('plain')).toBe('plain');
    expect(resolveToolTokens('')).toBe('');
  });
});

describe('resolveSkillTokens', () => {
  it('renders an actionable instruction naming the bare fetch tool', () => {
    expect(resolveSkillTokens('see {{skill:deep-research}}'))
      .toBe('see the `deep-research` skill (open it with skills_get)');
  });

  it('resolves every occurrence', () => {
    const out = resolveSkillTokens('{{skill:a}} {{skill:b}}');
    expect(out).toContain('`a` skill');
    expect(out).toContain('`b` skill');
  });

  it('leaves malformed tokens verbatim', () => {
    expect(resolveSkillTokens('{{skill:Not Kebab}}')).toBe('{{skill:Not Kebab}}');
  });

  it('leaves tool tokens alone', () => {
    expect(resolveSkillTokens('{{tool:gmail_search}}')).toBe('{{tool:gmail_search}}');
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

```bash
cd shared && npx vitest run src/mcp-naming.test.ts
```

Expected: FAIL. `canonicalToolName('reins__mark_onboarded')` still maps, `markOnboarded` still exists, and the runtime-parameter tests are gone but the module still has them.

- [ ] **Step 3: Rewrite the module**

Replace `shared/src/mcp-naming.ts` with:

```ts
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
```

- [ ] **Step 4: Run the shared tests and rebuild shared**

```bash
cd shared && npx vitest run && npm run build
```

Expected: PASS. (`npm run typecheck` at the root will fail now because `backend` still imports the removed names. That is expected until Tasks 4 and 5; do not run the root typecheck for this commit.)

- [ ] **Step 5: Commit**

```bash
git add shared/src/mcp-naming.ts shared/src/mcp-naming.test.ts
git commit -m "refactor(shared): every agent is an external MCP client; drop runtime-aware naming"
```

---

### Task 4: Rewire the MCP endpoint to `agents`

**Files:**
- Modify: `backend/src/mcp/agent-endpoint.ts` (imports lines 9-43; `runtimeOf`/`serverNameOf`/`getAgentToolNaming` lines 51-83; `tools/list` block lines 573-604; `buildSkillCatalog` lines 631-670; `mark_onboarded` handler lines 1227-1268; gate blocks lines 1270-1320; approval text line 1478-1493)
- Modify: `backend/src/mcp/agent-endpoint.test.ts`

**Interfaces:**
- Consumes: Task 3 exports; `agents.gateway_token`, `agents.user_id`.
- Produces: `buildSkillCatalog(agentId: string): Promise<string | null>`; every `deployed_agents` read in this file is gone; a blocked subscription returns an `isError` result on `tools/call`.

- [ ] **Step 1: Write the failing tests**

In `backend/src/mcp/agent-endpoint.test.ts`, change the billing mock (currently lines 233-240) to:

```ts
vi.mock('../services/billing.js', () => ({
  getSubscription: vi.fn().mockResolvedValue(null),
  upsertSubscription: vi.fn().mockResolvedValue(undefined),
  applyGracePeriod: vi.fn().mockResolvedValue(undefined),
  clearGrace: vi.fn().mockResolvedValue(undefined),
  cancelSubscription: vi.fn().mockResolvedValue(undefined),
  checkUsageGate: vi.fn().mockResolvedValue({ allowed: true }),
}));
```

Delete the `vi.mock('../services/spend.js', ...)` block (lines 229-232).

Delete these tests: `still dispatches the legacy reins__mark_onboarded name` (line 456), `names get_result the way a Hermes agent actually sees it` (492), `injects mark_onboarded under its new name when setup is incomplete` (535), `is listed for a Hermes deployment too — it does not depend on runtime` (1242). Rename `addresses get_result bare for a manual (Claude-connected) deployment` (513) to `addresses get_result bare` and remove any `deployed_agents` row it seeds. Rename `renders tool tokens bare for an external (manual) agent` (1077) to `renders tool tokens bare` and remove the deployment row it seeds.

At line 1508, change the gateway-token mock condition from `SELECT gateway_token FROM deployed_agents` to `SELECT gateway_token FROM agents`.

Add, inside the `describe` that covers `tools/call` (next to the `get_result` tests), this test:

```ts
  it('blocks a tool call when the owner\'s subscription has lapsed', async () => {
    const { client } = await import('../db/index.js');
    const { checkUsageGate } = await import('../services/billing.js');
    vi.mocked(client.execute).mockImplementation(async (q: unknown) => {
      const sql = typeof q === 'string' ? q : (q as { sql: string }).sql;
      if (sql.includes('SELECT user_id FROM agents WHERE id = ?')) {
        return { rows: [{ user_id: 'owner-1' }] } as never;
      }
      return { rows: [] } as never;
    });
    vi.mocked(checkUsageGate).mockResolvedValueOnce({ allowed: false, reason: 'lapsed' });

    const res = await handleMCPRequest('agent-1', {
      jsonrpc: '2.0', id: 9, method: 'tools/call',
      params: { name: 'gmail_search', arguments: { query: 'x' } },
    });

    expect(checkUsageGate).toHaveBeenCalledWith('owner-1');
    expect(res.result?.isError).toBe(true);
    expect(res.result?.content?.[0]?.text).toContain('subscription');
  });
```

Adjust the `handleMCPRequest` call shape to match how the neighbouring tests in that file invoke it (they may pass a principal or options as a third argument; copy their form).

- [ ] **Step 2: Run to verify failures**

```bash
cd backend && npx vitest run src/mcp/agent-endpoint.test.ts
```

Expected: FAIL on the new test (gate query does not exist yet) and on import errors for the removed shared names.

- [ ] **Step 3: Rewrite the imports**

In `backend/src/mcp/agent-endpoint.ts`:

- Delete line 11 `import { updateMachineEnv } from '../providers/fly.js';`.
- Delete line 41 `import { checkSpendCap } from '../services/spend.js';`.
- In the `@reins/shared` import block (lines 29-40) remove `LEGACY_MCP_SERVER_NAME`, `deploymentRuntime`, `type AgentRuntime`. Keep `MCP_SERVER_NAME`, `BUILTIN_TOOLS`, `canonicalToolName`, `modelVisibleToolName`, `resolveToolTokens`, `resolveSkillTokens` and whatever else it imports.

- [ ] **Step 4: Delete the naming helpers**

Delete `runtimeOf`, `serverNameOf`, and `getAgentToolNaming` (lines 51-83) with their doc comments.

- [ ] **Step 5: Simplify `tools/list`**

Replace lines 573-604 (from `// Inject mark_onboarded if ...` through the `buildSkillCatalog(...)` call) so the block reads:

```ts
  // Append this agent's skill catalog to the skills_list description.
  //
  // MCP-served skills do not self-advertise, so we reproduce progressive
  // disclosure here: names and one-liners always visible, bodies fetched on
  // demand via skills_get.
  const skillsTool = tools.find((t) => t.name === 'skills_list');
  if (skillsTool) {
    const catalog = await buildSkillCatalog(agentId);
```

Keep whatever follows the original `buildSkillCatalog` call unchanged.

- [ ] **Step 6: Simplify `buildSkillCatalog`**

Change its signature and body (lines 631-670):

```ts
export async function buildSkillCatalog(agentId: string): Promise<string | null> {
```

and inside the loop:

```ts
    const description = resolveSkillTokens(resolveToolTokens(String(row.description ?? '')));
```

- [ ] **Step 7: Read the gateway token from `agents`**

Replace the block at lines 788-795:

```ts
    const tokenRow = await client.execute({
      sql: `SELECT gateway_token FROM agents WHERE id = ? LIMIT 1`,
      args: [agentId],
    });
    if (tokenRow.rows.length > 0 && tokenRow.rows[0].gateway_token) {
      context.gatewayToken = tokenRow.rows[0].gateway_token as string;
    }
```

- [ ] **Step 8: Remove `mark_onboarded` and the spend cap, fix the gate**

Delete the whole `if (toolName === BUILTIN_TOOLS.markOnboarded) { ... }` handler (lines 1227-1268). Replace the two gate blocks (lines 1270-1320, from `// Subscription lapse gate` through the end of the spend-cap block) with:

```ts
  // Subscription gate. Lenient: only blocks when the owner's subscription has
  // explicitly lapsed or been canceled (see checkUsageGate).
  {
    const agentOwner = await client.execute({
      sql: `SELECT user_id FROM agents WHERE id = ? LIMIT 1`,
      args: [agentId],
    });
    const ownerId = agentOwner.rows[0]?.user_id as string | undefined;
    if (ownerId) {
      const subGate = await checkUsageGate(ownerId);
      if (!subGate.allowed) {
        await auditLogger.logToolCall(agentId, toolName, args, 'blocked', Date.now() - startTime, { reason: 'subscription_lapsed' });
        return {
          jsonrpc: '2.0',
          id: requestId,
          result: {
            content: [{ type: 'text', text: 'Your subscription has lapsed. This agent cannot make tool calls until you renew. Visit the dashboard to manage your billing.' }],
            isError: true,
          },
        };
      }
    }
  }
```

- [ ] **Step 9: Simplify the approval-pending text**

At lines 1478-1493 delete `const toolNaming = await getAgentToolNaming(agentId);` and change the interpolation to `modelVisibleToolName(BUILTIN_TOOLS.getResult)`.

- [ ] **Step 10: Sweep the file**

```bash
grep -n "deployed_agents\|runtime\|serverName\|markOnboarded\|sharedBotToken\|checkSpendCap" backend/src/mcp/agent-endpoint.ts
```

Expected: no matches except comments you consider still true. Delete any remaining reference.

- [ ] **Step 11: Run the suite**

```bash
cd backend && npx vitest run src/mcp/agent-endpoint.test.ts
```

Expected: PASS.

- [ ] **Step 12: Commit**

```bash
git add backend/src/mcp/agent-endpoint.ts backend/src/mcp/agent-endpoint.test.ts
git commit -m "refactor(mcp): read agent credential state from agents; make the subscription gate live"
```

---

### Task 5: Rewire the MCP-identity routes

**Files:**
- Modify: `backend/src/api/routes.ts` (agents list 283-320; `mcp-unauthenticated` 404-450; `POST /api/agents` 546-572; `destroyAgentCompletely` 634-687; `authenticateMcp` 3458-3486; `create-manual` 3759-3815; `detail` 4463-4550; `/api/admin/agents` 5664-5694; `resolveAgentFromGatewayToken` 5940-5968; skills routes 7033, 7068, 7150; `agent-admin` list 7258-7296 and create 7312-7365)
- Modify: `backend/src/services/permissions.ts:9`, `:376-393`, `:1836-1850`
- Modify tests: `backend/src/api/mcp-auth-routes.test.ts`, `backend/src/api/agent-admin-routes.test.ts`, `backend/src/api/skills-routes.test.ts`, `backend/src/integration/memory.test.ts`, `backend/src/mcp/scoped-services.e2e.test.ts`, `backend/src/api/permissions-instance-routes.test.ts`

**Interfaces:**
- Produces: `POST /api/agents` creates a closed agent with a gateway token and returns `{ data: { id, name, description, status: 'active', acceptsUnauthenticatedMcp: false } }`; `GET /api/agents/:id/detail` returns `{ data: { id, name, description, status, createdAt, mcpUrl, allowUnauthenticated } }`; `resolveAgentFromGatewayToken(request)` returns `{ agentId, userId } | null`; `listOpenMcpAgents` reads `agents.allow_unauthenticated`.

- [ ] **Step 1: Update the route test fixtures**

`backend/src/api/mcp-auth-routes.test.ts`:
- In `deploymentAllows` (line 112-121) rename to `agentAllows` and match `sql.includes('allow_unauthenticated') && sql.includes('FROM agents')`. Update every caller. The `null` case (no row) must now expect the endpoint to answer with the agent-not-found shape, not to be served: find the test that asserts an open endpoint for a missing row and change its expectation to 404 (or whatever `handleMCPRequest` returns for an unknown agent; read `mcpUnauthorized` and the `POST /mcp/:agentId` handler at lines 3518-3620 to pick the exact status).
- In `new agents are born closed` (line 275 onward) change `insertedDeployment` to look for `/INSERT INTO agents/i`, rename it `insertedAgent`, and change the test titles from `create-manual writes ...` to `POST /api/agents writes allow_unauthenticated = false explicitly`. Point the request at `POST /api/agents` with body `{ name: 'x' }`.

`backend/src/api/agent-admin-routes.test.ts`: at lines 186, 460 change `sql.includes('FROM deployed_agents da') && sql.includes('gateway_token')` to `sql.includes('FROM agents') && sql.includes('gateway_token = ?')` and return `rows([{ id: ADMIN_AGENT, user_id: 'user-1' }])`. At lines 399-404 replace the deployment-insert assertion with:

```ts
    const agentInsert = mockExecute.mock.calls.find(
      (c) => ((c[0] as any).sql as string).includes('INSERT INTO agents')
    );
    expect(agentInsert).toBeTruthy();
    expect((agentInsert![0] as any).sql).toContain('allow_unauthenticated');
    expect((agentInsert![0] as any).sql).toContain('false');
```

`backend/src/api/skills-routes.test.ts`: replace every `/FROM deployed_agents da/` matcher with `/gateway_token = \?/` and every row it returns with `rows([{ id: 'agent-1', user_id: 'user-1' }])` (or `'architect'` where the fixture says so). The test at line 417 `renders tokens bare for a manual agent, whose client adds its own prefix` keeps its assertions; rename it `renders tokens bare`. The test at line 438 `renders {{skill:...}} into an instruction naming the fetch tool` must expect `skills_get` bare.

`backend/src/integration/memory.test.ts` (lines 1726, 1992) and `backend/src/mcp/scoped-services.e2e.test.ts` (lines 295-303): match `sql.includes('gateway_token = ?')` and return `{ id: AGENT_ID, user_id: USER_ID }`; change `SELECT gateway_token FROM deployed_agents` to `SELECT gateway_token FROM agents`; delete the `JOIN deployed_agents da` line in scoped-services and add `if (sql.includes('SELECT user_id FROM agents WHERE id = ?')) return rows([{ user_id: USER }]);`. In both files, make sure the `vi.mock('../services/billing.js')` factory exports `checkUsageGate: vi.fn().mockResolvedValue({ allowed: true })` and no `checkDeployGate`.

`backend/src/api/permissions-instance-routes.test.ts:325`: the assertion that no `deployed_agents` query ran becomes an assertion that no `autoRedeployIfDeployed`-shaped query ran; since that helper is deleted in Task 6, simply delete this `expect` line and its comment.

- [ ] **Step 2: Run the six suites to see them fail**

```bash
cd backend && npx vitest run src/api/mcp-auth-routes.test.ts src/api/agent-admin-routes.test.ts src/api/skills-routes.test.ts src/integration/memory.test.ts src/mcp/scoped-services.e2e.test.ts src/api/permissions-instance-routes.test.ts
```

Expected: FAIL (fixtures no longer match the SQL the routes issue).

- [ ] **Step 3: `authenticateMcp`**

Replace the unauthenticated branch (lines 3475-3485) with:

```ts
    const row = await client.execute({
      sql: `SELECT allow_unauthenticated FROM agents WHERE id = ? LIMIT 1`,
      args: [agentId],
    });
    // Unknown agent: leave it to handleMCPRequest, which owns the
    // agent-not-found response shape.
    if (row.rows.length === 0) return { ok: true, principal: null };
    if (row.rows[0].allow_unauthenticated !== true) return { ok: false, reason: 'token_required' };
    return { ok: true, principal: null };
```

Update the doc comment above it: there is no longer a "no deployment row" case.

- [ ] **Step 4: `PUT /api/agents/:id/mcp-unauthenticated`**

Replace the UPDATE (lines 432-436) with:

```ts
    await client.execute({
      sql: `UPDATE agents SET allow_unauthenticated = ?, updated_at = ? WHERE id = ?`,
      args: [body.allowed, new Date().toISOString(), request.params.id],
    });
```

- [ ] **Step 5: `POST /api/agents` absorbs `create-manual`**

Replace the handler body (lines 546-572) with:

```ts
  app.post('/api/agents', async (request, reply) => {
    const parsed = CreateAgentSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: { code: 'VALIDATION_ERROR', message: parsed.error.message } });
    }

    const userId = getUserId(request);
    const id = nanoid();
    const gatewayToken = nanoid(32);
    const now = new Date().toISOString();

    // Born closed: the MCP URL alone does not reach this agent; a client has
    // to authenticate (OAuth) first. The owner can open it from the dashboard.
    await client.execute({
      sql: `INSERT INTO agents (id, user_id, name, description, policy_id, status, gateway_token, allow_unauthenticated, created_at, updated_at)
            VALUES (?, ?, ?, ?, ?, 'active', ?, false, ?, ?)`,
      args: [id, userId, parsed.data.name, parsed.data.description ?? null, parsed.data.policyId ?? null, gatewayToken, now, now],
    });

    await auditLogger.logAgentEvent(id, 'created', { name: parsed.data.name });
    getPostHog()?.capture({ distinctId: userId, event: 'agent_created', properties: { source: 'dashboard' } });
    await enableDefaultServices(id);

    return reply.code(201).send({
      data: {
        id,
        name: parsed.data.name,
        description: parsed.data.description ?? null,
        status: 'active',
        acceptsUnauthenticatedMcp: false,
      },
    });
  });
```

Delete `POST /api/agents/create-manual` (lines 3759-3815, including its comment block).

- [ ] **Step 6: Agents list and detail**

`GET /api/agents` (283-320): remove the `deployResult` query and the `telegramBotUsername` / `deploymentStatus` fields. The `Promise.all` becomes a single credentials query per agent.

`GET /api/agents/:id/detail` (4463-4550): replace the body after the 404 check with:

```ts
    const agent = agentResult.rows[0];
    if ((agent.user_id as string) !== getUserId(request)) {
      return reply.code(404).send({ error: { code: 'NOT_FOUND', message: 'Agent not found' } });
    }
    return {
      data: {
        id: agent.id,
        name: agent.name,
        description: agent.description,
        status: agent.status,
        createdAt: agent.created_at,
        mcpUrl: `${config.dashboardUrl}/mcp/${agent.id as string}`,
        allowUnauthenticated: agent.allow_unauthenticated === true,
      },
    };
```

- [ ] **Step 7: `destroyAgentCompletely`**

Delete the Fly destroy loop and the `DELETE FROM deployed_agents` statement (lines 637-655). The function starts with `mcpProxy.disconnectAgent(id)` and continues with the `agent_tool_permissions` delete.

- [ ] **Step 8: `resolveAgentFromGatewayToken` and the skills routes**

Replace lines 5940-5968 with:

```ts
  async function resolveAgentFromGatewayToken(
    request: any
  ): Promise<{ agentId: string; userId: string } | null> {
    const agentSecret = request.headers['x-reins-agent-secret'] as string | undefined;
    if (!agentSecret) return null;

    const result = await client.execute({
      sql: `SELECT id, user_id FROM agents WHERE gateway_token = ? LIMIT 1`,
      args: [agentSecret],
    });
    if (result.rows.length === 0) return null;
    return { agentId: result.rows[0].id as string, userId: result.rows[0].user_id as string };
  }
```

At lines 7033, 7068, 7150 change every `resolveSkillTokens(resolveToolTokens(x, agent.runtime, agent.serverName), agent.runtime, agent.serverName)` to `resolveSkillTokens(resolveToolTokens(x))`. Remove the comment at 7145-7147 about runtimes.

- [ ] **Step 9: `/api/admin/agents` and the helm-admin routes**

`GET /api/admin/agents` (5664-5694): the query becomes

```sql
SELECT a.id, a.name, a.status, a.user_id, a.allow_unauthenticated, a.created_at, a.updated_at
FROM agents a
ORDER BY a.name
```

`GET /api/agent-admin/agents` (7258-7296): drop the lateral join; select `a.id, a.name, a.description, a.status, a.created_at FROM agents a WHERE a.user_id = ? ORDER BY a.name`; drop `runtime`, `isManual`, `deploymentStatus` from the mapped output.

`POST /api/agent-admin/agents` (7312-7365): replace the two inserts with the single `agents` insert from Step 5 (same columns, `agent.userId` as owner), delete `deploymentId`, and rewrite the doc comment to say the agent is born closed because `allow_unauthenticated` defaults false on `agents`.

- [ ] **Step 10: `permissions.ts`**

Line 9: remove `deployedAgents` from the schema import. Replace `listOpenMcpAgents` (376-393) with:

```ts
export async function listOpenMcpAgents(userId: string): Promise<OpenMcpAgent[]> {
  const result = await client.execute({
    sql: `SELECT id, name FROM agents
          WHERE user_id = ? AND allow_unauthenticated = true
          ORDER BY name`,
    args: [userId],
  });
  return result.rows.map((row) => ({ id: row.id as string, name: row.name as string }));
}
```

Update its doc comment: it mirrors `authenticateMcp`, which now reads `agents.allow_unauthenticated`. In `getAgentPermissions` (1836-1850) delete the `deployments` query and the `telegramBotUsername` field; remove it from `AgentPermissionsResponse` wherever that type is declared (grep `telegramBotUsername` in `backend/src` and `shared/src`).

- [ ] **Step 11: Sweep**

```bash
grep -n "deployed_agents" backend/src/api/routes.ts backend/src/services/permissions.ts | grep -v "create-and-deploy\|/deploy\|/models\|/backups\|/onboarding\|webhooks\|topic-prompts\|logs\|management-url\|settings\|soul\|start\|stop\|restart\|redeploy\|usage\|spend"
```

Expected: only lines inside routes that Task 6 deletes. Anything else, fix now.

- [ ] **Step 12: Run the six suites**

```bash
cd backend && npx vitest run src/api/mcp-auth-routes.test.ts src/api/agent-admin-routes.test.ts src/api/skills-routes.test.ts src/integration/memory.test.ts src/mcp/scoped-services.e2e.test.ts src/api/permissions-instance-routes.test.ts
```

Expected: PASS. (Typecheck still fails until Task 6 removes the runtime routes and their imports.)

- [ ] **Step 13: Commit**

```bash
git add backend/src/api/routes.ts backend/src/services/permissions.ts backend/src/api/*.test.ts backend/src/integration/memory.test.ts backend/src/mcp/scoped-services.e2e.test.ts
git commit -m "refactor(api): MCP identity routes read and write agents directly"
```

---

### Task 6: Delete the runtime routes, services, and startup work

**Files:**
- Delete: `backend/src/providers/fly.ts`, `backend/src/providers/index.ts`, `backend/src/providers/fly.test.ts`, `backend/src/providers/provider.test.ts`, `backend/src/services/fly-lifecycle-monitor.ts`, `backend/src/services/agent-bot-relay.ts`, `backend/src/services/model-router.ts`, `backend/src/services/model-router.test.ts`, `backend/src/services/agent-backup.ts`, `backend/src/services/agent-backup.test.ts`, `backend/src/services/spend.ts`, `backend/src/services/spend.test.ts`, `backend/src/services/dream.ts`, `backend/src/services/dream.test.ts`, `backend/src/integration/user-journey.test.ts`, `backend/src/integration/user-journey-shared-bot.test.ts`
- Modify: `backend/src/api/routes.ts`, `backend/src/index.ts`, `backend/src/services/token-monitor.ts`, `backend/src/services/billing.ts` (+ test), `backend/src/notifications/handlers.ts:45`, `backend/src/notifications/telegram.ts:733-768`, `backend/src/notifications/approval-format.ts:113-114, 807-814`, `backend/src/services/email.ts:51-56`, `backend/src/config/index.ts`, `config/development.yaml`, `config/production.yaml`, and the eight route/integration test suites that mock deleted modules

**Interfaces:**
- Produces: `billing.ts` exports `getSubscription`, `upsertSubscription`, `checkUsageGate`, `applyGracePeriod`, `clearGrace`, `cancelSubscription` only; `token-monitor.ts` exports `startTokenMonitor`, `stopTokenMonitor` only; `GET /api/config/public` returns `{}`.

- [ ] **Step 1: Delete the route blocks in `routes.ts`**

Delete each range from the `app.<verb>(` line (including any comment block and `// ────` banner immediately above it) through the closing `});`. Use the anchors below, re-grepping each path after every deletion because line numbers shift:

| Route | Anchor to grep |
|---|---|
| `GET /api/initial-prompt-templates` | `'/api/initial-prompt-templates'` |
| `GET/PUT/DELETE /api/agents/:id/models` | `'/api/agents/:id/models'` |
| `POST /api/onboarding/oauth/google/link` | `'/api/onboarding/oauth/google/link'` |
| `POST /api/onboarding/auth/setup-link` | `'/api/onboarding/auth/setup-link'` |
| `GET /api/onboarding/deployments/:deploymentId/status` | `'/api/onboarding/deployments/` |
| `DELETE /api/onboarding/users/:telegramUserId/credentials` | `'/api/onboarding/users/` |
| `function classifyProvisionError`, `type ReauthProvider`, `async function createReauthApproval` | those names (lines 3659-3757) |
| `POST /api/agents/create-and-deploy` | `'/api/agents/create-and-deploy'` |
| `POST /api/agents/:id/deploy` | `'/api/agents/:id/deploy'` (the POST) |
| `GET /api/agents/:id/deployment` | `'/api/agents/:id/deployment'` |
| `PUT /api/agents/:id/soul` | `'/api/agents/:id/soul'` |
| `POST .../start`, `/stop`, `/restart`, `/redeploy` | each path |
| `PUT /api/agents/:id/settings` | `'/api/agents/:id/settings'` |
| `GET/PUT /api/agents/:id/topic-prompts` | `'/api/agents/:id/topic-prompts'` and the `// ─── Topic Prompts` banner |
| `DELETE /api/agents/:id/deploy` | the DELETE |
| `GET .../logs`, `.../logs/stream`, `.../management-url` | each path |
| `POST /api/auth/openai-device` | `'/api/auth/openai-device'` |
| `POST /api/webhooks/usage` | `'/api/webhooks/usage'` |
| `POST /api/agents/:agentId/spend/reset` | `'/spend/reset'` |
| `async function getActiveDeployment`, `async function autoRedeployIfDeployed` | those names |
| `/api/backups` (4 routes) | `'/api/backups` |
| `POST /telegram` | `app.post('/telegram'` |
| `POST /api/webhooks/shared-bot` | `'/api/webhooks/shared-bot'` and the `sharedBotNoAgentLastSent` map |
| `POST /api/webhooks/agent-bot/:deploymentId` | `'/api/webhooks/agent-bot/` |
| `function validateOnboardingApiKey` | that name |

Then delete the three `autoRedeployIfDeployed(...)` call sites at lines 1197, 1370, 1386 (each is a `.catch(...)` chained call; remove the whole statement and any `// redeploy` comment above it).

Change `GET /api/config/public` to `return reply.send({});`.

- [ ] **Step 2: Fix the imports in `routes.ts`**

Delete these import lines: `import { ... } from '../services/spend.js';` (74-83), `import { performBackup, ... } from '../services/agent-backup.js';` (84), `import { isCodexTokenExpired } from '../services/token-monitor.js';` (86), `import { forwardToOpenclaw, handleMyChatMember } from '../services/agent-bot-relay.js';` (87), `import * as provider from '../providers/index.js';` (123), `import { listModelConfigs, upsertModelConfig, deleteModelConfig } from '../services/model-router.js';` (133). From the `../services/billing.js` import remove `checkDeployGate`. From the `@reins/shared` import remove `LEGACY_MCP_SERVER_NAME`, `deploymentRuntime`, `type AgentRuntime`. Then:

```bash
cd backend && npx tsc --noEmit -p . 2>&1 | grep "routes.ts" | head -40
```

Fix every remaining unused or missing symbol the compiler reports in `routes.ts`.

- [ ] **Step 3: Delete the service files**

```bash
git rm -r backend/src/providers
git rm backend/src/services/fly-lifecycle-monitor.ts backend/src/services/agent-bot-relay.ts \
  backend/src/services/model-router.ts backend/src/services/model-router.test.ts \
  backend/src/services/agent-backup.ts backend/src/services/agent-backup.test.ts \
  backend/src/services/spend.ts backend/src/services/spend.test.ts \
  backend/src/services/dream.ts backend/src/services/dream.test.ts \
  backend/src/integration/user-journey.test.ts backend/src/integration/user-journey-shared-bot.test.ts
```

- [ ] **Step 4: Trim `token-monitor.ts`**

Delete `runTokenExpiryCheck`, `runHealthCheck`, `validateMinimaxKey`, `runMinimaxKeyCheck`, `isCodexTokenExpired`, the `provider` import (line 27), the timers `tokenCheckTimer`, `healthCheckTimer`, `minimaxCheckTimer`, and their interval constants. Delete `decodeJwtExpMs` and `isExpiredOrExpiringSoon` only if `runOAuthExpiryCheck` does not call them (check with grep). Replace `startTokenMonitor` / `stopTokenMonitor` with:

```ts
export function startTokenMonitor(): void {
  runOAuthExpiryCheck().catch(console.error);
  oauthCheckTimer = setInterval(() => {
    runOAuthExpiryCheck().catch(console.error);
  }, OAUTH_CHECK_INTERVAL_MS);
  console.info('[token-monitor] Started (oauth check: 30min)');
}

export function stopTokenMonitor(): void {
  if (oauthCheckTimer) { clearInterval(oauthCheckTimer); oauthCheckTimer = null; }
}
```

Rewrite the file's header comment to describe only the OAuth credential-expiry loop.

- [ ] **Step 5: Trim `billing.ts` and its test**

Delete `checkDeployGate`, `softStopLapsedAccounts`, and `startLapseCron` (lines 97-118 and 163-210). In `billing.test.ts` delete `describe('checkDeployGate', ...)` (176-218) and `describe('softStopLapsedAccounts', ...)` (340-end), and remove those two names from the import at the top.

- [ ] **Step 6: Notifications and email**

`backend/src/notifications/handlers.ts:41-50`: delete the `if (approval.tool === 'telegram_group' && approval.status === 'approved') { ... }` block.

`backend/src/notifications/telegram.ts:733-768` (`resolveAdminTargetSummary`): change the query to `SELECT a.id, a.name, a.status FROM agents a WHERE a.id = ? LIMIT 1` and drop `runtime` and `deploymentStatus` from the returned object.

`backend/src/notifications/approval-format.ts`: remove `runtime` and `deploymentStatus` from `AdminTargetSummary` (113-114); delete the `<b>Runtime:</b>` line (807-808); change the sentence at 814 to `\n<i>This cannot be undone. All access is removed. Notes it saved to your memory are kept.</i>`. Run `cd backend && npx vitest run src/notifications` and fix any expectation that quoted the old sentence.

`backend/src/services/email.ts:51-56`: delete the `'anthropic'`, `'openai-codex'`, `'openai'`, `'minimax'`, `'fly'`, `'docker'` entries of `providerLabel`.

- [ ] **Step 7: Rewrite `backend/src/index.ts`**

Replace the file with:

```ts
import { buildApp } from './app.js';
import { config } from './config/index.js';
import { initializeDatabase } from './db/index.js';
import { approvalQueue } from './approvals/queue.js';
import { initializeNativeServers, shutdownNativeServers } from './mcp/init-servers.js';
import { startTokenRefreshLoop, stopTokenRefreshLoop } from './credentials/vault.js';
import { startTokenMonitor, stopTokenMonitor } from './services/token-monitor.js';
import { startUploadGcCron } from './services/agent-uploads.js';
import { telegramNotifier } from './notifications/telegram.js';
import { initializeNotificationHandlers } from './notifications/handlers.js';
import { shutdownPostHog } from './analytics/posthog.js';

const app = await buildApp();

app.log.info('Initializing database...');
await initializeDatabase();
app.log.info('Database initialized');

app.log.info('Initializing native MCP servers...');
await initializeNativeServers();
app.log.info('Native MCP servers initialized');

// WebSocket endpoint for real-time updates
app.register(async (fastify) => {
  fastify.get('/ws', { websocket: true }, (connection) => {
    app.log.info('WebSocket client connected');
    const ws = connection.socket;

    const onApprovalRequest = (approval: unknown) => {
      ws.send(JSON.stringify({ type: 'approval_request', data: approval }));
    };
    const onApprovalResolved = (approval: unknown) => {
      ws.send(JSON.stringify({ type: 'approval_resolved', data: approval }));
    };

    approvalQueue.on('request', onApprovalRequest);
    approvalQueue.on('resolved', onApprovalResolved);

    ws.on('close', () => {
      app.log.info('WebSocket client disconnected');
      approvalQueue.off('request', onApprovalRequest);
      approvalQueue.off('resolved', onApprovalResolved);
    });
  });
});

// Background OAuth token refresh (every 45 minutes)
startTokenRefreshLoop();
app.log.info('Token refresh loop started');

// OAuth credential expiry monitor
startTokenMonitor();
app.log.info('Token monitor started');

// Agent-upload GC (purges expired attachment blobs hourly)
startUploadGcCron();
app.log.info('Agent upload GC started');

// Wire approval queue events to notification services
initializeNotificationHandlers();

// Approvals bot (non-fatal if not configured or fails)
if (telegramNotifier.isConfigured()) {
  telegramNotifier.init()
    .then(() => telegramNotifier.setupWebhook())
    .catch((err) => app.log.error('Telegram initialization failed:', err));
  app.log.info('Telegram bot initialization started');
}

const shutdown = async () => {
  app.log.info('Shutting down...');
  stopTokenRefreshLoop();
  stopTokenMonitor();
  await shutdownNativeServers();
  await shutdownPostHog();
  await app.close();
  process.exit(0);
};

process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);

try {
  await app.listen({ port: config.port, host: config.host });
  app.log.info(`Helm backend running at http://${config.host}:${config.port}`);
  app.log.info('Press Ctrl+C to stop');
} catch (err) {
  app.log.error(err);
  process.exit(1);
}
```

- [ ] **Step 8: Config**

`backend/src/config/index.ts`: in `YamlConfig` delete the `fly?` and `onboarding?` members. In `ConfigSchema` delete `flyOrg`, `openclawApp`, `openclawImage`, `hermesImage`, `sharedBotToken`, `sharedBotWebhookSecret`, `onboardingApiKey`, `onboardingBotWebhookUrl`, `onboardingBotWebhookSecret`, `onboardingBotUsername` and their comments. In the `raw` object delete the matching entries. Delete the `FLY_ORG=personal` guard (`const flyOrg = ...` through `process.exit(1); }`).

`config/development.yaml` and `config/production.yaml`: delete the `fly:` block and the `onboarding:` block, including their comments. Keep `server`, `urls`, `oauth`, `browser`.

Verify nothing still reads them:

```bash
grep -rn "config\.\(flyOrg\|openclawApp\|openclawImage\|hermesImage\|sharedBotToken\|sharedBotWebhookSecret\|onboarding[A-Za-z]*\)" backend/src
```

Expected: no output.

- [ ] **Step 9: Remove stale mocks from the surviving suites**

In each of `backend/src/api/agent-admin-routes.test.ts`, `approvals-routes.test.ts`, `mcp-auth-routes.test.ts`, `permissions-drive-routes.test.ts`, `permissions-instance-routes.test.ts`, `skills-routes.test.ts`, `backend/src/integration/memory.test.ts`, `backend/src/mcp/scoped-services.e2e.test.ts`: delete the `vi.mock(...)` blocks for `'../providers/index.js'`, `'../services/agent-bot-relay.js'`, `'../services/model-router.js'`, `'../services/spend.js'`, `'../services/agent-backup.js'`, and `'../services/token-monitor.js'`. Keep `'../services/agent-uploads.js'`.

- [ ] **Step 10: Typecheck and run the backend suite**

```bash
npm run typecheck && cd backend && npx vitest run
```

Expected: typecheck clean, all backend tests pass. Fix anything the compiler flags as unused or missing.

- [ ] **Step 11: Commit**

```bash
git add -A backend config
git commit -m "refactor(backend): remove the Fly agent runtime, onboarding API, spend cap, backups, and model router"
```

---

### Task 7: Remove the onboarding package and its CI wiring

**Files:**
- Delete: `onboarding/` (whole directory)
- Modify: `package.json`, `.github/workflows/deploy.yml`, `.github/workflows/ci.yml`, `package-lock.json` (regenerated)

- [ ] **Step 1: Delete the package**

```bash
git rm -r onboarding
```

- [ ] **Step 2: Root `package.json`**

Remove `"onboarding"` from `workspaces`. Remove the scripts `dev:onboarding`, `stub:build`, `stub:run`. Then `npm install` to regenerate `package-lock.json`.

- [ ] **Step 3: `deploy.yml`**

Change the job name to `Deploy agenthelm-core` and delete the `Deploy agenthelm-onboarding` step.

- [ ] **Step 4: `ci.yml`**

Delete the whole `build-stub-image` job. In `e2e`: `needs: [unit-tests]`; delete the env entries `REINS_PROVIDER`, `OPENCLAW_IMAGE`, `TEST_TELEGRAM_BOT_TOKEN` and the comment above `BYPASS_BILLING` becomes `# Creating agents sits behind the paid plan gate; BYPASS_BILLING is the hatch the backend ships for tests.`; delete the `Build stub Docker image` step.

- [ ] **Step 5: Verify**

```bash
npm run typecheck && npm test
```

Expected: green.

- [ ] **Step 6: Commit**

```bash
git add -A
git commit -m "chore: remove the Telegram onboarding package and its CI steps"
```

---

### Task 8: Frontend — agent pages become MCP-only

**Files:**
- Delete: `frontend/src/components/DeploymentPanel.tsx`, `LogViewer.tsx`, `LogViewer.test.tsx`, `LogsPanel.tsx`, `ChatModal.tsx`, `CodexDeviceFlow.tsx`, `frontend/src/pages/Backups.tsx`, `frontend/src/pages/Agents.tsx`
- Create: `frontend/src/components/McpAccessSection.tsx`
- Modify: `frontend/src/api/client.ts`, `frontend/src/pages/AgentNew.tsx`, `frontend/src/pages/AgentNew.test.tsx`, `frontend/src/pages/AgentDetail.tsx`, `frontend/src/pages/Permissions.tsx`, `frontend/src/pages/Login.tsx`, `frontend/src/components/ReauthModal.tsx`, `frontend/src/components/ReauthApprovalCard.tsx`, `frontend/src/App.tsx`

**Interfaces:**
- Consumes: `POST /api/agents` and `GET /api/agents/:id/detail` from Task 5; `GET /api/agents/:id/connect-prompt`; `mcpTokens` helpers (unchanged).
- Produces: `agents.create(data) => Promise<{ id: string; name: string; status: string }>`, `agents.getDetail(id) => Promise<AgentDetail>` with `AgentDetail = { id; name; description: string | null; status; createdAt; mcpUrl; allowUnauthenticated }`, `McpAccessSection({ agentId })`.

- [ ] **Step 1: Write the failing wizard test**

Replace `frontend/src/pages/AgentNew.test.tsx` with:

```tsx
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter } from 'react-router-dom';
import AgentNew from './AgentNew';

const mockNavigate = vi.fn();
vi.mock('react-router-dom', async (importOriginal) => {
  const actual = await importOriginal<typeof import('react-router-dom')>();
  return { ...actual, useNavigate: () => mockNavigate };
});

vi.mock('../api/client', () => ({
  agents: { create: vi.fn() },
}));

import { agents } from '../api/client';

function createWrapper() {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  return ({ children }: { children: React.ReactNode }) => (
    <MemoryRouter>
      <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
    </MemoryRouter>
  );
}

describe('AgentNew', () => {
  beforeEach(() => vi.clearAllMocks());

  it('creates the agent from name and description and opens its detail page', async () => {
    vi.mocked(agents.create).mockResolvedValue({ id: 'agent-123', name: 'Mine', status: 'active' });
    render(<AgentNew />, { wrapper: createWrapper() });

    fireEvent.change(screen.getByPlaceholderText('e.g. My Assistant'), { target: { value: 'Mine' } });
    fireEvent.change(screen.getByPlaceholderText('What does this agent do?'), { target: { value: 'Work mail' } });
    fireEvent.click(screen.getByRole('button', { name: 'Create Agent' }));

    await waitFor(() => {
      expect(agents.create).toHaveBeenCalledWith({ name: 'Mine', description: 'Work mail' });
      expect(mockNavigate).toHaveBeenCalledWith('/agents/agent-123');
    });
  });

  it('disables Create until a name is entered', () => {
    render(<AgentNew />, { wrapper: createWrapper() });
    expect(screen.getByRole('button', { name: 'Create Agent' })).toBeDisabled();
  });

  it('shows the API error', async () => {
    vi.mocked(agents.create).mockRejectedValue(new Error('boom'));
    render(<AgentNew />, { wrapper: createWrapper() });
    fireEvent.change(screen.getByPlaceholderText('e.g. My Assistant'), { target: { value: 'X' } });
    fireEvent.click(screen.getByRole('button', { name: 'Create Agent' }));
    expect(await screen.findByText('boom')).toBeInTheDocument();
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

```bash
cd frontend && npx vitest run src/pages/AgentNew.test.tsx
```

Expected: FAIL (the wizard still shows the type picker and calls `createManual`).

- [ ] **Step 3: `api/client.ts`**

- Delete `DeployConfig`, `DeploymentInfo`, `CreateAndDeployData`, `TelegramGroup`, `TopicPrompt` (check `TopicPrompt`/`TelegramGroup` have no other importers first: `grep -rn "TelegramGroup\|TopicPrompt" frontend/src`), the `AgentDetail.deployment` block, the `backups` object and `BackupMetadata`/`RestoreResult` types, the `models` object and `ModelConfig` type, the `openaiAuth` object (lines 241-256).
- Replace `AgentDetail` with:

```ts
export interface AgentDetail {
  id: string;
  name: string;
  description: string | null;
  status: string;
  createdAt: string;
  mcpUrl: string;
  allowUnauthenticated: boolean;
}
```

- In `agents`, delete `deploy`, `getDeployment`, `startDeployment`, `stopDeployment`, `restartDeployment`, `redeployAgent`, `destroyDeployment`, `createAndDeploy`, `createManual`, `getLogs`, `updateSoul`, `getManagementUrl`, `logsStreamUrl`, `updateSettings`. Change `create` to:

```ts
  create: (data: { name: string; description?: string }) =>
    request<{ id: string; name: string; status: string }>('/agents', { method: 'POST', body: JSON.stringify(data) }),
```

- Remove `telegramBotUsername` from the two types at lines 129 and 603. Change `config.getPublic` to return `Record<string, never>` (or `{}`), whichever the existing helper's generic accepts.

- [ ] **Step 4: Extract `McpAccessSection`**

Create `frontend/src/components/McpAccessSection.tsx` containing the `McpAccessSection` function from `DeploymentPanel.tsx` lines 47-201 verbatim, exported as default, with these imports at the top:

```tsx
import { useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { ShieldAlert, ShieldCheck } from 'lucide-react';
import { mcpTokens, ApiError } from '../api/client';
```

Then `git rm` the seven files listed under Delete.

- [ ] **Step 5: Rewrite `AgentNew.tsx`**

Replace the file with:

```tsx
import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useMutation } from '@tanstack/react-query';
import { ArrowLeft, Loader2 } from 'lucide-react';
import { agents } from '../api/client';

export default function AgentNew() {
  const navigate = useNavigate();
  const [name, setName] = useState('');
  const [description, setDescription] = useState('');
  const [error, setError] = useState('');

  const createMutation = useMutation({
    mutationFn: () => agents.create({ name: name.trim(), description: description.trim() || undefined }),
    onSuccess: (created) => navigate(`/agents/${created.id}`),
    onError: (err: unknown) => setError(err instanceof Error ? err.message : 'Failed to create agent'),
  });

  const canCreate = name.trim() !== '' && !createMutation.isPending;

  return (
    <div className="p-4 sm:p-8 max-w-2xl">
      <div className="flex items-center gap-4 mb-8">
        <button
          onClick={() => navigate('/agents')}
          className="p-2 text-gray-400 hover:text-reins-navy hover:bg-gray-100 rounded-lg transition-all"
          aria-label="Back to agents"
        >
          <ArrowLeft className="w-5 h-5" />
        </button>
        <div>
          <h1 className="text-2xl font-semibold text-reins-navy tracking-tight">Create Agent</h1>
          <p className="text-gray-400 text-sm mt-0.5">
            An MCP endpoint for Claude, Claude Code, Cowork, or any MCP client
          </p>
        </div>
      </div>

      <section className="bg-white rounded-xl border border-gray-100 p-6 space-y-4">
        <h2 className="text-sm font-semibold text-gray-500 uppercase tracking-wider">Basics</h2>
        <div>
          <label className="block text-xs font-medium text-gray-500 uppercase tracking-wider mb-1.5">
            Agent Name *
          </label>
          <input
            type="text"
            value={name}
            onChange={(e) => setName(e.target.value)}
            className="w-full border border-gray-200 rounded-lg px-3 py-2.5 text-sm focus:ring-2 focus:ring-trust-blue/20 focus:border-trust-blue transition-all outline-none"
            placeholder="e.g. My Assistant"
            autoFocus
          />
        </div>
        <div>
          <label className="block text-xs font-medium text-gray-500 uppercase tracking-wider mb-1.5">
            Description
          </label>
          <input
            type="text"
            value={description}
            onChange={(e) => setDescription(e.target.value)}
            className="w-full border border-gray-200 rounded-lg px-3 py-2.5 text-sm focus:ring-2 focus:ring-trust-blue/20 focus:border-trust-blue transition-all outline-none"
            placeholder="What does this agent do?"
          />
        </div>
        <ul className="text-sm text-gray-500 space-y-1 list-disc list-inside pt-2">
          <li>You get an MCP endpoint URL to paste into your client</li>
          <li>Helm enforces policies and manages OAuth credentials</li>
          <li>Add accounts, permissions, memory scopes, and skills after creation</li>
        </ul>
      </section>

      {error && (
        <div className="mt-4 p-3 bg-red-50 border border-red-100 rounded-lg text-sm text-red-700">{error}</div>
      )}

      <div className="flex items-center justify-between mt-8">
        <button
          type="button"
          onClick={() => navigate('/agents')}
          className="px-5 py-2.5 text-sm text-gray-500 hover:text-gray-700 transition-colors"
        >
          Cancel
        </button>
        <button
          type="button"
          onClick={() => { setError(''); createMutation.mutate(); }}
          disabled={!canCreate}
          className="flex items-center gap-2 px-6 py-2.5 bg-trust-blue text-white rounded-xl hover:bg-blue-600 transition-colors disabled:opacity-50 text-sm font-medium shadow-sm shadow-trust-blue/20"
        >
          {createMutation.isPending && <Loader2 className="w-4 h-4 animate-spin" />}
          Create Agent
        </button>
      </div>
    </div>
  );
}
```

- [ ] **Step 6: Rewrite `AgentDetail.tsx`**

Replace the file with:

```tsx
import { useState } from 'react';
import { useParams, useNavigate, Link } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { ArrowLeft, Copy, Check } from 'lucide-react';
import { agents, type AgentDetail as AgentDetailType } from '../api/client';
import McpAccessSection from '../components/McpAccessSection';

export default function AgentDetail() {
  const { id } = useParams<{ id: string }>();
  const navigate = useNavigate();
  const [copiedKey, setCopiedKey] = useState<string | null>(null);

  const { data: agent, isLoading } = useQuery<AgentDetailType>({
    queryKey: ['agent-detail', id],
    queryFn: () => agents.getDetail(id!),
    enabled: !!id,
  });

  const connectPrompt = useQuery({
    queryKey: ['connect-prompt', id],
    queryFn: () => agents.getConnectPrompt(id!),
    enabled: !!id,
    retry: false,
  });

  const copy = async (text: string, key: string) => {
    await navigator.clipboard.writeText(text);
    setCopiedKey(key);
    setTimeout(() => setCopiedKey(null), 2000);
  };

  if (isLoading) {
    return (
      <div className="p-4 sm:p-8 flex items-center justify-center min-h-[50vh]">
        <div className="flex items-center gap-3 text-gray-400">
          <div className="animate-spin rounded-full h-5 w-5 border-2 border-gray-300 border-t-trust-blue" />
          <span className="text-sm">Loading agent...</span>
        </div>
      </div>
    );
  }

  if (!agent) {
    return (
      <div className="p-4 sm:p-8">
        <p className="text-gray-500">Agent not found.</p>
        <Link to="/agents" className="text-trust-blue hover:underline text-sm mt-2 inline-block">
          Back to agents
        </Link>
      </div>
    );
  }

  const CopyButton = ({ text, k, dark = false }: { text: string; k: string; dark?: boolean }) => (
    <button
      onClick={() => copy(text, k)}
      className={dark ? 'absolute top-2 right-2 text-gray-400 hover:text-gray-200 transition-colors' : 'shrink-0 text-gray-400 hover:text-gray-600 transition-colors'}
      aria-label="Copy"
    >
      {copiedKey === k ? <Check className={`w-4 h-4 ${dark ? 'text-emerald-400' : 'text-emerald-500'}`} /> : <Copy className="w-4 h-4" />}
    </button>
  );

  return (
    <div className="p-4 sm:p-8 max-w-4xl">
      <div className="flex items-center gap-4 mb-8">
        <button
          onClick={() => navigate('/agents')}
          className="p-2 text-gray-400 hover:text-reins-navy hover:bg-gray-100 rounded-lg transition-all"
          aria-label="Back to agents"
        >
          <ArrowLeft className="w-5 h-5" />
        </button>
        <div>
          <h1 className="text-2xl font-semibold text-reins-navy tracking-tight">{agent.name}</h1>
          {agent.description && <p className="text-gray-400 text-sm mt-0.5">{agent.description}</p>}
        </div>
      </div>

      <div className="space-y-6">
        <div className="bg-white rounded-xl border border-gray-100 p-5 space-y-4">
          <h2 className="text-sm font-semibold text-gray-500 uppercase tracking-wider">Connect</h2>
          <div>
            <label className="block text-xs font-medium text-gray-400 uppercase tracking-wider mb-1.5">MCP Endpoint URL</label>
            <div className="flex items-center gap-2 p-3 bg-gray-50 rounded-lg font-mono text-xs text-gray-700 border border-gray-200">
              <span className="flex-1 break-all">{agent.mcpUrl}</span>
              <CopyButton text={agent.mcpUrl} k="url" />
            </div>
          </div>

          <McpAccessSection agentId={agent.id} />

          {connectPrompt.data && (
            <div>
              <label className="block text-xs font-medium text-gray-400 uppercase tracking-wider mb-1.5">Claude Code / Claude Desktop</label>
              <div className="relative">
                <pre className="p-3 bg-gray-900 text-gray-100 rounded-lg text-xs overflow-x-auto leading-relaxed">
                  {JSON.stringify(connectPrompt.data.claudeCodeConfig, null, 2)}
                </pre>
                <CopyButton text={JSON.stringify(connectPrompt.data.claudeCodeConfig, null, 2)} k="claude" dark />
              </div>
            </div>
          )}
        </div>

        <div className="bg-white rounded-xl border border-gray-100 p-5">
          <p className="text-sm text-gray-500">
            Accounts, permissions, memory scopes, and skills for this agent are managed on the{' '}
            <Link to="/agents" className="text-trust-blue hover:underline">Agents</Link> page.
          </p>
        </div>
      </div>
    </div>
  );
}
```

- [ ] **Step 7: `Permissions.tsx`, `App.tsx`, `Login.tsx`, reauth components**

`Permissions.tsx`: delete the `DeploymentPanel` import (43), the `deployAgentId` state (123), the Deploy button block (411-418) and the `Rocket` icon import if now unused, the Deploy Modal block (589-596), and the `telegramBotUsername` link block (390-402). Change the copy at 944 to `Open each one's detail page and turn off unauthenticated access.`

`App.tsx`: delete the `Backups` import (30), the `/backups` nav item (48) and the `Database` icon import if unused, and the `/backups` route (257).

`Login.tsx:11`: `not_authorized: 'This Google account is not set up on Helm. Ask your administrator for an invite.',`

`components/ReauthModal.tsx`: delete the `'openai-codex'` label (10), the `CodexDeviceFlow` import and the two provider branches at 163-175 (`openai-codex`, `minimax`). `components/ReauthApprovalCard.tsx:5`: delete the `'openai-codex'` label.

- [ ] **Step 8: Run frontend tests and typecheck**

```bash
cd frontend && npx vitest run && cd .. && npm run typecheck
```

Expected: PASS and clean. Fix any leftover imports the compiler names (`Rocket`, `Database`, `TelegramGroup`, etc.).

- [ ] **Step 9: Commit**

```bash
git add -A frontend
git commit -m "feat(frontend): agents are MCP endpoints; drop deployment, models, backups, and console UI"
```

---

### Task 9: Drop the runtime tables

**Files:**
- Modify: `backend/src/db/index.ts` (`spend_records` 209-229 and 231-232; `deployed_agents` 510-545, 547-560, 562-580, 616-670 and 776-786; `initial_prompt_templates` 794-810 and the seed at 1442; `agent_model_configs` 1228-1243)
- Modify: `backend/src/db/schema.ts` (`spendRecords` 109-120, `deployedAgents` 369-405, `agentModelConfigs` 421-431)

- [ ] **Step 1: Remove the DDL**

Delete every `CREATE TABLE IF NOT EXISTS`, `CREATE INDEX`, and `ALTER TABLE ... ADD COLUMN` statement (with its `DO $$ ... $$` wrapper and comments) for `deployed_agents`, `spend_records`, `initial_prompt_templates`, and `agent_model_configs`, plus the `initial_prompt_templates` seed `INSERT`. Keep the two `ALTER TABLE agents ADD COLUMN` statements and the `migrateDeployedAgents(client)` call from Task 2; move them to just after the `agents` table's `user_id` migration (around line 108) so they run before anything that references the new columns.

After the `migrateDeployedAgents(client)` call add:

```ts
  // Runtime-era tables. The fold above has already read deployed_agents.
  await sql`DROP TABLE IF EXISTS agent_model_configs`;
  await sql`DROP TABLE IF EXISTS initial_prompt_templates`;
  await sql`DROP TABLE IF EXISTS spend_records`;
  await sql`DROP TABLE IF EXISTS deployed_agents`;
```

- [ ] **Step 2: Remove the Drizzle mirrors**

Delete `spendRecords`, `deployedAgents`, and `agentModelConfigs` from `schema.ts`. Then:

```bash
grep -rn "deployedAgents\|spendRecords\|agentModelConfigs\|deployed_agents\|spend_records\|initial_prompt_templates\|agent_model_configs" backend/src servers/src shared/src frontend/src e2e
```

Expected: only `backend/src/db/migrate-deployed-agents.ts`, its test, and the DROP statements.

- [ ] **Step 3: Verify**

```bash
npm run typecheck && cd backend && npx vitest run
```

Expected: green.

- [ ] **Step 4: Commit**

```bash
git add backend/src/db
git commit -m "feat(db): drop deployed_agents, spend_records, initial_prompt_templates, agent_model_configs"
```

---

### Task 10: Infrastructure, scripts, skills, and docs

**Files:**
- Delete: `docker/`, `shared/BOOTSTRAP.md`, `admin/`, `scripts/build-agent-image.sh`, `scripts/check-token-scopes.mjs`, `scripts/recreate-missing-agents.mjs`, `scripts/run-sandbox-tests.sh`, `scripts/check-local-env.sh`, `tests/image-test/`, `tests/integration/`, `.claude/skills/image-test/`, `.claude/skills/integration-test/`, `.claude/skills/redeploy-agent/`, `.claude/skills/onboarding-flow-test/`, `docs/specs/ONBOARDING_BOT_SPEC.md`, `docs/specs/telegram-groups-topics.md`, `docs/ops/ADMIN_TOOLS.md`, `docs/ops/ADMIN_PROJECT_HANDOVER.md`, `docs/ops/UPDATE_API_KEY.md`, `docs/TELEGRAM_AGENTS.md`
- Modify: `CLAUDE.md`, `TESTING.md`, `README.md`, `docs/MEMORY.md`, `docs/architecture/MCP_TOOL_INJECTION.md`, `docs/ops/LOCAL_DEV_SETUP.md`, `docs/ops/PROD_SETUP.md`, `docs/MULTI_AGENT_SETUP.md`, `e2e/user-journey.spec.ts`, `.gitignore`

- [ ] **Step 1: Delete the files**

```bash
git rm -r docker admin tests/image-test tests/integration \
  .claude/skills/image-test .claude/skills/integration-test .claude/skills/redeploy-agent .claude/skills/onboarding-flow-test
git rm shared/BOOTSTRAP.md scripts/build-agent-image.sh scripts/check-token-scopes.mjs \
  scripts/recreate-missing-agents.mjs scripts/run-sandbox-tests.sh scripts/check-local-env.sh \
  docs/specs/ONBOARDING_BOT_SPEC.md docs/specs/telegram-groups-topics.md docs/ops/ADMIN_TOOLS.md \
  docs/ops/ADMIN_PROJECT_HANDOVER.md docs/ops/UPDATE_API_KEY.md docs/TELEGRAM_AGENTS.md
grep -n "docker/\|BOOTSTRAP" .gitignore
```

Remove any `.gitignore` lines that only pointed at deleted paths.

- [ ] **Step 2: `e2e/user-journey.spec.ts`**

Delete `waitForStatus` (lines 47-71), the four Fly/Telegram tests starting at lines 172, 292, 375, 437 (each `test(` through its closing `);`), and the helpers only they use (`deleteAgentsByPrefix`, `telethonSend`, and any `TELEGRAM_TOKEN` / `SHARED_BOT_USERNAME` / `TELETHON_*` constants left unreferenced). Rewrite the manual-agent test (line 130) to:

```ts
test('create an agent and land on its detail page', async ({ page, request }) => {
  await login(page, request);
  await page.goto('/agents/new');

  const agentName = `E2E Agent ${Date.now()}`;
  await page.getByPlaceholder(/my assistant/i).fill(agentName);
  await page.getByRole('button', { name: /^create agent$/i }).click();

  await page.waitForURL(/\/agents\/[^/]+$/, { timeout: 15_000 });
  await expect(page.getByText(agentName)).toBeVisible({ timeout: 5_000 });
  await expect(page.getByText(/MCP Endpoint URL/i)).toBeVisible();
});
```

- [ ] **Step 3: `CLAUDE.md`**

Make these edits, in order:

1. **Project Structure** block: delete the lines that are no longer true and add nothing new. Remove `templates/`? Check `ls templates` first; keep the line if the directory exists.
2. Delete the whole section `## Three-Tier Fly Permission Model` (through the line before `## ⛔ Production Deployment`).
3. In `## ⛔ Production Deployment — Explicit Confirmation Required`, the production list becomes only `fly deploy` targeting **agenthelm-core** and `fly secrets set` on it. Delete the bullets about `build-agent-image.sh`, `reins-openclaw`, `reins-hermes`, `OPENCLAW_IMAGE`, `HERMES_IMAGE`, and `agenthelm-onboarding`.
4. In `## ⛔ Production Testing`, delete the bullets about `/integration-test prod`, `ONBOARDING_BOT_TOKEN`, creating machines in `personal`, `FLY_ORG`, the dev `FLY_API_TOKEN`, and dev bots except `@reins_dev_bot`. Keep: no Playwright at `app.helm.mom`, unit and E2E run on localhost, no `setWebhook` on `REINS_TELEGRAM_BOT_TOKEN`. Delete the CI/CD bullet about `agenthelm-onboarding`.
5. Delete `## Development Philosophy` › `### Fly.io for All Environments`.
6. `## Commands Reference`: no change unless it names a deleted script.
7. `## Project Skills`: delete the rows for `/integration-test`, `/redeploy-agent`, `/onboarding-flow-test`, `/image-test`, `/agent-core-docs`. Keep `/new-mcp-server`.
8. Delete `## Admin Tools (Python)`.
9. `## Telegram Accounts`: delete subsections 1, 3, 5, 6 and the wiring checklist. Keep 2 (Approvals Bot, only its "after deployment" half) and 4 (Admin account, only the sentence about receiving approval notifications). Retitle the intro: "Two Telegram entities are wired: the approvals bot and the admin's account."
10. Delete `## Agent Runtimes` and `## Model Router` entirely.
11. `## Deployment Configuration`: in the config-files table delete the `fly.org`, `fly.openclaw_app`, `onboarding.notify_bot_username` rows. In `### Fly Apps` keep only `agenthelm-core`. Delete `### onboarding/fly.toml`. In `### Fly Secrets — agenthelm-core` delete `ONBOARDING_API_KEY`, `ONBOARDING_BOT_WEBHOOK_SECRET`, `ONBOARDING_BOT_WEBHOOK_URL`, `FLY_API_TOKEN`, `FLY_ORG`, `OPENCLAW_APP`, `OPENCLAW_IMAGE`, `HERMES_IMAGE`. Delete `### Fly Secrets — agenthelm-onboarding`. In `### Deploying` delete the onboarding and image-promotion commands. In `### Adding a New Config Parameter` delete step 3.
12. `## Documentation Index`: delete the rows for the six deleted docs and the whole `### Agent Container Context` table. Add under `### Specs`:

```
| [`docs/superpowers/specs/2026-09-16-mcp-only-enrollment-trials-design.md`](docs/superpowers/specs/2026-09-16-mcp-only-enrollment-trials-design.md) | Design: remove the deployed-agent runtime; add admin enrollment, Google self-enrollment, and trials |
```

13. In `## ⛔ Privileged Services`, invariant 2: replace "an agent with no live deployment row counts as open, because `authenticateMcp` serves it" with "`allow_unauthenticated` lives on `agents` and defaults to false".

- [ ] **Step 4: Other docs**

- `TESTING.md`: delete `## 3. Live Integration Tests (Telegram)` and `## 4. Onboarding Flow Test` with their subsections, the `### Environment Variables for Shared Bot E2E Cases` subsection, the `Before running live integration tests` checklists, and the `personal` org paragraphs in `## Environment Rules`. Renumber the remaining sections.
- `README.md`: remove mentions of Docker images, Fly agent provisioning, `onboarding`, and the stub image from `## Project Structure`, `## Testing`, and `## Architecture`.
- `docs/MEMORY.md` › `## Dream Process`: replace the scheduler description with two sentences: the `memory_dream` MCP tool returns a compact manifest; there is no scheduled push, the user's client runs a dream session by asking the agent to.
- `docs/architecture/MCP_TOOL_INJECTION.md`: delete Steps 1 to 4 and the Hermes section; the doc now starts at the initialize handshake. Retitle the intro "from client connect to model call".
- `docs/ops/LOCAL_DEV_SETUP.md`: delete the `FLY_*`, `OPENCLAW_*`, `HERMES_*`, `ONBOARDING_*`, `SHARED_BOT_*` variables from section 1 and the onboarding-bot parts of sections 3, 4, and 6.
- `docs/ops/PROD_SETUP.md`: delete `## Three-Token Fly Permission Model`, `### Onboarding bot env vars (prod)`, `## Onboarding bot persona`, and the onboarding bot from `## Telegram Bots`.
- `docs/MULTI_AGENT_SETUP.md` › `## Before you start`: delete the paragraph "Agents deployed before this keep their open URL" and the table row "Rotating means redeploying". Change "under **Agents → your agent → Deployment**" to "on the agent's detail page".

- [ ] **Step 5: Verify docs reference nothing deleted**

```bash
grep -rn "build-agent-image\|admin/list_agents\|docker/workspace\|agenthelm-onboarding\|reins-openclaw\|reins-hermes\|OPENCLAW_IMAGE\|HERMES_IMAGE\|image-test\|integration-test" --include='*.md' . | grep -v "docs/superpowers/\|node_modules\|COMMON_ERRORS"
```

Expected: no output. (`COMMON_ERRORS.md` keeps its history.)

- [ ] **Step 6: Commit**

```bash
git add -A
git commit -m "chore: remove runtime infrastructure, scripts, skills, and docs"
```

---

### Task 11: Final verification

- [ ] **Step 1: Clean build from scratch**

```bash
npm run clean && npm install
npm run build --workspace=shared --workspace=servers
npm run typecheck
npm run lint
npm test
npm run build
```

Expected: every command exits 0.

- [ ] **Step 2: Boot the backend against the dev database and smoke the fold**

```bash
npm run dev:backend
```

In the log, confirm `Database initialized` with no error from `migrateDeployedAgents`, then:

```bash
curl -s http://localhost:5001/health
curl -s http://localhost:5001/api/config/public
```

Expected: health ok, public config `{}`. Stop the server.

- [ ] **Step 3: Sweep for leftovers**

```bash
grep -rn "deployed_agents\|deployedAgents\|createAndDeploy\|create-manual\|createManual\|fly_app_name\|management_url\|OpenClaw\|Hermes\|openclaw\|hermes" backend/src frontend/src servers/src shared/src e2e --include='*.ts' --include='*.tsx' | grep -v "migrate-deployed-agents\|COMMON_ERRORS\|hermeneutix\|Hermeneutix"
```

Expected: no output. Anything left is a miss; fix it and re-run the suites.

- [ ] **Step 4: Open the PR**

```bash
git push -u origin feat/mcp-only
gh pr create --title "Remove the deployed-agent runtime" --body-file - <<'EOF'
Phase 1 of docs/superpowers/specs/2026-09-16-mcp-only-enrollment-trials-design.md.

Helm is now an MCP gateway plus memory and skills. This PR removes the Fly agent runtime, the Telegram onboarding bot, the spend cap, backups, the model router, and the Codex device flow, and folds `deployed_agents` into `agents`.

Behavior changes to know about:
- Agents that had no live deployment row are now closed to unauthenticated MCP. Clients using a bare URL for one of those agents must re-authenticate.
- The subscription gate on MCP tool calls is live for the first time (it previously joined on the wrong column).
- `POST /api/agents` creates a closed, active agent with a gateway token. `create-manual` is gone.

After merge, the manual production cleanup in spec section 1.6 still has to happen and needs explicit confirmation.

🤖 Generated with [Claude Code](https://claude.com/claude-code)
EOF
```

Do not merge. Merging deploys `agenthelm-core` through CI, which the user must confirm.
