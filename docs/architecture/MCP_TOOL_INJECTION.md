# MCP Tool Injection — End-to-End Architecture

This document explains how remote MCP tools are connected, installed, and injected into an
agent's context, from client connect to model call.

---

## Overview

```
MCP client connects
     │
     ▼
Initialize handshake → tools/list
     │
     ▼
Tools registered into client context
     │
     ▼
Model calls  helm__gmail_search(...) directly
```

---

## Step 1: MCP Connection — Initialize Handshake

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

## Step 2: Tool Registration into Agent Context

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

## Step 3: Tool Invocation

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

## Built-in tools and the approval layer

Beyond the service tools, the endpoint always injects `get_result` and `whoami`, and injects
`mark_onboarded` while the deployment has not completed first-run setup
(`backend/src/mcp/agent-endpoint.ts`). `whoami` takes no arguments and returns the calling
agent's `{ agentId, name }` — an agent has no other way to learn its own id, which memory
scopes, `helm-admin`, and skill assignment all take as an argument. It is read-only and
bypasses the policy layer, since the request is already authenticated as that agent.

A `tools/call` on a tool marked `require_approval` does **not** block. It returns
immediately with `isError: true` and an `APPROVAL_PENDING` body naming a jobId; the executor
closure is parked in memory, and the agent polls `get_result`, which long-polls up to 30s per
call. The in-memory executor map is why `fly.toml` pins `max_machines_running = 1`.

Tool names in any text the model reads must be the **model-visible** form, which differs per
runtime — see `modelVisibleToolName()` in `shared/src/mcp-naming.ts`. A manual (`is_manual`)
deployment resolves to runtime `external`, which renders *bare* names: its MCP client
(claude.ai / Claude Desktop / Claude Code) adds a prefix of its own that the backend cannot
know. Pre-rename names (`reins_get_result`, `reins__mark_onboarded`) are still accepted on
`tools/call` but are no longer advertised on `tools/list`.

---

## Key Files

| File | Role |
|------|------|
| `shared/src/mcp-naming.ts` | Server name, built-in tool names, legacy aliases, `{{tool:}}` resolution |
| `backend/src/mcp/agent-endpoint.ts` | JSON-RPC handler: `tools/list` filtering, `tools/call`, approvals |
