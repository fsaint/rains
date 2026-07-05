#!/bin/sh
set -e

mkdir -p ~/.hermes/skills

# Seed pre-installed AgentHelm skills (no-clobber — user skills take precedence)
if [ -d /agenthelm-skills ] && [ "$(ls -A /agenthelm-skills 2>/dev/null)" ]; then
  cp -rn /agenthelm-skills/* ~/.hermes/skills/ 2>/dev/null || true
fi

# ── Secrets (.env) ─────────────────────────────────────────────────────────────
{
  [ -n "$ANTHROPIC_API_KEY" ]       && echo "ANTHROPIC_API_KEY=${ANTHROPIC_API_KEY}"
  [ -n "$OPENAI_API_KEY" ]          && echo "OPENAI_API_KEY=${OPENAI_API_KEY}"
  [ -n "$MINIMAX_API_KEY" ]         && echo "MINIMAX_API_KEY=${MINIMAX_API_KEY}"
  [ -n "$TELEGRAM_BOT_TOKEN" ]      && echo "TELEGRAM_BOT_TOKEN=${TELEGRAM_BOT_TOKEN}"
  [ -n "$TELEGRAM_ALLOWED_USERS" ]  && echo "TELEGRAM_ALLOWED_USERS=${TELEGRAM_ALLOWED_USERS}"
  [ -n "$TELEGRAM_WEBHOOK_URL" ]    && echo "TELEGRAM_WEBHOOK_URL=${TELEGRAM_WEBHOOK_URL}"
  [ -n "$TELEGRAM_WEBHOOK_SECRET" ] && echo "TELEGRAM_WEBHOOK_SECRET=${TELEGRAM_WEBHOOK_SECRET}"
  [ -n "$TELEGRAM_WEBHOOK_PORT" ]   && echo "TELEGRAM_WEBHOOK_PORT=${TELEGRAM_WEBHOOK_PORT}"
} > ~/.hermes/.env

# Parse TELEGRAM_GROUPS_JSON and append group env vars for hermes-agent
if [ -n "$TELEGRAM_GROUPS_JSON" ]; then
  python3 - <<'PYEOF' >> ~/.hermes/.env
import json, os, sys
raw = os.environ.get('TELEGRAM_GROUPS_JSON', '')
if not raw:
    sys.exit(0)
try:
    groups = json.loads(raw)
    if not isinstance(groups, list):
        sys.exit(0)
    chat_ids = [str(g['chatId']) for g in groups if g.get('chatId')]
    if chat_ids:
        print(f"TELEGRAM_GROUP_ALLOWED_CHATS={','.join(chat_ids)}")
    if any(g.get('requireMention') for g in groups):
        print("TELEGRAM_GUEST_MODE=true")
except Exception:
    pass
PYEOF
fi

# ── config.yaml ────────────────────────────────────────────────────────────────
PROVIDER="${MODEL_PROVIDER:-anthropic}"
MODEL_ID="${MODEL_NAME:-claude-sonnet-4-5}"

# OpenAI-compatible endpoint — includes RouteLLM sidecar (localhost:4001) and other custom endpoints
if [ -n "$OPENAI_BASE_URL" ] && [ -n "$OPENAI_API_KEY" ]; then
  PROVIDER="custom"
  cat > ~/.hermes/config.yaml <<YAML
model:
  provider: "custom"
  default: "${MODEL_NAME:-router-mf-0.11785}"
  base_url: "${OPENAI_BASE_URL}"
  api_key: "${OPENAI_API_KEY}"

terminal:
  backend: "local"
  timeout: 180

memory:
  memory_enabled: true
  user_profile_enabled: true

agent:
  max_turns: 60
  reasoning_effort: "none"
YAML
# OpenAI requires the 'custom' provider (Hermes has no plain 'openai' provider).
# Reasoning must be disabled so standard GPT models work without org verification.
elif [ "$MODEL_PROVIDER" = "openai" ] && [ -n "$OPENAI_API_KEY" ]; then
  PROVIDER="custom"
  cat > ~/.hermes/config.yaml <<YAML
model:
  provider: "custom"
  default: "${MODEL_ID}"
  base_url: "https://api.openai.com/v1"
  api_key: "${OPENAI_API_KEY}"

terminal:
  backend: "local"
  timeout: 180

memory:
  memory_enabled: true
  user_profile_enabled: true

agent:
  max_turns: 60
  reasoning_effort: "none"
YAML
else
  cat > ~/.hermes/config.yaml <<YAML
model:
  provider: "${PROVIDER}"
  default: "${MODEL_ID}"

terminal:
  backend: "local"
  timeout: 180

memory:
  memory_enabled: true
  user_profile_enabled: true

agent:
  max_turns: 60
YAML
fi

# ── MCP servers ─────────────────────────────────────────────────────────────────
if [ -n "$MCP_CONFIG" ]; then
  python3 - <<'PYEOF' >> ~/.hermes/config.yaml
import json, os, sys

configs = json.loads(os.environ.get('MCP_CONFIG', '[]'))
if not configs:
    sys.exit(0)

print("")
print("mcp_servers:")
for cfg in configs:
    name = cfg.get('name', 'unnamed')
    transport = cfg.get('transport', 'http')
    if transport == 'http':
        url = cfg.get('url', '')
        print(f"  {name}:")
        print(f"    url: \"{url}\"")
    elif transport == 'stdio':
        cmd = cfg.get('command', '')
        args = cfg.get('args', [])
        print(f"  {name}:")
        print(f"    command: \"{cmd}\"")
        if args:
            print(f"    args: {json.dumps(args)}")
PYEOF
fi

# ── Pre-configure Telegram home channel + groups ───────────────────────────────
# TELEGRAM_ALLOWED_USERS holds the owner's Telegram user ID.
# For a private DM the chat_id equals the user_id, so we can seed the home
# channel without asking the user to /sethome manually on first boot.
# TELEGRAM_GROUPS_JSON (if set) adds group_allowed_chats, require_mention, and
# per-topic channel_prompts to the platforms.telegram config.
if [ -n "$TELEGRAM_ALLOWED_USERS" ]; then
  python3 - <<'PYEOF' >> ~/.hermes/config.yaml
import json, os

telegram_user = os.environ.get('TELEGRAM_ALLOWED_USERS', '')
groups_raw = os.environ.get('TELEGRAM_GROUPS_JSON', '')

groups = []
if groups_raw:
    try:
        parsed = json.loads(groups_raw)
        if isinstance(parsed, list):
            groups = parsed
    except Exception:
        pass

print("")
print("platforms:")
print("  telegram:")
print("    home_channel:")
print('      platform: "telegram"')
print(f'      chat_id: "{telegram_user}"')
print('      name: "Home"')

if groups:
    chat_ids = [str(g['chatId']) for g in groups if g.get('chatId')]
    # require_mention: true if ANY group requires it (conservative — avoids bot
    # flooding groups that only want @mention responses)
    require_mention = any(g.get('requireMention', False) for g in groups)

    if chat_ids:
        print("    extra:")
        print("      group_allowed_chats:")
        for cid in chat_ids:
            print(f'        - "{cid}"')
        print(f"      require_mention: {'true' if require_mention else 'false'}")

        # Per-topic prompts via channel_prompts (keyed by thread ID)
        channel_prompts = {}
        for g in groups:
            for tp in g.get('topicPrompts', []):
                if tp.get('threadId') and tp.get('prompt'):
                    channel_prompts[str(tp['threadId'])] = tp['prompt']

        if channel_prompts:
            print("      channel_prompts:")
            for thread_id, prompt in channel_prompts.items():
                print(f"        {json.dumps(thread_id)}: {json.dumps(prompt)}")
PYEOF
fi

# ── Persona (SOUL.md) ──────────────────────────────────────────────────────────
if [ -n "$HERMES_PERSONA" ]; then
  printf '%s' "$HERMES_PERSONA" > ~/.hermes/SOUL.md
else
  : > ~/.hermes/SOUL.md
fi

# Append first-run instructions if this is the agent's first boot
if [ -n "$INITIAL_PROMPT" ]; then
  printf '\n\n' >> ~/.hermes/SOUL.md
  printf '%s' "$INITIAL_PROMPT" >> ~/.hermes/SOUL.md
fi

# Append Reins platform knowledge so the agent can answer configuration and
# best-practice questions regardless of whether a persona was provided.
if [ -f /knowledge.md ]; then
  printf '\n\n' >> ~/.hermes/SOUL.md
  cat /knowledge.md >> ~/.hermes/SOUL.md
fi

# ── Usage reporter hook (agent:end) ────────────────────────────────────────────
# Install the usage_reporter hook so Hermes fires it after each agent turn.
# The hook estimates token usage from message/response length and reports to
# the AgentHelm backend, which enforces spend caps.
if [ -n "$USAGE_CALLBACK_URL" ] && [ -n "$INSTANCE_USER_ID" ] && [ -f "/agenthelm-hooks/usage_reporter/HOOK.yaml" ]; then
  mkdir -p ~/.hermes/hooks/usage_reporter
  cp /agenthelm-hooks/usage_reporter/HOOK.yaml ~/.hermes/hooks/usage_reporter/HOOK.yaml
  cp /agenthelm-hooks/usage_reporter/handler.py ~/.hermes/hooks/usage_reporter/handler.py
fi

# ── Health check server (background) ───────────────────────────────────────────
# Fly.io machines require an HTTP health check endpoint. hermes gateway run does
# not expose HTTP, so we start a minimal server on port 8000 that always returns 200.
python3 -c "
import http.server, socketserver
class H(http.server.BaseHTTPRequestHandler):
    def do_GET(self):
        self.send_response(200)
        self.end_headers()
        self.wfile.write(b'ok')
    def log_message(self, *args): pass
with socketserver.TCPServer(('0.0.0.0', 8000), H) as s:
    s.serve_forever()
" &

echo "[hermes] config.yaml:"
cat ~/.hermes/config.yaml
echo ""

# ── Model router sidecar (LiteLLM + RouteLLM) ──────────────────────────────
if [ -n "$LITELLM_CONFIG_B64" ]; then
  echo "[model-router] Decoding LiteLLM config..."
  echo "$LITELLM_CONFIG_B64" | base64 -d > /tmp/litellm_config.json

  python3 - <<'PYEOF'
import json
with open('/tmp/litellm_config.json') as f:
    config = json.load(f)
lines = ['model_list:']
for m in config.get('model_list', []):
    lines.append(f"  - model_name: {m['model_name']}")
    lines.append(f"    litellm_params:")
    for k, v in m.get('litellm_params', {}).items():
        lines.append(f"      {k}: \"{v}\"")
with open('/tmp/litellm_config.yaml', 'w') as f:
    f.write('\n'.join(lines) + '\n')
PYEOF

  python3 -m litellm --config /tmp/litellm_config.yaml --port 4000 --host 127.0.0.1 &
  for i in $(seq 1 30); do
    curl -sf http://127.0.0.1:4000/health > /dev/null 2>&1 && break
    sleep 1
  done
  echo "[model-router] LiteLLM ready"

  OPENAI_API_KEY=routellm-internal OPENAI_API_BASE=http://127.0.0.1:4000/v1 \
    python3 -m routellm.openai_server \
      --routers mf \
      --strong-model openai/strong \
      --weak-model openai/weak \
      --host 127.0.0.1 --port 4001 &
  for i in $(seq 1 30); do
    curl -sf http://127.0.0.1:4001/health > /dev/null 2>&1 && break
    sleep 1
  done
  echo "[model-router] RouteLLM ready"
fi
# ───────────────────────────────────────────────────────────────────────────

echo "[hermes] Starting gateway..."
exec hermes gateway run --accept-hooks
