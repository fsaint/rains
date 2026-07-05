#!/bin/bash
set -e

CONFIG_DIR="${HOME}/.openclaw"
WORKSPACE_DIR="${CONFIG_DIR}/workspace"

mkdir -p "$CONFIG_DIR" "$WORKSPACE_DIR" "$CONFIG_DIR/agents/main/sessions" "$CONFIG_DIR/agents/main/agent" "$CONFIG_DIR/agents/cron"
chmod 700 "$CONFIG_DIR"

# Symlink the default cron path into the Fly volume.
# OpenClaw writes to ~/.openclaw/cron/ by default (hardcoded in resolveDefaultCronStorePath).
# The volume is mounted at ~/.openclaw/agents/, so the real files live at agents/cron/.
# Recreated on every boot — the symlink itself is ephemeral but the target is on the volume.
if [ ! -L "$CONFIG_DIR/cron" ]; then
  rm -rf "$CONFIG_DIR/cron"
  ln -sf "$CONFIG_DIR/agents/cron" "$CONFIG_DIR/cron"
  echo "Linked cron store → agents/cron/ (volume-backed)"
fi

# Copy workspace templates if not already present
if [ ! -f "$WORKSPACE_DIR/SOUL.md" ]; then
  cp /workspace-template/* "$WORKSPACE_DIR/" 2>/dev/null || true
fi

# Override SOUL.md from env var if provided
if [ -n "$SOUL_MD" ]; then
  echo "$SOUL_MD" > "$WORKSPACE_DIR/SOUL.md"
fi

# Substitute deployment-specific placeholders in BOOTSTRAP.md (first boot only).
# INITIAL_PROMPT carries the per-deployment first-run instruction injected by the backend.
# envsubst limits substitution to the named vars to avoid clobbering other ${...} patterns.
if [ -f "$WORKSPACE_DIR/BOOTSTRAP.md" ]; then
  INITIAL_PROMPT="${INITIAL_PROMPT:-}" \
    envsubst '${INITIAL_PROMPT}' < "$WORKSPACE_DIR/BOOTSTRAP.md" > "$WORKSPACE_DIR/BOOTSTRAP.md.tmp" \
    && mv "$WORKSPACE_DIR/BOOTSTRAP.md.tmp" "$WORKSPACE_DIR/BOOTSTRAP.md"
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
      echo "MCP tools are pre-activated and appear directly in your tool list as \`<server>__<tool>\` (e.g. \`reins__list_emails\`). Use them immediately — **do NOT call \`mcp_manage\` at conversation start**. Calling \`mcp_manage\` to inspect servers adds unnecessary model round-trips that can cause response timeouts. If a \`reins__*\` tool is not in your list, tell the user instead of calling \`mcp_manage\`."
    } >> "$WORKSPACE_DIR/SOUL.md"
  fi
fi

# Append reference to memory policy so the agent knows where to find usage guidance
{
  echo ""
  echo "## References"
  echo ""
  echo "- **Memory hygiene & \`memory_*\` tool semantics** — read \`MEMORY_POLICY.md\` in your workspace before storing, searching, or linking memory entries."
} >> "$WORKSPACE_DIR/SOUL.md"

# Detect the Chromium executable path from Playwright's own registry.
# This survives Playwright version bumps (chromium-1208 → chromium-1217, etc.)
# without requiring a manual update to this file.
CHROMIUM_PATH=$(node -e "const { chromium } = require('/app/node_modules/playwright-core'); console.log(chromium.executablePath())" 2>/dev/null)
if [ -z "$CHROMIUM_PATH" ] || [ ! -f "$CHROMIUM_PATH" ]; then
  # Fallback: glob for any installed chromium binary
  CHROMIUM_PATH=$(ls /home/node/.cache/ms-playwright/chromium-*/chrome-linux*/chrome 2>/dev/null | head -1)
fi
echo "Chromium: ${CHROMIUM_PATH:-not found}"

# Export the real path so the wrapper script can exec it.
# The wrapper adds --disable-dev-shm-usage and --disable-gpu for container stability.
export CHROMIUM_REAL_PATH="${CHROMIUM_PATH}"
CHROMIUM_PATH=/usr/local/bin/chromium-wrapper
echo "Using Chromium wrapper: ${CHROMIUM_PATH}"

# Create /usr/bin symlinks for the OpenClaw browser tool detection code.
# The browser tool's findChromeExecutableLinux() only checks hardcoded /usr/bin/ paths
# (google-chrome, chrome, chromium, chromium-browser) — it does NOT search PATH or
# /usr/local/bin/. Without these symlinks, the browser tool fails with "No supported
# browser found" even when Chromium is installed via Playwright and the wrapper is in PATH.
for _name in google-chrome chrome chromium chromium-browser; do
  ln -sf /usr/local/bin/chromium-wrapper /usr/bin/$_name 2>/dev/null || true
done
unset _name

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
const defaultModelName = modelProvider === 'openai-codex' ? 'gpt-5.4' : modelProvider === 'minimax' ? 'MiniMax-M3' : 'claude-sonnet-4-6';
const modelName = process.env.MODEL_NAME || defaultModelName;
// OpenClaw 2026.5.27+ schema requires provider/model format.
// Codex auto-enable is prevented by setting models.providers.openai.baseUrl in openclaw.json
// (see the models: {} section below) — not by the provider name or any env var.
const primaryModel = modelProvider + '/' + modelName;
// Default to 'none' for non-Anthropic providers: OpenAI/MiniMax don't support extended thinking
// (GPT-4.1 is not an o-series model; reasoning_effort would cause API errors)
const thinkingDefault = process.env.THINKING_DEFAULT || (modelProvider === 'anthropic' ? 'medium' : 'none');

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
        primary: primaryModel,
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
      streaming: { mode: 'partial' },
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
    executablePath: '${CHROMIUM_PATH}',
    noSandbox: true,
    remoteCdpTimeoutMs: 60000,
    remoteCdpHandshakeTimeoutMs: 60000,
  },
  // For OpenAI-compatible endpoints, configure models.providers.openai in openclaw.json.
  // The gateway uses baseUrl for all API calls — set it to the real endpoint URL.
  // For native OpenAI (api.openai.com), the openai-responses transport is auto-selected
  // for models like gpt-4.1 and uses standard Bearer token auth (OPENAI_API_KEY).
  // The legacy codex mode (requiring OPENAI_CODEX_TOKENS) only triggers on providers["openai-codex"],
  // not providers["openai"], so using api.openai.com here is safe.
  ...(process.env.OPENAI_BASE_URL ? {
    models: {
      providers: {
        openai: {
          baseUrl: process.env.OPENAI_BASE_URL,
          ...(process.env.OPENAI_API_KEY ? { apiKey: process.env.OPENAI_API_KEY } : {}),
          // Declare available models so OpenClaw's capability resolver knows which models
          // support image inputs. Without this list the array is empty and OpenClaw falls
          // back to built-in defaults that don't exist on the MiniMax API, breaking vision.
          ...((process.env.OPENAI_BASE_URL || '').includes('minimax.io') ? {
            models: [
              { id: modelName, name: modelName, input: ['text', 'image'], contextWindow: 1048576, maxTokens: 8192 },
              ...(modelName !== 'MiniMax-VL01' ? [{ id: 'MiniMax-VL01', name: 'MiniMax Vision', input: ['text', 'image'], contextWindow: 1048576, maxTokens: 8192 }] : []),
            ],
          } : {}),
        },
      },
    },
  } : {}),
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
      // Add 'openai' plugin only for non-native OpenAI endpoints (e.g. MiniMax at api.minimax.io).
      // Native OpenAI (api.openai.com) uses openai-responses transport which handles MCP tool
      // format conversion internally. The 'openai' plugin on api.openai.com triggers the codex
      // agent runtime which registers tools as type:"custom", causing OpenAI API 400 errors.
      ...(process.env.OPENAI_BASE_URL && !process.env.OPENAI_BASE_URL.includes('api.openai.com') ? ['openai'] : []),
    ],
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
console.log('Model:', primaryModel);
console.log('Telegram:', telegramToken ? 'configured' : 'not set');
console.log('Telegram groups:', telegramGroups.length);
console.log('Topic prompt overrides:', topicEntries.length);
console.log('MCP servers:', Object.keys(mcpServers).length);
"
}

# Re-apply telegram group settings that the OpenClaw doctor strips on every startup.
# Called from Codex, MiniMax/OpenAI, and Anthropic startup paths after the doctor runs.
# Idempotent: only writes if groups, groupPolicy, or topic prompts differ.
repatch_telegram_groups() {
  node -e "
    const fs = require('fs');
    const configPath = '${CONFIG_DIR}/openclaw.json';
    let groups = [];
    try {
      const raw = process.env.TELEGRAM_GROUPS_JSON;
      if (raw && raw.trim()) groups = JSON.parse(raw);
      if (!Array.isArray(groups)) groups = [];
    } catch (e) { /* ignore */ }
    if (groups.length === 0) { console.log('[repatch] No telegram groups to re-patch'); process.exit(0); }

    // Build topic entries for reins-thread-prompt plugin
    const topicEntries = [];
    for (const g of groups) {
      if (Array.isArray(g.topicPrompts) && g.topicPrompts.length > 0) {
        for (const tp of g.topicPrompts) {
          topicEntries.push({ chatId: String(g.chatId), threadId: tp.threadId, prompt: tp.prompt });
        }
      }
    }

    try {
      let cfg = {};
      try { cfg = JSON.parse(fs.readFileSync(configPath, 'utf8')); } catch (e) { if (e.code !== 'ENOENT') throw e; }
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
      const currentPolicy = cfg.channels.telegram.groupPolicy;
      const existingTopics = (cfg.plugins && cfg.plugins.entries && cfg.plugins.entries['reins-thread-prompt'] && cfg.plugins.entries['reins-thread-prompt'].config && cfg.plugins.entries['reins-thread-prompt'].config.topics) || [];

      if (JSON.stringify(expected) === JSON.stringify(current) &&
          currentPolicy === 'allowlist' &&
          JSON.stringify(topicEntries) === JSON.stringify(existingTopics)) {
        console.log('[repatch] Telegram groups already correct, no patch needed');
        process.exit(0);
      }

      cfg.channels.telegram.groupPolicy = 'allowlist';
      cfg.channels.telegram.groups = expected;

      if (topicEntries.length > 0) {
        cfg.plugins = cfg.plugins || {};
        cfg.plugins.enabled = true;
        cfg.plugins.allow = cfg.plugins.allow || [];
        if (!cfg.plugins.allow.includes('reins-thread-prompt')) cfg.plugins.allow.push('reins-thread-prompt');
        cfg.plugins.entries = cfg.plugins.entries || {};
        cfg.plugins.entries['reins-thread-prompt'] = { enabled: true, config: { topics: topicEntries } };
      }

      fs.writeFileSync(configPath, JSON.stringify(cfg, null, 2));
      console.log('[repatch] Telegram groups re-patched:', Object.keys(expected).length, 'group(s),', topicEntries.length, 'topic prompt(s)');
    } catch (e) {
      process.stderr.write('[repatch] Failed to re-patch telegram groups: ' + e.message + '\n');
    }
  " 2>&1 || true
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

# reins-thread-prompt is pre-installed in the Docker image at build time.

# Note: custom model registration for OpenAI-compatible base URLs (e.g. MiniMax) is done
# AFTER the gateway initializes, because the gateway's doctor phase overwrites models.json
# on first boot. See the background poller in the startup section below.

# Start Xvfb virtual framebuffer for headless browser rendering
Xvfb :99 -screen 0 ${XVFB_RESOLUTION:-1280x1024x24} -nolisten tcp &
export DISPLAY=:99

# Pre-warm Chromium in the background so the 'openclaw' profile is decorated before the
# first user browser tool call. Chrome takes 10-30s to initialize a new profile; doing it
# here during gateway startup eliminates the cold-start race condition (profile decorates
# ~1s after the internal tool timeout on a fresh machine).
(
  sleep 2  # brief pause for Xvfb to settle
  echo "[prewarm] Warming Chromium profile..."
  "${CHROMIUM_REAL_PATH}" \
    --headless=new \
    --no-sandbox \
    --disable-dev-shm-usage \
    --disable-gpu \
    --user-data-dir="${CONFIG_DIR}/browsers/openclaw" \
    about:blank > /dev/null 2>&1 &
  PREWARM_PID=$!
  sleep 25
  kill $PREWARM_PID 2>/dev/null || true
  wait $PREWARM_PID 2>/dev/null || true
  echo "[prewarm] Chromium warm-up complete"
) &

# If Codex tokens provided, do a two-phase startup:
# 1. Start gateway briefly so it creates dirs and runs doctor
# 2. Kill it, inject auth, restart
# 3. After phase-3 gateway's doctor rewrites the config, re-patch telegram groups
#    (the doctor strips channels.telegram.groups on each startup)
if [ -n "$OPENAI_CODEX_TOKENS" ]; then
  # Phase 1: let gateway initialize (creates dirs, runs doctor)
  node /app/openclaw.mjs gateway --port 18789 &
  GATEWAY_PID=$!
  sleep 8
  kill $GATEWAY_PID 2>/dev/null
  wait $GATEWAY_PID 2>/dev/null || true

  # Phase 2: re-generate config (gateway init may have overwritten it) and inject auth
  generate_config
  node /write-codex-auth.js

  # Phase 3: restart gateway in background so we can re-patch config after doctor runs
  node /app/openclaw.mjs gateway --port 18789 &
  GATEWAY_PID=$!

  # Wait for gateway to become healthy (doctor rewrites openclaw.json during this window)
  for i in $(seq 1 45); do
    sleep 2
    if curl -sf http://localhost:18789/healthz > /dev/null 2>&1; then
      echo "Gateway healthy after ${i}x2s — re-patching telegram groups"
      break
    fi
  done

  # Re-apply telegram groups (groupPolicy + groups map + topic prompts) that the doctor strips.
  repatch_telegram_groups

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
    exec node /app/openclaw.mjs gateway --port 18789
  fi
elif [ -n "$OPENAI_BASE_URL" ] && [ -n "$MODEL_NAME" ]; then
  # For custom OpenAI-compatible base URLs (e.g. MiniMax), use a 2-phase startup on first
  # boot only. The gateway loads models.json into memory at boot and never re-reads it, so
  # we must inject the custom model BEFORE the final gateway start.
  #
  # Phase 1 lets the doctor create workspace + default models.json on the first boot.
  # On subsequent boots the workspace already exists — skipping Phase 1 prevents the doctor
  # from resetting workspace state, which causes slow (4+ min) Phase 2 startup and crashes.

  MODELS_PATH="${HOME:-/home/node}/.openclaw/agents/main/agent/models.json"
  if node -e "
    try {
      const fs = require('fs');
      const d = JSON.parse(fs.readFileSync('$MODELS_PATH', 'utf8'));
      const p = d.providers && d.providers['openai'];
      process.exit(p && p.models && p.models.find(m => m.id === '$MODEL_NAME') ? 0 : 1);
    } catch(e) { process.exit(1); }
  " 2>/dev/null; then
    echo "[entrypoint] models.json: $MODEL_NAME already registered, skipping Phase 1"
  else
    echo "[entrypoint] models.json: $MODEL_NAME not found, running Phase 1 to initialize workspace"
    # Phase 1: start briefly so doctor creates workspace + default models.json.
    # Poll for models.json to appear (ready in ~3-5s) instead of sleeping 8s unconditionally.
    node /app/openclaw.mjs gateway --port 18789 &
    GATEWAY_PID=$!
    PHASE1_DEADLINE=$((SECONDS + 12))
    until [ -f "$MODELS_PATH" ] || [ $SECONDS -gt $PHASE1_DEADLINE ]; do sleep 0.3; done
    kill $GATEWAY_PID 2>/dev/null
    wait $GATEWAY_PID 2>/dev/null || true

    # Re-generate openclaw.json (doctor may have overwritten it during phase 1)
    generate_config
  fi

  # Inject/update custom model into models.json before final startup
  node -e "
    const fs = require('fs'), path = require('path');
    const modelsPath = (process.env.HOME || '/home/node') + '/.openclaw/agents/main/agent/models.json';
    const modelName = process.env.MODEL_NAME;
    const baseUrl = process.env.OPENAI_BASE_URL;
    const apiKey = process.env.OPENAI_API_KEY;
    // Native OpenAI uses the Responses API which correctly converts MCP tools (type:"custom")
    // to type:"function". The Completions API path skips this conversion and sends type:"custom"
    // directly to the API, causing 400 errors. MiniMax/other custom endpoints stay on completions.
    const isNativeOpenAI = baseUrl && baseUrl.includes('api.openai.com');
    let data = { providers: {} };
    try { data = JSON.parse(fs.readFileSync(modelsPath, 'utf8')); } catch (e) {}
    const providerKey = 'openai';
    const provider = data.providers[providerKey] || { models: [] };
    if (!Array.isArray(provider.models)) provider.models = [];
    const apiType = isNativeOpenAI ? 'openai-responses' : 'openai-completions';
    const existing = provider.models.find(m => m.id === modelName);
    if (!existing) {
      provider.models.push({
        id: modelName, name: modelName,
        api: apiType,
        input: ['text'],
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
        contextWindow: 1000000, maxTokens: 40000,
        compat: { supportsTools: true }
      });
    } else if (existing.api !== apiType) {
      // Ensure correct api type even when doctor already registered the model
      existing.api = apiType;
    }
    provider.baseUrl = baseUrl;
    provider.apiKey = apiKey;
    data.providers[providerKey] = provider;
    fs.mkdirSync(path.dirname(modelsPath), { recursive: true });
    fs.writeFileSync(modelsPath, JSON.stringify(data, null, 2));
    console.log('[entrypoint] models.json: registered openai/' + modelName + (baseUrl ? ' at ' + baseUrl : ''));
  " 2>&1
  INJECT_EXIT=$?
  if [ $INJECT_EXIT -ne 0 ]; then
    echo "[entrypoint] FATAL: models.json injection failed (exit $INJECT_EXIT). Agent cannot start with an unregistered model." >&2
    exit 1
  fi

  # Strip browser.enabled from the MiniMax config so --allow-unconfigured does NOT enter
  # "auto-enable mode". When browser.enabled:true is present, OpenClaw auto-enables browser
  # and telegram from env/config but silently skips plugins.entries — so mcp-bridge never
  # loads. Without browser.enabled, the gateway starts in lazy mode (same as Anthropic Phase
  # 3 after doctor): extensions are auto-discovered per session, plugins.entries is processed,
  # and mcp-bridge loads with synchronous tool registration from the pre-cache.
  # Also remove gateway.mode+port — mode:'local' triggers doctor exit-78 and port is
  # overridden by the --port 18790 CLI flag anyway.
  node -e "
    const fs = require('fs');
    const configPath = (process.env.HOME || '/home/node') + '/.openclaw/openclaw.json';
    try {
      const cfg = JSON.parse(fs.readFileSync(configPath, 'utf8'));
      let changed = false;
      if (cfg.browser !== undefined) { delete cfg.browser; changed = true; }
      if (cfg.gateway) {
        if (cfg.gateway.mode !== undefined) { delete cfg.gateway.mode; changed = true; }
        if (cfg.gateway.port !== undefined) { delete cfg.gateway.port; changed = true; }
      }
      if (changed) {
        fs.writeFileSync(configPath, JSON.stringify(cfg, null, 2));
        console.log('[entrypoint] Stripped browser+gateway.mode+port from config (enables lazy plugin loading)');
      }
    } catch(e) { process.stderr.write('[entrypoint] Failed to strip config fields: ' + e.message + '\n'); }
  " 2>&1 || true

  # Pre-fetch MCP tool definitions so the patched plugin can register them synchronously
  # in register(). Without the cache at gateway start, the async .then() fires too late.
  if [ -n "$MCP_CONFIG" ]; then
    # node -e is broken in Node.js v24 for multi-line scripts — write to a file instead.
    cat > /tmp/mcp-pre-cache.mjs << 'EOF_PRECACHE'
(async () => {
  try {
    const config = JSON.parse(process.env.MCP_CONFIG || '[]');
    const servers = {};
    for (const s of config) { if (s.name && s.url) servers[s.name] = { url: s.url }; }
    if (!Object.keys(servers).length) { console.log('[pre-cache] No HTTP MCP servers'); return; }
    const { MCPManager } = await import('/app/dist/extensions/openclaw-mcp-bridge/dist/manager/mcp-manager.js');
    const manager = new MCPManager({ servers });
    await manager.connectAll();
    const tools = manager.getRegisteredTools();
    if (tools.length > 0) {
      const cache = tools.map(t => ({ namespacedName: t.namespacedName, description: t.description, inputSchema: t.inputSchema }));
      const { writeFileSync } = await import('fs');
      writeFileSync('/tmp/mcp-tools-cache.json', JSON.stringify(cache));
      console.log('[pre-cache] Cached', tools.length, 'MCP tools');
    } else {
      console.log('[pre-cache] No tools discovered from MCP server');
    }
    await manager.disconnectAll();
  } catch(err) { process.stderr.write('[pre-cache] failed: ' + err.message + '\n'); }
})();
EOF_PRECACHE
    for _attempt in 1 2 3; do
      echo "[entrypoint] pre-cache attempt ${_attempt}/3..."
      timeout 25 node /tmp/mcp-pre-cache.mjs 2>&1 || true
      if [ -f "/tmp/mcp-tools-cache.json" ]; then
        break
      fi
      [ "${_attempt}" -lt 3 ] && sleep 5
    done
    if [ -f "/tmp/mcp-tools-cache.json" ]; then
      node -e "
        try {
          const fs = require('fs');
          const cache = JSON.parse(fs.readFileSync('/tmp/mcp-tools-cache.json', 'utf8'));
          const toolNames = cache.map(t => t.namespacedName);
          if (toolNames.length > 0) {
            const manifestPath = '/app/dist/extensions/openclaw-mcp-bridge/openclaw.plugin.json';
            const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
            manifest.contracts = { tools: ['mcp_manage', ...toolNames] };
            fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2));
            console.log('[pre-cache] Patched manifest contracts.tools:', toolNames.length + 1, 'tools');
          }
        } catch(e) { process.stderr.write('[pre-cache] manifest patch failed: ' + e.message + '\n'); }
      " 2>&1 || true
    fi
  fi

  # Start TCP proxy so Fly IPv6 health checks reach the gateway on 127.0.0.1:18790.
  node -e "
    const net = require('net');
    const server = net.createServer(sock => {
      const dst = net.connect(18790, '127.0.0.1');
      sock.pipe(dst); dst.pipe(sock);
      sock.on('error', e => dst.destroy(e));
      dst.on('error', e => sock.destroy(e));
    });
    server.listen(18789, '::', () => process.stderr.write('[proxy] :::18789 -> 127.0.0.1:18790\n'));
  " &

  echo "[entrypoint] Starting gateway with --allow-unconfigured on internal port 18790 (TCP proxy on :::18789)"
  node /app/openclaw.mjs gateway --port 18790 --allow-unconfigured &
  GATEWAY_PID=$!

  # Phase 3: wait for gateway health, then start a background re-injection loop.
  # The OpenClaw doctor runs ~3 minutes after boot and rewrites models.json, stripping
  # any custom model entry. We loop every 15s for 5 minutes (20 iterations) to ensure
  # the custom model is always present — before, during, and after the doctor run.
  for _i in $(seq 1 45); do
    sleep 2
    if curl -sf http://localhost:18790/healthz > /dev/null 2>&1; then
      echo "[entrypoint] Gateway healthy after ${_i}x2s — starting models.json re-inject loop"
      break
    fi
  done
  (
    for _j in $(seq 1 20); do
      sleep 15
      node -e "
        const fs = require('fs');
        const mp = (process.env.HOME||'/home/node') + '/.openclaw/agents/main/agent/models.json';
        const mn = process.env.MODEL_NAME;
        const bu = process.env.OPENAI_BASE_URL;
        const ak = process.env.OPENAI_API_KEY;
        if (!mn) process.exit(0);
        let d = {providers: {}};
        try { d = JSON.parse(fs.readFileSync(mp,'utf8')); } catch(e) {}
        const p = d.providers['openai'] || {models: []};
        if (!Array.isArray(p.models)) p.models = [];
        if (!p.models.find(m => m.id === mn)) {
          p.models.push({id:mn,name:mn,api:'openai-completions',input:['text'],
            cost:{input:0,output:0,cacheRead:0,cacheWrite:0},
            contextWindow:1000000,maxTokens:40000,compat:{supportsTools:true}});
          if (bu) p.baseUrl = bu;
          if (ak) p.apiKey = ak;
          d.providers['openai'] = p;
          fs.writeFileSync(mp, JSON.stringify(d,null,2));
          console.log('[entrypoint] re-inject loop: added ' + mn);
        }
      " 2>&1 || true
    done
  ) &

  wait $GATEWAY_PID

  # Unreachable — exec replaces the shell. The exit-78 branch below is kept as dead
  # code for the unlikely case where the gateway exits unexpectedly.
  set +e
  PHASE2_EXIT=0
  set -e
  if [ "$PHASE2_EXIT" -eq 78 ]; then
    # Doctor completed: openclaw.json is now in Doctor's format (no gateway.mode).
    # Do NOT call generate_config here — it would re-add gateway.mode=local, causing another
    # exit-78 loop. The Doctor's config is complete; start Phase 3 with --allow-unconfigured
    # so the gateway accepts the Doctor-rewritten config without requiring a mode field.
    # Also re-inject models.json in case the Doctor stripped the MiniMax model entry.
    node -e "
      const fs = require('fs'), path = require('path');
      const modelsPath = (process.env.HOME || '/home/node') + '/.openclaw/agents/main/agent/models.json';
      const modelName = process.env.MODEL_NAME;
      const apiKey = process.env.OPENAI_API_KEY;
      if (!modelName) { console.log('[entrypoint] Phase 3: no custom model, skipping re-inject'); process.exit(0); }
      let data = { providers: {} };
      try { data = JSON.parse(fs.readFileSync(modelsPath, 'utf8')); } catch (e) {}
      const providerKey = 'openai';
      const provider = data.providers[providerKey] || { models: [] };
      if (!Array.isArray(provider.models)) provider.models = [];
      const baseUrl = process.env.OPENAI_BASE_URL || provider.baseUrl || '';
      if (!provider.models.find(m => m.id === modelName)) {
        provider.models.push({
          id: modelName, name: modelName, api: 'openai-completions', input: ['text'],
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
          contextWindow: 1000000, maxTokens: 40000, compat: { supportsTools: true }
        });
        console.log('[entrypoint] Phase 3: re-injected ' + modelName + ' into models.json');
      } else {
        console.log('[entrypoint] Phase 3: models.json ' + modelName + ' still present');
      }
      if (baseUrl) provider.baseUrl = baseUrl;
      if (apiKey) provider.apiKey = apiKey;
      data.providers[providerKey] = provider;
      // Remove openai-codex provider entry if the doctor injected it.
      delete data.providers['openai-codex'];
      fs.mkdirSync(path.dirname(modelsPath), { recursive: true });
      fs.writeFileSync(modelsPath, JSON.stringify(data, null, 2));
    " 2>&1 || true
    # Re-inject Telegram settings stripped by the doctor.
    # The doctor clears channels.telegram.allowFrom, webhookUrl, and gateway.controlUi on every
    # boot. Re-applying them here (before Phase 3 exec) means Phase 3 starts with the correct
    # config without requiring a gateway restart. Do NOT set gateway.port — Phase 3 uses the
    # --port 18790 CLI flag; adding gateway.port here would conflict with the proxy on 18789.
    node -e "
      const fs = require('fs');
      const configPath = (process.env.HOME || '/home/node') + '/.openclaw/openclaw.json';
      const telegramToken = process.env.TELEGRAM_BOT_TOKEN || '';
      const trustedUser = process.env.TELEGRAM_TRUSTED_USER;
      const webhookUrl = process.env.OPENCLAW_WEBHOOK_URL || '';
      const webhookSecret = process.env.OPENCLAW_WEBHOOK_SECRET || '';
      const modelProvider = process.env.MODEL_PROVIDER || 'anthropic';
      const modelName = process.env.MODEL_NAME || (modelProvider === 'minimax' ? 'MiniMax-M3' : '');
      const openaiBaseUrl = process.env.OPENAI_BASE_URL || '';
      const primaryModel = modelName ? (modelProvider + '/' + modelName) : null;
      try {
        let cfg = {};
        try {
          cfg = JSON.parse(fs.readFileSync(configPath, 'utf8'));
        } catch (readErr) {
          if (readErr.code !== 'ENOENT') throw readErr;
          // First boot: doctor didn't create config yet; bootstrap from scratch.
          const path = require('path');
          fs.mkdirSync(path.dirname(configPath), { recursive: true });
          console.log('[entrypoint] Phase 3: config missing, bootstrapping from env vars');
        }
        cfg.channels = cfg.channels || {};
        cfg.channels.telegram = cfg.channels.telegram || {};
        // The doctor strips botToken and enabled from the telegram channel on each run.
        // Re-inject both so the gateway can poll or relay Telegram messages in Phase 3.
        if (telegramToken) {
          cfg.channels.telegram.enabled = true;
          cfg.channels.telegram.botToken = telegramToken;
        }
        if (trustedUser) {
          cfg.channels.telegram.dmPolicy = 'allowlist';
          cfg.channels.telegram.allowFrom = [trustedUser];
        }
        if (webhookUrl) {
          cfg.channels.telegram.webhookUrl = webhookUrl;
          cfg.channels.telegram.webhookSecret = webhookSecret;
          cfg.channels.telegram.webhookHost = '0.0.0.0';
          cfg.channels.telegram.webhookPort = 8787;
        }
        cfg.gateway = cfg.gateway || {};
        cfg.gateway.controlUi = cfg.gateway.controlUi || {};
        cfg.gateway.controlUi.dangerouslyDisableDeviceAuth = true;
        cfg.gateway.controlUi.dangerouslyAllowHostHeaderOriginFallback = true;
        const mcpConfig = JSON.parse(process.env.MCP_CONFIG || '[]');
        const mcpServers = {};
        for (const s of mcpConfig) {
          if (s.name && s.url) {
            mcpServers[s.name] = { url: s.url, ...(s.transport ? { transport: s.transport } : {}) };
          } else if (s.name && s.command) {
            mcpServers[s.name] = { command: s.command, args: s.args || [], env: s.env || {} };
          }
        }
        if (Object.keys(mcpServers).length) {
          cfg.plugins = cfg.plugins || {};
          cfg.plugins.enabled = true;
          cfg.plugins.allow = cfg.plugins.allow || [];
          if (!cfg.plugins.allow.includes('openclaw-mcp-bridge')) cfg.plugins.allow.push('openclaw-mcp-bridge');
          cfg.plugins.entries = cfg.plugins.entries || {};
          cfg.plugins.entries['openclaw-mcp-bridge'] = { enabled: true, config: { servers: mcpServers } };
        }
        if (primaryModel) {
          cfg.agents = cfg.agents || {};
          cfg.agents.defaults = cfg.agents.defaults || {};
          cfg.agents.defaults.model = { primary: primaryModel };
        }
        // Re-add models.providers.openai config so the openai plugin has the correct endpoint.
        if (openaiBaseUrl) {
          cfg.models = cfg.models || {};
          cfg.models.providers = cfg.models.providers || {};
          cfg.models.providers.openai = cfg.models.providers.openai || {};
          cfg.models.providers.openai.baseUrl = openaiBaseUrl;
          const apiKey = process.env.OPENAI_API_KEY;
          if (apiKey) cfg.models.providers.openai.apiKey = apiKey;
        }
        fs.writeFileSync(configPath, JSON.stringify(cfg, null, 2));
        console.log('[entrypoint] Phase 3: re-injected Telegram + controlUi + plugins + model settings into openclaw.json');
      } catch (e) {
        process.stderr.write('[entrypoint] Phase 3: failed to re-inject Telegram settings: ' + e.message + '\n');
      }
    " 2>&1 || true
    repatch_telegram_groups
    # Pre-fetch MCP tool definitions so the plugin can register them synchronously.
    # openclaw drops api.registerTool() calls made after register() returns — the plugin's
    # async .then() fires too late. We write /tmp/mcp-tools-cache.json here (before exec)
    # and the patched plugin reads it synchronously in register().
    if [ -n "$MCP_CONFIG" ]; then
      # node -e is broken in Node.js v24 for multi-line scripts — write to a file instead.
      cat > /tmp/mcp-pre-cache.mjs << 'EOF_PRECACHE'
(async () => {
  try {
    const config = JSON.parse(process.env.MCP_CONFIG || '[]');
    const servers = {};
    for (const s of config) { if (s.name && s.url) servers[s.name] = { url: s.url }; }
    if (!Object.keys(servers).length) { console.log('[pre-cache] No HTTP MCP servers'); return; }
    const { MCPManager } = await import('/app/dist/extensions/openclaw-mcp-bridge/dist/manager/mcp-manager.js');
    const manager = new MCPManager({ servers });
    await manager.connectAll();
    const tools = manager.getRegisteredTools();
    if (tools.length > 0) {
      const cache = tools.map(t => ({ namespacedName: t.namespacedName, description: t.description, inputSchema: t.inputSchema }));
      const { writeFileSync } = await import('fs');
      writeFileSync('/tmp/mcp-tools-cache.json', JSON.stringify(cache));
      console.log('[pre-cache] Cached', tools.length, 'MCP tools');
    } else {
      console.log('[pre-cache] No tools discovered from MCP server');
    }
    await manager.disconnectAll();
  } catch(err) { process.stderr.write('[pre-cache] failed: ' + err.message + '\n'); }
})();
EOF_PRECACHE
      for _attempt in 1 2 3; do
        echo "[entrypoint] pre-cache attempt ${_attempt}/3..."
        timeout 25 node /tmp/mcp-pre-cache.mjs 2>&1 || true
        if [ -f "/tmp/mcp-tools-cache.json" ]; then
          break
        fi
        [ "${_attempt}" -lt 3 ] && sleep 5
      done
    fi
    # Patch openclaw-mcp-bridge manifest with discovered tool names as contracts.tools.
    # resolvePluginToolRuntimePluginIds only includes plugins that have non-empty contracts.tools
    # in their manifest — if absent, the plugin ID never enters scopedPluginIds and all its
    # registered tools are silently skipped during tool list construction.
    if [ -f "/tmp/mcp-tools-cache.json" ]; then
      node -e "
        try {
          const fs = require('fs');
          const cache = JSON.parse(fs.readFileSync('/tmp/mcp-tools-cache.json', 'utf8'));
          const toolNames = cache.map(t => t.namespacedName);
          if (toolNames.length > 0) {
            const manifestPath = '/app/dist/extensions/openclaw-mcp-bridge/openclaw.plugin.json';
            const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
            // Include mcp_manage (the plugin's built-in meta-tool) alongside the MCP server tools.
            // tools-Ciw2IILF.js rejects any tool not listed in contracts.tools at compile time.
            manifest.contracts = { tools: ['mcp_manage', ...toolNames] };
            fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2));
            console.log('[pre-cache] Patched manifest contracts.tools:', toolNames.length + 1, 'tools');
          }
        } catch(e) { process.stderr.write('[pre-cache] manifest patch failed: ' + e.message + '\n'); }
      " 2>&1 || true
    fi
    # Fly Firecracker VMs are IPv6-only — no IPv4 interfaces exist. The gateway's default
    # loopback bind (127.0.0.1) is unreachable from Fly's health checker, which connects
    # via the machine's private IPv6 address. A tiny Node.js TCP proxy bridges the gap:
    # listens on :::18789 (all IPv6 interfaces) and forwards to the gateway on 127.0.0.1:18790.
    # The proxy is started in the background before exec so it survives the shell replacement.
    node -e "
      const net = require('net');
      const server = net.createServer(sock => {
        const dst = net.connect(18790, '127.0.0.1');
        sock.pipe(dst); dst.pipe(sock);
        sock.on('error', e => dst.destroy(e));
        dst.on('error', e => sock.destroy(e));
      });
      server.listen(18789, '::', () => process.stderr.write('[proxy] :::18789 -> 127.0.0.1:18790\n'));
    " &
    echo "[entrypoint] Phase 3: starting gateway on internal port 18790 (proxy on :::18789)"
    exec node /app/openclaw.mjs gateway --port 18790 --allow-unconfigured
  elif [ "$PHASE2_EXIT" -ne 0 ]; then
    exit "$PHASE2_EXIT"
  fi
else
  # Anthropic path: 3-phase startup to survive the OpenClaw doctor rewrite.
  #
  # Every boot: the doctor runs, rewrites openclaw.json (removing gateway.mode), and
  # exits 78 as a "restart me" signal. We must catch that exit, regenerate the config,
  # and start the final gateway (Phase 3) — which starts cleanly because workspace is
  # already initialized from Phase 2.
  #
  # Phase 1 (10s kick-start): same as Codex/MiniMax — creates workspace dirs early so
  #   Phase 2's doctor run is shorter (reduces total first-boot time).
  # Phase 2 (foreground): doctor runs to completion, exits 78.
  # Phase 3 (exec): regenerated config + initialized workspace → stable start.
  AGENT_DIR="${HOME:-/home/node}/.openclaw/agents/main"
  if [ ! -d "$AGENT_DIR/agent" ] || [ -z "$(ls -A "$AGENT_DIR/agent" 2>/dev/null)" ]; then
    echo "[entrypoint] Phase 1: kick-starting workspace initialization"
    node /app/openclaw.mjs gateway --port 18789 &
    GATEWAY_PID=$!
    sleep 10
    kill $GATEWAY_PID 2>/dev/null
    wait $GATEWAY_PID 2>/dev/null || true
    echo "[entrypoint] Phase 1 complete, starting Phase 2 (doctor run)"
  fi
  # Always regenerate openclaw.json before Phase 2 — the config lives outside the volume
  # and is absent on every restart if Phase 1 was skipped.
  generate_config

  # Pre-fetch MCP tool definitions on every boot so the plugin can register them synchronously.
  # Phase 3 (after doctor exit-78) also runs the pre-cache, but the doctor only exits 78 on the
  # FIRST boot when the workspace is initialized. On subsequent restarts (e.g. after enabling
  # sandbox tools), Phase 2 runs the gateway directly without exiting 78, so Phase 3 never runs.
  # Running the pre-cache here (before Phase 2) ensures tools are always up-to-date on every restart.
  if [ -n "$MCP_CONFIG" ]; then
    cat > /tmp/mcp-pre-cache.mjs << 'EOF_PRECACHE'
(async () => {
  try {
    const config = JSON.parse(process.env.MCP_CONFIG || '[]');
    const servers = {};
    for (const s of config) { if (s.name && s.url) servers[s.name] = { url: s.url }; }
    if (!Object.keys(servers).length) { console.log('[pre-cache] No HTTP MCP servers'); return; }
    const { MCPManager } = await import('/app/dist/extensions/openclaw-mcp-bridge/dist/manager/mcp-manager.js');
    const manager = new MCPManager({ servers });
    await manager.connectAll();
    const tools = manager.getRegisteredTools();
    if (tools.length > 0) {
      const cache = tools.map(t => ({ namespacedName: t.namespacedName, description: t.description, inputSchema: t.inputSchema }));
      const { writeFileSync } = await import('fs');
      writeFileSync('/tmp/mcp-tools-cache.json', JSON.stringify(cache));
      console.log('[pre-cache] Cached', tools.length, 'MCP tools');
    } else {
      console.log('[pre-cache] No tools discovered from MCP server');
    }
    await manager.disconnectAll();
  } catch(err) { process.stderr.write('[pre-cache] failed: ' + err.message + '\n'); }
})();
EOF_PRECACHE
    for _attempt in 1 2 3; do
      echo "[entrypoint] pre-cache attempt ${_attempt}/3..."
      timeout 25 node /tmp/mcp-pre-cache.mjs 2>&1 || true
      if [ -f "/tmp/mcp-tools-cache.json" ]; then
        break
      fi
      [ "${_attempt}" -lt 3 ] && sleep 5
    done
    if [ -f "/tmp/mcp-tools-cache.json" ]; then
      node -e "
        try {
          const fs = require('fs');
          const cache = JSON.parse(fs.readFileSync('/tmp/mcp-tools-cache.json', 'utf8'));
          const toolNames = cache.map(t => t.namespacedName);
          if (toolNames.length > 0) {
            const manifestPath = '/app/dist/extensions/openclaw-mcp-bridge/openclaw.plugin.json';
            const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
            manifest.contracts = { tools: ['mcp_manage', ...toolNames] };
            fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2));
            console.log('[pre-cache] Patched manifest contracts.tools:', toolNames.length + 1, 'tools');
          }
        } catch(e) { process.stderr.write('[pre-cache] manifest patch failed: ' + e.message + '\n'); }
      " 2>&1 || true
    fi
  fi

  # Phase 2: run gateway in foreground; catch exit 78 from the doctor.
  # Use set +e to correctly capture exit code ($? inside `if ! cmd` is always 0, not the real code).
  set +e
  node /app/openclaw.mjs gateway --port 18789
  PHASE2_EXIT=$?
  set -e
  if [ "$PHASE2_EXIT" -eq 78 ]; then
    # Doctor completed: openclaw.json is in Doctor's format (no gateway.mode).
    # Do NOT call generate_config — it re-adds gateway.mode=local causing another exit-78 loop.
    # Re-inject Telegram settings stripped by the doctor (same as MiniMax path above).
    node -e "
      const fs = require('fs');
      const configPath = (process.env.HOME || '/home/node') + '/.openclaw/openclaw.json';
      const telegramToken = process.env.TELEGRAM_BOT_TOKEN || '';
      const trustedUser = process.env.TELEGRAM_TRUSTED_USER;
      const webhookUrl = process.env.OPENCLAW_WEBHOOK_URL || '';
      const webhookSecret = process.env.OPENCLAW_WEBHOOK_SECRET || '';
      const modelProvider = process.env.MODEL_PROVIDER || 'anthropic';
      const modelName = process.env.MODEL_NAME || '';
      const openaiBaseUrl = process.env.OPENAI_BASE_URL || '';
      const primaryModel = modelName ? (modelProvider + '/' + modelName) : null;
      try {
        let cfg = {};
        try {
          cfg = JSON.parse(fs.readFileSync(configPath, 'utf8'));
        } catch (readErr) {
          if (readErr.code !== 'ENOENT') throw readErr;
          // First boot: doctor didn't create config yet; bootstrap from scratch.
          const path = require('path');
          fs.mkdirSync(path.dirname(configPath), { recursive: true });
          console.log('[entrypoint] Phase 3: config missing, bootstrapping from env vars');
        }
        cfg.channels = cfg.channels || {};
        cfg.channels.telegram = cfg.channels.telegram || {};
        // The doctor strips botToken and enabled from the telegram channel on each run.
        // Re-inject both so the gateway can poll or relay Telegram messages in Phase 3.
        if (telegramToken) {
          cfg.channels.telegram.enabled = true;
          cfg.channels.telegram.botToken = telegramToken;
        }
        if (trustedUser) {
          cfg.channels.telegram.dmPolicy = 'allowlist';
          cfg.channels.telegram.allowFrom = [trustedUser];
        }
        if (webhookUrl) {
          cfg.channels.telegram.webhookUrl = webhookUrl;
          cfg.channels.telegram.webhookSecret = webhookSecret;
          cfg.channels.telegram.webhookHost = '0.0.0.0';
          cfg.channels.telegram.webhookPort = 8787;
        }
        cfg.gateway = cfg.gateway || {};
        cfg.gateway.controlUi = cfg.gateway.controlUi || {};
        cfg.gateway.controlUi.dangerouslyDisableDeviceAuth = true;
        cfg.gateway.controlUi.dangerouslyAllowHostHeaderOriginFallback = true;
        const mcpConfig = JSON.parse(process.env.MCP_CONFIG || '[]');
        const mcpServers = {};
        for (const s of mcpConfig) {
          if (s.name && s.url) {
            mcpServers[s.name] = { url: s.url, ...(s.transport ? { transport: s.transport } : {}) };
          } else if (s.name && s.command) {
            mcpServers[s.name] = { command: s.command, args: s.args || [], env: s.env || {} };
          }
        }
        if (Object.keys(mcpServers).length) {
          cfg.plugins = cfg.plugins || {};
          cfg.plugins.enabled = true;
          cfg.plugins.allow = cfg.plugins.allow || [];
          if (!cfg.plugins.allow.includes('openclaw-mcp-bridge')) cfg.plugins.allow.push('openclaw-mcp-bridge');
          cfg.plugins.entries = cfg.plugins.entries || {};
          cfg.plugins.entries['openclaw-mcp-bridge'] = { enabled: true, config: { servers: mcpServers } };
        }
        if (primaryModel) {
          cfg.agents = cfg.agents || {};
          cfg.agents.defaults = cfg.agents.defaults || {};
          cfg.agents.defaults.model = { primary: primaryModel };
        }
        // Re-add models.providers.openai config so the openai plugin has the correct endpoint.
        if (openaiBaseUrl) {
          cfg.models = cfg.models || {};
          cfg.models.providers = cfg.models.providers || {};
          cfg.models.providers.openai = cfg.models.providers.openai || {};
          cfg.models.providers.openai.baseUrl = openaiBaseUrl;
          const apiKey = process.env.OPENAI_API_KEY;
          if (apiKey) cfg.models.providers.openai.apiKey = apiKey;
        }
        fs.writeFileSync(configPath, JSON.stringify(cfg, null, 2));
        console.log('[entrypoint] Phase 3: re-injected Telegram + controlUi + plugins + model settings into openclaw.json');
      } catch (e) {
        process.stderr.write('[entrypoint] Phase 3: failed to re-inject Telegram settings: ' + e.message + '\n');
      }
    " 2>&1 || true
    repatch_telegram_groups
    # Pre-fetch MCP tool definitions so the plugin can register them synchronously.
    # openclaw drops api.registerTool() calls made after register() returns — the plugin's
    # async .then() fires too late. We write /tmp/mcp-tools-cache.json here (before exec)
    # and the patched plugin reads it synchronously in register().
    if [ -n "$MCP_CONFIG" ]; then
      # node -e is broken in Node.js v24 for multi-line scripts — write to a file instead.
      cat > /tmp/mcp-pre-cache.mjs << 'EOF_PRECACHE'
(async () => {
  try {
    const config = JSON.parse(process.env.MCP_CONFIG || '[]');
    const servers = {};
    for (const s of config) { if (s.name && s.url) servers[s.name] = { url: s.url }; }
    if (!Object.keys(servers).length) { console.log('[pre-cache] No HTTP MCP servers'); return; }
    const { MCPManager } = await import('/app/dist/extensions/openclaw-mcp-bridge/dist/manager/mcp-manager.js');
    const manager = new MCPManager({ servers });
    await manager.connectAll();
    const tools = manager.getRegisteredTools();
    if (tools.length > 0) {
      const cache = tools.map(t => ({ namespacedName: t.namespacedName, description: t.description, inputSchema: t.inputSchema }));
      const { writeFileSync } = await import('fs');
      writeFileSync('/tmp/mcp-tools-cache.json', JSON.stringify(cache));
      console.log('[pre-cache] Cached', tools.length, 'MCP tools');
    } else {
      console.log('[pre-cache] No tools discovered from MCP server');
    }
    await manager.disconnectAll();
  } catch(err) { process.stderr.write('[pre-cache] failed: ' + err.message + '\n'); }
})();
EOF_PRECACHE
      for _attempt in 1 2 3; do
        echo "[entrypoint] pre-cache attempt ${_attempt}/3..."
        timeout 25 node /tmp/mcp-pre-cache.mjs 2>&1 || true
        if [ -f "/tmp/mcp-tools-cache.json" ]; then
          break
        fi
        [ "${_attempt}" -lt 3 ] && sleep 5
      done
    fi
    # Patch openclaw-mcp-bridge manifest with discovered tool names as contracts.tools.
    # resolvePluginToolRuntimePluginIds only includes plugins that have non-empty contracts.tools
    # in their manifest — if absent, the plugin ID never enters scopedPluginIds and all its
    # registered tools are silently skipped during tool list construction.
    if [ -f "/tmp/mcp-tools-cache.json" ]; then
      node -e "
        try {
          const fs = require('fs');
          const cache = JSON.parse(fs.readFileSync('/tmp/mcp-tools-cache.json', 'utf8'));
          const toolNames = cache.map(t => t.namespacedName);
          if (toolNames.length > 0) {
            const manifestPath = '/app/dist/extensions/openclaw-mcp-bridge/openclaw.plugin.json';
            const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
            // Include mcp_manage (the plugin's built-in meta-tool) alongside the MCP server tools.
            // tools-Ciw2IILF.js rejects any tool not listed in contracts.tools at compile time.
            manifest.contracts = { tools: ['mcp_manage', ...toolNames] };
            fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2));
            console.log('[pre-cache] Patched manifest contracts.tools:', toolNames.length + 1, 'tools');
          }
        } catch(e) { process.stderr.write('[pre-cache] manifest patch failed: ' + e.message + '\n'); }
      " 2>&1 || true
    fi
    # Fly Firecracker VMs are IPv6-only — no IPv4 interfaces exist. The gateway's default
    # loopback bind (127.0.0.1) is unreachable from Fly's health checker, which connects
    # via the machine's private IPv6 address. A tiny Node.js TCP proxy bridges the gap:
    # listens on :::18789 (all IPv6 interfaces) and forwards to the gateway on 127.0.0.1:18790.
    # The proxy is started in the background before exec so it survives the shell replacement.
    node -e "
      const net = require('net');
      const server = net.createServer(sock => {
        const dst = net.connect(18790, '127.0.0.1');
        sock.pipe(dst); dst.pipe(sock);
        sock.on('error', e => dst.destroy(e));
        dst.on('error', e => sock.destroy(e));
      });
      server.listen(18789, '::', () => process.stderr.write('[proxy] :::18789 -> 127.0.0.1:18790\n'));
    " &
    echo "[entrypoint] Phase 3: starting gateway on internal port 18790 (proxy on :::18789)"
    exec node /app/openclaw.mjs gateway --port 18790 --allow-unconfigured
  elif [ "$PHASE2_EXIT" -ne 0 ]; then
    exit "$PHASE2_EXIT"
  fi
fi
