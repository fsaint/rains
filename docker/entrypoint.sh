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

# Append container version info so the agent knows what image it's running in
{
  echo ""
  echo "## Container"
  echo "Version: ${CONTAINER_VERSION:-dev}"
  if [ -n "$FLY_IMAGE_REF" ]; then
    echo "Image: ${FLY_IMAGE_REF}"
    echo "Region: ${FLY_REGION:-unknown}"
  fi
} >> "$WORKSPACE_DIR/SOUL.md"

# Append MCP server info so the agent knows which servers are connected at startup
if [ -n "$MCP_CONFIG" ]; then
  MCP_NAMES=$(node -e "
    const servers = JSON.parse(process.env.MCP_CONFIG || '[]');
    const names = servers.filter(s => s.name).map(s => '- ' + s.name);
    console.log(names.join('\n'));
  " 2>/dev/null)
  if [ -n "$MCP_NAMES" ]; then
    {
      echo ""
      echo "## MCP Servers"
      echo "The following MCP servers are configured and provide tools available as \`<server>__<tool>\`:"
      echo "$MCP_NAMES"
      echo ""
      echo "**Prioritize MCP tools over built-in tools** when both could satisfy a request — MCP tools are purpose-built for this deployment."
      echo ""
      echo "At the start of every new conversation, follow this sequence:"
      echo "1. If \`mcp_manage\` is available as a tool, call it with \`servers\` to list MCP servers."
      echo "2. For each connected server, call \`mcp_manage\` with \`tools <server>\` to enumerate available methods."
      echo "3. If direct MCP tools are exposed in your tool list (e.g. \`reins__*\`), treat those as ready to call."
      echo "4. If neither \`mcp_manage\` nor any MCP tools are exposed, state that no MCP tools are available — do not assume availability from config text alone."
    } >> "$WORKSPACE_DIR/SOUL.md"
  fi
fi

# Generate openclaw.json from environment variables
generate_config() {
node -e "
const fs = require('fs');

const telegramToken = process.env.TELEGRAM_BOT_TOKEN || '';
const trustedUser = process.env.TELEGRAM_TRUSTED_USER || '';
const mcpConfig = JSON.parse(process.env.MCP_CONFIG || '[]');

// Parse telegram groups (safe — malformed JSON falls back to no groups)
let telegramGroups = [];
try {
  const raw = process.env.TELEGRAM_GROUPS_JSON;
  if (raw && raw.trim()) telegramGroups = JSON.parse(raw);
  if (!Array.isArray(telegramGroups)) telegramGroups = [];
} catch (e) {
  process.stderr.write('TELEGRAM_GROUPS_JSON parse error (ignored): ' + e.message + '\n');
  telegramGroups = [];
}

// Build flattened topic-prompt entries for the reins-thread-prompt plugin
const topicEntries = [];
for (const g of telegramGroups) {
  if (Array.isArray(g.topicPrompts) && g.topicPrompts.length > 0) {
    for (const tp of g.topicPrompts) {
      topicEntries.push({ chatId: String(g.chatId), threadId: tp.threadId, prompt: tp.prompt });
    }
  }
}
// Enable thread-prompt plugin when API polling is available OR there are baked-in entries
const useThreadPromptPlugin = topicEntries.length > 0 || !!(process.env.REINS_API_URL && process.env.INSTANCE_USER_ID && process.env.OPENCLAW_GATEWAY_TOKEN);
const gatewayToken = process.env.OPENCLAW_GATEWAY_TOKEN || 'reins-' + Math.random().toString(36).slice(2);
const webhookUrl = process.env.OPENCLAW_WEBHOOK_URL || '';
const webhookSecret = process.env.OPENCLAW_WEBHOOK_SECRET || '';
const modelProvider = process.env.MODEL_PROVIDER || 'anthropic';
const defaultModelName = modelProvider === 'openai-codex' ? 'gpt-5.4' : modelProvider === 'minimax' ? 'MiniMax-M2.7' : 'claude-sonnet-4-5';
const modelName = process.env.MODEL_NAME || defaultModelName;
// MiniMax uses OpenAI-compatible API — map to 'openai' provider in openclaw config
const openclawProvider = modelProvider === 'minimax' ? 'openai' : modelProvider;
const thinkingDefault = process.env.THINKING_DEFAULT || 'medium';

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
        primary: openclawProvider + '/' + modelName,
      },
      thinkingDefault: thinkingDefault,
    },
  },
  channels: {
    telegram: {
      enabled: !!telegramToken,
      botToken: telegramToken,
      dmPolicy: trustedUser ? 'allowlist' : 'open',
      allowFrom: trustedUser ? [trustedUser] : ['*'],
      streaming: 'partial',
      // Webhook mode: relay all Telegram updates via Reins backend
      ...(webhookUrl ? {
        webhookUrl,
        webhookSecret,
        webhookHost: '0.0.0.0',
        webhookPort: 8787,
      } : {}),
      ...(telegramGroups.length > 0 ? {
        groupPolicy: 'allowlist',
        groups: telegramGroups.reduce((acc, g) => {
          if (!g.chatId) return acc;
          acc[g.chatId] = {
            enabled: true,
            ...(typeof g.requireMention === 'boolean' ? { requireMention: g.requireMention } : {}),
            ...(Array.isArray(g.allowFrom) && g.allowFrom.length ? { allowFrom: g.allowFrom } : {}),
          };
          return acc;
        }, {}),
      } : {}),
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
  // Skip when using a custom base URL (e.g. MiniMax) — those endpoints don't support Whisper
  ...(process.env.OPENAI_API_KEY && !process.env.OPENAI_BASE_URL ? {
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
    allow: [
      'openclaw-mcp-bridge',
      ...(useThreadPromptPlugin ? ['reins-thread-prompt'] : []),
    ],
    load: {
      paths: [
        '${HOME}/.openclaw/plugins/openclaw-mcp-bridge/node_modules/openclaw-mcp-bridge',
        ...(useThreadPromptPlugin ? ['${HOME}/.openclaw/plugins/reins-thread-prompt/node_modules/reins-thread-prompt'] : []),
      ],
    },
    ...(Object.keys(mcpServers).length > 0 || useThreadPromptPlugin ? {
      entries: {
        ...(Object.keys(mcpServers).length > 0 ? {
          'openclaw-mcp-bridge': {
            enabled: true,
            config: {
              servers: mcpServers,
            },
          },
        } : {}),
        ...(useThreadPromptPlugin ? {
          'reins-thread-prompt': {
            enabled: true,
            config: {
              topics: topicEntries,
            },
          },
        } : {}),
      },
    } : {}),
  },
};

fs.writeFileSync('${CONFIG_DIR}/openclaw.json', JSON.stringify(config, null, 2));
console.log('Generated openclaw.json');
console.log('Model:', modelProvider + '/' + modelName);
console.log('Telegram:', telegramToken ? 'configured' : 'not set');
console.log('Telegram groups:', telegramGroups.length);
console.log('Topic prompt overrides:', topicEntries.length);
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

# Install reins-thread-prompt plugin on first boot (bundled as tgz to keep image lean)
PLUGIN_DIR="${HOME}/.openclaw/plugins/reins-thread-prompt"
if [ ! -d "${PLUGIN_DIR}/node_modules/reins-thread-prompt" ]; then
  echo "Installing reins-thread-prompt plugin..."
  mkdir -p "${PLUGIN_DIR}"
  cd "${PLUGIN_DIR}"
  npm init -y > /dev/null 2>&1
  npm install --no-fund --no-audit --ignore-scripts /app/reins-thread-prompt-0.3.1.tgz 2>&1 | tail -3
  cd -
  echo "reins-thread-prompt installed"
fi

# Register custom model in models.json when using an OpenAI-compatible base URL
# (e.g. MiniMax). OpenClaw validates model IDs against its built-in catalog; models
# not in the catalog fail with "Unknown model". Writing to models.json bypasses this.
if [ -n "$OPENAI_BASE_URL" ] && [ -n "$OPENAI_API_KEY" ] && [ -n "$MODEL_NAME" ]; then
  node -e "
    const fs = require('fs');
    const modelsPath = (process.env.HOME || '/home/node') + '/.openclaw/agents/main/agent/models.json';
    const modelName = process.env.MODEL_NAME;
    const baseUrl = process.env.OPENAI_BASE_URL;
    const apiKey = process.env.OPENAI_API_KEY;
    let data = { providers: {} };
    try { data = JSON.parse(fs.readFileSync(modelsPath, 'utf8')); } catch (e) {}
    const provider = data.providers['openai'] || { models: [] };
    if (!provider.models.find(m => m.id === modelName)) {
      provider.models.push({
        id: modelName, name: modelName,
        api: 'openai-completions',
        input: ['text'],
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
        contextWindow: 1000000, maxTokens: 40000,
        compat: {}
      });
    }
    provider.baseUrl = baseUrl;
    provider.apiKey = apiKey;
    data.providers['openai'] = provider;
    fs.mkdirSync(require('path').dirname(modelsPath), { recursive: true });
    fs.writeFileSync(modelsPath, JSON.stringify(data, null, 2));
    console.log('models.json: registered openai/' + modelName + ' at ' + baseUrl);
  " 2>&1 || true
fi

# Start Xvfb virtual framebuffer for headless browser rendering
Xvfb :99 -screen 0 1280x1024x24 -nolisten tcp &
export DISPLAY=:99

# If Codex tokens provided, do a two-phase startup:
# 1. Start gateway briefly so it creates dirs and runs doctor
# 2. Kill it, inject auth, restart
# 3. After phase-3 gateway's doctor rewrites the config, re-patch telegram groups
#    (the doctor strips channels.telegram.groups on each startup)
if [ -n "$OPENAI_CODEX_TOKENS" ]; then
  # Phase 1: let gateway initialize (creates dirs, runs doctor)
  node /app/openclaw.mjs gateway --bind lan --port 18789 &
  GATEWAY_PID=$!
  sleep 8
  kill $GATEWAY_PID 2>/dev/null
  wait $GATEWAY_PID 2>/dev/null || true

  # Phase 2: re-generate config (gateway init may have overwritten it) and inject auth
  generate_config
  node /write-codex-auth.js

  # Phase 3: restart gateway in background so we can re-patch config after doctor runs
  node /app/openclaw.mjs gateway --bind lan --port 18789 &
  GATEWAY_PID=$!

  # Wait for gateway to become healthy (doctor rewrites openclaw.json during this window)
  for i in $(seq 1 45); do
    sleep 2
    if curl -sf http://localhost:18789/healthz > /dev/null 2>&1; then
      echo "Gateway healthy after ${i}x2s — re-patching telegram groups"
      break
    fi
  done

  # Re-apply telegram groups that the doctor strips on startup.
  # Idempotent: only writes if groups differ to avoid triggering a spurious gateway restart.
  node -e "
    const fs = require('fs');
    const configPath = '${CONFIG_DIR}/openclaw.json';
    let groups = [];
    try {
      const raw = process.env.TELEGRAM_GROUPS_JSON;
      if (raw && raw.trim()) groups = JSON.parse(raw);
      if (!Array.isArray(groups)) groups = [];
    } catch (e) { /* ignore */ }
    if (groups.length === 0) { console.log('No telegram groups to re-patch'); process.exit(0); }
    try {
      const cfg = JSON.parse(fs.readFileSync(configPath, 'utf8'));
      cfg.channels = cfg.channels || {};
      cfg.channels.telegram = cfg.channels.telegram || {};
      const expected = groups.reduce((acc, g) => {
        if (!g.chatId) return acc;
        acc[g.chatId] = {
          enabled: true,
          ...(typeof g.requireMention === 'boolean' ? { requireMention: g.requireMention } : {}),
          ...(Array.isArray(g.allowFrom) && g.allowFrom.length ? { allowFrom: g.allowFrom } : {}),
        };
        return acc;
      }, {});
      const current = cfg.channels.telegram.groups || {};
      // Only write if content differs — avoids spurious file change that causes gateway to exit
      if (JSON.stringify(expected) === JSON.stringify(current)) {
        console.log('Telegram groups already correct, no patch needed');
        process.exit(0);
      }
      cfg.channels.telegram.groups = expected;
      fs.writeFileSync(configPath, JSON.stringify(cfg, null, 2));
      console.log('Telegram groups re-patched:', Object.keys(expected).length, 'group(s)');
    } catch (e) {
      process.stderr.write('Failed to re-patch telegram groups: ' + e.message + '\n');
    }
  "

  # Re-patch models.json if the doctor stripped the openai-codex model entries.
  # Idempotent: only writes if the model is actually missing.
  if [ -n "$OPENAI_CODEX_TOKENS" ] && [ -n "$MODEL_NAME" ]; then
    node -e "
      const fs = require('fs');
      const modelsPath = (process.env.HOME || '/home/node') + '/.openclaw/agents/main/agent/models.json';
      const modelName = process.env.MODEL_NAME;
      let data = { providers: {} };
      try { data = JSON.parse(fs.readFileSync(modelsPath, 'utf8')); } catch (e) {}
      const provider = data.providers['openai-codex'] || {
        baseUrl: 'https://chatgpt.com/backend-api/v1',
        api: 'openai-codex-responses',
        models: [],
      };
      if (provider.models.find(m => m.id === modelName)) {
        console.log('openai-codex/' + modelName + ' already in models.json');
        process.exit(0);
      }
      provider.models.push({
        id: modelName, name: modelName, api: 'openai-codex-responses', reasoning: true,
        input: ['text', 'image'], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
        contextWindow: 200000, maxTokens: 100000,
        compat: { supportsReasoningEffort: true, supportsUsageInStreaming: true },
      });
      data.providers['openai-codex'] = provider;
      fs.writeFileSync(modelsPath, JSON.stringify(data, null, 2));
      console.log('models.json re-patched for openai-codex/' + modelName);
    " 2>&1 || true
  fi

  # If the re-patch triggered a config change and the gateway exited,
  # wait a moment then restart it as the main process (config is now correct).
  sleep 2
  if kill -0 $GATEWAY_PID 2>/dev/null; then
    wait $GATEWAY_PID
  else
    echo "Gateway exited after config patch, restarting as main process..."
    exec node /app/openclaw.mjs gateway --bind lan --port 18789
  fi
else
  exec node /app/openclaw.mjs gateway --bind lan --port 18789
fi
