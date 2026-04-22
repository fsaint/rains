#!/bin/sh
set -e

mkdir -p ~/.hermes

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

# ── config.yaml ────────────────────────────────────────────────────────────────
PROVIDER="${MODEL_PROVIDER:-anthropic}"
MODEL_ID="${MODEL_NAME:-claude-sonnet-4-5}"

# OpenAI requires the 'custom' provider (Hermes has no plain 'openai' provider).
# Reasoning must be disabled so standard GPT models work without org verification.
if [ "$MODEL_PROVIDER" = "openai" ] && [ -n "$OPENAI_API_KEY" ]; then
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

# ── Persona (SOUL.md) ──────────────────────────────────────────────────────────
if [ -n "$HERMES_PERSONA" ]; then
  printf '%s' "$HERMES_PERSONA" > ~/.hermes/SOUL.md
fi

# ── Usage reporter (background) ────────────────────────────────────────────────
if [ -n "$USAGE_CALLBACK_URL" ] && [ -n "$INSTANCE_USER_ID" ]; then
  (
    while true; do
      sleep 300
      curl -sf -X POST "$USAGE_CALLBACK_URL" \
        -H "Content-Type: application/json" \
        -d "{\"instanceId\":\"${INSTANCE_USER_ID}\",\"tokens\":0,\"source\":\"hermes\"}" \
        >/dev/null 2>&1 || true
    done
  ) &
fi

echo "[hermes] config.yaml:"
cat ~/.hermes/config.yaml
echo ""
echo "[hermes] Starting gateway..."
exec hermes gateway run --accept-hooks
