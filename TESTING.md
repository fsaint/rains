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
| `auth.test.ts` | Login, session management |
| `credentials.test.ts` | Credential storage and retrieval |
| `policy-engine.test.ts` | YAML policy parsing, allow/block/approval logic |
| `providers.test.ts` | Fly machine provisioning logic |
| `approvals.test.ts` | Approval queue CRUD |
| `audit.test.ts` | Audit log writing |
| `db-compat.test.ts` | SQLite schema migrations |
| `mcp-agent-endpoint.test.ts` | MCP proxy forwarding |
| `permissions.test.ts` | User and agent permission checks |
| `registration.test.ts` | Agent self-registration flow |
| `integration/user-journey.test.ts` | Full HTTP stack with mocked DB and providers |
| `integration/memory.test.ts` | Memory API end to end, including a restricted agent (gateway token + scope grants) exercising every route |
| `mcp/scoped-services.e2e.test.ts` | **Context scopes, for real:** `tools/call` → `executeTool` → real `@reins/servers` handlers for Hermeneutix (pinned project), Drive (folder rules), and memory (scope grants). Every refusal asserts no upstream call was made |

#### Frontend (`frontend/src/**/*.test.ts`)

| Test file | Covers |
|-----------|--------|
| `client.test.ts` | API client request helpers |
| `LogViewer.test.tsx` | Log display component |
| `Approvals.test.tsx` | Approval queue UI |
| `Login.test.tsx` | Login form |
| `Permissions.test.tsx` | Add-service flow, Hermeneutix project picker, memory scope editor, Drive path editor |
| `Credentials.test.tsx` | Update-token action on API-key credentials |

#### Servers (`servers/src/**/*.test.ts`)

| Test file | Covers |
|-----------|--------|
| `gmail/handlers.test.ts` | Gmail MCP tool handlers |
| `calendar/handlers.test.ts` | Calendar MCP tool handlers |
| `drive/handlers.test.ts` | Drive MCP tool handlers |
| `drive/path-rules.test.ts` | Folder rule resolution: subtree inheritance, nearest rule, multi-parent veto, depth cap |
| `hermeneutix/handlers.test.ts` | Hermeneutix handlers, including project pinning and response-verified refusals |
| `browser/handlers.test.ts` | Browser automation handlers |
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
