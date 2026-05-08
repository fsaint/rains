---
name: integration-test
description: Run the full Reins integration test suite — all 8 test cases (6 runtime×provider combinations + 2 shared bot cases) via Playwright UI + Telethon Telegram verification. Use when the user asks to "run integration tests", "test all combinations", "verify the bots work", or "run e2e tests". Supports dev (default) and production targets.
---

# Integration Test — All Runtime × Provider + Shared Bot Cases

Tests all 6 combinations of runtime (OpenClaw, Hermes) × LLM provider (Anthropic, OpenAI, MiniMax) plus 2 shared bot cases (OpenClaw and Hermes routing by telegram_user_id), creating agents through the UI and verifying bot replies via real Telegram messages.

## Targets

| Target | Frontend URL | Env file | Agent deployment |
|--------|-------------|----------|-----------------|
| `dev` (default) | `http://localhost:6173` | `tests/integration/.env.test` | Fly.io `reins-dev` org |
| `prod` | `https://app.agenthelm.mom` | `tests/integration/.env.prod-test` | Fly.io `personal` org |

Both targets deploy agents to Fly.io — dev uses the `reins-dev` org for isolation. The backend and frontend still run locally for the dev target.

## Prerequisites

### Test credentials file

Secrets live in `tests/integration/.env.test` (dev) or `tests/integration/.env.prod-test` (prod), both gitignored. Each file must have:

```
# LLM provider API keys
ANTHROPIC_API_KEY=sk-ant-api03-...
OPENAI_API_KEY=sk-proj-...
MINIMAX_API_KEY=sk-cp-...

# Reins backend
REINS_URL=http://localhost:5001          # or https://app.agenthelm.mom for prod
REINS_FRONTEND_URL=http://localhost:6173  # or https://app.agenthelm.mom for prod
REINS_ADMIN_EMAIL=admin@reins.local
REINS_ADMIN_PASSWORD=testpass123

# Your Telegram user ID (numeric) — used as the allowed-user for each bot
TELEGRAM_USER_ID=5982613183

# Bot tokens — all 6 can share one token if tests run sequentially
BOT_TOKEN_OC_ANTHROPIC=<token>
BOT_TOKEN_OC_OPENAI=<token>
BOT_TOKEN_OC_MINIMAX=<token>
BOT_TOKEN_H_ANTHROPIC=<token>
BOT_TOKEN_H_OPENAI=<token>
BOT_TOKEN_H_MINIMAX=<token>

# Shared bot (platform-owned, routes by telegram_user_id)
# Dev: @AgentHelmDevPilot_bot  Prod: @AgentHelmPilot_bot
SHARED_BOT_TOKEN=<token>
SHARED_BOT_WEBHOOK_SECRET=<hex secret>

# Telethon (real Telegram user account for sending test messages)
TELEGRAM_TEST_MODE=telethon
TELEGRAM_API_ID=<id from https://my.telegram.org/apps>
TELEGRAM_API_HASH=<hash from https://my.telegram.org/apps>
TELEGRAM_PHONE=+1xxxxxxxxxx
```

Root `.env` must have `ANTHROPIC_API_KEY` (backend passes it to agent machines server-side) and `REINS_PUBLIC_URL` set to an externally reachable URL so Fly machines can call back to the local backend:

```
# /Users/fsaint/git/reins/.env
ANTHROPIC_API_KEY=sk-ant-api03-...
REINS_PUBLIC_URL=https://reins-dev.btv.pw   # must be reachable from Fly machines
FLY_ORG=reins-dev
FLY_API_TOKEN=<dev org token>
```

If the dev backend is not exposed externally, use a tunnel (e.g. `ngrok http 5001`) and set `REINS_PUBLIC_URL` to the tunnel URL.

### Telethon session

On first use, create the Telethon session file (one-time interactive login):

```bash
python3 /tmp/tg_login.py
```

This writes `~/.reins_test_telethon.session`. After that the session is reused without prompts.

Two Telethon helper scripts are used:

**`/tmp/tg_send_and_wait_filtered.py`** — sends a message and waits for the first non-progress reply. Skips `🐍`, `⚡`, `📬`, `⚙️` prefixes (Hermes progress/welcome). Handles OpenClaw's streaming responses by listening to MessageEdited events with a 3-second settle timer. Use for the basic ping test:

```bash
source tests/integration/.env.test
TELEGRAM_API_ID=$TELEGRAM_API_ID \
TELEGRAM_API_HASH=$TELEGRAM_API_HASH \
TELEGRAM_PHONE=$TELEGRAM_PHONE \
python3 /tmp/tg_send_and_wait_filtered.py <bot_username> "<message>" [timeout_secs]
```

**`/tmp/tg_mcp_tool_test.py`** — sends a message, optionally polls Reins API for an approval and approves/rejects it, then returns the final bot reply. Handles streaming via MessageEdited events + settle timer. Uses `curl` for Reins API calls. Use for the dev-sandbox permission tests:

```bash
source tests/integration/.env.test
TELEGRAM_API_ID=$TELEGRAM_API_ID \
TELEGRAM_API_HASH=$TELEGRAM_API_HASH \
TELEGRAM_PHONE=$TELEGRAM_PHONE \
REINS_URL=$REINS_URL \
REINS_ADMIN_EMAIL=$REINS_ADMIN_EMAIL \
REINS_ADMIN_PASSWORD=$REINS_ADMIN_PASSWORD \
python3 /tmp/tg_mcp_tool_test.py <bot_username> <agent_id> "<message>" <action> [timeout_secs]
# action: "none" | "approve" | "reject"
```

**`/tmp/run_sandbox_tests.sh`** — orchestrates all 4 sandbox permission tests for a given agent. Handles machine restart (needed so OpenClaw picks up newly-enabled dev-sandbox tools), approval polling, and result checking:

```bash
source /tmp/run_sandbox_tests.sh
sandbox_tests <bot_username> <agent_id>
```

The cookie file `/tmp/reins_test_cookies.txt` must contain a valid admin session (created automatically by `run_sandbox_tests.sh`, or manually):

```bash
source tests/integration/.env.test
curl -s -c /tmp/reins_test_cookies.txt -X POST $REINS_URL/api/auth/login \
  -H "Content-Type: application/json" \
  -d "{\"email\":\"$REINS_ADMIN_EMAIL\",\"password\":\"$REINS_ADMIN_PASSWORD\"}"
```

### Local services running

```bash
# Backend (terminal 1)
npm run dev:backend

# Frontend (terminal 2)
npm run dev:frontend   # typically http://localhost:6173
```

---

## Test matrix

| # | Runtime  | Provider  | Model default       | Key source       | Bot mode    |
|---|----------|-----------|---------------------|------------------|-------------|
| 1 | OpenClaw | Anthropic | claude-sonnet-4-5   | Server env var   | Per-user    |
| 2 | OpenClaw | OpenAI    | gpt-4.1             | UI API key field | Per-user    |
| 3 | OpenClaw | MiniMax   | MiniMax-M2.7        | UI API key field | Per-user    |
| 4 | Hermes   | Anthropic | claude-sonnet-4-5   | Server env var   | Per-user    |
| 5 | Hermes   | OpenAI    | gpt-4.1             | UI API key field | Per-user    |
| 6 | Hermes   | MiniMax   | MiniMax-M2.7        | UI API key field | Per-user    |
| 7 | OpenClaw | MiniMax   | MiniMax-M2.7        | UI API key field | Shared bot  |
| 8 | Hermes   | MiniMax   | MiniMax-M2.7        | UI API key field | Shared bot  |

Run tests **sequentially** — tests 1–6 can share one bot token because each fully creates → verifies → deletes before the next starts. Tests 7–8 use the platform shared bot (`SHARED_BOT_TOKEN`) and require `SHARED_BOT_TOKEN` + `SHARED_BOT_WEBHOOK_SECRET` set on the backend.

**Shared bot bots:**
- Dev: `@AgentHelmDevPilot_bot`
- Prod: `@AgentHelmPilot_bot`

---

## Per-test procedure

### Step 1 — Create agent via UI (Playwright)

Navigate to `http://localhost:6173/agents/new` and click **Hosted Agent**.

**Step 1/4 — Basics:**
- Agent Name: `Test: <Runtime> + <Provider>`
- Telegram Bot Token: value of `BOT_TOKEN_<RUNTIME>_<PROVIDER>` from `.env.test`
- Telegram User ID: `TELEGRAM_USER_ID` from `.env.test`

**Step 2/4 — Model:**
- Runtime: click **OpenClaw** or **Hermes**
- Provider: click the provider button
  - For Anthropic: no extra fields
  - For OpenAI: fill API key (`OPENAI_API_KEY`)
  - For MiniMax: fill API key (`MINIMAX_API_KEY`)

**Step 3/4 — Personality:** accept defaults, click Next.

**Step 4/4 — Deploy:** click **Create & Deploy**.

Note the agent ID from the URL (e.g. `/agents/uhfcEbkGWF9XjE3BsQ-ZM` → `uhfcEbkGWF9XjE3BsQ-ZM`).

### Step 2 — Wait for Fly machine to start

Watch the agent detail page in the UI for status to change to `running`. Fly machines in the dev org typically start within 30–60 s.

To watch from the CLI (get the app name from the UI under Management):

```bash
# Check machine state
fly machine list --app <fly-app-name> --org reins-dev

# Tail logs
fly logs --app <fly-app-name> --org reins-dev
```

- **OpenClaw**: health check passes when the gateway is up (~60 s on cold boot)
- **Hermes**: ready once it connects to Telegram (~15–30 s after machine starts)

### Step 3 — Basic ping test via Telethon

The bot username is shown in the UI (or look it up via `@BotFather`):

```bash
source tests/integration/.env.test
TELEGRAM_API_ID=$TELEGRAM_API_ID \
TELEGRAM_API_HASH=$TELEGRAM_API_HASH \
TELEGRAM_PHONE=$TELEGRAM_PHONE \
python3 /tmp/tg_send_and_wait_filtered.py <bot_username> \
  "What is 7+8? Reply with ONLY the number, nothing else." 90
```

**Expected output:** `15`

**Hermes quirks:**
- First message to a new Hermes bot triggers a welcome message (`📬 No home channel...`). Use `tg_send_and_wait_filtered.py` — it automatically skips those.
- Hermes may send tool-use progress lines (`🐍`, `⚙️`). The filtered script skips those too.
- After the welcome message, the bot may reply "⚡ Interrupting..." — send once more.

**OpenClaw + MiniMax quirk:** If the ping returns an error about "Unknown model: openai/MiniMax-M2.7", the models.json poller hasn't run yet. Wait 30 s and retry — the entrypoint patches models.json after the gateway becomes healthy.

### Step 4 — Dev Sandbox permission tests

Run the orchestration script after the ping passes:

```bash
source /tmp/run_sandbox_tests.sh
sandbox_tests <bot_username> <agent_id>
```

This script:
1. Enables dev-sandbox on the agent via API (access=true, level=full)
2. **Restarts the Fly machine** so OpenClaw picks up the new tools (OpenClaw caches tools at startup)
3. Waits 15 s for Telegram reconnect
4. Runs 4 scenarios in sequence:
   - **ALLOWED** (`sandbox_echo`) — expects immediate echo of "ping-allowed"
   - **APPROVE** (`sandbox_send_message`) — script polls approval queue and approves; expects delivery confirmation
   - **DENY** (`sandbox_send_message`) — script rejects the pending approval; expects denial message
   - **BLOCKED** (`sandbox_delete_item`) — tool is not in tools/list; expects bot to report it's unavailable

**Expected:** `4/4 passed, 0/4 failed`

To restart a Fly machine manually (e.g. after enabling dev-sandbox):

```bash
# Get the machine ID from the UI or:
fly machine list --app <fly-app-name> --org reins-dev
fly machine restart <machine-id> --app <fly-app-name> --org reins-dev
```

**Manual step-by-step** (if you need to run scenarios individually):

```bash
AGENT_ID=<id>
source tests/integration/.env.test
TENV="TELEGRAM_API_ID=$TELEGRAM_API_ID TELEGRAM_API_HASH=$TELEGRAM_API_HASH TELEGRAM_PHONE=$TELEGRAM_PHONE REINS_URL=$REINS_URL REINS_ADMIN_EMAIL=$REINS_ADMIN_EMAIL REINS_ADMIN_PASSWORD=$REINS_ADMIN_PASSWORD"

# ALLOWED
eval "$TENV python3 /tmp/tg_mcp_tool_test.py <bot_username> $AGENT_ID \
  'Call the sandbox_echo tool with message ping-allowed. Report the tool result.' none 90"

# APPROVE
eval "$TENV python3 /tmp/tg_mcp_tool_test.py <bot_username> $AGENT_ID \
  'Call sandbox_send_message: to=ops@reins.io, subject=approve-test, body=please approve. Report result.' approve 120"

# DENY
eval "$TENV python3 /tmp/tg_mcp_tool_test.py <bot_username> $AGENT_ID \
  'Call sandbox_send_message: to=ops@reins.io, subject=deny-test, body=denied. Report what happened.' reject 120"

# BLOCKED
eval "$TENV python3 /tmp/tg_mcp_tool_test.py <bot_username> $AGENT_ID \
  'Call ONLY the sandbox_delete_item tool to delete item-1. Do NOT call any other tool. If sandbox_delete_item is not in your toolset, say so explicitly.' none 90"
```

### Step 5 — Tear down

Delete via the Reins UI (Agents → Delete) — this destroys the Fly machine and app automatically.

Or via CLI:
```bash
fly machine destroy <machine-id> --app <fly-app-name> --org reins-dev --force
fly apps destroy <fly-app-name> --org reins-dev --yes
```

---

## Known issues and workarounds

### REINS_PUBLIC_URL must be externally reachable

Fly machines need to call back to the local backend for MCP tool calls. If `REINS_PUBLIC_URL` points to `localhost`, MCP calls from agents will fail silently.

**Fix:** Set `REINS_PUBLIC_URL` in root `.env` to an externally reachable URL:
- If the dev backend is tunneled: use the tunnel URL (e.g. ngrok)
- If the dev backend is behind a domain: use that (e.g. `https://reins-dev.btv.pw`)

Then restart the backend. All new machines will embed the correct URL.

### OpenClaw + MiniMax: "Unknown model: openai/MiniMax-M2.7"

The entrypoint patches `models.json` after the gateway becomes healthy. On first boot there can be a race. Wait 30–60 s and retry the ping — the background poller resolves it automatically. No manual action needed.

### OpenClaw streams responses via message edits

OpenClaw sends an initial (often incomplete) Telegram message then progressively edits it. `tg_send_and_wait_filtered.py` and `tg_mcp_tool_test.py` both listen to `MessageEdited` events and use a 3-second settle timer after the last edit. Do not use the older `tg_send_and_wait.py` (no edit support).

### Machine restart required after enabling dev-sandbox

OpenClaw caches the MCP tool list at startup. After enabling dev-sandbox via API, restart the Fly machine:

```bash
fly machine restart <machine-id> --app <fly-app-name> --org reins-dev
```

The `run_sandbox_tests.sh` script does this automatically via the Reins restart API.

### Hermes + OpenAI: org-verification / encrypted-content errors

Handled automatically by the Hermes entrypoint (`entrypoint.sh`) which maps `MODEL_PROVIDER=openai` to the `custom` provider with `reasoning_effort: none`. No manual intervention needed as long as the image is current.

### Hermes progress prefixes to skip

Hermes emits several progress-indicator prefixes that are not final replies. All scripts skip: `🐍` (code execution), `⚡` (interrupting), `📬` (no home channel), `⚙️` (MCP tool calls). If you capture one of these as the reply, ensure your scripts have the updated `SKIP_PREFIXES` tuple.

### Hermes + MiniMax BLOCKED test: model chooses substitute tool

MiniMax, when asked to "delete" something and `sandbox_delete_item` isn't in its tools list, may attempt `sandbox_update_item` as a substitute. This creates a pending approval and the bot goes silent.

**Fix:** Use the explicit prompt in the BLOCKED scenario (already included in `run_sandbox_tests.sh`).

If the bot is stuck, reject all pending approvals:
```bash
source tests/integration/.env.test
curl -s -b /tmp/reins_test_cookies.txt "$REINS_URL/api/approvals?agentId=$AGENT_ID" | \
  python3 -c "import sys,json; [print(a['id']) for a in json.load(sys.stdin)['data'] if a['status']=='pending']" | \
  while read id; do
    curl -s -b /tmp/reins_test_cookies.txt -X POST "$REINS_URL/api/approvals/$id/reject" \
      -H "Content-Type: application/json" -d '{}'
  done
```

### Bot token conflict (409 Conflict)

Only one process can poll a bot token at a time. If a previous machine is still running with the same token, destroy it first (Step 5), then create the new agent.

### GET /api/approvals admin visibility

The `GET /api/approvals` endpoint allows admin users to see approvals for any agent regardless of ownership. Testing with `admin@reins.local` covers all agents.

---

## Quick checklist

**Dev:**
```
[ ] tests/integration/.env.test exists and has all keys (incl. SHARED_BOT_TOKEN)
[ ] ANTHROPIC_API_KEY in root .env
[ ] SHARED_BOT_TOKEN + SHARED_BOT_WEBHOOK_SECRET in root .env (dev: @AgentHelmDevPilot_bot)
[ ] REINS_PUBLIC_URL in root .env points to externally reachable backend URL
[ ] FLY_ORG=reins-dev and FLY_API_TOKEN set in root .env
[ ] Backend running (npm run dev:backend)
[ ] Frontend running (npm run dev:frontend)
[ ] fly CLI authenticated (fly auth whoami)
[ ] Telethon session exists (~/.reins_test_telethon.session)
[ ] No orphan Fly machines from previous runs (fly machine list --org reins-dev)
[ ] /tmp/run_sandbox_tests.sh, /tmp/tg_mcp_tool_test.py, /tmp/tg_send_and_wait_filtered.py all present
```

**Prod (additional/different):**
```
[ ] tests/integration/.env.prod-test exists and has all keys (incl. SHARED_BOT_TOKEN)
[ ] SHARED_BOT_TOKEN + SHARED_BOT_WEBHOOK_SECRET set on agenthelm-core (prod: @AgentHelmPilot_bot)
[ ] Telethon session exists (~/.reins_test_telethon.session)
[ ] fly CLI authenticated (fly auth whoami)
[ ] /tmp/run_sandbox_tests.sh, /tmp/tg_mcp_tool_test.py, /tmp/tg_send_and_wait_filtered.py all present
```

When invoking sandbox_tests for prod, pass the env file as the third argument:
```bash
source /tmp/run_sandbox_tests.sh
sandbox_tests <bot_username> <agent_id> /Users/fsaint/git/reins/tests/integration/.env.prod-test
```

```
Test 1: OpenClaw + Anthropic        (per-user)   [ ] ping [ ] allowed [ ] approve [ ] reject [ ] blocked
Test 2: OpenClaw + OpenAI           (per-user)   [ ] ping [ ] allowed [ ] approve [ ] reject [ ] blocked
Test 3: OpenClaw + MiniMax          (per-user)   [ ] ping [ ] allowed [ ] approve [ ] reject [ ] blocked
Test 4: Hermes + Anthropic          (per-user)   [ ] ping [ ] allowed [ ] approve [ ] reject [ ] blocked
Test 5: Hermes + OpenAI             (per-user)   [ ] ping [ ] allowed [ ] approve [ ] reject [ ] blocked
Test 6: Hermes + MiniMax            (per-user)   [ ] ping [ ] allowed [ ] approve [ ] reject [ ] blocked
Test 7: OpenClaw + MiniMax          (shared bot) [ ] ping [ ] routing [ ] second-user-ignored
Test 8: Hermes + MiniMax            (shared bot) [ ] ping [ ] routing [ ] second-user-ignored
```

### Shared bot test procedure (Tests 7 & 8)

These tests verify that the shared platform bot routes messages to the correct agent by `telegram_user_id`.

**Prerequisites:** `SHARED_BOT_TOKEN` and `SHARED_BOT_WEBHOOK_SECRET` must be set on the backend before starting. Restart the backend if you just added them.

**Step 1 — Create agent via UI (no bot token field)**

Navigate to `/agents/new` → Hosted Agent. The Telegram Bot Token field will be **hidden** and replaced with "Uses platform bot". Fill in:
- Agent Name: `Test 7: OpenClaw Shared Bot` (or `Test 8: Hermes Shared Bot`)
- Telegram User ID: `TELEGRAM_USER_ID` from `.env.test`
- Model: MiniMax + `MINIMAX_API_KEY`
- Runtime: OpenClaw (Test 7) or Hermes (Test 8)

**Step 2 — Wait for machine to start** (same as per-user tests)

**Step 3 — Ping test via shared bot**

Send via Telethon to the shared bot username (not a per-agent bot):

```bash
source tests/integration/.env.test
SHARED_BOT_USERNAME=AgentHelmDevPilot_bot   # or AgentHelmPilot_bot for prod

TELEGRAM_API_ID=$TELEGRAM_API_ID \
TELEGRAM_API_HASH=$TELEGRAM_API_HASH \
TELEGRAM_PHONE=$TELEGRAM_PHONE \
python3 /tmp/tg_send_and_wait_filtered.py $SHARED_BOT_USERNAME \
  "What is 7+8? Reply with ONLY the number, nothing else." 90
```

**Expected:** `15`

**Step 4 — Routing verification**

Confirm the agent's DB record has `is_shared_bot=1` and `telegram_user_id=<TELEGRAM_USER_ID>`:

```bash
source tests/integration/.env.test
curl -s -b /tmp/reins_test_cookies.txt \
  "$REINS_URL/api/agents/<agent_id>/deployment" | python3 -m json.tool | grep -E "is_shared|telegram_user"
```

**Step 5 — Unknown-user test**

From a different Telegram account (or using a second Telethon session), message the shared bot. The bot should reply "I don't have an agent set up for you yet."

**Step 6 — Tear down** (same as per-user tests)
