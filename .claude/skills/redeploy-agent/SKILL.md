---
name: redeploy-agent
description: Safely redeploy a Reins agent to the latest container image. Takes a backup, updates the Fly machine to the latest agentx-openclaw image, then restores the backup. Use when the user asks to "redeploy", "update the container", "upgrade the image", or "update [agent name]".
---

# Redeploy Agent

## What this skill does

Safely rolls an agent's Fly machine to the latest `agentx-openclaw` image:

1. **Backup** — dump the full Reins DB to `backend/data/backups/`
2. **Redeploy** — `fly machine update` the agent's machine to the latest image
3. **Restore** — restore the backup to ensure DB state is consistent post-deploy

## How to invoke

```
/redeploy-agent <agent-name>
```

`<agent-name>` is the human-readable name stored in the `agents` table (e.g. `violeta_aventurera`, `Email and Calendar`). Partial/case-insensitive matches are fine — confirm with the user if ambiguous.

## Step-by-step procedure

### 0. If no agent name was given

Ask: "Which agent would you like to redeploy? Run `psql postgres://rains:rains@localhost:5432/rains -c \"SELECT a.name, da.fly_app_name FROM deployed_agents da JOIN agents a ON da.agent_id = a.id ORDER BY a.name;\"` and show the list."

### 1. Look up the agent

```bash
psql postgres://rains:rains@localhost:5432/rains -c \
  "SELECT a.name, da.fly_app_name, da.fly_machine_id, da.gateway_token \
   FROM deployed_agents da JOIN agents a ON da.agent_id = a.id \
   WHERE LOWER(a.name) LIKE LOWER('%<agent-name>%');"
```

Confirm you have:
- `fly_app_name` (e.g. `agentx-cmn3s8e9`)
- `fly_machine_id` (e.g. `185022ec204dd8`)

If `fly_app_name` or `fly_machine_id` is null, stop and tell the user this agent has no Fly deployment.

### 2. Get the latest image

The latest deployed image is always available from the last successful `agentx-openclaw` deployment. Get it from the most recent healthy machine in `agentx-openclaw` (used as the base app):

```bash
fly machines list --app agentx-openclaw 2>&1 | grep -v "^Warning\|^$\|^Found\|^View"
```

Use the `IMAGE` column value. It looks like:
`registry.fly.io/agentx-openclaw:deployment-XXXX`

Alternatively, check what image the target machine is already running — if it matches the latest, tell the user it's already up-to-date and stop.

### 3. Backup

Run the backup using tsx:

```bash
cat > /tmp/do-backup.mts << 'EOF'
import { performBackup } from '/Users/fsaint/git/rains/backend/src/services/agent-backup.js';
const meta = await performBackup();
console.log(JSON.stringify(meta, null, 2));
EOF
npx tsx /tmp/do-backup.mts 2>&1
```

Capture the backup `id` from the output (e.g. `2026-04-09_21-36-39`). If the backup fails, **stop** — do not redeploy.

### 4. Redeploy

```bash
fly machine update <fly_machine_id> \
  --image <latest-image> \
  --app <fly_app_name> \
  --yes 2>&1
```

Wait for `Machine <id> updated successfully!` and health check `1/1`. If the machine fails to become healthy, report the error — the backup is safe to restore manually.

### 5. Restore

```bash
cat > /tmp/do-restore.mts << 'EOF'
import { restoreBackup } from '/Users/fsaint/git/rains/backend/src/services/agent-backup.js';
const result = await restoreBackup('<backup-id>');
console.log(JSON.stringify(result, null, 2));
EOF
npx tsx /tmp/do-restore.mts 2>&1
```

Confirm you see `"restored": { ... }` in the output with non-zero row counts.

### 6. Report results

Summarise:
- Backup ID and size
- Old image → new image
- Machine health check status
- Restore row counts (agents, credentials, service instances, etc.)

## Errors and recovery

| Situation | Action |
|-----------|--------|
| Backup fails | Stop. Do not redeploy. Show the error. |
| Redeploy fails / machine unhealthy | Report the error. Backup is safe at `backend/data/backups/<id>.json`. Suggest `fly machine update --image <old-image> --yes` to roll back. |
| Restore fails | Warn the user. The machine is running the new image but DB may be in an older state. Show the safety backup ID (taken by `restoreBackup` automatically). |

## Redeploying all agents

To redeploy all agents with a Fly deployment, run this skill for each agent returned by:

```bash
psql postgres://rains:rains@localhost:5432/rains -c \
  "SELECT a.name FROM deployed_agents da \
   JOIN agents a ON da.agent_id = a.id \
   WHERE da.fly_app_name IS NOT NULL AND da.fly_machine_id IS NOT NULL \
   ORDER BY a.name;"
```
