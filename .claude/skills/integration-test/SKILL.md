---
name: integration-test
description: Run the full Reins integration test suite — all 6 runtime×provider combinations (OpenClaw+Hermes × Anthropic+OpenAI+MiniMax) via Playwright UI + Telethon Telegram verification. Use when the user asks to "run integration tests", "test all combinations", "verify the bots work", or "run e2e tests". Supports local (default) and production targets.
---

# Integration Test — All Runtime × Provider Combinations

Tests all 6 combinations of runtime (OpenClaw, Hermes) × LLM provider (Anthropic, OpenAI, MiniMax) by creating agents through the UI and verifying bot replies via real Telegram messages.

## Targets

| Target | Frontend URL | Env file | Agent deployment |
|--------|-------------|----------|-----------------|
| `local` (default) | `http://localhost:6173` | `tests/integration/.env.test` | Local Docker |
| `prod` | `https://reins.btv.pw` | `tests/integration/.env.prod-test` | Fly.io |

To run against production, source `.env.prod-test` instead of `.env.test` and navigate Playwright to `$REINS_FRONTEND_URL`. All other steps are the same except container restart (see below).

## Prerequisites

### Test credentials file

Secrets live in `tests/integration/.env.test` (local) or `tests/integration/.env.prod-test` (prod), both gitignored. Each file must have:

```
# LLM provider API keys
ANTHROPIC_API_KEY=sk-ant-api03-...
OPENAI_API_KEY=sk-proj-...
MINIMAX_API_KEY=sk-cp-...

# Reins backend
REINS_URL=http://localhost:5001          # or https://reins.btv.pw for prod
REINS_FRONTEND_URL=http://localhost:6173  # or https://reins.btv.pw for prod
REINS_ADMIN_EMAIL=admin@reins.local
REINS_ADMIN_PASSWORD=testpass123

# Your Telegram user ID (numeric) — used as the allowed-user for each bot
TELEGRAM_USER_ID=5982613183

# Bot tokens — for local dev all 6 can share one token if tests run sequentially
BOT_TOKEN_OC_ANTHROPIC=<token>
BOT_TOKEN_OC_OPENAI=<token>
BOT_TOKEN_OC_MINIMAX=<token>
BOT_TOKEN_H_ANTHROPIC=<token>
BOT_TOKEN_H_OPENAI=<token>
BOT_TOKEN_H_MINIMAX=<token>

# Telethon (real Telegram user account for sending test messages)
TELEGRAM_TEST_MODE=telethon
TELEGRAM_API_ID=<id from https://my.telegram.org/apps>
TELEGRAM_API_HASH=<hash from https://my.telegram.org/apps>
TELEGRAM_PHONE=+1xxxxxxxxxx
```

The `ANTHROPIC_API_KEY` must also be in the root `.env` file (OpenClaw reads it from the backend's server-side environment — it is never passed from the UI):

```
# /Users/fsaint/git/reins/.env
ANTHROPIC_API_KEY=sk-ant-api03-...
```

**Critical:** `REINS_PUBLIC_URL` in root `.env` must be `http://host.docker.internal:5001` (not the external domain) so local Docker containers can reach the backend for MCP calls:

```
REINS_PUBLIC_URL=http://host.docker.internal:5001
```

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

**`/tmp/tg_mcp_tool_test.py`** — sends a message, optionally polls Reins API for an approval and approves/rejects it, then returns the final bot reply. Handles streaming via MessageEdited events + settle timer. Uses `curl` for Reins API calls (not Python urllib, which breaks with localhost cookies). Use for the dev-sandbox permission tests:

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

**`/tmp/run_sandbox_tests.sh`** — orchestrates all 4 sandbox permission tests for a given agent. Handles container restart (needed so OpenClaw picks up newly-enabled dev-sandbox tools), approval polling, and result checking:

```bash
source /tmp/run_sandbox_tests.sh
sandbox_tests <bot_username> <agent_id>
```

The cookie file `/tmp/reins_test_cookies.txt` must contain a valid admin session (created automatically by `run_sandbox_tests.sh`, or manually):

```bash
source tests/integration/.env.test
curl -s -c /tmp/reins_test_cookies.txt -X POST http://localhost:5001/api/auth/login \
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

### Docker images built

```bash
# OpenClaw image
docker build -f docker/Dockerfile -t reins-openclaw:latest docker/

# Hermes image
docker build -f docker/hermes/Dockerfile -t reins-hermes:latest docker/hermes/
```

---

## Test matrix

| # | Runtime  | Provider  | Model default       | Key source       |
|---|----------|-----------|---------------------|------------------|
| 1 | OpenClaw | Anthropic | claude-sonnet-4-5   | Server env var   |
| 2 | OpenClaw | OpenAI    | gpt-4.1             | UI API key field |
| 3 | OpenClaw | MiniMax   | MiniMax-M2.7        | UI API key field |
| 4 | Hermes   | Anthropic | claude-sonnet-4-5   | Server env var   |
| 5 | Hermes   | OpenAI    | gpt-4.1             | UI API key field |
| 6 | Hermes   | MiniMax   | MiniMax-M2.7        | UI API key field |

Run tests **sequentially** — all 6 can share one bot token because each test fully creates → verifies → deletes before the next starts.

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

### Step 2 — Wait for container / machine

**Local:**
```bash
# Watch until container appears (OpenClaw also shows "(healthy)" — Hermes has no HTTP health check)
docker ps --format "{{.Names}}\t{{.Status}}" | grep "reins-"
```
- **OpenClaw**: wait for `(healthy)` — typically 20–60 s
- **Hermes**: container shows `Up N seconds`; ready once it connects to Telegram (~10–15 s after start)

The container name is `reins-` + first 12 chars of the `deployed_agents` instance ID. The UI shows it under Management → App Name.

**Prod:**
Watch the agent detail page in the UI for status to change to `running`. Fly machines typically start within 30–60 s. The UI shows the Fly app name and machine ID under Management.

### Step 3 — Basic ping test via Telethon

The bot username is shown in the UI (or look it up via `@BotFather`). For the test bot `@EmailAndCalendar_bot`:

```bash
source tests/integration/.env.test
TELEGRAM_API_ID=$TELEGRAM_API_ID \
TELEGRAM_API_HASH=$TELEGRAM_API_HASH \
TELEGRAM_PHONE=$TELEGRAM_PHONE \
python3 /tmp/tg_send_and_wait_filtered.py EmailAndCalendar_bot \
  "What is 7+8? Reply with ONLY the number, nothing else." 90
```

**Expected output:** `15`

**Hermes quirks:**
- First message to a new Hermes bot triggers a welcome message (`📬 No home channel...`). Use `tg_send_and_wait_filtered.py` — it automatically skips those.
- Hermes may send tool-use progress lines (`🐍`, `⚙️`). The filtered script skips those too.
- After the welcome message, the bot may reply "⚡ Interrupting..." — send once more.

**OpenClaw + MiniMax quirk:** If the ping returns an error about "Unknown model: openai/MiniMax-M2.7", the models.json poller hasn't run yet. Apply the manual patch (see Known Issues) and resend.

### Step 4 — Dev Sandbox permission tests

Run the orchestration script after the ping passes:

```bash
source /tmp/run_sandbox_tests.sh
sandbox_tests EmailAndCalendar_bot <agent_id>
```

This script:
1. Enables dev-sandbox on the agent via API (access=true, level=full)
2. **Restarts the container** so OpenClaw picks up the new tools (OpenClaw caches tools at startup)
3. Waits 15 s for Telegram reconnect
4. Runs 4 scenarios in sequence:
   - **ALLOWED** (`sandbox_echo`) — expects immediate echo of "ping-allowed"
   - **APPROVE** (`sandbox_send_message`) — script polls approval queue and approves; expects delivery confirmation
   - **DENY** (`sandbox_send_message`) — script rejects the pending approval; expects denial message
   - **BLOCKED** (`sandbox_delete_item`) — tool is not in tools/list; expects bot to report it's unavailable

**Expected:** `4/4 passed, 0/4 failed`

**Manual step-by-step** (if you need to run scenarios individually):

```bash
AGENT_ID=<id>
source tests/integration/.env.test
TENV="TELEGRAM_API_ID=$TELEGRAM_API_ID TELEGRAM_API_HASH=$TELEGRAM_API_HASH TELEGRAM_PHONE=$TELEGRAM_PHONE REINS_URL=$REINS_URL REINS_ADMIN_EMAIL=$REINS_ADMIN_EMAIL REINS_ADMIN_PASSWORD=$REINS_ADMIN_PASSWORD"

# ALLOWED
eval "$TENV python3 /tmp/tg_mcp_tool_test.py EmailAndCalendar_bot $AGENT_ID \
  'Call the sandbox_echo tool with message ping-allowed. Report the tool result.' none 90"

# APPROVE
eval "$TENV python3 /tmp/tg_mcp_tool_test.py EmailAndCalendar_bot $AGENT_ID \
  'Call sandbox_send_message: to=ops@reins.io, subject=approve-test, body=please approve. Report result.' approve 120"

# DENY
eval "$TENV python3 /tmp/tg_mcp_tool_test.py EmailAndCalendar_bot $AGENT_ID \
  'Call sandbox_send_message: to=ops@reins.io, subject=deny-test, body=denied. Report what happened.' reject 120"

# BLOCKED
eval "$TENV python3 /tmp/tg_mcp_tool_test.py EmailAndCalendar_bot $AGENT_ID \
  'Call ONLY the sandbox_delete_item tool to delete item-1. Do NOT call any other tool. If sandbox_delete_item is not in your toolset, say so explicitly.' none 90"
```

### Step 5 — Tear down

**Local:**
```bash
docker stop <container-name> && docker rm <container-name>
```

**Prod:** Delete via the Reins UI (Agents → Delete) — this destroys the Fly machine automatically.

---

## Known issues and workarounds

### REINS_PUBLIC_URL must be host.docker.internal

If local Docker containers point to the external server URL (e.g. `https://reins-dev.btv.pw`), MCP tool calls go to the wrong server, approvals never appear locally, and all sandbox tests fail silently.

**Fix:** Set in root `.env`:
```
REINS_PUBLIC_URL=http://host.docker.internal:5001
```
Then restart the backend. All new containers will embed the correct URL.

### OpenClaw + MiniMax: "Unknown model: openai/MiniMax-M2.7"

The OpenClaw entrypoint registers the MiniMax model in `~/.openclaw/agents/main/agent/models.json` after the gateway becomes healthy (via a background poller). On first boot there can be a race where the model isn't registered yet when the first message arrives. If this error appears in `docker logs <container>`:

```bash
# Manual fix — patch models.json inside the running container
docker exec <container> node -e "
  const fs = require('fs');
  const p = '/home/node/.openclaw/agents/main/agent/models.json';
  const modelName = process.env.MODEL_NAME;
  const baseUrl = process.env.OPENAI_BASE_URL;
  const apiKey = process.env.OPENAI_API_KEY;
  let d = { providers: {} };
  try { d = JSON.parse(fs.readFileSync(p, 'utf8')); } catch(e) {}
  const prov = d.providers['openai'] || { models: [] };
  if (!prov.models.find(m => m.id === modelName)) {
    prov.models.push({ id: modelName, name: modelName, api: 'openai-completions',
      input: ['text'], cost: { input:0, output:0, cacheRead:0, cacheWrite:0 },
      contextWindow: 1000000, maxTokens: 40000, compat: {} });
  }
  prov.baseUrl = baseUrl; prov.apiKey = apiKey;
  d.providers['openai'] = prov;
  fs.mkdirSync(require('path').dirname(p), { recursive: true });
  fs.writeFileSync(p, JSON.stringify(d, null, 2));
  console.log('patched');
"
# Then resend the Telethon message — no container restart needed
```

### OpenClaw streams responses via message edits

OpenClaw sends an initial (often incomplete) Telegram message then progressively edits it. `tg_send_and_wait_filtered.py` and `tg_mcp_tool_test.py` both listen to `MessageEdited` events and use a 3-second settle timer after the last edit. Do not use the older `tg_send_and_wait.py` (no edit support).

### Container restart required after enabling dev-sandbox

OpenClaw caches the MCP tool list at startup. After enabling dev-sandbox via API, you must restart the container for the new tools to appear. The `run_sandbox_tests.sh` script does this automatically.

### Hermes + OpenAI: org-verification / encrypted-content errors

Handled automatically by the Hermes entrypoint (`entrypoint.sh`) which maps `MODEL_PROVIDER=openai` to the `custom` provider with `reasoning_effort: none`. No manual intervention needed as long as the image is current.

### Hermes progress prefixes to skip

Hermes emits several progress-indicator prefixes that are not final replies. All scripts skip: `🐍` (code execution), `⚡` (interrupting), `📬` (no home channel), `⚙️` (MCP tool calls). If you capture one of these as the reply, ensure your scripts have the updated `SKIP_PREFIXES` tuple.

### Hermes + MiniMax BLOCKED test: model chooses substitute tool

MiniMax, when asked to "delete" something and `sandbox_delete_item` isn't in its tools list, may attempt `sandbox_update_item` as a substitute. This creates a pending approval in the queue and the bot goes silent waiting for it.

**Fix:** Use the explicit prompt in the BLOCKED scenario:
```
"Call ONLY the sandbox_delete_item tool to delete item-1. Do NOT call any other tool. If sandbox_delete_item is not in your toolset, say so explicitly."
```

If the bot is stuck, reject all pending approvals:
```bash
curl -s -b /tmp/reins_test_cookies.txt "http://localhost:5001/api/approvals?agentId=$AGENT_ID" | \
  python3 -c "import sys,json; [print(a['id']) for a in json.load(sys.stdin)['data'] if a['status']=='pending']" | \
  while read id; do
    curl -s -b /tmp/reins_test_cookies.txt -X POST "http://localhost:5001/api/approvals/$id/reject" \
      -H "Content-Type: application/json" -d '{}'
  done
```

### GET /api/approvals admin visibility

The `GET /api/approvals` endpoint was fixed to allow admin users to see approvals for any agent regardless of ownership. If you're testing with `admin@reins.local` and agents were created by another user, the admin bypass ensures approvals are returned correctly.

### Bot token conflict (409 Conflict)

Only one process can poll a bot token at a time. If a previous container is still running:

```bash
docker ps | grep reins-
docker stop <old-container>
```

Then retry the Telethon message (the new container will take over polling within seconds).

---

## Deploying to Fly.io production

### One-time setup (Hermes only)

The Hermes image must be pushed to Fly's registry and `HERMES_IMAGE` set on the backend. Run these once after changing `docker/hermes/`:

```bash
# Create registry namespace (only once, ever)
fly apps create reins-hermes --machines

# Authenticate with Fly's registry
fly auth docker

# Build and push
docker build -f docker/hermes/Dockerfile -t registry.fly.io/reins-hermes:latest docker/hermes/
docker push registry.fly.io/reins-hermes:latest

# Tell the backend where the image is
fly secrets set HERMES_IMAGE=registry.fly.io/reins-hermes:latest --app <backend-app-name>
```

The OpenClaw image is resolved automatically from the `OPENCLAW_APP` Fly app — no equivalent step needed for OpenClaw unless publishing a new image.

### Why Hermes needs a health server

`hermes gateway run` does not expose HTTP. Fly.io requires an HTTP health check on internal port 8000 before marking a machine as started. The `docker/hermes/entrypoint.sh` starts a minimal Python HTTP server on port 8000 in the background before launching the gateway — this is what satisfies Fly's health check.

---

## Quick checklist

**Local:**
```
[ ] tests/integration/.env.test exists and has all keys
[ ] ANTHROPIC_API_KEY is in root .env (for OpenClaw Anthropic)
[ ] REINS_PUBLIC_URL=http://host.docker.internal:5001 in root .env
[ ] Backend running (npm run dev:backend)
[ ] Frontend running (npm run dev:frontend)
[ ] Docker images built (reins-openclaw:latest, reins-hermes:latest)
[ ] Telethon session exists (~/.reins_test_telethon.session)
[ ] No orphan containers from previous runs (docker ps | grep reins-)
[ ] /tmp/run_sandbox_tests.sh, /tmp/tg_mcp_tool_test.py, /tmp/tg_send_and_wait_filtered.py all present
```

**Prod (additional/different):**
```
[ ] tests/integration/.env.prod-test exists and has all keys
[ ] Telethon session exists (~/.reins_test_telethon.session)
[ ] fly CLI authenticated (fly auth whoami)
[ ] /tmp/run_sandbox_tests.sh, /tmp/tg_mcp_tool_test.py, /tmp/tg_send_and_wait_filtered.py all present
[ ] e2e-admin@reins.local account exists on reins.btv.pw
```

When invoking sandbox_tests for prod, pass the env file as the third argument:
```bash
source /tmp/run_sandbox_tests.sh
sandbox_tests Telmanfsj_bot <agent_id> /Users/fsaint/git/reins/tests/integration/.env.prod-test
```

Test 1: OpenClaw + Anthropic  [ ] ping [ ] allowed [ ] approve [ ] reject [ ] blocked
Test 2: OpenClaw + OpenAI     [ ] ping [ ] allowed [ ] approve [ ] reject [ ] blocked
Test 3: OpenClaw + MiniMax    [ ] ping* [ ] allowed [ ] approve [ ] reject [ ] blocked
Test 4: Hermes + Anthropic    [ ] ping [ ] allowed [ ] approve [ ] reject [ ] blocked
Test 5: Hermes + OpenAI       [ ] ping [ ] allowed [ ] approve [ ] reject [ ] blocked
Test 6: Hermes + MiniMax      [ ] ping [ ] allowed [ ] approve [ ] reject [ ] blocked

* Test 3: may need models.json patch if ping fails with "Unknown model" error
```
