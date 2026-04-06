#!/bin/bash
set -e

CONFIG_DIR="${HOME}/.openclaw"
WORKSPACE_DIR="${CONFIG_DIR}/workspace"

mkdir -p "$CONFIG_DIR" "$WORKSPACE_DIR" "$CONFIG_DIR/agents/main/sessions" "$CONFIG_DIR/agents/main/agent"
chmod 700 "$CONFIG_DIR"

# Copy workspace templates if not already present
if [ ! -f "$WORKSPACE_DIR/SOUL.md" ]; then
  cp /workspace-template/* "$WORKSPACE_DIR/" 2>/dev/null || true
fi

# Override SOUL.md from env var if provided
if [ -n "$SOUL_MD" ]; then
  echo "$SOUL_MD" > "$WORKSPACE_DIR/SOUL.md"
fi

# Generate openclaw.json from environment variables
generate_config() {
node -e "
const fs = require('fs');

const telegramToken = process.env.TELEGRAM_BOT_TOKEN || '';
const trustedUser = process.env.TELEGRAM_TRUSTED_USER || '';
const mcpConfig = JSON.parse(process.env.MCP_CONFIG || '[]');
const gatewayToken = process.env.OPENCLAW_GATEWAY_TOKEN || 'reins-' + Math.random().toString(36).slice(2);
const modelProvider = process.env.MODEL_PROVIDER || 'anthropic';
const defaultModelName = modelProvider === 'openai-codex' ? 'gpt-5.4' : 'claude-sonnet-4-5';
const modelName = process.env.MODEL_NAME || defaultModelName;

// Build MCP servers object from array
const mcpServers = {};
for (const server of mcpConfig) {
  if (server.name) {
    if (server.url) {
      // HTTP/SSE remote MCP server
      mcpServers[server.name] = {
        url: server.url,
        ...(server.transport ? { transport: server.transport } : {}),
        ...(server.headers ? { headers: server.headers } : {}),
      };
    } else {
      // stdio local MCP server
      mcpServers[server.name] = {
        command: server.command || 'npx',
        args: server.args || [],
        env: server.env || {},
      };
    }
  }
}

const config = {
  gateway: {
    port: 18789,
    mode: 'local',
    auth: { token: gatewayToken },
    controlUi: {
      dangerouslyAllowHostHeaderOriginFallback: true,
      dangerouslyDisableDeviceAuth: true,
    },
  },
  agents: {
    defaults: {
      workspace: '${WORKSPACE_DIR}',
      model: {
        primary: modelProvider + '/' + modelName,
      },
    },
  },
  channels: {
    telegram: {
      enabled: !!telegramToken,
      botToken: telegramToken,
      dmPolicy: trustedUser ? 'allowlist' : 'open',
      allowFrom: trustedUser ? [trustedUser] : ['*'],
      streaming: 'partial',
    },
  },
  browser: {
    enabled: true,
    headless: true,
    defaultProfile: 'openclaw',
    executablePath: '/home/node/.cache/ms-playwright/chromium-1208/chrome-linux/chrome',
    noSandbox: true,
  },
  // Configure audio transcription (Whisper) when OPENAI_API_KEY is available
  ...(process.env.OPENAI_API_KEY ? {
    tools: {
      media: {
        audio: {
          enabled: true,
          models: [
            { provider: 'openai', model: 'gpt-4o-mini-transcribe' },
          ],
        },
      },
    },
  } : {}),
  // Configure plugins including MCP bridge for HTTP/stdio MCP servers
  plugins: {
    enabled: true,
    allow: ['openclaw-mcp-bridge'],
    load: {
      paths: ['${HOME}/.openclaw/plugins/openclaw-mcp-bridge/node_modules/openclaw-mcp-bridge'],
    },
    ...(Object.keys(mcpServers).length > 0 ? {
      entries: {
        'openclaw-mcp-bridge': {
          enabled: true,
          config: {
            servers: mcpServers,
          },
        },
      },
    } : {}),
  },
};

fs.writeFileSync('${CONFIG_DIR}/openclaw.json', JSON.stringify(config, null, 2));
console.log('Generated openclaw.json');
console.log('Model:', modelProvider + '/' + modelName);
console.log('Telegram:', telegramToken ? 'configured' : 'not set');
console.log('MCP servers:', Object.keys(mcpServers).length);
"
}

generate_config

# Start usage reporter in background (reports every 5 minutes)
if [ -n "$USAGE_CALLBACK_URL" ] && [ -n "$INSTANCE_USER_ID" ]; then
  node -e "
    const INTERVAL = 5 * 60 * 1000;
    let lastInputTokens = 0;
    let lastOutputTokens = 0;

    async function reportUsage() {
      try {
        const res = await fetch('http://localhost:18789/healthz');
        if (!res.ok) return;

        const statsRes = await fetch('http://localhost:18789/api/v1/stats', {
          headers: { 'Authorization': 'Bearer ' + process.env.OPENCLAW_GATEWAY_TOKEN }
        });
        if (!statsRes.ok) return;
        const stats = await statsRes.json();

        const inputTokens = (stats.totalInputTokens || 0) - lastInputTokens;
        const outputTokens = (stats.totalOutputTokens || 0) - lastOutputTokens;

        if (inputTokens === 0 && outputTokens === 0) return;

        lastInputTokens = stats.totalInputTokens || 0;
        lastOutputTokens = stats.totalOutputTokens || 0;

        await fetch(process.env.USAGE_CALLBACK_URL, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            userId: process.env.INSTANCE_USER_ID,
            inputTokens,
            outputTokens,
          }),
        });
      } catch (err) {
        console.error('Usage report failed:', err.message);
      }
    }

    setInterval(reportUsage, INTERVAL);
    console.log('Usage reporter started (every 5m)');
  " &
fi

# Start Xvfb virtual framebuffer for headless browser rendering
Xvfb :99 -screen 0 1280x1024x24 -nolisten tcp &
export DISPLAY=:99

# If Codex tokens provided, do a two-phase startup:
# 1. Start gateway briefly so it creates dirs and runs doctor
# 2. Kill it, inject auth, restart
if [ -n "$OPENAI_CODEX_TOKENS" ]; then
  # Phase 1: let gateway initialize (creates dirs, runs doctor)
  node /app/openclaw.mjs gateway --bind lan --port 18789 &
  GATEWAY_PID=$!
  sleep 8
  kill $GATEWAY_PID 2>/dev/null
  wait $GATEWAY_PID 2>/dev/null

  # Phase 2: re-generate config (gateway init may have overwritten it) and inject auth
  generate_config
  node /write-codex-auth.js

  # Phase 3: restart gateway — it will read the auth file and correct config this time
  exec node /app/openclaw.mjs gateway --bind lan --port 18789
else
  exec node /app/openclaw.mjs gateway --bind lan --port 18789
fi
