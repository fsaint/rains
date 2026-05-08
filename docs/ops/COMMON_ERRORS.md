# Common Errors & Runbook

Recurring operational issues, their root causes, and how to fix them.

---

## Agent bot not responding on Telegram

### Symptoms
- Sending a message to the bot gets no reply
- `agenthelm-core` logs show: `[webhook-relay] OpenClaw returned 404 for deployment <id>`
- Telegram `getWebhookInfo` shows `last_error_message` or growing `pending_update_count`

### Root Cause A: `openclaw_webhook_url` pointing to wrong port

The DB column `deployed_agents.openclaw_webhook_url` tells `agenthelm-core` where to relay
incoming Telegram updates. The correct URL uses **port 8443** (mapped to machine port 8787,
where OpenClaw's Telegram webhook listener runs). If the URL uses the default port (443),
requests go to port 18789 (the web console), which has no `/telegram-webhook` route → 404.

**Port mapping on OpenClaw machines:**

| External port | Internal port | Purpose |
|---|---|---|
| 443 | 18789 | OpenClaw web console (`/chat`, `/healthz`) |
| 8443 | 8787 | Telegram webhook listener (`/telegram-webhook`) |

**Diagnosis:**

```bash
# Connect to DB (adjust MPG cluster ID as needed)
fly mpg proxy 82ylg01l77zrzx19 -p 15432 &
PGPASSWORD=<password> psql -h 127.0.0.1 -p 15432 -U fly-user -d fly-db \
  -c "SELECT id, fly_app_name, openclaw_webhook_url FROM deployed_agents WHERE fly_app_name LIKE 'reins-%';"
```

Look for URLs missing `:8443` — e.g. `https://reins-abc123.fly.dev/telegram-webhook` (wrong)
vs `https://reins-abc123.fly.dev:8443/telegram-webhook` (correct).

You can also confirm directly:
```bash
# Port 443 → should NOT return 404 on /telegram-webhook (but will, if broken)
curl -o /dev/null -w "%{http_code}" https://reins-abc123.fly.dev/telegram-webhook -X POST -d '{}'
# Port 8443 → should return 401 (secret required) if OpenClaw is up
curl -o /dev/null -w "%{http_code}" https://reins-abc123.fly.dev:8443/telegram-webhook -X POST -d '{}'
```

**Fix:**

```sql
-- Fix a single deployment
UPDATE deployed_agents
SET openclaw_webhook_url = 'https://reins-<id>.fly.dev:8443/telegram-webhook'
WHERE id = '<deployment-id>';

-- Fix all deployments missing :8443 at once
UPDATE deployed_agents
SET openclaw_webhook_url = REPLACE(
  openclaw_webhook_url,
  '.fly.dev/telegram-webhook',
  '.fly.dev:8443/telegram-webhook'
)
WHERE openclaw_webhook_url LIKE 'https://reins-%.fly.dev/telegram-webhook'
RETURNING id, fly_app_name, openclaw_webhook_url;
```

**When does this happen?** Typically after a recovery script recreates machines and sets the DB
record manually — easy to forget the `:8443` suffix.

---

### Root Cause B: MiniMax machine stuck in two-phase startup

OpenClaw machines with `model_provider: minimax` use a two-phase boot sequence in
`docker/entrypoint.sh` to inject the MiniMax model into `models.json` before the gateway
loads it. Phase 2 (the real gateway) takes **8-10 minutes** to reach `[gateway] ready`.

**The trap:** `fly machines restart` has a health-check timeout (~2 minutes). Running it
while the gateway is starting will kill the machine right before it becomes healthy, creating
an infinite restart loop.

**Symptoms:**
- `fly machines restart` keeps printing `Waiting for <id> to become healthy (started, 0/1)` and
  then fails with `context deadline exceeded`
- Logs show `[gateway] loading configuration...` then silence for several minutes, then
  `[gateway] ready (N plugins; 213s)` — but then the machine is immediately killed
- Health check shows `critical` (port 18789 not responding during startup)

**Diagnosis:**
```bash
fly logs --app reins-<id> --no-tail | grep -E "gateway.*ready|SIGINT sent|abruptly"
```

If you see `[gateway] ready` followed immediately by `SIGINT sent` and `Virtual machine exited abruptly`,
the restart command killed it at the worst possible moment.

**Fix:** Let the machine start without interruption — it will become healthy on its own.
Do NOT run `fly machines restart` on MiniMax machines unless absolutely necessary.
If you must restart, run it and then **ignore the CLI timeout error** — the machine will
continue booting in the background. Wait 10-12 minutes and then verify:

```bash
# Phase sequence (takes ~10 min total):
# 1. entrypoint.sh starts (~0:00)
# 2. "Usage reporter started" → Phase 1 gateway (~0:20)
# 3. Phase 1 killed after 8s, Phase 2 starts (~0:28)
# 4. "[gateway] loading configuration..." (~7:00)
# 5. "[gateway] resolving authentication..." (~7:06)
# 6. "[gateway] starting HTTP server..." (~10:30)
# 7. "[gateway] ready" (~10:40)  ← machine is healthy from here

fly logs --app reins-<id> --no-tail | grep "gateway.*ready"
```

---

## Fly machine health check never passes (MiniMax)

See Root Cause B above. The health check on port 18789 has a 2-minute grace period, but
MiniMax gateway startup takes 10+ minutes. The machine is "unhealthy" from Fly's perspective
for the first 10 minutes of every boot, but will self-heal.

To avoid false alarms, do not alert on health-check failures for MiniMax machines within the
first 12 minutes of a restart.

---

### Root Cause C: MiniMax machine missing `OPENAI_BASE_URL` (recovery scripts only)

**Symptoms:**
- `agenthelm-core` logs: `[webhook-relay] OpenClaw returned 404` (port issue) AND
- Machine logs: `Unknown model: openai/MiniMax-M2.7` after the relay is fixed
- `fly logs --app reins-<id>` shows `Model: openai/MiniMax-M2.7` (with `openai/` prefix)

**Root cause:** The provisioning code (`backend/src/providers/fly.ts`) translates
`model_provider=minimax` (DB) into specific machine env vars:

```
MODEL_PROVIDER=openai          ← NOT "minimax"
OPENAI_BASE_URL=https://api.minimax.io/v1
OPENAI_API_KEY=<key>
MODEL_NAME=MiniMax-M2.7
```

Recovery scripts that read `model_provider` from the DB and set `MODEL_PROVIDER=minimax`
directly will miss `OPENAI_BASE_URL`. Without it, `entrypoint.sh` falls to the `else` branch
and generates `model: "openai/MiniMax-M2.7"` in `openclaw.json` — a model that doesn't
exist in OpenClaw's registry → "Unknown model" error on every message.

When `OPENAI_BASE_URL` is set, `entrypoint.sh` uses the bare model name `MiniMax-M2.7` and
OpenClaw resolves the model via the env var directly. Startup is also much faster (22s vs 10min)
once the workspace already exists.

**Diagnosis:**
```bash
fly machines list --app reins-<id> --json | jq -r '.[0].config.env | {MODEL_PROVIDER, OPENAI_BASE_URL, MODEL_NAME}'
# Correct:  MODEL_PROVIDER=openai, OPENAI_BASE_URL=https://api.minimax.io/v1
# Broken:   MODEL_PROVIDER=minimax, OPENAI_BASE_URL=null
```

**Fix:**
```bash
fly machines update <machine-id> --app reins-<id> \
  --env OPENAI_BASE_URL=https://api.minimax.io/v1 \
  --yes
# The CLI will time out (expected — startup takes ~30s on second boot, 10min on first).
# Ignore the timeout; the machine will come up on its own.
```

> **Note on `fly machines update` / `fly machines restart` CLI timeouts**
>
> These commands wait for health checks to pass before returning. For MiniMax machines, the
> gateway takes longer than the CLI's health-check deadline. The CLI prints
> `Error: failed to wait for health checks to pass: context deadline exceeded` and exits — but
> the **update was applied** and the **machine continues booting in the background**. This is
> not a failure. Verify with `fly logs --app reins-<id> --no-tail | grep "gateway.*ready"`.
> Exit code 0 from the CLI runner confirms the update itself ran without error.

---

## After machine recovery/recreation: full checklist

When machines are recreated from a recovery script (e.g. after accidental Fly app deletion),
run through all of the following:

**1. Check `openclaw_webhook_url` in DB (port must be 8443):**

```bash
fly mpg proxy 82ylg01l77zrzx19 -p 15432 &
PGPASSWORD=<pw> psql -h 127.0.0.1 -p 15432 -U fly-user -d fly-db \
  -c "SELECT id, fly_app_name, openclaw_webhook_url FROM deployed_agents WHERE fly_app_name LIKE 'reins-%';"
# Fix if missing :8443 — see Root Cause A above
```

**2. Check `OPENCLAW_WEBHOOK_URL` machine env (must point to Reins, not fly.dev):**

```bash
fly machines list --app reins-<id> --json | jq -r '.[0].config.env.OPENCLAW_WEBHOOK_URL'
# Should be: https://app.agenthelm.mom/api/webhooks/agent-bot/<deploymentId>
# NOT:       https://reins-<id>.fly.dev/...
```

**3. For MiniMax machines — check `OPENAI_BASE_URL` is set:**

```bash
fly machines list --app reins-<id> --json | jq -r '.[0].config.env.OPENAI_BASE_URL'
# Should be: https://api.minimax.io/v1
# Fix: fly machines update <machine-id> --app reins-<id> --env OPENAI_BASE_URL=https://api.minimax.io/v1 --yes
```

---

## MiniMax agent configuration

### How MiniMax works in this system

MiniMax M2.7 is accessed via an OpenAI-compatible API. The provisioning layer
translates the `minimax` provider into four specific machine env vars:

```
MODEL_PROVIDER=openai                    ← OpenClaw provider (NOT "minimax")
OPENAI_BASE_URL=https://api.minimax.io/v1
OPENAI_API_KEY=<user-key or platform-key>
MODEL_NAME=MiniMax-M2.7
```

`docker/entrypoint.sh` detects `OPENAI_BASE_URL + MODEL_NAME` and runs a
2-phase startup that injects `MiniMax-M2.7` into `models.json` before the
OpenClaw gateway loads it. Without this registration, OpenClaw auto-prefixes
bare model names to `openai/MiniMax-M2.7` — a model it doesn't know — and
fails with "Unknown model".

### API key — platform fallback

The MiniMax API key is **optional** in the frontend. When a user deploys without
providing their own key, the backend falls back to the platform default:

```
MINIMAX_API_KEY=<platform-key>           ← set as Fly secret on agenthelm-core
                                           and in .env for local dev
```

`backend/src/providers/fly.ts` handles this:
```typescript
OPENAI_API_KEY: opts.openaiApiKey || process.env.MINIMAX_API_KEY || ''
```

If both are missing, `OPENAI_API_KEY` is set to an empty string. The model
will still register, but the API call will fail with an auth error (better than
"Unknown model").

### Setting the platform key

**Production:**
```bash
fly secrets set --app agenthelm-core MINIMAX_API_KEY="sk-cp-..."
```

**Local dev** (`.env`):
```
MINIMAX_API_KEY=sk-cp-...
```
Then restart the backend (`npm run dev:backend`) — `dotenv` loads the file at
startup; a running process does not pick up new values automatically.

### Diagnosing a broken MiniMax agent

**Step 1 — Check the machine has the right env vars:**
```bash
fly ssh console --app reins-<id> --command \
  "printenv MODEL_NAME MODEL_PROVIDER OPENAI_BASE_URL OPENAI_API_KEY"
# Expected:
#   MiniMax-M2.7
#   openai
#   https://api.minimax.io/v1
#   sk-cp-...    ← non-empty
```

**Step 2 — Check models.json has the model registered:**
```bash
fly ssh console --app reins-<id> \
  --command "cat /home/node/.openclaw/agents/main/agent/models.json" \
  | grep -A3 "MiniMax\|minimax"
# Should show: "id": "MiniMax-M2.7" under providers.openai
# If missing: the 2-phase startup was skipped (likely OPENAI_API_KEY was empty at first boot)
```

**Step 3 — If OPENAI_API_KEY is missing or models.json lacks the model:**
```bash
fly machine update <machine-id> --app reins-<id> \
  --env OPENAI_API_KEY="sk-cp-..." \
  --yes
# Machine will restart and run 2-phase startup again.
# CLI may time out (~10 min for first-boot MiniMax startup) — that's expected.
# Verify with: fly logs --app reins-<id> --no-tail | grep "registered openai/MiniMax"
```

**Step 4 — Confirm the model was injected:**
```bash
fly logs --app reins-<id> --no-tail | grep "registered openai"
# Should print: [entrypoint] models.json: registered openai/MiniMax-M2.7 at https://api.minimax.io/v1
```

### Common MiniMax error messages

| Error | Cause | Fix |
|-------|-------|-----|
| `Unknown model: openai/MiniMax-M2.7` | `models.json` missing the model — 2-phase startup was skipped | Set `OPENAI_API_KEY` and restart; see Step 3 above |
| `model-selection` warning in logs | Normal — OpenClaw resolving `MiniMax-M2.7` → `openai/MiniMax-M2.7` | No action needed; this is informational |
| Auth error / 401 from MiniMax API | `OPENAI_API_KEY` is empty or invalid | Update key via `fly machine update` |
| Startup takes 10+ minutes | Expected on first boot — 2-phase startup | Wait; do not restart mid-boot |

---

## Shared-bot Telegram gateway not working

The shared Telegram bot (`@AgentHelmDevPilot_bot` in dev, `@AgentHelmApprovalsBot` in prod)
routes messages to individual agents via Reins. This is a multi-layer relay:

```
User → Telegram → registered webhook URL → Reins /api/webhooks/shared-bot
  → DB lookup by telegram_user_id → agent machine :8443/telegram-webhook
```

### Symptoms

- Messages to the shared bot get no response
- `getWebhookInfo` shows `last_error_message` or growing `pending_update_count`
- OpenClaw console (`/chat`) works fine — the model itself is healthy

### Diagnosis

**Step 1 — Check Telegram webhook status:**
```bash
# Dev shared bot
curl -s "https://api.telegram.org/bot${SHARED_BOT_TOKEN}/getWebhookInfo" | python3 -m json.tool

# Prod shared bot
curl -s "https://api.telegram.org/bot${REINS_TELEGRAM_BOT_TOKEN}/getWebhookInfo" | python3 -m json.tool
```

Key fields to check:
- `url` — must point to `https://<domain>/api/webhooks/shared-bot`
- `pending_update_count` — non-zero means messages are queued (Telegram couldn't deliver)
- `last_error_message` — the reason delivery failed

**Common `last_error_message` values:**

| Error | Cause |
|-------|-------|
| `Wrong response from the webhook: 530 <none>` | Cloudflare can't reach the origin (tunnel down in dev, or app down in prod) |
| `Wrong response from the webhook: 404` | Route not registered — backend not running or wrong URL |
| `Wrong response from the webhook: 401` | Wrong `secret_token` in webhook registration |
| `Connection refused` | Backend process not running |

**Step 2 — Verify the webhook endpoint is reachable:**
```bash
# Should return {"ok":true}
curl -s -X POST https://<domain>/api/webhooks/shared-bot \
  -H "Content-Type: application/json" \
  -H "X-Telegram-Bot-Api-Secret-Token: <SHARED_BOT_WEBHOOK_SECRET>" \
  -d '{"update_id":1,"message":{"from":{"id":0},"chat":{"id":0,"type":"private"},"text":"test"}}'
```

**Step 3 — Check the agent's `openclaw_webhook_url` in the DB:**
```bash
psql "$DATABASE_URL" -c \
  "SELECT id, telegram_user_id, openclaw_webhook_url, is_shared_bot
   FROM deployed_agents WHERE is_shared_bot = 1 ORDER BY created_at DESC LIMIT 5;"
# openclaw_webhook_url should be: https://reins-<id>.fly.dev:8443/telegram-webhook
```

**Step 4 — Verify the agent machine has port 8443 mapped:**
```bash
fly machine list --app reins-<id> --json \
  | python3 -c "
import json, sys
m = json.load(sys.stdin)[0]
for s in m['config']['services']:
    print(s.get('ports'), '->', s.get('internal_port'))
"
# Should show two services: port 443→18789 and port 8443→8787
```

### Fix: tunnel not running (local dev only)

The dev webhook URL `reins-dev.btv.pw` routes to `localhost:5001` via a Cloudflare
tunnel. If the tunnel is down, Telegram gets a 530 error and backs off.

```bash
# Start the tunnel
cloudflared tunnel run development-tunnel > /tmp/cf-dev-tunnel.log 2>&1 &

# Verify it connected (look for "Registered tunnel connection connIndex=...")
tail -5 /tmp/cf-dev-tunnel.log
```

After starting the tunnel, Telegram will retry on its own, but the backoff can
be long. Re-register the webhook to clear the queue immediately:

```bash
curl -s "https://api.telegram.org/bot${SHARED_BOT_TOKEN}/setWebhook" \
  -d "url=https://reins-dev.btv.pw/api/webhooks/shared-bot" \
  -d "secret_token=${SHARED_BOT_WEBHOOK_SECRET}" \
  -d "drop_pending_updates=true"
# {"ok":true,"result":true}
```

Verify it's clean:
```bash
curl -s "https://api.telegram.org/bot${SHARED_BOT_TOKEN}/getWebhookInfo" \
  | python3 -c "import json,sys; d=json.load(sys.stdin)['result']; print('pending:', d['pending_update_count'], '| error:', d.get('last_error_message','none'))"
# pending: 0 | error: none
```

### Fix: wrong webhook URL registered

If OpenClaw re-registered the webhook pointing to the wrong URL (e.g. the machine's
own fly.dev address instead of Reins), reset it manually:

```bash
# Production
curl "https://api.telegram.org/bot${REINS_TELEGRAM_BOT_TOKEN}/setWebhook" \
  -d "url=https://app.agenthelm.mom/api/webhooks/shared-bot" \
  -d "secret_token=${SHARED_BOT_WEBHOOK_SECRET}"

# Dev
curl "https://api.telegram.org/bot${SHARED_BOT_TOKEN}/setWebhook" \
  -d "url=https://reins-dev.btv.pw/api/webhooks/shared-bot" \
  -d "secret_token=${SHARED_BOT_WEBHOOK_SECRET}"
```

### Fix: missing port 8443 on agent machine

If `openclaw_webhook_url` is correct but Reins can't forward to the machine:

```bash
fly machine update <machine-id> --app reins-<id> \
  --port 443:18789/tcp:tls:http \
  --port 8443:8787/tcp:tls:http \
  --yes
```

### Architecture note

The shared bot token is used by OpenClaw **only** to call `setWebhook` at startup —
pointing it back to Reins. OpenClaw does not poll or independently handle Telegram
updates for shared-bot machines; all routing goes through `agenthelm-core`.

The per-user lookup at `/api/webhooks/shared-bot` uses `telegram_user_id` from the
DB. If a user's deployment is not found (`is_shared_bot=1, status='running'`), they
get a rate-limited "no agent set up" reply once per hour.
