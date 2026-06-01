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
# Should be: https://app.helm.mom/api/webhooks/agent-bot/<deploymentId>
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
  -d "url=https://app.helm.mom/api/webhooks/shared-bot" \
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

---

## Cron jobs lost on agent redeploy

### Symptom

After a `fly machine update --image` (or any redeploy that resets the rootfs), previously
scheduled cron jobs vanish. The agent starts fresh with no cron entries.

### Root Cause

OpenClaw's default cron store path (`~/.openclaw/cron/`) lives in the container's ephemeral
rootfs, not on the persistent Fly volume (mounted at `~/.openclaw/agents/`). Every rootfs
reset (redeploy, image upgrade) wipes the directory.

### Fix (implemented — `docker/entrypoint.sh`)

On every container boot, `entrypoint.sh` creates a symlink redirecting the default cron
path into the volume:

```
~/.openclaw/cron  →  ~/.openclaw/agents/cron/  (volume-backed)
```

OpenClaw writes to `~/.openclaw/cron/` as usual; the symlink transparently routes all
reads and writes to the persistent volume path. The symlink itself is re-created each boot
(it lives in the ephemeral rootfs), but the target directory and its contents survive.

**Relevant code:** `docker/entrypoint.sh` lines ~10-18:
```bash
if [ ! -L "$CONFIG_DIR/cron" ]; then
  rm -rf "$CONFIG_DIR/cron"
  ln -sf "$CONFIG_DIR/agents/cron" "$CONFIG_DIR/cron"
fi
```

### What does NOT work

Setting `cron.store` in `openclaw.json` does **not** work. OpenClaw 2026.4.14 does not
support this config key — it triggers an immediate exit 78 (`"Missing config. Run openclaw
setup..."`) on every boot. The symlink approach is the correct solution.

---

## OpenClaw Anthropic path: infinite exit-78 crash loop

### Symptom

An OpenClaw agent using Anthropic (`MODEL_PROVIDER=anthropic` or no `MODEL_PROVIDER`)
never becomes healthy. Logs show the gateway starting, printing `Chromium:` or similar,
then exiting ~50 seconds later. The machine restarts and repeats indefinitely.

### Root Cause

OpenClaw's built-in "doctor" runs on every container boot. It initializes the workspace,
rewrites `openclaw.json` (removing any `gateway.mode: 'local'` key it doesn't recognize),
then exits with **code 78** as a "restart me" signal. Without special handling:

1. `exec node openclaw.mjs gateway` starts the gateway
2. Doctor runs inside the gateway process (~50s on a warm workspace, ~6 min cold)
3. Doctor exits the process with code 78
4. The container exits; Fly restarts it
5. Same sequence repeats → infinite crash loop

The gateway never reaches a stable state because step 3 always removes `gateway.mode:
'local'` from the config, and step 4 restarts before anyone can re-inject it.

### Fix (implemented — `docker/entrypoint.sh`)

Three-phase Anthropic startup:

| Phase | What happens | Why |
|-------|-------------|-----|
| **Phase 1** (10s background kill) | Gateway starts, creates workspace dirs, is killed after 10s | Reduces Phase 2 doctor runtime from ~6 min to ~50s |
| **Phase 2** (foreground, exit-78 catch) | Gateway runs; `if ! node ...` catches exit 78 without triggering `set -e` | Lets the doctor complete; captures exit code |
| **Phase 3** (`exec`) | `generate_config` re-injects `gateway.mode: 'local'`, then `exec node openclaw.mjs` | Starts with valid config; workspace already initialized → runs stably |

Total first-boot time: ~7 minutes. Subsequent boots: same (~7 min) because the
`agents/main/agent/` directory is created by `mkdir -p` on every boot, so Phase 1 always
runs.

**Diagnosis:**
```bash
fly logs --app reins-<id> --no-tail | grep -E "Phase|entrypoint|exit 78|gateway.*ready"
# Healthy boot shows: Phase 1, Phase 2 (exit 78), Phase 3, then "[gateway] ready"
# Stuck boot shows: repeated "Phase 1" with no "[gateway] ready"
```

**Key detail:** The `if ! node ...; then PHASE2_EXIT=$?` pattern is required because
`set -e` is active in the entrypoint. A plain `node ...` call that exits non-zero would
terminate the script before the `$?` check. The `if !` construct suppresses `set -e`
for that one command.

---

## OpenClaw browser tool: "No supported browser found" even when Chromium is installed

### Symptom

Agent responds "the browser tool isn't available in this environment" or similar, even
though Chromium is present on the machine and `browser/service: Browser control service
ready (profiles=2)` appears in the gateway log. Log line confirms the failure:

```
[tools] browser failed: Error: No supported browser found (Chrome/Brave/Edge/Chromium on macOS, Linux, or Windows).
  raw_params={"action":"screenshot","url":"https://example.com"}
```

### Root Cause

The browser tool plugin (`chrome.executables-*.js`) uses `findChromeExecutableLinux()`,
which only checks **hardcoded `/usr/bin/` paths**:

```
/usr/bin/google-chrome, /usr/bin/google-chrome-stable, /usr/bin/chrome,
/usr/bin/brave-browser, /usr/bin/microsoft-edge, /usr/bin/chromium,
/usr/bin/chromium-browser, /snap/bin/chromium
```

It does NOT search `PATH`, `/usr/local/bin/`, or `PLAYWRIGHT_BROWSERS_PATH`. The
`chromium-wrapper` script lives in `/usr/local/bin/` — outside the hardcoded list —
so the detection code silently returns null and throws.

**Critical distinction:** The `browser/service` (port 18792) and the `browser` MCP
tool are **two separate subsystems**. The service is the web-UI remote browser. The
tool is what the agent calls and has its own browser-detection path. A healthy
`browser/service` does NOT imply the browser tool will work.

### Fix (implemented — `docker/entrypoint.sh`)

`entrypoint.sh` now creates symlinks in `/usr/bin/` at every container boot, before
any gateway starts:

```bash
for _name in google-chrome chrome chromium chromium-browser; do
  ln -sf /usr/local/bin/chromium-wrapper /usr/bin/$_name 2>/dev/null || true
done
```

To fix a running machine without a redeploy (symlinks take effect immediately, no
gateway restart needed):

```bash
# Via Fly exec API — note: embed full command in a single string, not "args" array
FLY_API_TOKEN=... 
curl -s -X POST \
  "https://api.machines.dev/v1/apps/reins-<id>/machines/<machine-id>/exec" \
  -H "Authorization: Bearer ${FLY_API_TOKEN}" \
  -H "Content-Type: application/json" \
  -d '{"cmd": "/bin/sh -c \"ln -sf /usr/local/bin/chromium-wrapper /usr/bin/google-chrome && ln -sf /usr/local/bin/chromium-wrapper /usr/bin/chromium && ln -sf /usr/local/bin/chromium-wrapper /usr/bin/chromium-browser\"", "timeout": 10}'
```

After the symlinks exist, the next browser tool call will find `/usr/bin/google-chrome`
and launch successfully without any gateway restart.

### What does NOT work

- Creating symlinks in `/usr/local/bin/` — detection code hardcodes `/usr/bin/` only
- Setting `PLAYWRIGHT_BROWSERS_PATH` — the browser tool does not use this env var for detection
- Relying on `browser/service` being ready as a proxy for browser tool health — they are independent

---

## OpenClaw doctor strips `agents.defaults.model` from openclaw.json

### Symptom

After a fresh machine boot with MiniMax (or any custom `MODEL_NAME`), the agent replies
with: `HTTP 404: 404 page not found`. Gateway log shows:

```
[gateway] agent model: openai/gpt-5.4
[agent/embedded] error: HTTP 404: 404 page not found
  failoverReason: model_not_found, model: gpt-5.4
```

Even though `generate_config()` writes `agents.defaults.model.primary: openai/MiniMax-M2.7`
into `openclaw.json` before Phase 2, this field is stripped during Phase 2.

### Root Cause

The OpenClaw doctor rewrites `openclaw.json` during Phase 2. It strips fields it
doesn't recognize or manage, including `agents.defaults.model`. When Phase 3 starts
with the doctor's rewritten config, the model defaults to `openai/gpt-5.4`
(OpenClaw's internal fallback) — which does not exist on the MiniMax API → 404 on
every message.

The previously existing Phase 3 re-injection block only restored Telegram config and
`gateway.controlUi`; it did not restore `agents.defaults.model`.

### Fix (implemented — `docker/entrypoint.sh`)

Both Phase 3 re-injection blocks (MiniMax path and Anthropic path) now also restore
the model config:

```javascript
if (primaryModel) {
  cfg.agents = cfg.agents || {};
  cfg.agents.defaults = cfg.agents.defaults || {};
  cfg.agents.defaults.model = { primary: primaryModel };
}
```

`primaryModel` is derived from `MODEL_PROVIDER` + `MODEL_NAME` env vars, same logic
as `generate_config()`. The patch is idempotent — if the doctor left the field intact,
the same value is re-written with no visible effect on the running gateway.

To fix a running Phase 3 machine (no restart):

```bash
# Only channels.* and agents.* changes are safe at runtime — gateway does a hot reload.
# Do NOT set gateway.* fields on a running Phase 3 machine (see next entry).
curl -s -X POST \
  "https://api.machines.dev/v1/apps/reins-<id>/machines/<machine-id>/exec" \
  -H "Authorization: Bearer ${FLY_API_TOKEN}" \
  -H "Content-Type: application/json" \
  -d '{"cmd": "/bin/sh -c \"node /tmp/patch.js\"", "timeout": 15}'
# Write patch.js with base64 trick: encode, echo | base64 -d > /tmp/patch.js, then exec
```

---

## Patching `gateway.*` fields in a running Phase 3 openclaw.json crashes the machine

### Symptom

After writing a new value to `openclaw.json` on a Phase 3 machine (e.g. adding
`gateway.port` or `gateway.auth.token`), the gateway immediately crashes and the health
check starts failing. Logs show:

```
[reload] config change requires gateway restart (gateway)
[gateway] restart mode: full process restart (spawned pid N)
```

Then silence — the respawned gateway tries to bind to port 18789, which is occupied by
the TCP proxy → crash. The machine becomes unhealthy.

### Root Cause

Phase 3 runs two processes:
- TCP proxy: `node -e ...` listening on `:::18789` → forwards to `127.0.0.1:18790`
- Gateway: `node openclaw.mjs gateway --port 18790`

The gateway watches `openclaw.json` for changes. Any change to `gateway.*` keys
triggers a **full process restart** (SIGUSR1 → spawn new process). The new process
reads `gateway.port` from the config (now 18789) and tries to bind — but the TCP proxy
already owns port 18789 → EADDRINUSE → crash.

Changes to `channels.*` or `agents.*` keys do a **hot reload** (restart only the
affected channel/agent subsystem) — these are safe to apply at runtime.

### Fix

Never write `gateway.*` fields to `openclaw.json` on a running Phase 3 machine.
Inject them in the Phase 3 re-injection block in `entrypoint.sh` instead (runs before
`exec`, so the gateway starts with the correct config in Phase 3).

**Safe to patch at runtime:**
- `channels.telegram.*` (dmPolicy, allowFrom, webhookUrl, etc.)
- `agents.defaults.model`
- `agents.defaults.*` (other agent settings)

**Unsafe — will crash the Phase 3 gateway:**
- `gateway.port`
- `gateway.auth.*`
- `gateway.mode`
- Any other `gateway.*` key

---

## Fly Machines exec API: `args` array is ignored — embed everything in `cmd`

### Symptom

A `POST /v1/apps/{app}/machines/{id}/exec` call with `"cmd": "/bin/ls", "args": ["/tmp"]`
behaves identically to `"cmd": "/bin/ls"` with no args — it lists the current working
directory (root `/`), not `/tmp`.

### Root Cause

The Fly Machines exec API treats `cmd` as a single string that is split on spaces into
argv. The separate `args` field is accepted by the API but does not propagate to the
process. This is undocumented behavior.

### Fix

Embed the full command as a single space-separated string in `cmd`:

```bash
# ✅ Works — full path + arg in cmd string
{"cmd": "/bin/ls /tmp", "timeout": 10}

# ❌ Does NOT work — args ignored, /bin/ls runs in cwd
{"cmd": "/bin/ls", "args": ["/tmp"], "timeout": 10}
```

For commands that need shell features (pipes, redirects), use:
```bash
{"cmd": "/bin/sh -c 'ls /tmp | grep openclaw'", "timeout": 10}
```

For multi-line scripts, use the base64 encode trick:
```bash
B64=$(echo 'node /tmp/patch.js' | base64)
{"cmd": "/bin/sh -c 'echo ${B64} | base64 -d | sh'", "timeout": 15}
# First write the script: {"cmd": "/bin/sh -c 'echo SCRIPT_B64 | base64 -d > /tmp/patch.js'"}
# Then run it: {"cmd": "/bin/sh -c 'node /tmp/patch.js'"}
```

---

## Dev Fly org is `development-808`, not `reins-dev`

### Symptom

Local dev agent provisioning fails with `organization not found` or machines land in the
wrong org (or the backend refuses to start with an org mismatch error).

### Root Cause

The dev org was historically documented as `reins-dev` in several places, but the actual
org is `development-808`. `config/development.yaml` had `fly.org: reins-dev` which caused
all dev provisioning to fail.

### Fix

`config/development.yaml` now has:
```yaml
fly:
  org: development-808
  openclaw_app: reins-openclaw-dev
```

The local `.env` must also have `FLY_ORG=development-808` and a `FLY_API_TOKEN` scoped to
`development-808`. The backend enforces `FLY_ORG !== 'personal'` in non-production
environments and will refuse to start if the wrong org is set.

---

## `fly deploy --build-only` does not push the image to the Fly registry

### Symptom

`fly deploy --build-only` completes successfully and reports `image: registry.fly.io/<app>:<tag>`,
but when an ephemeral machine tries to pull that image it fails with:

```
MANIFEST_UNKNOWN: manifest unknown
```

### Root Cause

`--build-only` builds in the remote Depot cache but does not create a release, so the image
is never pushed to the persistent Fly registry. Only a full deploy (`--remote-only` without
`--build-only`) writes the image to `registry.fly.io/<app>`.

### Fix

Use a real deploy followed by an immediate scale-to-0 to keep the image without leaving a
running machine:

```bash
fly deploy --remote-only --app reins-imgtest --dockerfile <path> --image-label <tag>
fly scale count 0 --app reins-imgtest --yes
```

The image is now in the registry and can be referenced as `registry.fly.io/reins-imgtest:<tag>`.

---

## OpenClaw health check stays `critical` during phases 1 & 2 (image test runner)

### Symptom

Image test runner waits for the machine health check to pass (`servicecheck-00-http` → `passing`)
but it stays `critical: "connect: connection refused"` for the full 180 s timeout.

### Root Cause

OpenClaw has a 3-phase startup:
- Phase 1 and 2 bind only to `127.0.0.1` (IPv4 loopback, port 18789).
- Fly's health checker reaches the machine over IPv6 and gets `connection refused` on both phases.
- Only Phase 3 creates a `:::18789` IPv6-aware TCP proxy; the health check only passes then.

Waiting on the Fly health check means always timing out for phases 1 & 2.

### Fix

In `tests/image-test/lib/lifecycle.ts`, `waitForHealthy` returns as soon as `machine.state === 'started'`
instead of waiting for the health check `status === 'passing'`. The test runner's own warmup
(sending `/new` and polling for a bot reply) confirms the bot is actually up.

---

## Hermes uses `TELEGRAM_ALLOWED_USERS`; OpenClaw uses `TELEGRAM_TRUSTED_USER`

### Symptom

Hermes bot rejects all incoming messages with "Hi~ I don't recognize you yet!" even though
the correct Telegram account is sending messages. OpenClaw works fine with the same setup.

### Root Cause

The two runtimes use different env var names for the same concept (trusted user IDs):

| Runtime | Env var | Format |
|---------|---------|--------|
| Hermes | `TELEGRAM_ALLOWED_USERS` | comma-separated user IDs |
| OpenClaw | `TELEGRAM_TRUSTED_USER` | single user ID |

### Fix

`tests/image-test/lib/runner.ts` now injects the correct var based on `variant.runtime`:

```typescript
...(telegramUserId && variant.runtime === 'hermes'
  ? { TELEGRAM_ALLOWED_USERS: telegramUserId }
  : {}),
...(telegramUserId && variant.runtime !== 'hermes'
  ? { TELEGRAM_TRUSTED_USER: telegramUserId }
  : {}),
```

Add `TELEGRAM_USER_ID=<numeric_id>` to `tests/image-test/.env.image-test`.

---

## Chrome CDP warmup messages sent to Hermes corrupt subsequent responses

### Symptom

Hermes ping test times out or returns a browser-navigation reply ("⏳ Working — 3 min — terminal")
instead of the expected arithmetic answer.

### Root Cause

The image test runner's Chrome warmup sequence sends "Open about:blank" (and similar probe
messages) to the bot before starting scenarios. OpenClaw ignores these as Chrome CDP commands;
Hermes treats them as user prompts, queues browser-finding tasks, and those in-flight tasks
corrupt the context when the real scenario prompt arrives.

### Fix

In `tests/image-test/lib/runner.ts`, the Chrome warmup block is skipped entirely for Hermes:

```typescript
if (variant.runtime === 'hermes') {
  console.log('\nHermes runtime: waiting 30s for bot to connect to Telegram...');
  await new Promise<void>((r) => setTimeout(r, 30_000));
  console.log('Ready. Starting scenarios.\n');
} else {
  // full Chrome /new + CDP polling + warmup sequence for OpenClaw
}
```

---

## `⏳` is Hermes's "Working" progress prefix — must be filtered in test scripts

### Symptom

Telethon test script captures `⏳ Working — 3 min — terminal` (or similar) as the final
reply, causing assertion failures even though the bot eventually sends a correct answer.

### Root Cause

Hermes emits `⏳ <status>` messages while long-running tasks (terminal, browser) are in
progress. The test scripts only filtered OpenClaw prefixes (`🐍`, `⚡`, `📬`, `⚙️`).

### Fix

Added `"⏳"` to `SKIP_PREFIXES` in `tests/image-test/lib/tg-browser-test.py`:

```python
SKIP_PREFIXES = ("🐍", "⚡", "📬", "⚙️", "⏳")
```

Apply the same addition to any other Telethon helper that filters progress messages.

---

## `source .env.file` without `set -a` does not export vars to child processes

### Symptom

A shell script `source`s a `.env` file but child processes (e.g. `fly deploy`) cannot see
the variables, resulting in "no access token available. Please login with 'flyctl auth login'".

### Root Cause

`source` (`.`) evaluates the file in the current shell but does not mark variables for
export. Child processes inherit only exported variables.

### Fix

Wrap the source call with `set -a` / `set +a`:

```bash
set -a
source /path/to/.env.file
set +a
```

`set -a` causes every variable assignment to be automatically exported until `set +a` is called.

---

## `reins-imgtest` registry app must be created once before image tests

### Symptom

`fly deploy --remote-only --app reins-imgtest ...` fails with `app not found` or
`Could not find App`.

### Root Cause

The `reins-imgtest` app in the `development-808` org is the shared registry app for all
image test variants. It does not exist by default and must be created once.

### Fix

```bash
FLY_API_TOKEN=<development-808 token> fly apps create reins-imgtest --org development-808
```

After creation, all image test builds and pulls use `registry.fly.io/reins-imgtest:<variant-tag>`.
The app itself never runs machines in normal operation — it is a registry-only app that is
scaled to 0 after each build.

---

## `tg_mcp_tool_test.py`: stale cached Telegram messages captured as test reply

### Symptom

Sandbox test scenarios 1–3 return old bot messages from a previous session ("I do not have
a `sandbox_echo` tool", "NONE", etc.) instead of the actual response to the test prompt.
The bot's OpenClaw log shows no inbound message for the current test, confirming the reply
was never actually sent by the bot.

### Root Cause

When Telethon calls `await client.start()` to connect, Telegram delivers all pending updates
that the user's account has not yet seen. These include old bot messages from previous test
runs. The `NewMessage` handler is registered immediately after `client.start()` and fires for
these cached messages before the test prompt is even sent.

### Fix (implemented — `tests/integration/tg_mcp_tool_test.py`)

Before sending the test message, snapshot the latest bot message ID:

```python
baseline_msgs = await client.get_messages(bot, limit=1)
baseline_id = baseline_msgs[0].id if baseline_msgs else 0
```

Then filter in both handlers:

```python
@client.on(events.NewMessage(from_users=bot_id))
async def on_new(event):
    if event.message.id <= baseline_id:
        return  # stale cached message, ignore
    ...
```

---

## `tg_mcp_tool_test.py`: approval poller stops after first streaming bot message

### Symptom

Sandbox APPROVE/DENY scenarios time out on an intermediate streaming response such as
`Scuttling\n\n🧩 Reins Reins Get Result: running`. The approval remains `pending` in the
DB even though the test action was `approve` or `reject`. The model is stuck polling
`reins__reins_get_result` and getting "still pending" forever.

### Root Cause

The approval poller runs inside the outer `while time.monotonic() < deadline` loop, which
breaks once `got_reply.is_set()`. For MCP tool approval scenarios, OpenClaw streams an
intermediate message (tool progress indicator) **before** the approval request is created in
the DB. The `got_reply` event fires for this intermediate message, the loop exits, and the
approval poller never runs again — leaving the approval unresolved.

The settle timer then waits 3 seconds with no edits and returns the intermediate response.

### Fix (implemented — `tests/integration/tg_mcp_tool_test.py`)

Two changes:

1. **Run approval polling as a concurrent asyncio task** so it continues throughout the entire
   test, including during the settle timer:

```python
async def approval_poller():
    nonlocal approval_handled
    while time.monotonic() < deadline and not approval_handled:
        approval_id = get_pending_approval(agent_id)
        if approval_id:
            take_action(approval_id, action)
            approval_handled = True
            return
        await asyncio.sleep(1.0)

if action != 'none':
    poller_task = asyncio.create_task(approval_poller())
```

2. **Increase `SETTLE_SECS` from 3 to 8** — the gap between an intermediate tool-running
   update and the final result (after approval resolution → `reins_get_result` returns →
   model composes final reply) can exceed 3 seconds.

---

## Per-agent bot Telegram webhook cleared periodically during dev testing

### Symptom

After registering the Telegram webhook for a dev agent bot, the webhook is cleared roughly
every 25–30 seconds. `getWebhookInfo` shows `"url": ""`. OpenClaw's log shows no webhook
operations after initial registration, ruling out OpenClaw as the cause.

### Root Cause

`backend/src/index.ts` re-registers Telegram webhooks for all `status='running'` deployments
on every backend startup. When `tsx watch` hot-reloads the backend (e.g. due to file saves or
a second `tsx` process being spawned), the startup block runs repeatedly. If any re-registration
attempt fails silently or uses a mismatched URL, the webhook may end up in an inconsistent state.

The exact clearing mechanism is periodic but not fully isolated — both the tsx watch worker
restart cycle and any competing backend process contribute.

### Workaround (dev testing only)

Run a background webhook keepalive loop before starting sandbox tests:

```bash
BOT_TOKEN="<bot_token>"
WEBHOOK_URL="https://reins-dev.btv.pw/api/webhooks/agent-bot/<deploymentId>"
SECRET="<webhookRelaySecret>"

python3 - <<'EOF' > /tmp/webhook-keepalive.log 2>&1 &
import time, urllib.request, urllib.parse, json
bot_token = '$BOT_TOKEN'
webhook_url = '$WEBHOOK_URL'
secret = '$SECRET'
while True:
    data = urllib.parse.urlencode({'url': webhook_url, 'secret_token': secret}).encode()
    req = urllib.request.Request(f'https://api.telegram.org/bot{bot_token}/setWebhook', data=data)
    urllib.request.urlopen(req, timeout=10)
    time.sleep(15)
EOF
KEEPALIVE_PID=$!
# ... run tests ...
kill $KEEPALIVE_PID
```

Note: `run_sandbox_tests.sh` does NOT need this workaround when the machine has just been
redeployed (the machine itself re-registers the webhook at boot). The workaround is only
needed when testing against a long-running machine without redeploying.

---

## Hermes machine crashes immediately on startup: `cp: cannot stat '/agenthelm-hooks/...'`

### Symptom

A newly provisioned Hermes machine starts, logs one or two lines, then prints:

```
cp: cannot stat '/agenthelm-hooks/usage_reporter/HOOK.yaml': No such file or directory
Main child exited normally with code: 1
```

The machine restarts in a tight loop. Status never reaches `running`.

### Root Cause

`docker/hermes/entrypoint.sh` runs with `set -e`. When `USAGE_CALLBACK_URL` and
`INSTANCE_USER_ID` are both set (injected by the backend), it tries to `cp` the
usage-reporter hook files from `/agenthelm-hooks/usage_reporter/` — a directory that
does not exist in the current Hermes image because those files have never been baked
in. The `cp` exits non-zero, `set -e` kills the script, and the machine dies.

### Fix

Two changes were applied:

**1. `docker/hermes/entrypoint.sh`** — added a file-existence guard so the copy only
runs when the hook files are actually present in the image:

```sh
# Before (crashes when files missing):
if [ -n "$USAGE_CALLBACK_URL" ] && [ -n "$INSTANCE_USER_ID" ]; then
  cp /agenthelm-hooks/usage_reporter/HOOK.yaml ...

# After (safe):
if [ -n "$USAGE_CALLBACK_URL" ] && [ -n "$INSTANCE_USER_ID" ] && [ -f "/agenthelm-hooks/usage_reporter/HOOK.yaml" ]; then
  cp /agenthelm-hooks/usage_reporter/HOOK.yaml ...
```

**2. `backend/src/providers/fly.ts`** — `INSTANCE_USER_ID` and `USAGE_CALLBACK_URL`
are no longer injected into Hermes machine configs until the hook files are baked into
the image:

```typescript
// Omitted from Hermes env until usage_reporter hook is in the image:
// INSTANCE_USER_ID: opts.instanceId,
// USAGE_CALLBACK_URL: `${reinsUrl}/api/webhooks/usage`,
```

The entrypoint fix protects future image builds; the fly.ts fix was the immediate
unblock for the currently deployed image.

---

## Backend not taking effect after `pkill -f "tsx watch"` — old child process still serves requests

### Symptom

`pkill -f "tsx watch"` appears to succeed, a new `npm run dev:backend` is started, but
the backend continues to serve the old code. Code changes have no effect. `lsof -i :5001`
reveals a Node.js process still bound to the port that was not killed.

### Root Cause

`tsx watch` spawns a **child Node.js process** to run the actual server. Killing the
parent `tsx watch` process does not send SIGTERM to the child. The child continues
listening on port 5001 and the new backend process fails to bind (or binds on a different
port). The old binary keeps running.

### Fix

Find and kill all relevant PIDs explicitly:

```bash
# Find everything touching port 5001
lsof -i :5001

# Kill the tsx parent(s) and any Node.js child processes
kill <tsx-pid> <node-child-pid>

# Verify the port is free
lsof -i :5001   # should be empty

# Then start the backend
npm run dev:backend
```

Alternatively, kill by name to catch all spawned children:

```bash
pkill -f "tsx watch" || true
pkill -f "node.*backend" || true
# Wait a moment, then verify
lsof -i :5001
```

---

## OpenClaw + MiniMax (or any custom OpenAI-compatible endpoint): codex runtime auto-enabled, agent silent or MCP tools missing

### Symptom

OpenClaw agents using MiniMax (or any provider with `OPENAI_BASE_URL` set) either:

- Return no reply at all, with logs showing:
  ```
  FailoverError: Unknown model: openai-codex/MiniMax-M2.7
  Embedded agent failed before reply: Unknown model: openai-codex/MiniMax-M2.7
  ```
- Or respond but without MCP tools, with logs showing:
  ```
  gateway: auto-enabled plugins for this runtime without writing config:
    openai/MiniMax-M2.7 model configured, enabled automatically.
    codex agent runtime configured, enabled automatically.
  ```

Port 8787 (webhook receiver) may also refuse connections as a secondary symptom when the agent fails to initialize properly.

### Root Cause

OpenClaw ≥ 2026.5.x auto-enables the **codex agent runtime** whenever
`agents.defaults.model.primary` starts with `openai/`. The codex runtime remaps the
model to `openai-codex/<name>` and calls OpenAI's Responses API — which MiniMax (and
any custom endpoint) does not support → hard failure on every inference.

The backend maps MiniMax agents to `MODEL_PROVIDER=openai` + `OPENAI_BASE_URL=https://api.minimax.io/v1`.
The entrypoint was previously writing `openai/MiniMax-M2.7` as the primary model, which
triggered codex. The condition `modelProvider === 'minimax'` never fired because
`MODEL_PROVIDER` is `openai`, not `minimax`.

This behavior was introduced between OpenClaw 2026.4.14 (unaffected) and 2026.5.x
(affected). It recurs whenever the base image is upgraded.

### Fix

In `docker/entrypoint.sh`, all three `openclawProvider` assignments must use
`OPENAI_BASE_URL` as the signal — not `modelProvider === 'minimax'`:

```javascript
// WRONG — modelProvider is 'openai' for MiniMax, so this never fires
const openclawProvider = modelProvider === 'minimax' ? '' : modelProvider;

// CORRECT — OPENAI_BASE_URL means custom endpoint; bare name avoids codex trigger
const openclawProvider = process.env.OPENAI_BASE_URL ? '' : modelProvider;
const primaryModel = openclawProvider ? openclawProvider + '/' + modelName : modelName;
```

The three locations to update (all in `docker/entrypoint.sh`):
1. `generate_config()` function (line ~147)
2. MiniMax/OpenAI Phase 3 re-inject block (line ~591)
3. Anthropic Phase 3 re-inject block (line ~772)

`models.json` registers the model as bare id `MiniMax-M2.7` under the `openai` provider
with `baseUrl` set to `OPENAI_BASE_URL`, so OpenClaw resolves the bare name correctly
without the `openai/` prefix. This fix is also correct for RouteLLM and any future
custom-endpoint provider.

After fixing, the gateway log should show:
```
agent model: MiniMax-M2.7 (thinking=medium, fast=off)
```
with **no** "codex agent runtime configured" line.

### What does NOT work

- Checking `MODEL_PROVIDER === 'minimax'` — the backend sends `MODEL_PROVIDER=openai` for MiniMax.
- Targeting the condition based on `MODEL_NAME` containing "MiniMax" — fragile and misses future providers.
- Downgrading to OpenClaw 2026.4.14 — avoids the issue but loses new features and will recur on the next upgrade.

---

## OpenClaw `--allow-unconfigured` + `browser.enabled: true` silently skips `plugins.entries`

### Symptom

An OpenClaw agent using MiniMax (or any custom OpenAI-compatible endpoint) has MCP tools
missing even though `plugins.entries` in `openclaw.json` correctly configures `openclaw-mcp-bridge`.
Gateway log shows:

```
gateway: auto-enabled plugins for this runtime without writing config:
- openai/MiniMax-M2.7 model configured, enabled automatically.
- browser configured, enabled automatically.
http server listening (2 plugins: browser, telegram; 5.9s)
```

Session logs never show `mcp-bridge: pre-registered N cached tools synchronously`.

### Root Cause

When both `--allow-unconfigured` is passed to the gateway AND `browser.enabled: true` exists
in `openclaw.json`, OpenClaw enters **"auto-enable mode"**. In this mode it auto-enables
browser and telegram from the config without processing `plugins.entries`. Extension-based
plugins like `openclaw-mcp-bridge` are silently ignored — the plugin count is only the
auto-enabled built-ins.

Contrast: when `--allow-unconfigured` is used WITHOUT `browser.enabled: true` in config
(e.g. Anthropic Phase 3 after the doctor strips `browser`), OpenClaw starts in lazy mode
("0 plugins" at boot) and discovers extension plugins lazily at session start. In that
mode, `plugins.entries` IS processed and mcp-bridge registers tools synchronously via
the pre-cache.

### Fix (implemented — `docker/entrypoint.sh`)

Before starting the gateway with `--allow-unconfigured`, strip the `browser` section from
`openclaw.json`. The browser extension auto-discovers from `/app/dist/extensions/` at
session start regardless — removing `browser.enabled: true` does not disable the browser tool:

```javascript
// In entrypoint.sh MiniMax path, after models.json injection:
const cfg = JSON.parse(fs.readFileSync(configPath, 'utf8'));
if (cfg.browser !== undefined) { delete cfg.browser; }
if (cfg.gateway) {
  delete cfg.gateway.mode;
  delete cfg.gateway.port;
}
fs.writeFileSync(configPath, JSON.stringify(cfg, null, 2));
```

After this patch the gateway starts in lazy mode:
```
gateway: auto-enabled plugins for this runtime without writing config:
- openai/MiniMax-M2.7 model configured, enabled automatically.
http server listening (1 plugin: telegram; 5.9s)
mcp-bridge: pre-registered 17 cached tools synchronously
mcp-bridge: registered 17 tools from 1 server(s)
```

### What does NOT work

- **Installing mcp-bridge as a user plugin via symlink** (`~/.openclaw/plugins/openclaw-mcp-bridge/` → `/app/dist/extensions/openclaw-mcp-bridge`): the symlink IS discoverable but `--allow-unconfigured` in auto-enable mode still skips `plugins.entries`, so even user plugins aren't loaded.
- **Removing `--allow-unconfigured`** while keeping `browser.enabled: true`: the gateway then tries to start with `gateway.mode: 'local'` in the config, which causes the doctor to exit with code 78 and the machine to restart.

---

## MiniMax stops after APPROVAL_PENDING instead of auto-polling

### Symptom

The APPROVE sandbox test fails. The bot replies with something like "I need to poll for the
result" after calling a tool that returns `APPROVAL_PENDING`, and then stops without
calling `reins_get_result` to retrieve the final decision.

The Anthropic model handles the same prompt correctly by continuing in the same turn.

### Root Cause

MiniMax models are less aggressive about autonomous multi-step execution. When a tool
returns `APPROVAL_PENDING`, the model interprets it as a natural stopping point — it
reports the pending state to the user instead of continuing to poll `reins_get_result`
within the same agent turn.

### Fix (implemented — `tests/integration/run_sandbox_tests.sh`)

Explicitly instruct the model to poll for the result in the same prompt:

```bash
# Before:
"Call sandbox_send_message: to=ops@reins.io, subject=approve-test, body=please approve. Report result."

# After:
"Call sandbox_send_message: to=ops@reins.io, subject=approve-test, body=please approve. \
If you receive APPROVAL_PENDING, immediately call reins_get_result to poll for the \
decision and report the final status."
```

Also increased `SETTLE_SECS` in `tg_mcp_tool_test.py` from 8.0 to 15.0 to give MiniMax
enough time to complete the poll + compose a final reply in a second agent turn if it
chooses not to stay in the same turn.

---

## Shared bot agent creation blocked by stale DB record from previous test run

### Symptom

Creating a new agent with the platform shared bot fails with:

```
You already have an agent on the shared bot. Provide your own Telegram bot token to create another.
```

The agent list in the UI shows no shared-bot agents. No active Fly machine exists for
the old agent. The error code is `SHARED_BOT_LIMIT_REACHED`.

### Root Cause

The backend enforces one shared-bot agent per `telegram_user_id`. The check queries
`deployed_agents` for rows with `is_shared_bot = 1` and `status NOT IN ('destroyed',
'error')`. Previous test runs (onboarding flow tests, manual experiments) can leave rows
in `running` status even after the Fly app was manually deleted or the agent record
disappeared from the UI.

### Fix

Find the stale record and mark it destroyed:

```bash
# Find the blocking row
psql "$DATABASE_URL" -c \
  "SELECT id, agent_id, telegram_user_id, status, fly_app_name
   FROM deployed_agents
   WHERE telegram_user_id = '<user_id>' AND is_shared_bot = 1
     AND status NOT IN ('destroyed', 'error');"

# Mark it destroyed
psql "$DATABASE_URL" -c \
  "UPDATE deployed_agents SET status = 'destroyed' WHERE id = '<deployment_id>';"
```

If the Fly app still exists, destroy it too:
```bash
FLY_API_TOKEN=<dev-token> fly apps destroy reins-<appname> --org development-808 --yes
```
