# MCP Tool Injection — End-to-End Architecture

This document explains how remote MCP tools are connected, installed, and injected into an OpenClaw agent's context, from Fly.io machine boot to the model calling a tool.

---

## Overview

```
Fly Machine Boot
     │
     ▼
entrypoint.sh generates openclaw.json
     │  (MCP_CONFIG env var → plugin entries)
     ▼
OpenClaw gateway starts (two-phase if Codex)
     │
     ▼
Plugin runtime loads openclaw-mcp-bridge
     │  (register(api) called synchronously)
     ▼
MCPManager.connectAll() → initialize handshake → tools/list
     │  (retried with backoff if event loop was blocked)
     ▼
Tools registered into agent context
     │  (api.registerTool() per discovered tool)
     ▼
Model calls  reins__gmail_search(...) directly
```

---

## Step 1: Environment Variables → openclaw.json

When a Fly machine starts, `entrypoint.sh` reads the `MCP_CONFIG` environment variable — a JSON array of server descriptors — and generates `~/.openclaw/openclaw.json`.

**Input (`MCP_CONFIG` env var):**
```json
[
  {
    "name": "reins",
    "url": "https://your-reins-instance.fly.dev/mcp",
    "transport": "streamable-http"
  }
]
```

**Output (relevant section of `openclaw.json`):**
```json
{
  "plugins": {
    "enabled": true,
    "allow": ["openclaw-mcp-bridge"],
    "load": {
      "paths": ["/home/node/.openclaw/plugins/openclaw-mcp-bridge/node_modules/openclaw-mcp-bridge"]
    },
    "entries": {
      "openclaw-mcp-bridge": {
        "enabled": true,
        "config": {
          "servers": {
            "reins": {
              "url": "https://your-reins-instance.fly.dev/mcp",
              "transport": "streamable-http"
            }
          }
        }
      }
    }
  }
}
```

The `servers` map is keyed by the logical server name (e.g. `reins`). This name becomes the namespace prefix on every tool: `reins__gmail_search`, `reins__calendar_list_events`, etc.

---

## Step 2: Plugin Installation (Docker Build Time)

The `openclaw-mcp-bridge` plugin is baked into the Docker image at build time:

```dockerfile
# From docker/Dockerfile
COPY openclaw-mcp-bridge-0.3.5.tgz /tmp/openclaw-mcp-bridge-0.3.5.tgz
RUN mkdir -p /home/node/.openclaw/plugins/openclaw-mcp-bridge && \
    cd /home/node/.openclaw/plugins/openclaw-mcp-bridge && \
    npm init -y > /dev/null 2>&1 && \
    npm install /tmp/openclaw-mcp-bridge-0.3.5.tgz && \
    chown -R node:node /home/node/.openclaw
```

The plugin is installed as a local npm package into `/home/node/.openclaw/plugins/openclaw-mcp-bridge/node_modules/openclaw-mcp-bridge/`. OpenClaw's plugin loader finds it via the `load.paths` entry in `openclaw.json`.

---

## Step 3: Two-Phase Gateway Startup (Codex agents)

Agents configured with Codex tokens go through a two-phase startup that blocks the Node.js event loop for approximately 30 seconds:

```
Phase 1 (8 s)  — Gateway starts, creates directories, runs doctor checks
                   └─ killed after 8s
Phase 2         — openclaw.json regenerated, Codex auth injected
Phase 3         — Gateway restarts (final, permanent)
                   └─ Event loop is blocked here for ~30s while
                      Codex completes its initialization sequence
```

**Why this matters for MCP:** When the plugin's `register()` is called during Phase 3, it immediately fires an HTTP `initialize` request to the MCP server. The server responds within milliseconds, but the Node.js event loop is blocked — the response cannot be processed. When the event loop finally frees up (~30s later), the `AbortController` timeout fires and cancels the request even though the response was already waiting in the socket buffer.

The fix is retry-with-backoff in the plugin (see Step 5).

---

## Step 4: Plugin Loading — `register(api)` Called Synchronously

When the OpenClaw gateway starts, it:

1. Reads `openclaw.json` and finds `plugins.entries["openclaw-mcp-bridge"]`
2. Validates the plugin config against the plugin's JSON schema
3. `require()`s the plugin's entry point (`dist/index.js`)
4. Calls `plugin.register(api)` **synchronously**

`register()` must complete synchronously. Any async work happens via detached promises. OpenClaw logs a warning if `register()` returns a Promise.

**What `register()` does synchronously:**

```typescript
// src/index.ts
function register(api: PluginApi): void {
  // 1. Register mcp_manage as a meta-tool (always available, even before connection)
  api.registerTool({ name: "mcp_manage", ... });

  // 2. Create the shared MCPManager singleton (once across all register() calls)
  if (!sharedManager) {
    sharedManager = new MCPManager(toManagerConfig(config));
    connectPromise = retryConnect(sharedManager).catch(...);
  }

  // 3. Attach a .then() to register tools into THIS api context once connected
  connectPromise!.then(() => {
    for (const rt of manager.getRegisteredTools()) {
      api.registerTool({ name: rt.namespacedName, ... });
    }
  });

  // 4. Register gateway_stop hook for graceful shutdown
  api.registerHook("gateway_stop", async () => { ... });
}
```

The `sharedManager` singleton is important: OpenClaw calls `register()` once per agent context (multiple times at startup). Without the singleton, each call would open N duplicate connections to the same MCP servers.

---

## Step 5: MCP Connection — Initialize Handshake

`MCPManager.connectAll()` connects to each server in the config:

```
Plugin → POST https://reins.../mcp
         Content-Type: application/json
         Body: {"jsonrpc":"2.0","method":"initialize","params":{
                  "protocolVersion":"2025-03-26",
                  "capabilities":{"roots":{"listChanged":false}},
                  "clientInfo":{"name":"openclaw-mcp-client","version":"1.0.0"}
                },"id":1}

Server → 200 OK
         Content-Type: application/json
         Body: {"jsonrpc":"2.0","result":{
                  "protocolVersion":"2025-03-26",
                  "capabilities":{...},
                  "serverInfo":{"name":"reins","version":"..."}
                },"id":1}

Plugin → POST https://reins.../mcp
         Body: {"jsonrpc":"2.0","method":"notifications/initialized","id":null}

Plugin → POST https://reins.../mcp
         Body: {"jsonrpc":"2.0","method":"tools/list","id":2}

Server → 200 OK
         Body: {"jsonrpc":"2.0","result":{"tools":[
                  {"name":"gmail_search","description":"...","inputSchema":{...}},
                  {"name":"calendar_list_events","description":"...","inputSchema":{...}},
                  ...33 tools total
                ]},"id":2}
```

### Retry logic (v0.3.5+)

Because the event loop blocking during Codex startup causes the first attempt to be aborted, the plugin retries with fixed delays:

```typescript
const retryDelaysMs = [0, 5_000, 15_000, 45_000]; // attempts at T+0, T+5s, T+20s, T+65s

for (const delay of retryDelaysMs) {
  if (delay > 0) await sleep(delay);
  // Disconnect any servers that errored on the previous attempt
  for (const conn of manager.getConnections()) {
    if (conn.status === "error") await manager.disconnect(conn.name);
  }
  await manager.connectAll();
  if (manager.getRegisteredTools().length > 0) return; // success
}
```

In practice, the first attempt fails (event loop blocked), and either the 5s or 15s retry succeeds (event loop free by then). Tools are available within ~20–40 seconds of gateway startup.

---

## Step 6: Tool Registration into Agent Context

Once the MCP connection resolves, each discovered tool is registered into the OpenClaw agent context:

```typescript
// JSON Schema → TypeBox conversion
function buildTypeBoxSchema(inputSchema: MCPToolInput) {
  // converts {"type":"string","description":"..."} → Type.String({description:"..."})
  // optional fields wrapped in Type.Optional()
}

for (const rt of registeredTools) {
  api.registerTool({
    name: rt.namespacedName,       // e.g. "reins__gmail_search"
    label: rt.description.slice(0, 60),
    description: rt.description,
    parameters: buildTypeBoxSchema(rt.inputSchema),
    async execute(_toolCallId, params) {
      const result = await manager.callTool(rt.namespacedName, params);
      return { content: [{ type: "text", text: JSON.stringify(result) }], details: result };
    },
  });
}
```

The `namespacedName` format is `<server-name>__<tool-name>` (double underscore). With server name `reins`, a tool named `gmail_search` becomes `reins__gmail_search`.

---

## Step 7: Tool Invocation

When the model calls `reins__gmail_search`:

```
Model calls reins__gmail_search({"query": "invoice", "max_results": 10})
     │
     ▼
OpenClaw routes to plugin's execute() handler
     │
     ▼
MCPManager.callTool("reins__gmail_search", params)
     │  strips namespace prefix → "gmail_search"
     ▼
POST https://reins.../mcp
Body: {"jsonrpc":"2.0","method":"tools/call",
       "params":{"name":"gmail_search","arguments":{"query":"invoice","max_results":10}},
       "id":3}
     │
     ▼
Server executes → returns result JSON
     │
     ▼
Plugin returns { content: [{ type: "text", text: "..." }] }
     │
     ▼
OpenClaw delivers tool result to model context
```

---

## Runtime Tool Discovery

The `mcp_manage` tool is always registered synchronously (before any connection attempt) so the model can inspect MCP status at any time:

| Command | Description |
|---------|-------------|
| `mcp_manage servers` | List all configured servers and connection status |
| `mcp_manage tools reins` | List all tools from the `reins` server |
| `mcp_manage status reins` | Detailed connection status for one server |
| `mcp_manage refresh reins` | Force re-discovery of tools from a server |
| `mcp_manage connect <url>` | Connect to a new server at runtime |
| `mcp_manage disconnect reins` | Disconnect a server |

The SOUL.md is also injected at boot with the list of configured MCP servers and instructions to call `mcp_manage` at the start of every conversation (see `entrypoint.sh`).

---

## Key Files

| File | Role |
|------|------|
| `docker/entrypoint.sh` | Generates `openclaw.json` from env vars; manages two-phase Codex startup |
| `docker/Dockerfile` | Installs plugin tarball into `/home/node/.openclaw/plugins/` at build time |
| `openclaw-mcp-bridge/src/index.ts` | Plugin entry point — `register(api)`, retry logic, tool injection |
| `openclaw-mcp-bridge/src/manager/mcp-manager.ts` | MCP session lifecycle, tool discovery, tool invocation routing |
| `openclaw-mcp-bridge/src/transport/streamable-http.ts` | HTTP transport — POST requests, SSE streaming, AbortController timeouts |
| `openclaw-mcp-bridge/src/manager/tool-registry.ts` | In-memory registry of discovered tools, namespace management |
| `openclaw-mcp-bridge/src/config-schema.ts` | TypeBox config schema validated by OpenClaw at plugin load time |

---

## Known Quirks

**Health checks show 0/1 on some Fly machines.** The OpenClaw gateway does not expose a TCP health-check endpoint by default. Some agent apps were deployed without a health check config, so Fly's health check always shows `0/1`. The machine is running normally — this is a Fly configuration gap, not a gateway failure.

**`api.pluginConfig` does not apply schema defaults.** OpenClaw's `validatePluginConfig()` validates the config and passes `validatedConfig.value` — the original parsed JSON, not a defaults-applied copy. Any optional config fields with TypeBox `default()` values must be handled with nullish coalescing in the plugin code.

**Tools are not available until ~20–40 seconds after gateway start.** The retry sequence means the first successful connection attempt typically happens on the 5s or 15s retry. This is acceptable because the Codex event loop is blocked during this window anyway — no prompts are being processed.
