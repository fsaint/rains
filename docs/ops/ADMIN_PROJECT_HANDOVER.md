# Reins Admin Project — Architecture Handover

This document describes everything needed to build a standalone admin tool for the Reins platform. The admin project is a separate codebase with broader Fly.io permissions than the main repo's developer environment. It interacts with two systems: the **Reins backend admin API** (for agent and user data) and the **Fly Machines API** (for fleet operations).

---

## Overview

Reins is an AI agent platform. Each user has one or more "agents" — AI processes running on Fly.io machines. The backend (deployed as `agenthelm-core` on Fly) manages:
- Agent configuration stored in a PostgreSQL database
- Fly machine provisioning in the `personal` org

The admin project needs to:
- Inspect the full agent fleet (DB + live Fly state)
- Recover destroyed machines from database records
- Restart/diagnose machines without WireGuard SSH
- Manage platform users
- Execute Telegram webhooks and broadcasts

---

## Authentication

### Reins Backend Admin API

All admin endpoints require:
```
Authorization: Bearer <REINS_ADMIN_API_KEY>
```

The `REINS_ADMIN_API_KEY` is a 64-character hex string set as a Fly secret on `agenthelm-core`. Request the value from the platform operator or generate a new one:
```bash
NEW_KEY=$(openssl rand -hex 32)
fly secrets set --app agenthelm-core REINS_ADMIN_API_KEY="$NEW_KEY"
```

Base URL: `https://app.helm.mom`

### Fly Machines API

All Fly API calls require:
```
Authorization: Bearer <FLY_ADMIN_TOKEN>
```

The admin project token needs access to both `personal` (agent machines) and `core-191` (platform apps). Unlike the read-only token used in the main repo's `admin/` scripts, this project's token needs write access for machine creation and, optionally, app destruction.

Fly.io token types (verified via `fly tokens create --help`):
- `fly tokens create readonly --org <slug>` — read-only org access (list/describe, no mutations)
- `fly tokens create deploy --app <app>` — deploy a specific app
- `fly tokens create org --org <slug>` — full org access (create, destroy, deploy)
- `fly tokens create machine-exec --app <app>` — scoped to exec on a specific app's machines

For the admin project, start with `readonly` and add `org` scope only if destruction capability is explicitly required.

Fly API base: `https://api.machines.dev/v1`
Fly GraphQL: `https://api.fly.io/graphql`

---

## Reins Backend Admin API

### `GET /api/admin/agents`

Returns all agents joined with their active deployment record.

**Response:**
```json
{
  "data": [
    {
      "id": "bX6AkIUQwE5gc9Izo57TM",
      "name": "user5982613183's Agent",
      "agent_status": "active",
      "deployment_id": "YKrJigoovSbjf_nlUFpgf",
      "fly_app_name": "reins-ykrjigoo",
      "fly_machine_id": "080de37f66d178",
      "fly_volume_id": "vol_abc123",
      "deployment_status": "running",
      "runtime": "openclaw",
      "is_shared_bot": 1,
      "region": "iad",
      "telegram_user_id": "5982613183",
      "model_provider": "minimax",
      "model_name": "MiniMax-M2.7",
      "management_url": "https://reins-ykrjigoo.fly.dev/chat?session=main",
      "deployed_at": "2026-05-21T21:00:00.000Z",
      "deployment_updated_at": "2026-05-21T21:00:00.000Z"
    }
  ]
}
```

**Notes:**
- `is_shared_bot = 1` means this agent routes through the shared platform bot (`@AgentHelmPilot_bot`). The bot token is not per-agent; Telegram routes messages by `telegram_user_id`.
- `is_shared_bot = 0` means the agent has its own bot token. The Telegram webhook is registered to `/api/webhooks/agent-bot/<deployment_id>`.
- `deployment_status` values: `running`, `stopped`, `destroyed`, `error`
- Only active deployments are returned (destroyed records are excluded).

### `GET /api/admin/users`

Returns all non-deleted platform users.

**Response:**
```json
{
  "data": [
    {
      "id": "user-nanoid-21chars",
      "email": "user@example.com",
      "name": "User Name",
      "role": "admin",
      "status": "active",
      "created_at": "2026-01-01T00:00:00.000Z",
      "updated_at": "2026-01-01T00:00:00.000Z"
    }
  ]
}
```

**Roles:** `admin`, `user`
**Statuses:** `active`, `suspended`, `deleted`

### `POST /api/admin/users`

Create a platform user.

**Body:** `{ "email": string, "name": string, "password": string, "role": "admin" | "user" }`

**Response (201):** User object.

### `PATCH /api/admin/users/:id`

Update name, role, or status.

**Body:** `{ "name"?: string, "role"?: "admin" | "user", "status"?: "active" | "suspended" }`

### `DELETE /api/admin/users/:id`

Soft-delete a user (sets `status = 'deleted'`).

### `POST /api/admin/users/:id/reset-password`

**Body:** `{ "password": string }` (min 8 chars)

### `POST /api/admin/broadcast`

Send a Telegram message to all users who have linked their Telegram account.

**Body:** `{ "message": string, "parseMode"?: "HTML" | "Markdown" }`

---

## Fly Machines API

All paths are relative to `https://api.machines.dev/v1`.

### List apps in an org

```
GET /apps?org_slug=personal
GET /apps?org_slug=core-191
```

**Response:** `{ "apps": [ { "id": "app-id", "name": "reins-ykrjigoo", "status": "running", ... } ] }`

### Get a specific app

```
GET /apps/<app_name>
```

### List machines in an app

```
GET /apps/<app_name>/machines
```

**Response:** Array of machine objects. Each machine has:
- `id` — machine ID
- `name` — human name
- `state` — `started`, `stopped`, `destroyed`
- `region` — e.g. `iad`
- `config.image` — the container image ref
- `config.env` — environment variables

### Get a specific machine

```
GET /apps/<app_name>/machines/<machine_id>
```

### Execute a command on a machine

```
POST /apps/<app_name>/machines/<machine_id>/exec
Content-Type: application/json

{
  "command": ["sh", "-c", "ls /tmp"],
  "timeout": 30
}
```

**Response:** `{ "stdout": "...", "stderr": "...", "exit_code": 0 }`

Does not require WireGuard. Works when `fly ssh console` is unavailable (e.g. during Fly gateway outages). The machine must be in `started` state.

You can pass stdin by base64-encoding data:
```json
{
  "command": ["sh", "-c", "base64 -d | tar xzf - -C /target"],
  "stdin": "<base64-encoded tarball>"
}
```

### Restart a machine

```
POST /apps/<app_name>/machines/<machine_id>/restart
```

### Create a new app

```
POST /apps
Content-Type: application/json

{
  "app_name": "reins-newagent",
  "org_slug": "personal"
}
```

### Create a volume

```
POST /apps/<app_name>/volumes
Content-Type: application/json

{
  "name": "agent_state",
  "region": "iad",
  "size_gb": 1,
  "encrypted": false
}
```

**Response:** `{ "id": "vol_abc123", ... }`

### Create a machine

```
POST /apps/<app_name>/machines
Content-Type: application/json

{
  "name": "openclaw-abc12345",
  "region": "iad",
  "config": { ... see Machine Config below ... }
}
```

**Response:** `{ "id": "machine-id", ... }`

### Destroy a machine

```
DELETE /apps/<app_name>/machines/<machine_id>?force=true
```

### Destroy an app

```
DELETE /apps/<app_name>
```

### Allocate IPs (required for new apps to be reachable)

Uses the GraphQL endpoint:

```
POST https://api.fly.io/graphql
Authorization: Bearer <FLY_ADMIN_TOKEN>
Content-Type: application/json

{
  "query": "mutation($input: AllocateIPAddressInput!) { allocateIpAddress(input: $input) { ipAddress { id } } }",
  "variables": { "input": { "appId": "reins-newagent", "type": "v6" } }
}
```

Allocate both `v6` and `shared_v4`. Failures here are non-fatal (app still works; IPs may auto-allocate on first request).

---

## Agent Machine Config

This is the exact config used when creating an OpenClaw agent machine. Keep this in sync with `backend/src/providers/fly.ts` in the main repo — drift between recovery tooling and the live provisioner is dangerous.

```json
{
  "image": "registry.fly.io/reins-openclaw:<tag>",
  "guest": {
    "cpu_kind": "shared",
    "cpus": 2,
    "memory_mb": 4096
  },
  "env": {
    "TELEGRAM_BOT_TOKEN": "<agent's bot token — omit for shared-bot agents>",
    "MCP_CONFIG": "[{\"name\":\"reins\",\"url\":\"https://app.helm.mom/mcp/<agent_id>\",\"transport\":\"http\"}]",
    "USAGE_CALLBACK_URL": "https://app.helm.mom/api/webhooks/usage",
    "INSTANCE_USER_ID": "<new_deployment_id>",
    "REINS_API_URL": "https://app.helm.mom",
    "ANTHROPIC_API_KEY": "<platform anthropic key, if any>",
    "OPENCLAW_GATEWAY_TOKEN": "<new_gateway_token — random 32 hex chars>",
    "NODE_OPTIONS": "--max-old-space-size=3072 --dns-result-order=ipv4first",
    "SOUL_MD": "<optional — agent personality>",
    "TELEGRAM_TRUSTED_USER": "<optional — telegram_user_id of allowed user>",
    "MODEL_NAME": "MiniMax-M2.7",
    "MODEL_PROVIDER": "openai",
    "OPENAI_BASE_URL": "https://api.minimax.io/v1",
    "OPENAI_API_KEY": "<user's MiniMax key, or fall back to platform MINIMAX_API_KEY>",
    "THINKING_DEFAULT": "medium",
    "OPENCLAW_WEBHOOK_URL": "<see Webhook Routing below>",
    "OPENCLAW_WEBHOOK_SECRET": "<new_webhook_secret — random 32 hex chars>"
  },
  "mounts": [
    {
      "volume": "<volume_id>",
      "path": "/home/node/.openclaw/agents"
    }
  ],
  "services": [
    {
      "ports": [{ "port": 443, "handlers": ["tls", "http"] }],
      "protocol": "tcp",
      "internal_port": 18789,
      "autostart": true,
      "autostop": "off",
      "checks": [{
        "type": "http",
        "method": "get",
        "path": "/healthz",
        "port": 18789,
        "interval": "15s",
        "timeout": "5s",
        "grace_period": "120s"
      }]
    },
    {
      "ports": [{ "port": 8443, "handlers": ["tls", "http"] }],
      "protocol": "tcp",
      "internal_port": 8787,
      "autostart": true,
      "autostop": "off"
    }
  ]
}
```

### Webhook Routing

The `OPENCLAW_WEBHOOK_URL` value determines how Telegram updates reach the agent:

| Agent type | `OPENCLAW_WEBHOOK_URL` | Webhook registered by |
|---|---|---|
| `is_shared_bot = 1` | `https://app.helm.mom/api/webhooks/shared-bot` | OpenClaw on boot (automatic) |
| `is_shared_bot = 0` | `https://app.helm.mom/api/webhooks/agent-bot/<new_deployment_id>` | Backend + OpenClaw on boot |

For **per-user bots** (`is_shared_bot = 0`), after creating the machine also register the Telegram webhook:

```
POST https://api.telegram.org/bot<TELEGRAM_BOT_TOKEN>/setWebhook
Content-Type: application/json

{
  "url": "https://app.helm.mom/api/webhooks/agent-bot/<new_deployment_id>",
  "secret_token": "<new_webhook_secret>",
  "allowed_updates": ["message", "edited_message", "callback_query", "my_chat_member"]
}
```

For **shared-bot agents**, do NOT call `setWebhook` — OpenClaw will register `/api/webhooks/shared-bot` when it boots. Calling `setWebhook` would overwrite the shared bot's webhook and break routing for all other users.

### Image Resolution

The current OpenClaw image is stored as a Fly secret `OPENCLAW_IMAGE` on `agenthelm-core`. To read it:

```bash
fly ssh console -a agenthelm-core --command "printenv OPENCLAW_IMAGE"
# or via exec endpoint if SSH is unavailable:
# POST /apps/agenthelm-core/machines/<id>/exec with ["printenv", "OPENCLAW_IMAGE"]
```

Alternatively, read it from the running machines in the `reins-openclaw` registry app:
```
GET /apps/reins-openclaw/machines
→ machines[0].config.image
```

### Deployment ID generation

IDs use a URL-safe base64 nanoid alphabet (A-Z, a-z, 0-9, `-`, `_`), 21 characters. Python:
```python
import secrets
ALPHABET = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz_-'
def nanoid(n=21): return ''.join(secrets.choice(ALPHABET) for _ in range(n))
```

### App name convention

```python
suffix = re.sub(r'[^a-z0-9]', '', deployment_id.lower())[:8]
app_name = f'reins-{suffix}'
```

### `deployed_agents` DB record (for reference)

After provisioning a new machine, the `deployed_agents` row must be updated. The Reins backend currently does not expose this mutation via the admin API — you must call the backend's `/api/agents/:id/deploy` endpoint or write directly to the DB via the exec endpoint on `agenthelm-core`.

Key columns:
| Column | Value |
|--------|-------|
| `id` | new_deployment_id |
| `agent_id` | agent's agents.id |
| `fly_app_name` | new app name |
| `fly_machine_id` | new machine ID |
| `fly_volume_id` | new volume ID |
| `status` | `running` |
| `management_url` | `https://<app>.fly.dev/chat?session=main` |
| `openclaw_webhook_url` | `https://<app>.fly.dev:8443/telegram-webhook` |
| `webhook_relay_secret` | new_webhook_secret |
| `gateway_token` | new_gateway_token |
| `runtime` | `openclaw` |
| `is_shared_bot` | 0 or 1 |

---

## Fly Org Reference

| Org | Purpose | Apps |
|-----|---------|------|
| `personal` | Production agent machines | All `reins-*` apps |
| `core-191` | Platform infrastructure | `agenthelm-core`, `agenthelm-onboarding` |
| `reins-dev` | Developer testing | Dev agent machines only |

Key apps in `core-191`:
- `agenthelm-core` — backend + frontend SPA. Machine ID `6e820d63cee048`. **Always 1 machine** (`max_machines_running = 1` in fly.toml — approval routing is in-memory).
- `agenthelm-onboarding` — Telegram onboarding bot. May scale to zero.

Key apps in `personal`:
- `reins-openclaw` — OpenClaw image registry (not a running service; just stores the image).
- `reins-hermes` — Hermes image registry.
- `reins-*` — Individual agent machines, one Fly app per agent.

---

## Reference Implementations

The main Reins repo contains starter Python scripts in `admin/` that implement the core operations described above. These are the reference implementations for recovery, exec, list, and restart. They intentionally omit DELETE operations.

Relevant source files in the main repo:
- `admin/lib/fly.py` — Fly API client (no DELETE, read + create only)
- `admin/lib/reins.py` — Reins admin API client
- `admin/recover_agent.py` — full agent recovery flow
- `backend/src/providers/fly.ts` — authoritative machine config builder (keep in sync)
- `scripts/recreate-missing-agents.mjs` — Node.js recovery script (earlier reference)

---

## Operational Notes

- **Never set `max_machines_running > 1` on `agenthelm-core`** — the approval/email routing uses an in-memory map per instance; multiple machines would break it.
- **Health check grace period is 120s** — new machines take up to 2 minutes to pass their first health check. Don't assume a machine is unhealthy if it shows `0/1` immediately after creation.
- **MiniMax model race on boot** — OpenClaw patches `models.json` after the gateway is healthy. First boot may return "Unknown model: openai/MiniMax-M2.7" for ~30 seconds. Normal; retry.
- **Shared-bot webhook** — OpenClaw registers the webhook on boot. Don't call `setWebhook` manually for shared-bot agents.
- **WireGuard is unreliable** — the exec endpoint (`POST /machines/<id>/exec`) is the reliable alternative. It uses HTTPS and doesn't require the WireGuard tunnel.
