# Special Agent Helm — Onboarding Bot Spec
**Version:** 0.1
**Date:** 2026-04-23
**Status:** Draft

---

## Overview

The onboarding bot is a standalone Telegram bot (`@SpecialAgentHelm`) that qualifies beta applicants and guides them through the full AgentHelm setup flow. It is a **separate service** from the AgentHelm backend, communicating via REST API.

The notification bot (`@AgentHelmNotify`) is a lightweight handler embedded inside the main AgentHelm backend service. It registers users for proactive notifications and fires messages on system events.

---

## Characters

| Bot | Handle | Purpose |
|---|---|---|
| Special Agent Helm | `@SpecialAgentHelm` | Qualification + full onboarding. Conversational, in character. |
| AgentHelm Notify | `@AgentHelmNotify` | Proactive alerts: reauth, key expiry, agent status. Silent unless needed. |

Both speak in the same voice — terse, competent, dry.

---

## Architecture

### Onboarding Bot (separate Fly app)

```
Telegram
   │
   ▼
Onboarding Bot (separate Fly app — Node.js + grammy)
   │  owns: applicants table, state machine
   │
   ├── POST /api/oauth/google/link        → AgentHelm backend
   ├── POST /api/agents/create-and-deploy → AgentHelm backend
   ├── POST /api/auth/setup-link          → AgentHelm backend
   └── GET  /api/agents/:id/status        → AgentHelm backend (polling)

AgentHelm backend
   └── POST <onboarding-bot>/webhook/oauth-complete → Onboarding bot
       (fires when user completes Gmail OAuth)
```

### Notification Bot (inside AgentHelm backend)

- Single Fastify route handles Telegram webhook from `@AgentHelmNotify`
- On `/start` or any message: captures `chat_id`, calls `registerNotifyChatId(telegramUserId, chatId)`
- Internal `sendNotification(userId, message)` function fires Telegram message to stored `chat_id`

---

## Onboarding State Machine

```
qualification
    ↓
pending_approval
    ↓
gmail_oauth
    ↓ (shared-bot mode)       ↓ (custom-bot mode)
notify_bot               botfather
    ↓                         ↓
    └──────────┬──────────────┘
               ↓
         provisioning
               ↓
          validating
               ↓
        password_setup
               ↓
             done
```

**Shared-bot mode** (default, `SHARED_BOT_ENABLED=true`): the platform provides both the Telegram bot (`@MailAndCalendarHelmBot`) and the LLM API key. Users skip `minimax_key` and `botfather` entirely — they go directly from `gmail_oauth` to `notify_bot`.

**Custom-bot mode** (`SHARED_BOT_ENABLED=false`): users create their own Telegram bot via BotFather and provide the token. The `minimax_key` state is a no-op that auto-advances; the platform still provides the LLM API key.

---

## Stage Definitions

### `qualification`

Helm runs a short conversational qualification. Questions are asked in character, not as a form.

**Collected:**
- Telegram user ID (automatic from chat)
- Telegram username (automatic)
- Use case (open text — primary filter)
- Confirmation they use Telegram daily (implicit from the medium)

**On completion:**
- Write applicant row to DB with `state: pending_approval`
- Notify Felipe via Telegram (hardcoded admin chat ID):
  ```
  New applicant: @username
  Use case: "<their answer>"
  /approve_<telegram_user_id>  /reject_<telegram_user_id>
  ```
- Message user: *"Understood. I'll be in touch."*

---

### `pending_approval`

Bot waits. No timeout — Felipe approves or rejects manually.

**On `/approve_<id>`:**
- Update state to `gmail_oauth`
- Message user: *"Clearance granted. Let's get you set up."*

**On `/reject_<id>`:**
- Update state to `rejected`
- Message user: *"Not the right fit for this round. We'll keep your info on file."*

---

### `gmail_oauth`

Helm calls AgentHelm backend to generate a one-time OAuth link tied to the user's Telegram ID.

```
POST /api/oauth/google/link
{ telegram_user_id: <id> }
→ { url: "https://agenthelm.ai/oauth/google?token=<one-time-token>" }
```

Helm sends the link:
> "First, connect your Gmail. This is what your agent will use to read and send email on your behalf."
> `[Connect Gmail →]`

Bot enters waiting state. AgentHelm fires a webhook to `POST <onboarding-bot>/webhook/oauth-complete` when the user finishes OAuth. Bot advances automatically.

Helm: *"Gmail connected."*

---

### `minimax_key` *(deprecated — no-op)*

This state is no longer used. The handler auto-advances to `notify_bot` (shared-bot mode) or `botfather` (custom-bot mode) without prompting the user. Retained in the code only to gracefully advance any applicants whose state was set by an older version of the flow.

The platform provides the LLM API key (via `MINIMAX_API_KEY` secret on `agenthelm-core`) — users are never asked to supply one.

---

### `botfather` *(custom-bot mode only)*

Helm instructs:
> "Open @BotFather on Telegram. Send /newbot, give your agent a name, and paste the token it gives you back here."

On paste:
- Validate token format (`^\d+:[A-Za-z0-9_-]{35,}$`)
- Call Telegram `getMe` API to confirm token is live
- If valid: store token, advance
- If invalid: *"That token didn't check out. Make sure you copied the full thing."*

---

### `notify_bot`

Helm instructs:
> "One more thing — message @AgentHelmNotify on Telegram. That's how I'll reach you when something needs your attention: re-authentication, key renewals, status updates. One message is all it takes."

Bot polls for `notify_chat_id` on the applicant row every 5s (set by the notification bot webhook). Advances automatically when registered.

Timeout: 10 minutes. If not done, Helm re-prompts once then skips with a warning logged.

---

### `provisioning`

Bot calls AgentHelm backend:

```
POST /api/agents/create-and-deploy
{
  name: "<username>'s Agent",
  telegramUserId: <telegram_user_id>,
  modelProvider: "anthropic",
  modelName: "claude-sonnet-4-5",
  runtime: "openclaw",
  soulMd: <default_starter_persona>
  // telegramToken: omitted in shared-bot mode (SHARED_BOT_TOKEN used by backend)
  // openaiApiKey: omitted — backend uses platform ANTHROPIC_API_KEY
}
```

Helm: *"Your agent is spinning up. Stand by."*

Stores returned `agent_id` and `deployment_id` on applicant row. Advances to `validating`.

---

### `validating`

Bot polls `GET /api/agents/:deployment_id/status` every 10s.

- `status: running` → advance
- Timeout after 3 minutes → flag to Felipe, message user: *"Taking longer than expected. I'll follow up shortly."*

On success: Helm sends a test message to the user from their new bot (via Telegram Bot API using the stored bot token) to confirm it responds.

If test message is received → advance.

---

### `password_setup`

Bot calls AgentHelm backend:

```
POST /api/auth/setup-link
{ telegram_user_id: <id> }
→ { url: "https://agenthelm.ai/setup?token=<signed-jwt>" }
```

JWT contains: `telegram_user_id`, `email` (from Gmail OAuth), expiry (24h).

Helm sends:
> "Your agent is live. Set up your AgentHelm account — this link expires in 24 hours."
> `[Set up account →]`

After password set → redirect to `agenthelm.ai/dashboard`.

---

### `done`

Helm sends:
> "You're operational. Your agent is live in Telegram. I'll be around."

State set to `done`. No further bot interaction unless user messages Helm again (handled as general help/support).

---

## Database Schema

### Onboarding Bot DB

```sql
CREATE TABLE applicants (
  telegram_user_id   BIGINT PRIMARY KEY,
  username           TEXT,
  use_case           TEXT,
  state              TEXT NOT NULL DEFAULT 'qualification',
  minimax_key        TEXT,
  bot_token          TEXT,
  notify_chat_id     BIGINT,
  agent_id           TEXT,
  deployment_id      TEXT,
  rejected_at        TIMESTAMP,
  created_at         TIMESTAMP NOT NULL DEFAULT NOW(),
  updated_at         TIMESTAMP NOT NULL DEFAULT NOW()
);
```

### AgentHelm Backend (additions)

```sql
-- Add to users table
ALTER TABLE users ADD COLUMN telegram_user_id BIGINT UNIQUE;
ALTER TABLE users ADD COLUMN telegram_notify_chat_id BIGINT;
```

---

## AgentHelm Backend — New Endpoints Required

| Method | Path | Purpose |
|---|---|---|
| `POST` | `/api/oauth/google/link` | Generate one-time OAuth URL tied to Telegram user ID (no account required) |
| `POST` | `/api/auth/setup-link` | Generate signed JWT for password setup from Telegram user ID |
| `POST` | `/api/webhooks/onboarding/oauth-complete` | Called by AgentHelm when Gmail OAuth completes; fires webhook to onboarding bot |

**Existing endpoints used by the bot:**

| Method | Path | Notes |
|---|---|---|
| `POST` | `/api/agents/create-and-deploy` | Already exists |
| `GET` | `/api/agents/:id/status` | Already exists (or equivalent) |

---

## Notification Bot — Events

Embedded in AgentHelm backend. Fires on these events:

| Event | Message |
|---|---|
| Gmail OAuth token expired | "Your Gmail connection needs renewal. Re-authenticate: [link]" |
| MiniMax API key invalid/expired | "Your MiniMax API key isn't working. Update it here: [link]" |
| Agent stopped unexpectedly | "Your agent @BotName went offline. [View status]" |
| Agent resumed | "Your agent @BotName is back online." |
| Daily usage threshold hit | "Your agent hit the daily usage limit." |

---

## Infrastructure

### Onboarding Bot

| Property | Value |
|---|---|
| Runtime | Node.js 20 |
| Framework | `grammy` |
| Database | Postgres (shared with AgentHelm or separate) |
| Fly machine | `shared-cpu-1x`, 256MB RAM |
| Fly org | `agenthelm` (control plane org) |
| Env vars | `BOT_TOKEN`, `DATABASE_URL`, `AGENTHELM_API_URL`, `AGENTHELM_API_KEY`, `ADMIN_TELEGRAM_ID` |

### Notification Bot

| Property | Value |
|---|---|
| Runtime | Inside AgentHelm Fastify backend |
| Env vars | `NOTIFY_BOT_TOKEN` (added to main service) |

---

## Helm's Persona (SOUL.md excerpt)

```markdown
You are Special Agent Helm.

You run qualification and onboarding for AgentHelm — a platform for deploying
personal AI agents. You are terse, competent, and dry. You do not over-explain.
You do not make small talk. You handle things.

Your job right now: qualify this person and get them set up.

Rules:
- Keep messages short. One idea per message.
- Never say "Great!" or "Sure!" or any filler affirmation.
- If something fails, state the fact and tell them what to do next.
- If something succeeds, confirm it briefly and move on.
- You are not a chatbot. You are an agent.
```

---

## Authentication

### Model

Service-to-service authentication uses shared secrets passed as `Authorization: Bearer <token>` headers. Two secrets are required — one in each direction.

| Direction | Secret | Held by |
|---|---|---|
| Onboarding bot → AgentHelm | `AGENTHELM_API_KEY` | Both services |
| AgentHelm → Onboarding bot (webhooks) | `ONBOARDING_BOT_WEBHOOK_SECRET` | Both services |

Secrets are generated at deploy time (`openssl rand -hex 32`), stored as Fly secrets, never in code or version control.

AgentHelm rejects any request from the onboarding bot without a valid `Authorization` header with `401 Unauthorized`.

The onboarding bot rejects any webhook from AgentHelm without a valid `Authorization` header with `401 Unauthorized`.

---

## API Spec

### Authentication Header (all requests)

```
Authorization: Bearer <AGENTHELM_API_KEY>
Content-Type: application/json
```

---

### 1. Generate Gmail OAuth Link

Creates a one-time OAuth URL tied to a Telegram user ID. No AgentHelm account is required at this stage.

**Request**
```
POST /api/oauth/google/link
Authorization: Bearer <AGENTHELM_API_KEY>
Content-Type: application/json

{
  "telegramUserId": 123456789
}
```

**Response `200`**
```json
{
  "url": "https://agenthelm.ai/oauth/google?token=<one-time-token>",
  "expiresAt": "2026-04-23T10:00:00Z"
}
```

**Response `400`**
```json
{ "error": { "code": "INVALID_REQUEST", "message": "telegramUserId is required" } }
```

**Response `409`**
```json
{ "error": { "code": "ALREADY_LINKED", "message": "Gmail already connected for this Telegram user" } }
```

**Notes:**
- Token is single-use, expires in 30 minutes
- AgentHelm stores `telegram_user_id` alongside the OAuth state parameter
- On OAuth completion, AgentHelm fires the oauth-complete webhook (see below)

---

### 2. OAuth Complete Webhook (AgentHelm → Onboarding Bot)

Called by AgentHelm when a user finishes Gmail OAuth. Advances the user's state machine.

**Request** *(sent by AgentHelm to onboarding bot)*
```
POST <ONBOARDING_BOT_URL>/webhook/oauth-complete
Authorization: Bearer <ONBOARDING_BOT_WEBHOOK_SECRET>
Content-Type: application/json

{
  "telegramUserId": 123456789,
  "email": "user@gmail.com",
  "success": true
}
```

**On failure:**
```json
{
  "telegramUserId": 123456789,
  "success": false,
  "error": "access_denied"
}
```

**Response `200`**
```json
{ "ok": true }
```

---

### 3. Create and Deploy Agent

Provisions the user's personal agent. Uses the existing endpoint — documented here with the onboarding-specific payload.

**Request**
```
POST /api/agents/create-and-deploy
Authorization: Bearer <AGENTHELM_API_KEY>
Content-Type: application/json

{
  "name": "My Agent",
  "telegramUserId": "123456789",
  "modelProvider": "anthropic",
  "modelName": "claude-sonnet-4-5",
  "runtime": "openclaw",
  "soulMd": "<default_starter_persona>",
  "onboardingTelegramUserId": 123456789
  // Shared-bot mode: telegramToken omitted — backend uses SHARED_BOT_TOKEN
  // openaiApiKey omitted — backend uses platform ANTHROPIC_API_KEY
}
```

**Response `201`**
```json
{
  "data": {
    "id": "<agent_id>",
    "name": "My Agent",
    "status": "active",
    "deployment": {
      "deploymentId": "<deployment_id>",
      "status": "running",
      "appName": "reins-abc12345",
      "runtime": "hermes"
    }
  }
}
```

**Response `400`**
```json
{ "error": { "code": "VALIDATION_ERROR", "message": "telegramToken is invalid" } }
```

**Response `500`**
```json
{ "error": { "code": "DEPLOY_FAILED", "message": "Deployment failed: <reason>" } }
```

---

### 4. Get Deployment Status

Polled by the onboarding bot every 10s during `validating` stage.

**Request**
```
GET /api/deployments/:deploymentId/status
Authorization: Bearer <AGENTHELM_API_KEY>
```

**Response `200`**
```json
{
  "deploymentId": "<deployment_id>",
  "status": "running",
  "agentId": "<agent_id>",
  "appName": "reins-abc12345",
  "updatedAt": "2026-04-23T09:45:00Z"
}
```

**Status values:** `pending` | `starting` | `running` | `stopped` | `error`

---

### 5. Generate Password Setup Link

Called once the agent is validated and live. Generates a signed JWT for the user to set their AgentHelm password.

**Request**
```
POST /api/auth/setup-link
Authorization: Bearer <AGENTHELM_API_KEY>
Content-Type: application/json

{
  "telegramUserId": 123456789
}
```

**Response `200`**
```json
{
  "url": "https://agenthelm.ai/setup?token=<signed-jwt>",
  "expiresAt": "2026-04-24T09:45:00Z"
}
```

**Response `404`**
```json
{ "error": { "code": "NOT_FOUND", "message": "No linked account for this Telegram user" } }
```

**Notes:**
- JWT is signed with `REINS_SESSION_SECRET`, expires 24h
- JWT payload: `{ telegramUserId, email, type: "setup", iat, exp }`
- AgentHelm creates the user account on first visit to `/setup` if it doesn't exist yet
- After password set → redirect to `agenthelm.ai/dashboard`

---

### 6. Register Notify Chat ID (Notification Bot → AgentHelm)

Called by the `@AgentHelmNotify` bot handler (inside AgentHelm) when a user sends their first message to the notification bot.

**Internal call** — no HTTP, direct function call since the notification bot is inside the main service:

```typescript
await registerNotifyChatId(telegramUserId: number, chatId: number): Promise<void>
```

Updates `telegram_notify_chat_id` on the users table (or applicants table if account not yet created).

---

### 7. Send Notification (Internal)

Called by AgentHelm internals on system events.

```typescript
await sendNotification(userId: string, message: string): Promise<void>
```

Looks up `telegram_notify_chat_id` for the user, fires Telegram `sendMessage` API call. Fails silently with a logged error if `notify_chat_id` is null (user never registered).

---

### Onboarding Bot — Inbound Webhook Summary

| Path | Called by | Purpose |
|---|---|---|
| `POST /webhook/oauth-complete` | AgentHelm backend | Gmail OAuth finished |

**All inbound webhooks require:**
```
Authorization: Bearer <ONBOARDING_BOT_WEBHOOK_SECRET>
```

---

### Error Handling

All AgentHelm API errors follow the format:
```json
{ "error": { "code": "ERROR_CODE", "message": "Human readable message" } }
```

The onboarding bot handles errors as follows:

| HTTP Status | Bot behavior |
|---|---|
| `400` | Surface the message to user, prompt retry |
| `401` | Log critical error, alert admin (Felipe) via Telegram |
| `404` | Log error, message user there was a setup issue |
| `500` | Retry once after 5s, then alert admin |
| Timeout | Retry once after 10s, then alert admin |

---

## Open Questions

- Does the onboarding bot share the AgentHelm Postgres instance or run its own? (Sharing is simpler for beta; separate is cleaner long-term.)
- What is the default starter SOUL.md for new user agents?
- Should rejected applicants be able to reapply? If so, how?
- Timeout handling for `pending_approval` — does Helm follow up if Felipe doesn't respond in 24h?
