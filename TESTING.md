# Testing Guide

This document covers all test tiers in the Reins project: unit/integration tests, E2E browser tests, live integration tests (Telegram), and the onboarding flow test.

---

## Table of Contents

1. [Unit & Integration Tests (Vitest)](#1-unit--integration-tests-vitest)
2. [E2E Tests (Playwright)](#2-e2e-tests-playwright)
3. [Live Integration Tests (Telegram)](#3-live-integration-tests-telegram)
4. [Onboarding Flow Test](#4-onboarding-flow-test)
5. [Known Failing Tests](#5-known-failing-tests)

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

#### Frontend (`frontend/src/**/*.test.ts`)

| Test file | Covers |
|-----------|--------|
| `client.test.ts` | API client request helpers |
| `LogViewer.test.tsx` | Log display component |
| `Approvals.test.tsx` | Approval queue UI |
| `Login.test.tsx` | Login form |

#### Servers (`servers/src/**/*.test.ts`)

| Test file | Covers |
|-----------|--------|
| `gmail/handlers.test.ts` | Gmail MCP tool handlers |
| `calendar/handlers.test.ts` | Calendar MCP tool handlers |
| `drive/handlers.test.ts` | Drive MCP tool handlers |
| `browser/handlers.test.ts` | Browser automation handlers |
| `web-search/handlers.test.ts` | Web search handlers |

---

## 2. E2E Tests (Playwright)

### Requirements

- Backend running locally: `npm run dev:backend`
- Frontend running locally: `npm run dev:frontend`
- `REINS_ADMIN_EMAIL` and `REINS_ADMIN_PASSWORD` set (defaults: `admin@reins.local` / `testpass123`)
- Playwright browsers installed: `npx playwright install`

For the **hosted agent** test case, a stub container must be reachable. The test skips the deploy step by mocking the provider, so no Fly credentials are required.

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
2. **Create manual agent** — wizard flow: name → model → personality → deploy (manual token path)
3. **Create hosted agent — per-user bot, MiniMax** — wizard flow: name → runtime → MiniMax provider + API key → personality → deploy (platform stub)
4. **Create hosted agent — shared bot, Anthropic** — when `SHARED_BOT_TOKEN` is set in backend env, the token field is replaced with "Uses the platform bot" notice; Anthropic provider requires no API key input; wizard completes without entering either
5. **Create hosted agent — shared bot, no MiniMax key** — shared bot mode with Anthropic provider selected; verifies that both the telegram token field and the provider API key field are absent from the wizard

### Environment Variables for Shared Bot E2E Cases

The backend must have `SHARED_BOT_TOKEN` set for tests 4 and 5. Add to your `.env`:

```bash
SHARED_BOT_TOKEN=<dev shared bot token>   # enables sharedBotEnabled=true on /api/config/public
```

Restart the backend after setting it. The E2E tests check `/api/config/public` → `sharedBotEnabled` to decide which form variant to expect.

---

## 3. Live Integration Tests (Telegram)

These tests deploy real Fly machines, create agents via the Reins UI, and verify bot responses using a real Telegram account via Telethon. There are **8 test cases**:

| # | Runtime | Provider | Bot mode |
|---|---------|----------|----------|
| 1 | OpenClaw | Anthropic | Per-user bot |
| 2 | OpenClaw | OpenAI | Per-user bot |
| 3 | OpenClaw | MiniMax | Per-user bot |
| 4 | Hermes | Anthropic | Per-user bot |
| 5 | Hermes | OpenAI | Per-user bot |
| 6 | Hermes | MiniMax | Per-user bot |
| 7 | OpenClaw | MiniMax | Shared bot |
| 8 | Hermes | MiniMax | Shared bot |

### Requirements

#### Tools

- `fly` CLI authenticated (`fly auth whoami`)
- Python 3 with Telethon installed (`pip install telethon`)
- Playwright MCP (`npx playwright`) for UI agent creation

#### Env files

**Dev:** `tests/integration/.env.test`

```bash
ANTHROPIC_API_KEY=...
OPENAI_API_KEY=...
MINIMAX_API_KEY=...

REINS_URL=http://localhost:5001
REINS_FRONTEND_URL=http://localhost:6173
REINS_ADMIN_EMAIL=admin@reins.local
REINS_ADMIN_PASSWORD=testpass123

TELEGRAM_USER_ID=<your numeric Telegram user ID>

BOT_TOKEN_OC_ANTHROPIC=<token>
BOT_TOKEN_OC_OPENAI=<token>
BOT_TOKEN_OC_MINIMAX=<token>
BOT_TOKEN_H_ANTHROPIC=<token>
BOT_TOKEN_H_OPENAI=<token>
BOT_TOKEN_H_MINIMAX=<token>

# Shared bot (dev: @AgentHelmDevPilot_bot)
SHARED_BOT_TOKEN=<token>
SHARED_BOT_WEBHOOK_SECRET=<hex secret>

TELEGRAM_TEST_MODE=telethon
TELEGRAM_API_ID=<id>
TELEGRAM_API_HASH=<hash>
TELEGRAM_PHONE=+1xxxxxxxxxx
```

**Prod:** `tests/integration/.env.prod-test` — same keys, prod values.

#### Root `.env` (dev only)

```bash
ANTHROPIC_API_KEY=sk-ant-api03-...
REINS_PUBLIC_URL=https://reins-dev.btv.pw   # must be reachable from Fly machines
FLY_ORG=reins-dev
FLY_API_TOKEN=<dev org token>
SHARED_BOT_TOKEN=<dev shared bot token>
SHARED_BOT_WEBHOOK_SECRET=<hex secret>
```

`REINS_PUBLIC_URL` must be externally reachable — Fly machines call back to it for MCP tool calls. Use a tunnel (`ngrok http 5001`) if not already exposed.

#### Local services

```bash
npm run dev:backend   # terminal 1
npm run dev:frontend  # terminal 2
```

#### Telethon session (one-time setup)

```bash
python3 /tmp/tg_login.py
# Interactive login — writes ~/.reins_test_telethon.session
```

#### Helper scripts (must exist in /tmp)

| Script | Purpose |
|--------|---------|
| `/tmp/tg_send_and_wait_filtered.py` | Send a message, wait for first non-progress reply |
| `/tmp/tg_mcp_tool_test.py` | Send message, optionally approve/reject pending tool approval, return final reply |
| `/tmp/run_sandbox_tests.sh` | Orchestrate all 4 sandbox permission tests for an agent |

### Running a Test

Use the `/integration-test` skill for the full procedure:

```
/integration-test
```

Or for a prod run:

```
/integration-test prod
```

### Per-User Bot Tests (Tests 1–6)

Each test:
1. Creates an agent via the Reins UI (Playwright)
2. Waits for the Fly machine to reach `running` status
3. Sends a ping message via Telethon → expects `15` (7+8)
4. Runs sandbox permission tests (allowed / approve / deny / blocked)
5. Tears down the agent

### Shared Bot Tests (Tests 7–8)

Prerequisites: `SHARED_BOT_TOKEN` set in root `.env` and backend restarted (so it calls `setWebhook` at startup).

Each test:
1. Creates an agent via UI **without** providing a bot token (the form shows "Uses the platform bot")
2. Verifies `is_shared_bot = 1` in DB
3. Messages the shared bot directly — expects the message to be routed to the correct agent
4. Runs the same ping test (`7+8 = 15`)
5. Tears down

### Sandbox Tests Quick Reference

```bash
source /tmp/run_sandbox_tests.sh
sandbox_tests <bot_username> <agent_id>

# Prod target:
sandbox_tests <bot_username> <agent_id> tests/integration/.env.prod-test
```

Expected: `4/4 passed, 0/4 failed`

---

## 4. Onboarding Flow Test

Tests the full Telegram onboarding bot flow: `/start` → use-case → email → BotFather step (or shared bot skip) → Gmail OAuth → approvals bot → provisioning.

### Requirements

- Backend + frontend running locally
- Playwright MCP configured (browser automation on Telegram Web)
- A Telegram account logged in to `web.telegram.org`
- Onboarding bot running (`agenthelm-onboarding` or locally)
- A Gmail account for the OAuth step
- Admin Telegram account to approve the applicant

### Running

```
/onboarding-flow-test
```

The skill (`/.claude/skills/onboarding-flow-test/SKILL.md`) contains the full step-by-step procedure.

### Test Variants

Run the onboarding flow test under each configuration below. Vary the onboarding bot's environment, then restart it before each variant.

#### Variant A — Per-user bot + MiniMax (baseline)

```bash
# onboarding env: SHARED_BOT_ENABLED not set (default false)
```

Expected flow:
```
/start → use-case → email → minimax-key (user pastes key) → botfather (user pastes token) → notify_bot → gmail_oauth → provisioning → done
```

#### Variant B — Shared bot + MiniMax

```bash
# onboarding env:
SHARED_BOT_ENABLED=true
```

Expected flow:
```
/start → use-case → email → minimax-key (user pastes key) → notify_bot (BotFather step SKIPPED) → gmail_oauth → provisioning → done
```

Verify: the `botfather` state is never sent; provisioning call omits `telegramToken`; `is_shared_bot = 1` in DB.

#### Variant C — Shared bot + Anthropic (no MiniMax key)

```bash
# onboarding env:
SHARED_BOT_ENABLED=true
# No MINIMAX_API_KEY secret set on the onboarding bot
```

When the onboarding bot transitions to `minimax-key` but the user has no MiniMax key, they should be able to proceed with Anthropic (server-side key). The provisioning call uses `provider: "anthropic"` and omits both `telegramToken` and `minimax_api_key`.

Expected flow:
```
/start → use-case → email → minimax-key (user skips / selects Anthropic) → notify_bot → gmail_oauth → provisioning → done
```

Verify: provisioning succeeds; deployed agent uses Anthropic model; no MiniMax key stored.

#### Variant D — Per-user bot + Anthropic (no MiniMax key)

```bash
# onboarding env: SHARED_BOT_ENABLED not set
```

Expected flow:
```
/start → use-case → email → minimax-key (user skips / selects Anthropic) → botfather (user pastes token) → notify_bot → gmail_oauth → provisioning → done
```

Verify: provisioning succeeds; `is_shared_bot = 0` in DB; Anthropic provider used.

---

## 5. Known Failing Tests

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

### Before running live integration tests (dev)

```
[ ] tests/integration/.env.test populated
[ ] ANTHROPIC_API_KEY + REINS_PUBLIC_URL + FLY_ORG + FLY_API_TOKEN in root .env
[ ] SHARED_BOT_TOKEN + SHARED_BOT_WEBHOOK_SECRET in root .env (for shared bot tests)
[ ] Backend restarted after setting SHARED_BOT_TOKEN (so setWebhook fires)
[ ] fly auth whoami succeeds
[ ] Telethon session exists (~/.reins_test_telethon.session)
[ ] /tmp helper scripts present
[ ] No orphan Fly machines from previous runs: fly machine list --org reins-dev
[ ] npm run dev:backend running
[ ] npm run dev:frontend running
```

### Before running live integration tests (prod)

```
[ ] tests/integration/.env.prod-test populated
[ ] fly auth whoami succeeds
[ ] Telethon session exists (~/.reins_test_telethon.session)
[ ] /tmp helper scripts present
```
