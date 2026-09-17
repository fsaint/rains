# Helm as MCP + Memory + Skills: Runtime Removal, Enrollment, and Trials

**Date:** 2026-09-16
**Status:** Approved 2026-09-16

## Problem

Helm today has two products in one codebase: a hosted agent runtime (OpenClaw / Hermes
containers provisioned on Fly.io, driven by a Telegram onboarding bot) and an MCP gateway
(agents as MCP identities at `/mcp/<id>` with OAuth-connected clients, permissions, memory
scopes, and skills). The hosted runtime is being dropped. What remains is the MCP gateway,
memory, and skills.

At the same time there is no way for a user to join. The only account creation paths are
an admin form that requires a password and the Telegram onboarding bot, which ends by
provisioning a machine. Google sign-in rejects any email not already in `users`. Billing
has no trial concept: the deploy gate blocks anyone without a subscription and the MCP usage
gate is effectively dead code because it joins `deployed_agents.id` against an `agents.id`
(`backend/src/mcp/agent-endpoint.ts:1280`).

This spec covers both changes because they share a seam: the trial gate replaces the deploy
gate, the usage gate, the spend cap, and the lapse cron, all of which are runtime-shaped.

## Delivery

Two branches, two PRs, in order:

1. **Phase 1: `feat/mcp-only`** removes the deployed-agent runtime. Pure deletion and
   column moves. Ships and deploys on its own.
2. **Phase 2: `feat/enrollment-trials`** adds admin enrollment, Google self-enrollment,
   trials, the access gate, and trial emails. Builds on Phase 1.

Each phase gets its own implementation plan.

## Decisions already made

| Question | Decision |
|---|---|
| Product shape | Agents stay as MCP identities. Fly runtime, onboarding bot, and everything that only serves a machine go. |
| Self-enrollment | Google sign-in with an unknown email creates the account. No signup form. |
| Trial lengths | Admin-created: 0, 30, 60, or 90 days. Self-enrolled: 15 days. Configurable. |
| Trial end | Tool calls blocked, connecting a client blocked, until an active subscription exists. |
| Existing users | Grandfathered: a null trial date means allowed. |
| Agents with no deployment row | Closed to unauthenticated MCP after migration. |
| Model credentials and Codex device flow | Removed with the runtime. |
| Pricing | Unchanged. BYOK and Managed remain the conversion targets. |
| Emails | Invite or welcome on creation, reminder 3 days before trial end, notice at trial end. |

---

# Phase 1: Remove the deployed-agent runtime

## 1.1 Data model

`deployed_agents` is dropped. It is the row the MCP layer authenticates against, so two
columns move to `agents` first:

```sql
ALTER TABLE agents ADD COLUMN IF NOT EXISTS gateway_token TEXT;
ALTER TABLE agents ADD COLUMN IF NOT EXISTS allow_unauthenticated BOOLEAN NOT NULL DEFAULT false;
```

`mcp_server_name` and `runtime` do not move. Every agent is now an external MCP client whose
own software adds the tool prefix, so tool names render bare and neither column has a reader.

Migration, run once inside `initializeDatabase` and guarded so it is idempotent:

1. For every agent, take its newest `deployed_agents` row whose status is not `destroyed`
   or `error`. Copy `gateway_token` and `allow_unauthenticated` onto the agent.
2. Agents with no such row get `allow_unauthenticated = false` (the default) and a freshly
   generated `gateway_token`. This closes agents created through the plain
   `POST /api/agents` path, which today are open because `authenticateMcp` treats a
   missing row as open. This is a deliberate behavior change: any client still using a bare
   URL for one of these agents must re-authenticate.
3. Drop `deployed_agents`, `agent_model_configs`, `initial_prompt_templates`,
   `spend_records`. The `applicants` table belongs to the onboarding package and is left in
   place in Postgres; nothing reads it after the package is deleted.

`agents.status` keeps its values. Every new agent is inserted as `active`.

The Drizzle mirrors in `backend/src/db/schema.ts` change to match.

## 1.2 Backend: delete

| Path | Reason |
|---|---|
| `backend/src/providers/fly.ts`, `providers/index.ts` | Fly Machines client and provider abstraction |
| `backend/src/services/fly-lifecycle-monitor.ts` | Polls Fly |
| `backend/src/services/agent-bot-relay.ts` | Relays Telegram to a container |
| `backend/src/services/model-router.ts` | LiteLLM sidecar config |
| `backend/src/services/agent-backup.ts` | Snapshots machine state |
| `backend/src/services/spend.ts` | Prices token usage reported by containers. Nothing feeds it without a runtime. |
| `backend/src/services/dream.ts` `runDreamProcess` and `startDreamScheduler` | Pushes a prompt into a machine's chat. The MCP `memory_dream` tool and `GET /api/memory/dream` manifest are server-side and stay. |
| `backend/src/services/token-monitor.ts` loops 1, 2, 4 | Codex JWT expiry, Fly health, MiniMax key checks. Loop 3 (OAuth credential expiry) stays. |
| `backend/src/services/billing.ts` `checkDeployGate`, `softStopLapsedAccounts`, `startLapseCron` | Deploy gate and soft-stop are runtime-shaped. `checkUsageGate` stays until Phase 2 replaces it. |
| `onboarding/` package | The whole funnel ends in a provisioned machine |

Routes removed from `backend/src/api/routes.ts`:

- Deployment lifecycle: `create-and-deploy`, `:id/deploy` (POST, GET deployment, DELETE),
  `:id/soul`, `:id/start`, `:id/stop`, `:id/restart`, `:id/redeploy`, `:id/settings`,
  `:id/topic-prompts` (GET, PUT), `:id/logs`, `:id/logs/stream`, `:id/management-url`.
- Model router: `:id/models` (GET, PUT, DELETE).
- Backups: all four `/api/backups*`.
- Onboarding: the four `/api/onboarding/*` routes and the `/telegram` relay, plus
  `validateOnboardingApiKey`.
- Runtime Telegram and usage: `/api/webhooks/shared-bot`, `/api/webhooks/agent-bot/:deploymentId`,
  `/api/webhooks/usage`, `/api/initial-prompt-templates`.
- `:agentId/spend/reset`.
- `/api/auth/openai-device` (Codex device flow).

Startup in `backend/src/index.ts` loses `startBackupLoop`, `startDreamScheduler`,
`startLapseCron`, `flyLifecycleMonitor`, the shared-bot `setWebhook` block, and the
per-deployment webhook re-registration loop. `startTokenRefreshLoop`, the reduced
`startTokenMonitor`, `startUploadGcCron`, and the approvals bot init stay.

Config: `config/*.yaml` lose the `fly:` and `onboarding:` blocks. `backend/src/config/index.ts`
drops the matching fields and `sharedBotToken`. `GET /api/config/public` returns
`{ selfEnroll: boolean }` from Phase 2 onward; in Phase 1 it returns `{}`.

## 1.3 Backend: modify

- `backend/src/mcp/agent-endpoint.ts`: every `deployed_agents` read becomes an `agents`
  read. The runtime-aware naming helpers go; `shared/src/mcp-naming.ts` loses its runtime
  and server-name parameters and always renders bare names. The `mark_onboarded` builtin and its `updateMachineEnv` call are removed. The subscription gate
  block at line 1280 resolves the owner with `SELECT user_id FROM agents WHERE id = ?`
  (this is the fix for the dead join). The spend cap block is removed.
- `backend/src/api/routes.ts` `authenticateMcp`: without a bearer token it reads
  `agents.allow_unauthenticated`. Unknown agent id returns the same not-found shape as
  today. There is no longer a "missing row" branch.
- `PUT /api/agents/:id/mcp-unauthenticated` writes `agents.allow_unauthenticated`. The
  helm-admin latch is unchanged.
- `POST /api/agents/create-manual` becomes the body of `POST /api/agents`: insert the agent
  with `status = 'active'`, a generated `gateway_token`, `allow_unauthenticated = false`,
  then `enableDefaultServices`. The `create-manual` path is removed and
  the frontend calls `POST /api/agents`. The `soulMd` field is dropped.
- `GET /api/agents/:id/detail` drops the `deployment` block. `GET /api/agents` and
  `services/permissions.ts` read `allow_unauthenticated` from `agents` directly instead of
  the lateral join, and drop `telegramBotUsername`.
- The gateway-token lookups at `routes.ts:4991`, `:5046`, `:5937` read `agents.gateway_token`.
- `backend/src/notifications/telegram.ts:737` drops the runtime join and always renders
  external tool names.
- `shared/src/mcp-naming.ts`: `deploymentRuntime`, `AgentRuntime`, `LEGACY_MCP_SERVER_NAME`,
  and `BUILTIN_TOOLS.markOnboarded` are removed; `modelVisibleToolName`, `resolveToolTokens`,
  and `resolveSkillTokens` take only the text.
- `backend/src/services/email.ts` `sendReauthEmail` drops the anthropic, openai-codex,
  openai, minimax, fly, and docker provider labels.
- `credentials/vault.ts` and the credential routes drop the model-provider credential
  types (`anthropic`, `openai-codex`, `minimax`) if they are enumerated there.
- `backend/src/auth/index.ts:572`: the `x-reins-agent-secret` bypass in the auth guard
  stays; it is how memory and skills handlers call back into the API.

## 1.4 Frontend

Delete: `components/DeploymentPanel.tsx`, `LogViewer.tsx`, `LogsPanel.tsx`,
`ChatModal.tsx`, `CodexDeviceFlow.tsx`, `pages/Backups.tsx`, `pages/Agents.tsx`
(unrouted), and the `/backups` route.

Modify:

- `pages/AgentNew.tsx`: keep only the manual branch. Remove the agent-type chooser, the
  runtime selector, model provider fields, Telegram fields, and `createAndDeploy`. The page
  becomes name, description, then the MCP URL and connect instructions.
- `pages/AgentDetail.tsx`: remove `ModelsSection`, `TelegramGroupsSection`, the soul
  editor, and the start/stop/restart/redeploy/destroy mutations. What remains is name,
  description, MCP URL, connected clients, and the unauthenticated toggle.
- `pages/Permissions.tsx`: remove the `DeploymentPanel` import, state, Deploy button, and
  modal. Reword the copy at line 944 to point at the agent's detail page.
- `components/ReauthModal.tsx`: remove the Codex branch.
- `pages/Credentials.tsx`: remove model-provider credential types from the add flow.
- `api/client.ts`: remove the deployment, backups, models, `createManual`, and
  `openaiDevice` helpers. `agents.create` posts to `/api/agents`.
- `pages/Login.tsx`: the `not_authorized` message no longer mentions Telegram onboarding.
  Phase 2 replaces it.

## 1.5 Infrastructure, scripts, docs, tests

Delete: `docker/` entirely, `shared/BOOTSTRAP.md`, `admin/` entirely,
`scripts/build-agent-image.sh`, `scripts/check-token-scopes.mjs`,
`scripts/recreate-missing-agents.mjs`, `scripts/run-sandbox-tests.sh`,
`scripts/check-local-env.sh`, `onboarding/fly.toml`, `tests/image-test/`,
`tests/integration/`, the four project skills `image-test`, `integration-test`,
`redeploy-agent`, `onboarding-flow-test`, and the docs `docs/specs/ONBOARDING_BOT_SPEC.md`,
`docs/specs/telegram-groups-topics.md`, `docs/ops/ADMIN_TOOLS.md`,
`docs/ops/ADMIN_PROJECT_HANDOVER.md`, `docs/ops/UPDATE_API_KEY.md`, `docs/TELEGRAM_AGENTS.md`.

CI: `.github/workflows/deploy.yml` drops the onboarding deploy step. `ci.yml` drops the
`build-stub-image` job and the runtime env vars in the e2e job. Root `package.json` drops
`dev:onboarding`, `stub:build`, `stub:run`, and the `onboarding` workspace.

`CLAUDE.md` is rewritten in place: remove the Fly permission table, the production
deploy and test confirmation sections' runtime items (keep the `agenthelm-core` deploy
confirmation), the Agent Runtimes, Model Router, and Telegram Accounts sections (keep the
approvals bot and admin account), the runtime rows of the Project Skills table, the dead
secrets in the Fly secrets table, and the deleted docs from the Documentation Index. Add
this spec to the index. `docs/architecture/MCP_TOOL_INJECTION.md`, `docs/MEMORY.md` (dream
section), `TESTING.md`, `docs/ops/LOCAL_DEV_SETUP.md`, `docs/ops/PROD_SETUP.md`,
`docs/MULTI_AGENT_SETUP.md`, and `README.md` lose their runtime paragraphs.

Tests: delete `providers/fly.test.ts`, `providers/provider.test.ts`,
`services/agent-backup.test.ts`, `services/model-router.test.ts`, `services/spend.test.ts`,
`services/dream.test.ts`, `integration/user-journey.test.ts`,
`integration/user-journey-shared-bot.test.ts`, `frontend/src/components/LogViewer.test.tsx`.
Remove the `vi.mock` entries for `providers/index.js`, `agent-bot-relay.js`,
`model-router.js`, and `spend.js` from the eight suites that declare them. Update
`billing.test.ts`, `agent-endpoint.test.ts`, `mcp-naming.test.ts`, `AgentNew.test.tsx`, and
`e2e/user-journey.spec.ts` (drop the two Fly tests and `pollDeploymentStatus`). Add a
migration test that seeds agents with and without deployment rows and asserts the folded
columns.

## 1.6 Production operations (manual, each needs explicit confirmation)

After Phase 1 deploys through CI:

1. Destroy every remaining agent machine and app in the `personal` Fly org.
2. Delete the `agenthelm-onboarding` Fly app.
3. Unset on `agenthelm-core`: `FLY_API_TOKEN`, `FLY_ORG`, `OPENCLAW_APP`, `OPENCLAW_IMAGE`,
   `HERMES_IMAGE`, `ONBOARDING_API_KEY`, `ONBOARDING_BOT_WEBHOOK_SECRET`,
   `ONBOARDING_BOT_WEBHOOK_URL`, `SHARED_BOT_TOKEN`.
4. Retire `@SpecialAgentHelmBot` and the shared bot in BotFather. `@AgentHelmApprovalsBot`
   stays.

`max_machines_running = 1` in the root `fly.toml` stays. Approval executors and MCP rate
buckets are in-memory.

---

# Phase 2: Enrollment and trials

## 2.1 Data model

```sql
ALTER TABLE users ADD COLUMN IF NOT EXISTS first_name TEXT;
ALTER TABLE users ADD COLUMN IF NOT EXISTS last_name TEXT;
ALTER TABLE users ADD COLUMN IF NOT EXISTS trial_ends_at TEXT;
ALTER TABLE users ADD COLUMN IF NOT EXISTS trial_reminder_sent_at TEXT;
ALTER TABLE users ADD COLUMN IF NOT EXISTS trial_ended_notified_at TEXT;
ALTER TABLE users ALTER COLUMN password_hash DROP NOT NULL;
```

- `name` stays as the display name. On create it is `first_name + ' ' + last_name`,
  trimmed. Existing users keep their `name`; `first_name` and `last_name` stay null for
  them until edited.
- `trial_ends_at` is an ISO timestamp. Null means grandfathered: no trial, never blocked.
  A 0-day trial is `trial_ends_at = created_at`, so the user is blocked until they
  subscribe.
- `password_hash` becomes nullable. Google sign-in is the primary login. Password login
  rejects a user with a null hash with the same "invalid email or password" message.

## 2.2 Config

`config/development.yaml` and `config/production.yaml`:

```yaml
enrollment:
  self_enroll: true
  self_trial_days: 15
  admin_trial_days: [0, 30, 60, 90]
```

Read in `backend/src/config/index.ts` with env overrides `ENROLLMENT_SELF_ENROLL` and
`ENROLLMENT_SELF_TRIAL_DAYS`. `GET /api/config/public` returns `{ selfEnroll }` so the login
page can show or hide the trial pitch.

## 2.3 Access gate

One function in `backend/src/services/billing.ts` replaces `checkUsageGate`:

```ts
export type AccessReason = 'trial_ended' | 'subscription_lapsed' | 'subscription_canceled';
export interface AccessResult { allowed: boolean; reason?: AccessReason; trialEndsAt?: string }
export async function checkAccess(userId: string): Promise<AccessResult>
```

Evaluation order, first match wins:

1. `BYPASS_BILLING=true` → allowed.
2. `users.role = 'admin'` → allowed.
3. Subscription `active` → allowed.
4. Subscription `past_due` with `grace_until` in the future → allowed.
5. Subscription `past_due` past grace → blocked, `subscription_lapsed`.
6. Subscription `canceled` → blocked, `subscription_canceled`.
7. No subscription, `trial_ends_at` null → allowed (grandfathered).
8. No subscription, `trial_ends_at` in the future → allowed, with `trialEndsAt`.
9. Otherwise → blocked, `trial_ended`.

A canceled subscription blocks even inside a trial window, because the user made a choice.

Enforcement points:

- **MCP `tools/call`** in `backend/src/mcp/agent-endpoint.ts`, replacing the lapse gate
  block. Blocked calls return an `isError` result whose text names the reason and the
  billing URL, and are audit-logged with `reason: 'access_blocked'`. `initialize`,
  `tools/list`, and the `whoami` builtin are not gated, so a client can still render the
  message.
- **OAuth consent** in `backend/src/mcp/oauth/routes.ts`. After the session check and
  ownership check on both GET and POST, call `checkAccess(session.userId)`. On GET a blocked
  user sees a page with the reason and a link to `/pricing` instead of the consent form. On
  POST a blocked user gets `403 { error: 'access_denied', reason }`.
- **Dashboard** reads `GET /api/billing/status`, which gains `trialEndsAt`, `access:
  'active' | 'trial' | 'blocked'`, and `reason`.

Nothing else is gated. Creating agents, editing permissions, memory, and skills in the
dashboard stay available during a blocked period so the user can subscribe and resume
without losing setup.

## 2.4 Admin enrollment

`POST /api/admin/users` in `backend/src/auth/index.ts` takes:

```ts
{ firstName: string; lastName: string; email: string; trialDays: 0 | 30 | 60 | 90; role?: 'user' | 'admin' }
```

`trialDays` must be one of `config.enrollment.adminTrialDays`. Password is no longer
accepted here; the existing reset-password route remains for admins who want to set one.
The route inserts the user with `trial_ends_at = now + trialDays`, `password_hash = null`,
then sends the invite email and captures a PostHog `user_invited` event with `trialDays`.

`PATCH /api/admin/users/:id` additionally accepts `firstName`, `lastName`, and
`trialEndsAt` (ISO string or null) so an admin can extend, shorten, or remove a trial.

`GET /api/admin/users` returns the new columns.

`frontend/src/pages/AdminUsers.tsx`: the create form has first name, last name, email,
role, and a trial-length select. The table gains a Trial column showing the end date and
days remaining, or "none" for grandfathered users, with an inline edit to change it.

## 2.5 Google self-enrollment

In the Google SSO callback in `backend/src/auth/index.ts`, when the email is not found:

1. If `config.enrollment.selfEnroll` is false, redirect with `login_error=not_authorized`
   as today.
2. Otherwise insert a user: `first_name` and `last_name` from Google's `given_name` and
   `family_name` (the `profile` scope already returns them), `name` from Google's `name`,
   `role = 'user'`, `status = 'active'`, `password_hash = null`,
   `trial_ends_at = now + selfTrialDays`.
3. Send the welcome email. Capture PostHog `user_enrolled` with `method: 'google'`.
4. Sign the session and redirect as for any login.

A user with `status = 'suspended'` or `'deleted'` is not re-created; the existing
"not authorized" branch handles them because the lookup is by email regardless of status.
The lookup changes from `WHERE email = ? AND status = 'active'` to `WHERE email = ?`
followed by a status check, so a deleted user's email cannot re-enroll for a fresh trial.

`frontend/src/pages/Login.tsx`: when `selfEnroll` is true the subtitle reads "Sign in with
Google to start your 15-day free trial" (days from config). The `not_authorized` message
becomes "Sign-ups are closed. Ask your administrator for an invite."

## 2.6 Emails

Four templates in `backend/src/services/email.ts`, each with html and text bodies,
sent through the existing `sendEmail`:

| Function | Sent when | Content |
|---|---|---|
| `sendInviteEmail` | Admin creates a user | Greeting by first name, who invited them (the admin's name), trial length, "Sign in with Google using this address" and the dashboard URL. For a 0-day trial: "Subscribe to get started" and the pricing URL. |
| `sendWelcomeEmail` | Google self-enrollment | Greeting, trial end date, the MCP setup doc link (`docs/MULTI_AGENT_SETUP.md` on the public site), pricing URL. |
| `sendTrialReminderEmail` | 3 days before `trial_ends_at` | Days left, what stops working, pricing URL. |
| `sendTrialEndedEmail` | At `trial_ends_at` | What stopped, pricing URL. |

Email failures are logged and never fail the request that triggered them.

## 2.7 Trial cron

`startTrialCron` in `backend/src/services/billing.ts`, started from `backend/src/index.ts`,
runs hourly like the old lapse cron did:

- Reminder: users with no subscription row, `trial_ends_at` between now and now + 3 days,
  `trial_reminder_sent_at` null. Send, then stamp.
- Ended: users with no subscription row, `trial_ends_at` in the past,
  `trial_ended_notified_at` null. Send, then stamp.

Both stamp before sending so a Mailgun outage cannot cause repeats. A trial extended by an
admin after the reminder went out does not resend; the stamp stays.

## 2.8 Billing page and Stripe

- `frontend/src/pages/Billing.tsx` shows a Trial state: end date, days left, and a subscribe
  button to `/pricing`. A blocked state shows the reason and the same button.
- A dashboard banner in `App.tsx` layout shows "Trial ends in N days" when `access ===
  'trial'` and N ≤ 7, and "Your trial has ended" when blocked. Both link to `/pricing`.
- `POST /api/billing/checkout`: when the user is in an active trial, pass
  `subscription_data: { trial_end: <unix trial_ends_at> }` to Stripe Checkout so the first
  charge lands when the trial would have ended. Stripe requires `trial_end` to be at least
  48 hours ahead; below that, omit it.
- On `checkout.session.completed` nothing changes: an active subscription row wins over
  the trial in `checkAccess`.

## 2.9 Tests

- `billing.test.ts`: table-driven cases for all nine `checkAccess` branches, and the cron's
  two selects plus stamp-before-send.
- `auth/auth.test.ts`: admin create validates `trialDays`, sets `trial_ends_at`, sends the
  invite, rejects a password field; Google callback creates a user with a 15-day trial when
  enabled, rejects when disabled, refuses a deleted user's email; password login rejects a
  null hash.
- `mcp/agent-endpoint.test.ts`: `tools/call` blocked for `trial_ended`, allowed in trial,
  allowed for admin; `tools/list` unaffected.
- `mcp/oauth/routes.test.ts`: consent GET renders the blocked page, POST returns 403.
- `email` template tests: each template renders the right URLs and the 0-day variant.
- Frontend: `AdminUsers` form submits the new shape; `Login` shows the trial pitch when
  `selfEnroll`; `Billing` renders trial and blocked states.
- `e2e/user-journey.spec.ts`: session-injected user with a future trial can create an agent
  and see the trial banner.

## Out of scope

- New pricing or plan changes.
- Domain allowlists or invite codes for self-enrollment. The config switch is the only
  control.
- A server-side dream process to replace the machine push.
- Stripe-native trials or card-up-front trials.
- Deleting the `applicants` table data in production.
