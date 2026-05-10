# Updating a User's API Key

> **Note (2026-05):** In shared-bot mode, the platform provides the LLM API key via `MINIMAX_API_KEY` / `ANTHROPIC_API_KEY` on `agenthelm-core`. Individual users no longer supply their own key. To rotate the platform key, update the secret on `agenthelm-core` and restart the service — no per-user update is needed.
>
> This runbook applies to agents that were deployed with a **user-supplied API key** (custom-bot mode or pre-shared-bot deployments).

When a user's API key (MiniMax, OpenAI, etc.) is invalid or rotated, two things must be updated:
1. The `applicants` table in the DB (source of truth for re-provisioning)
2. The running Fly machine's env var (live key the agent actually uses)

## Step-by-step

### 1. Validate the new key

```bash
curl -s -X POST "https://api.minimax.io/v1/text/chatcompletion_v2" \
  -H "Authorization: Bearer <new-key>" \
  -H "Content-Type: application/json" \
  -d '{"model":"MiniMax-M2.7","messages":[{"role":"user","content":"hi"}],"max_tokens":5}' \
  | jq '{status: .base_resp, id: .id}'
```

Expect `status_code: 0`. If not, do not proceed — get a valid key first.

### 2. Update the DB

```bash
fly ssh console --app agenthelm-core --command "node -e \"
const sql = require('/app/node_modules/postgres')(process.env.DATABASE_URL);
sql\`UPDATE applicants SET minimax_key = '<new-key>', updated_at = NOW()
     WHERE username = '<telegram-username>'
     RETURNING telegram_user_id, username\`
  .then(r => { console.log(JSON.stringify(r)); sql.end(); })
  .catch(e => { console.error(e.message); sql.end(); });
\""
```

> The column is named `minimax_key` regardless of provider — it stores whichever LLM key was provided at onboarding.

### 3. Find the agent's Fly machine

```bash
fly ssh console --app agenthelm-core --command "node -e \"
const sql = require('/app/node_modules/postgres')(process.env.DATABASE_URL);
sql\`SELECT a.name, da.fly_app_name, da.fly_machine_id
     FROM deployed_agents da JOIN agents a ON da.agent_id = a.id
     JOIN applicants ap ON ap.deployment_id = da.id
     WHERE ap.username = '<telegram-username>'\`
  .then(r => { console.log(JSON.stringify(r, null, 2)); sql.end(); })
  .catch(e => { console.error(e.message); sql.end(); });
\""
```

### 4. Verify what key the machine is running

```bash
fly ssh console --app <fly_app_name> --command "env" | grep -i "openai\|minimax\|model"
```

MiniMax agents use `OPENAI_API_KEY` + `OPENAI_BASE_URL=https://api.minimax.io/v1` (OpenAI-compatible mode).

### 5. Update the machine env var

```bash
fly machine update <fly_machine_id> \
  --app <fly_app_name> \
  --env OPENAI_API_KEY=<new-key> \
  --yes
```

Wait for `Machine <id> updated successfully!` and `1/1` health check.

### 6. Notify the user

```bash
# Get onboarding bot token
fly ssh console --app agenthelm-onboarding --command "env" | grep ONBOARDING_BOT_TOKEN

# Send message (use onboarding bot — approvals bot requires an active chat session)
curl -s -X POST "https://api.telegram.org/<ONBOARDING_BOT_TOKEN>/sendMessage" \
  -H "Content-Type: application/json" \
  -d '{"chat_id": "<telegram_user_id>", "text": "Your agent is ready! There was an issue with your API key that has now been fixed."}'
```

Use `telegram_user_id` from the `applicants` table. For DMs, user ID and chat ID are the same value.

## Provider key env var mapping

| Provider  | Env var on machine                                                              |
|-----------|---------------------------------------------------------------------------------|
| MiniMax   | `OPENAI_API_KEY` (+ `OPENAI_BASE_URL=https://api.minimax.io/v1`)               |
| OpenAI    | `OPENAI_API_KEY`                                                                |
| Anthropic | `ANTHROPIC_API_KEY`                                                             |
