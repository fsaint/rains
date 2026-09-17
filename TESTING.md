# Testing Guide

This document covers all test tiers in the Reins project: unit/integration tests and E2E browser tests.

---

## Environment Rules

These rules are **non-negotiable**. Violating them risks corrupting real user data or breaking the live product for paying users.

| Rule | Requirement |
|------|-------------|
| **Telegram bots** | Dev bot only: `@reins_dev_bot` (approvals). Never use the prod bot token in dev tests. |
| **Unit & E2E tests** | Must run against a local backend (`localhost:5001` / `localhost:6173`). Never point Playwright or Vitest at `app.helm.mom`. |
| **Explicit confirmation** | **Ask the user before running any live test that touches production.** Wait for an explicit "yes, run against prod". |
| **No shared bot webhook changes** | Tests must not call `setWebhook` with the prod bot token (`REINS_TELEGRAM_BOT_TOKEN`). Doing so would break the webhook for all users. |
| **Unit tests** | Always safe — no environment dependency. Run freely. |
| **E2E tests (Playwright)** | Must target local or `reins-dev.btv.pw`. Never `app.helm.mom`. |

### At a Glance

| Test tier | Development | Production |
|-----------|-------------|------------|
| Unit (Vitest) | ✅ Free | ✅ Free |
| E2E (Playwright) | ✅ Local backend only | ❌ Not allowed |

---

## Table of Contents

1. [Unit & Integration Tests (Vitest)](#1-unit--integration-tests-vitest)
2. [E2E Tests (Playwright)](#2-e2e-tests-playwright)
3. [Known Failing Tests](#3-known-failing-tests)

---

## 1. Unit & Integration Tests (Vitest)

### Requirements

- Node.js 20+
- `npm install` at repo root
- No external services required (all I/O is mocked)

### Running Tests

```bash
# All workspaces
npm test

# With coverage report
npm run test:coverage

# Watch mode (development)
npm run test:watch

# Single workspace
npm test --workspace=backend
npm test --workspace=frontend
npm test --workspace=servers
```

### Coverage Thresholds

| Workspace / Component | Minimum |
|-----------------------|---------|
| Backend — Policy Engine | 90% |
| Backend — MCP Proxy | 85% |
| Backend — API | 80% |
| Frontend — Components | 80% |
| Frontend — Hooks | 85% |
| Servers — Utilities | 90% |

### What's Tested

#### Backend (`backend/src/**/*.test.ts`)

| Test file | Covers |
|-----------|--------|
| `api/agent-admin-routes.test.ts` | Route-level tests for `/api/agent-admin/*`: the service enablement gate and privilege boundaries |
| `api/approvals-routes.test.ts` | Approval decision endpoints (approve, deny, request changes) through the real Fastify plugin |
| `api/mcp-auth-routes.test.ts` | `POST`/`GET`/`DELETE /mcp/:agentId` route-level auth, including unauthenticated access when the owner allows it |
| `api/mcp-server-key.test.ts` | `mcpServerKey` helper |
| `api/permissions-drive-routes.test.ts` | `PUT /api/permissions/:agentId/drive/path-config` |
| `api/permissions-instance-routes.test.ts` | Per-instance config and the Hermeneutix project picker under `/api/permissions` |
| `api/skills-routes.test.ts` | Skill management endpoints through the real Fastify plugin |
| `api/upload-body-limit.test.ts` | Body-limit arrangement for the agent-upload route |
| `approvals/queue.test.ts` | `ApprovalQueue` CRUD |
| `audit/logger.test.ts` | Audit log writing |
| `auth/auth.test.ts` | Login, session management |
| `credentials/vault.test.ts` | Credential storage and retrieval |
| `db/compat.test.ts` | PostgreSQL compatibility wrapper (schema translation layer) |
| `db/migrate-deployed-agents.test.ts` | `migrateDeployedAgents` column-folding migration |
| `integration/memory.test.ts` | Memory API end to end through the full Fastify stack, including a restricted agent (gateway token + scope grants) exercising every route |
| `mcp/agent-endpoint.test.ts` | MCP agent endpoint: tool routing, `tools/list`, `tools/call` |
| `mcp/init-servers.test.ts` | `createServerWrapper` — the tool-context field whitelist between the server manager and service handlers |
| `mcp/oauth/routes.test.ts` | MCP OAuth authorization server HTTP routes (register / authorize / token) |
| `mcp/oauth/tokens.test.ts` | MCP token store: issuance, verification, scoping a token to exactly one agent |
| `mcp/redact-args.test.ts` | `redactToolArgs` — attachment redaction |
| `mcp/scoped-services.e2e.test.ts` | **Context scopes, for real:** `tools/call` → `executeTool` → real `@reins/servers` handlers for Hermeneutix (pinned project), Drive (folder rules), and memory (scope grants). Every refusal asserts no upstream call was made |
| `mcp/server-manager.test.ts` | `ServerManager.callTool` context injection (Drive path config reaching both Drive and Gmail handlers) |
| `notifications/telegram.test.ts` | Rich email and calendar previews in Telegram approval messages |
| `policy/engine.test.ts` | `PolicyEngine`: YAML policy parsing, allow/block/approval logic |
| `services/agent-limits.test.ts` | `getAgentLimits` — owner-set limits rendered for MCP surfaces |
| `services/agent-uploads.test.ts` | `createUpload` |
| `services/billing.test.ts` | Billing service (subscriptions, Stripe webhooks) |
| `services/memory-scopes.test.ts` | Memory scope resolution (`ensureDefaultScope`, grant lookups) |
| `services/memory.test.ts` | `parseWikilinks`, `updateLinkIndex`, `ensureMemoryRoot` |
| `services/permissions.test.ts` | User and agent permission checks |
| `services/registration.test.ts` | Agent self-registration flow |
| `services/skills.test.ts` | Skill availability resolver (`parseRequiredServices`) |

#### Frontend (`frontend/src/**/*.test.{ts,tsx}`)

| Test file | Covers |
|-----------|--------|
| `api/client.test.ts` | API client request helpers, including `ApiError` |
| `components/AgentSkillToggles.test.tsx` | Agent skill toggle component |
| `pages/AgentNew.test.tsx` | Create-agent form and wizard flow |
| `pages/Approvals.test.tsx` | Approval queue UI |
| `pages/Credentials.test.tsx` | Update-token action on API-key credentials |
| `pages/Login.test.tsx` | Login form |
| `pages/Permissions.test.tsx` | Add-service flow, Hermeneutix project picker, memory scope editor, Drive path editor |
| `utils/drive.test.ts` | `parseDriveFolderId` and other Drive URL/path utilities |

#### Servers (`servers/src/**/*.test.ts`)

| Test file | Covers |
|-----------|--------|
| `browser/handlers.test.ts` | Browser automation handlers |
| `calendar/handlers.test.ts` | Calendar MCP tool handlers |
| `drive/handlers.test.ts` | Drive MCP tool handlers |
| `drive/path-rules.test.ts` | Folder rule resolution: subtree inheritance, nearest rule, multi-parent veto, depth cap |
| `gmail/attachments.test.ts` | Attachment parsing, including backwards compatibility |
| `gmail/handlers.test.ts` | Gmail MCP tool handlers |
| `gmail/mime.test.ts` | MIME message building, attachment encoding, header sanitization |
| `gmail/safe-fetch.test.ts` | `isBlockedAddress` — SSRF guard on outbound Gmail fetches |
| `hermeneutix/handlers.test.ts` | Hermeneutix handlers, including project pinning and response-verified refusals |
| `memory/handlers.test.ts` | Memory MCP tool handlers (mocking `global.fetch`) |
| `pipedrive/handlers.test.ts` | Pipedrive handlers: HTTP verb per resource and custom-field passthrough |
| `registry.test.ts` | Every tool exported by a service is classified in `def.permissions` (read/write/blocked) |
| `skill-authoring/definition.test.ts` | Skill-authoring definition invariants — the privilege boundary the backend derives permissions from |
| `skill-authoring/handlers.test.ts` | Skill-authoring wire contract: gateway token, method/endpoint, refusal shape |
| `skills/handlers.test.ts` | Skills MCP tool handlers (mocking `global.fetch`) |
| `web-search/handlers.test.ts` | Web search handlers |

---

## 2. E2E Tests (Playwright)

### Requirements

- Backend running locally: `npm run dev:backend`
- Frontend running locally: `npm run dev:frontend`
- `REINS_ADMIN_EMAIL` and `REINS_ADMIN_PASSWORD` set (defaults: `admin@reins.local` / `testpass123`)
- Playwright browsers installed: `npx playwright install`

### Running E2E Tests

```bash
# Run all E2E specs
npm run test:e2e

# With browser visible (headed mode)
npm run test:e2e -- --headed

# Single spec file
npx playwright test e2e/user-journey.spec.ts
```

### What's Tested (`e2e/user-journey.spec.ts`)

1. **Login** — loads the login page, submits credentials, lands on the dashboard
2. **Create an agent** — wizard flow: name → create → lands on the agent detail page showing the MCP endpoint URL
3. **Agent list** — created agents appear in the agent list

---

## 3. Known Failing Tests

### `servers/src/gmail/handlers.test.ts`

**Status:** 1 failing test (as of 2026-05-07)

**Symptom:** The `handleGetMessage` test expects attachment metadata without an `attachmentId` field, but the handler now includes it.

**Impact:** `npm test --workspace=servers` reports `1 failed | 95 passed`.

**Fix:** Update the test expectation to include `attachmentId` in the expected attachment object, matching the current handler output.

---

## Quick Checklists

### Before running unit tests

```
[ ] npm install (repo root)
[ ] No TypeScript errors: npm run typecheck
```

### Before running E2E tests

```
[ ] npm run dev:backend running
[ ] npm run dev:frontend running
[ ] npx playwright install (first time)
```
