# MCP Tool Injection — End-to-End Architecture

This document explains how remote MCP tools are connected, installed, and injected into an
agent's context, from Fly.io machine boot to the model calling a tool.

The detailed walkthrough below covers **OpenClaw**. Hermes consumes the same `MCP_CONFIG`
but differs in two ways that matter — see [Hermes](#hermes) at the end.

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
Model calls  helm__gmail_search(...) directly
```

---

## Step 1: Environment Variables → openclaw.json

When a Fly machine starts, `entrypoint.sh` reads the `MCP_CONFIG` environment variable — a JSON array of server descriptors — and generates `~/.openclaw/openclaw.json`.

**Input (`MCP_CONFIG` env var):**
```json
[
  {
    "name": "helm",
    "url": "https://app.helm.mom/mcp/<agentId>",
    "transport": "http"
  }
]
```

**Output (relevant section of `openclaw.json`):**
```json
{
  "plugins": {
    "enabled": true,
    "allow": ["openclaw-mcp-bridge"],
    "entries": {
      "openclaw-mcp-bridge": {
        "enabled": true,
        "config": {
          "servers": {
            "helm": {
              "url": "https://app.helm.mom/mcp/<agentId>",
              "transport": "http"
            }
          }
        }
      }
    }
  }
}
```

The `servers` map is keyed by the logical server name (`helm`, from `MCP_SERVER_NAME` in
`shared/src/mcp-naming.ts`). That name becomes the namespace prefix on every tool:
`helm__gmail_search`, `helm__calendar_list_events`.

Two things are easy to get wrong here:

- **The URL is per-agent** — `/mcp/<agentId>`, not a shared `/mcp`. The agent id in the path
  is the only credential; there is no `Authorization` header and `/mcp/` is exempt from the
  auth hook (`backend/src/auth/index.ts`).
- **`transport` is `"http"`**, not `"streamable-http"`. The plugin's schema accepts only
  `"http"` or `"stdio"`, and treats anything that is not `"stdio"` as HTTP.

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

In practice, the first attempt fails (event loop blocked), and either the 5s or 15s retry
succeeds (event loop free by then).

**This is no longer the mechanism that makes tools appear.** The entrypoint now pre-caches:
`/tmp/mcp-pre-cache.mjs` connects and writes `/tmp/mcp-tools-cache.json` *before* the gateway
is exec'd, and `docker/patch-plugin.js` makes `register()` read that file and register tools
synchronously. The retry path remains as a fallback for servers that were unreachable at boot.

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
    name: rt.namespacedName,       // e.g. "helm__gmail_search"
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

The `namespacedName` format is `<server-name>__<tool-name>` (double underscore). With server name `helm`, a tool named `gmail_search` becomes `helm__gmail_search`.

---

## Step 7: Tool Invocation

When the model calls `helm__gmail_search`:

```
Model calls helm__gmail_search({"query": "invoice", "max_results": 10})
     │
     ▼
OpenClaw routes to plugin's execute() handler
     │
     ▼
MCPManager.callTool("helm__gmail_search", params)
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
| `mcp_manage tools helm` | List all tools from the `helm` server |
| `mcp_manage status helm` | Detailed connection status for one server |
| `mcp_manage refresh helm` | Force re-discovery of tools from a server |
| `mcp_manage connect <url>` | Connect to a new server at runtime |
| `mcp_manage disconnect helm` | Disconnect a server |

`mcp_manage` is available but **the model is explicitly told not to call it at conversation
start** (`docker/entrypoint.sh`): tools are pre-activated by the boot-time cache, and the
extra round-trips caused response timeouts. Earlier revisions of this document said the
opposite.

---

## Built-in tools and the approval layer

Beyond the service tools, the endpoint always injects `get_result`, and injects
`mark_onboarded` while the deployment has not completed first-run setup
(`backend/src/mcp/agent-endpoint.ts`).

A `tools/call` on a tool marked `require_approval` does **not** block. It returns
immediately with `isError: true` and an `APPROVAL_PENDING` body naming a jobId; the executor
closure is parked in memory, and the agent polls `get_result`, which long-polls up to 30s per
call. The in-memory executor map is why `fly.toml` pins `max_machines_running = 1`.

Tool names in any text the model reads must be the **model-visible** form, which differs per
runtime — see `modelVisibleToolName()` in `shared/src/mcp-naming.ts`. Pre-rename names
(`reins_get_result`, `reins__mark_onboarded`) are still accepted on `tools/call` but are no
longer advertised on `tools/list`.

---

## Hermes

Hermes consumes the same `MCP_CONFIG`, written by `docker/hermes/entrypoint.sh` into
`~/.hermes/config.yaml` as an `mcp_servers:` map. Two differences matter:

- **Namespacing.** hermes-agent renders tools as `mcp__<server>__<tool>`
  (`tools/mcp_tool.py` → `mcp_prefixed_tool_name`), so the same tool the OpenClaw model calls
  as `helm__gmail_search` is `mcp__helm__gmail_search` on Hermes. It also sanitizes each
  component with `[^A-Za-z0-9_] -> _`, which is why the server name avoids hyphens.
- **Config fidelity.** The Hermes entrypoint reads only `url` (or `command`/`args`); it drops
  `transport`, and there is no header or auth passthrough.

Because the two runtimes disagree, anything stored once and served to both — skill bodies,
prompt templates, `shared/BOOTSTRAP.md` — names tools with `{{tool:NAME}}` and has it
resolved for the target runtime at serve time (`/api/agent-skills`, `provision()`) or at
image build time (`scripts/build-agent-image.sh`).

---

## Key Files

| File | Role |
|------|------|
| `docker/entrypoint.sh` | Generates `openclaw.json` from env vars; manages two-phase Codex startup |
| `docker/Dockerfile` | Unpacks plugin tarball into `/app/dist/extensions/` at build time |
| `docker/patch-plugin.js` | Rewrites the plugin's `dist/index.js` for id + synchronous tool registration |
| `shared/src/mcp-naming.ts` | Server name, built-in tool names, legacy aliases, `{{tool:}}` resolution |
| `backend/src/mcp/agent-endpoint.ts` | JSON-RPC handler: `tools/list` filtering, `tools/call`, approvals |
| `openclaw-mcp-bridge/src/index.ts` | Plugin entry point — `register(api)`, retry logic, tool injection |
| `openclaw-mcp-bridge/src/manager/mcp-manager.ts` | MCP session lifecycle, tool discovery, tool invocation routing |
| `openclaw-mcp-bridge/src/transport/streamable-http.ts` | HTTP transport — POST requests, SSE streaming, AbortController timeouts |
| `openclaw-mcp-bridge/src/manager/tool-registry.ts` | In-memory registry of discovered tools, namespace management |
| `openclaw-mcp-bridge/src/config-schema.ts` | TypeBox config schema validated by OpenClaw at plugin load time |

---

## Known Quirks

**Health checks show 0/1 on some Fly machines.** The OpenClaw gateway does not expose a TCP health-check endpoint by default. Some agent apps were deployed without a health check config, so Fly's health check always shows `0/1`. The machine is running normally — this is a Fly configuration gap, not a gateway failure.

**`api.pluginConfig` does not apply schema defaults.** OpenClaw's `validatePluginConfig()` validates the config and passes `validatedConfig.value` — the original parsed JSON, not a defaults-applied copy. Any optional config fields with TypeBox `default()` values must be handled with nullish coalescing in the plugin code.

**~~Tools are not available until ~20–40 seconds after gateway start.~~** No longer true. The
boot-time pre-cache registers tools synchronously during `register()`, so they are present in
the model's very first turn. Retry-with-backoff only matters if the pre-cache failed.

**The approval poll can surface as a timeout.** `get_result` long-polls for up to 30s
(`agent-endpoint.ts`) while the plugin's `requestTimeoutMs` is also 30s
(`transport/streamable-http.js`) and Reins does not override it. The two deadlines race, so a
pending approval intermittently reaches the model as
`Request "tools/call" timed out after 30000ms` instead of `status: "pending"`.
