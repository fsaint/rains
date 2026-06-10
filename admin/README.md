# Reins Admin Tools

Python scripts for read-mostly production management. These replace the ad-hoc Node.js scripts that were written under pressure during incidents.

## Setup

1. **Mint read-only Fly tokens:**

   ```bash
   # personal org (agents) — read + restart only
   fly tokens create org-read --org personal --name "admin-tools-personal-read" --expiry 720h

   # core-191 org (platform apps) — read only
   fly tokens create org-read --org core-191 --name "admin-tools-core191-read" --expiry 720h
   ```

   Combine both token strings (comma-separated) as `FLY_ADMIN_TOKEN`.

2. **Set up credentials file:**

   ```bash
   cp admin/.env.admin.example admin/.env.admin
   # edit admin/.env.admin with your tokens and API key
   ```

3. **Get the admin API key:**

   The `REINS_ADMIN_API_KEY` value is set as a Fly secret on `agenthelm-core`. Ask the platform admin or retrieve it via:

   ```bash
   fly ssh console -a agenthelm-core --command "env | grep REINS_ADMIN_API_KEY"
   ```

## Available scripts

| Script | What it does |
|--------|-------------|
| `list_agents.py` | List all agents with deployment and Fly state |
| `list_users.py` | List all platform users |
| `exec_machine.py <app> <id> -- <cmd>` | Run a diagnostic command on a machine (no WireGuard needed) |
| `restart_machine.py <app> <id>` | Restart a Fly machine |
| `recover_agent.py <agent_id>` | Recreate a destroyed Fly app/machine from the DB record |
| `update_minimax_model.py [--model X] [--dry-run]` | Redeploy all MiniMax agents with a new model name |

## What this lane CANNOT do

The `FLY_ADMIN_TOKEN` is scoped to **read + restart** only. The admin Python library (`lib/fly.py`) enforces an allowlist that has no DELETE operations.

**You cannot accidentally destroy a production app or machine from this toolset.** That is by design.

To destroy an app intentionally:
- Use the Reins dashboard (production-runtime lane — the deployed agenthelm-core holds the correct token).
- Or mint a wider Fly token explicitly, use `flyctl` manually, and accept the friction as the safety check.

## Security notes

- `admin/.env.admin` is gitignored. Never commit it.
- Rotate `FLY_ADMIN_TOKEN` every 30 days (Fly tokens expire after `--expiry`; set a calendar reminder).
- `REINS_ADMIN_API_KEY` rotates independently; update the Fly secret and `.env.admin` together.
- Scripts make HTTPS calls only — no WireGuard dependency. Works even when `fly ssh console` is unavailable.
