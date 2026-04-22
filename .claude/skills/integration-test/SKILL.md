---
name: integration-test
description: Run the full Reins integration test suite — all 6 runtime×provider combinations (OpenClaw+Hermes × Anthropic+OpenAI+MiniMax) via Playwright UI + Telethon Telegram verification. Use when the user asks to "run integration tests", "test all combinations", "verify the bots work", or "run e2e tests".
---

# Integration Test — All Runtime × Provider Combinations

Tests all 6 combinations of runtime (OpenClaw, Hermes) × LLM provider (Anthropic, OpenAI, MiniMax) by creating agents through the UI and verifying bot replies via real Telegram messages.

## Prerequisites

### Test credentials file

All secrets live in `tests/integration/.env.test` (gitignored). This file must exist with the following variables populated:

```
# LLM provider API keys
ANTHROPIC_API_KEY=sk-ant-api03-...
OPENAI_API_KEY=sk-proj-...
MINIMAX_API_KEY=sk-cp-...

# Reins backend (local dev)
REINS_URL=http://localhost:5001
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

### Telethon session

On first use, create the Telethon session file (one-time interactive login):

```bash
python3 /tmp/tg_login.py
```

This writes `~/.reins_test_telethon.session`. After that the session is reused without prompts.

The helper script at `/tmp/tg_send_and_wait.py` sends a message as your real Telegram account and captures the first bot reply:

```bash
source tests/integration/.env.test
TELEGRAM_API_ID=$TELEGRAM_API_ID \
TELEGRAM_API_HASH=$TELEGRAM_API_HASH \
TELEGRAM_PHONE=$TELEGRAM_PHONE \
python3 /tmp/tg_send_and_wait.py <bot_username> "<message>" [timeout_secs]
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

### Step 2 — Wait for container

```bash
# Watch until container appears (OpenClaw also shows "(healthy)" — Hermes has no HTTP health check)
docker ps --format "{{.Names}}\t{{.Status}}" | grep "reins-"
```

- **OpenClaw**: wait for `(healthy)` — typically 20–60 s
- **Hermes**: container shows `Up N seconds` with no health annotation; the gateway is ready once it connects to Telegram (~10 s after start)

### Step 3 — Verify via Telethon

The bot username is shown in the UI (or look it up via `@BotFather`). For the test bot `@EmailAndCalendar_bot`:

```bash
source tests/integration/.env.test
TELEGRAM_API_ID=$TELEGRAM_API_ID \
TELEGRAM_API_HASH=$TELEGRAM_API_HASH \
TELEGRAM_PHONE=$TELEGRAM_PHONE \
python3 /tmp/tg_send_and_wait.py EmailAndCalendar_bot \
  "What is 7+8? Reply with ONLY the number, nothing else." 90
```

**Expected output:** `15`

**Hermes quirks:**
- First message to a new Hermes bot triggers a welcome message (`📬 No home channel...`). Resend the question.
- Hermes sometimes sends tool-use progress lines (`🐍 execute_code: ...`) before the final answer. If you capture one of these, wait ~15 s and resend.

### Step 4 — Tear down

```bash
docker stop <container-name> && docker rm <container-name>
```

Or delete via the Reins UI (Agents → Delete).

---

## Known issues and workarounds

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

### Hermes + OpenAI: org-verification / encrypted-content errors

Handled automatically by the Hermes entrypoint (`entrypoint.sh`) which maps `MODEL_PROVIDER=openai` to the `custom` provider with `reasoning_effort: none`. No manual intervention needed as long as the image is current.

### Bot token conflict (409 Conflict)

Only one process can poll a bot token at a time. If a previous container is still running:

```bash
docker ps | grep reins-
docker stop <old-container>
```

Then retry the Telethon message (the new container will take over polling within seconds).

---

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

```
[ ] tests/integration/.env.test exists and has all keys
[ ] ANTHROPIC_API_KEY is in root .env (for OpenClaw Anthropic)
[ ] Backend running (npm run dev:backend)
[ ] Frontend running (npm run dev:frontend)
[ ] Docker images built (reins-openclaw:latest, reins-hermes:latest)
[ ] Telethon session exists (~/.reins_test_telethon.session)
[ ] No orphan containers from previous runs (docker ps | grep reins-)

Test 1: OpenClaw + Anthropic  [ ] PASS / [ ] FAIL
Test 2: OpenClaw + OpenAI     [ ] PASS / [ ] FAIL
Test 3: OpenClaw + MiniMax    [ ] PASS / [ ] FAIL
Test 4: Hermes + Anthropic    [ ] PASS / [ ] FAIL
Test 5: Hermes + OpenAI       [ ] PASS / [ ] FAIL
Test 6: Hermes + MiniMax      [ ] PASS / [ ] FAIL
```
