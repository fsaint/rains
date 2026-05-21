# Admin Tools

Python scripts for read-mostly production management. These live in `admin/` at the repo root.

## Permission model

The admin lane is one of three Fly permission lanes:

| Lane | Token | Org access | Can destroy? |
|------|-------|------------|-------------|
| Local dev | `.env` `FLY_API_TOKEN` | `reins-dev` only | Dev org only |
| CI/CD | GitHub Actions `FLY_API_TOKEN` | `core-191` (deploy only) | No |
| Production runtime | `agenthelm-core` Fly secret `FLY_API_TOKEN` | `personal` | Yes — via dashboard only |
| **Admin tools** | `admin/.env.admin` `FLY_ADMIN_TOKEN` | `personal` + `core-191` **read + restart** | **No** |

The admin toolset is structurally incapable of destroying production apps or machines:
1. `FLY_ADMIN_TOKEN` is a read-scoped Fly token (see setup below) — Fly returns 403 on DELETE calls.
2. `admin/lib/fly.py` has an ALLOWED_PATTERNS allowlist with no DELETE entries.
3. No destroy scripts exist in `admin/`.

## Setup

### 1. Mint the Fly token

```bash
# Read-only token for personal org (agent machines)
fly tokens create org-read --org personal \
  --name "admin-tools-personal-read" --expiry 720h

# Read-only token for core-191 org (platform apps)
fly tokens create org-read --org core-191 \
  --name "admin-tools-core191-read" --expiry 720h
```

Combine both output token strings, comma-separated, as `FLY_ADMIN_TOKEN`.

> If Fly's `org-read` scope does not allow machine exec or restart, you may need
> a scoped `deploy` token instead. Always verify with the hard-guard test below
> before shipping: `curl -X DELETE -H "Authorization: Bearer $FLY_ADMIN_TOKEN" ...`
> must return 403.

### 2. Set up credentials file

```bash
cp admin/.env.admin.example admin/.env.admin
# edit with your tokens and API key
```

### 3. Get the admin API key

The `REINS_ADMIN_API_KEY` is a Fly secret on `agenthelm-core`. Generate a new one:

```bash
NEW_KEY=$(openssl rand -hex 32)
fly secrets set --app agenthelm-core REINS_ADMIN_API_KEY="$NEW_KEY"
echo "REINS_ADMIN_API_KEY=$NEW_KEY"
```

Add the same value to `admin/.env.admin`.

## Available scripts

```bash
# List all agents (DB view via backend API)
python3 admin/list_agents.py

# List agents + live Fly machine state (slower)
python3 admin/list_agents.py --fly

# List all platform users
python3 admin/list_users.py

# Run a diagnostic command on a machine (no WireGuard needed)
python3 admin/exec_machine.py agenthelm-core 6e820d63cee048 -- ls /tmp
python3 admin/exec_machine.py reins-ykrjigoo 080de37f66d178 -- sh -c "ps aux | head -10"

# Restart a machine
python3 admin/restart_machine.py reins-ykrjigoo 080de37f66d178

# Recover a destroyed agent (recreates Fly app + machine from DB record)
python3 admin/recover_agent.py bX6AkIUQwE5gc9Izo57TM
```

## Hard-guard verification (run after every token rotation)

```bash
# Layer A — Fly token must refuse DELETE
curl -s -X DELETE \
  -H "Authorization: Bearer $FLY_ADMIN_TOKEN" \
  "https://api.machines.dev/v1/apps/reins-ykrjigoo"
# Expected: {"error":"unauthorized"} or 403. If you get 200, the token is too wide — do not use.

# Layer B — code allowlist blocks DELETE before any HTTP call
python3 -c "
import sys; sys.path.insert(0, 'admin')
from lib.fly import _check_allowed
try:
    _check_allowed('DELETE', '/v1/apps/reins-ykrjigoo')
    print('FAIL: should have raised PermissionError')
except PermissionError as e:
    print(f'OK: {e}')
"

# Layer C — no destroy scripts in admin/
ls admin/*destroy* admin/*delete* 2>&1 | grep -v 'No such file' && echo 'FAIL: found destroy script' || echo 'OK: no destroy scripts'
```

## Token rotation

Fly tokens expire after `--expiry`. Set a calendar reminder 7 days before expiry.

To rotate:
1. Mint new tokens with the commands above.
2. Update `admin/.env.admin`.
3. Re-run the hard-guard verification.

`REINS_ADMIN_API_KEY` does not expire automatically; rotate it quarterly or after any team member departure.

## What you cannot do from this lane

- Destroy Fly apps or machines in `personal` or `core-191`.
- Deploy new versions of `agenthelm-core` or `agenthelm-onboarding` (CI/CD lane only).
- Provision agents via the backend (production-runtime lane only — use the dashboard).

For intentional destruction:
- Use the Reins dashboard (Agents → Delete).
- Or `fly apps destroy <name>` with your personal `flyctl` account (full token, WireGuard needed — deliberate friction).
