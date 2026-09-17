# MCP Tool Injection — End-to-End Architecture

This document explains how remote MCP tools are connected, installed, and injected into an
agent's context, from client connect to model call. It documents the server side of that
flow — the client can be Claude, Claude Code, Cowork, or any other MCP client; the backend
cannot know or control how a given client presents tools to its model, so this document
covers what the backend does up through the wire response, not what happens inside a
client's own tool-calling loop.

---

## Overview

```
MCP client authorizes (OAuth 2.1, or none if the endpoint is open)
     │
     ▼
Initialize handshake
     │
     ▼
tools/list → backend filters by service instances + permissions
     │
     ▼
Client's model calls a tool → tools/call
     │
     ▼
Policy layer: allow → forward to native handler
              require_approval → APPROVAL_PENDING, poll get_result
```

---

## Step 1: Authorization

Every agent is an MCP endpoint at `/mcp/<agentId>`. A client reaches it one of two ways:

- **OAuth 2.1** (`backend/src/mcp/oauth/routes.ts`) — dynamic client registration and
  authorization-code + PKCE, ending in a bearer token scoped to exactly one agent:
  1. `POST /mcp/oauth/register` — the client registers itself dynamically (RFC 7591-style),
     receiving a `client_id` (and a `client_secret` for confidential clients).
  2. `GET /mcp/oauth/authorize` — the user consents on a page in the dashboard. The
     `resource` parameter names the agent's MCP URL and becomes the token's audience, so a
     token minted here cannot be replayed against a different agent.
  3. `POST /mcp/oauth/token` — the client exchanges the authorization code for a bearer
     token.
  4. The client presents the token as `Authorization: Bearer <token>` on every request to
     `/mcp/<agentId>`.
- **Unauthenticated** — only if the agent owner has explicitly opened the endpoint
  (`agents.allow_unauthenticated = true`, default `false`). `authenticateMcp()`
  (`backend/src/api/routes.ts`) checks for a bearer token first; if none is present it falls
  back to unauthenticated only when that flag is set, and a token that fails to verify is
  always rejected with 401 — even on an open agent, so a misconfigured client never silently
  falls through.

---

## Step 2: Initialize Handshake

Once authorized (or waved through as unauthenticated), the client sends the standard MCP
handshake to `POST /mcp/<agentId>`:

```
Client → POST /mcp/<agentId>
         Content-Type: application/json
         Body: {"jsonrpc":"2.0","method":"initialize","params":{
                  "protocolVersion":"2025-03-26",
                  "capabilities":{"roots":{"listChanged":false}},
                  "clientInfo":{"name":"<client-name>","version":"..."}
                },"id":1}

Server → 200 OK
         Body: {"jsonrpc":"2.0","result":{
                  "protocolVersion":"2025-03-26",
                  "capabilities":{"tools":{"listChanged":false}},
                  "serverInfo":{"name":"helm","version":"1.0.0"}
                },"id":1}

Client → POST /mcp/<agentId>
         Body: {"jsonrpc":"2.0","method":"notifications/initialized","id":null}
```

If the agent is restricted, the `initialize` response also carries an `instructions` field
rendering its limits (`renderAgentLimits()`), so the client hears about constraints up front
rather than discovering them as failed calls.

---

## Step 3: `tools/list` — Filtered by Service Instances and Permissions

```
Client → POST /mcp/<agentId>
         Body: {"jsonrpc":"2.0","method":"tools/list","id":2}

Server → 200 OK
         Body: {"jsonrpc":"2.0","result":{"tools":[
                  {"name":"gmail_search","description":"...","inputSchema":{...}},
                  {"name":"calendar_list_events","description":"...","inputSchema":{...}},
                  ...
                ]},"id":2}
```

`handleListTools()` (`backend/src/mcp/agent-endpoint.ts`) aggregates tools across every
enabled service instance granted to the agent: for each instance it reads the effective
tool permissions (`getEffectiveInstancePermissions()`), and includes a tool if its
permission is `allow` or `require_approval` (a `block`ed tool is omitted entirely, not
just hidden behind a later refusal). Tools are deduplicated by name across instances of the
same service type — if any granted instance allows a tool, it is listed once. There is no
per-client variation in what is returned; the same agent lists the same tools to any client
that connects to it.

---

## Step 4: Tool Invocation

```
Client → POST /mcp/<agentId>
         Body: {"jsonrpc":"2.0","method":"tools/call",
                "params":{"name":"gmail_search","arguments":{"query":"invoice","max_results":10}},
                "id":3}
```

`handleCallTool()` re-checks permission at call time (never trusting the `tools/list`
snapshot) and then does one of two things:

- **`allow`** — forwards to the tool's native handler and returns the result as
  `{"jsonrpc":"2.0","result":{"content":[{"type":"text","text":"..."}]},"id":3}`.
- **`require_approval`** — does **not** block. It returns immediately with `isError: true`
  and an `APPROVAL_PENDING` body naming a jobId, while the executor closure is parked in
  memory. See [Built-in tools and the approval layer](#built-in-tools-and-the-approval-layer)
  for how the caller retrieves the eventual result.

---

## Built-in tools and the approval layer

Beyond the service tools, the endpoint always injects `get_result` and `whoami`. `whoami`
takes no arguments and returns the calling agent's `{ agentId, name }` — an agent has no
other way to learn its own id, which memory scopes, `helm-admin`, and skill assignment all
take as an argument. It is read-only and bypasses the policy layer, since the request is
already authenticated as that agent.

A `tools/call` on a tool marked `require_approval` does **not** block. It returns
immediately with `isError: true` and an `APPROVAL_PENDING` body naming a jobId; the executor
closure is parked in memory, and the caller polls `get_result`, which long-polls up to 30s per
call. The in-memory executor map is why `fly.toml` pins `max_machines_running = 1`.

Every agent is an external MCP client (`shared/src/mcp-naming.ts`) — Claude, Claude Code,
Cowork, or any other client. Those clients namespace tools with a prefix of their own that
the backend cannot know, so tool names in any text the model reads must be the bare,
**model-visible** form (`modelVisibleToolName()`), never a namespaced one. Pre-rename names
(`reins_get_result`) are still accepted on `tools/call` but are no longer advertised on
`tools/list`.

---

## Key Files

| File | Role |
|------|------|
| `backend/src/mcp/oauth/routes.ts` | OAuth 2.1 endpoints: dynamic registration, authorize, token |
| `backend/src/mcp/agent-endpoint.ts` | JSON-RPC handler: `initialize`, `tools/list` filtering, `tools/call`, approvals |
| `backend/src/services/permissions.ts` | Effective tool permissions per service instance |
| `shared/src/mcp-naming.ts` | Server name, built-in tool names, legacy aliases, `{{tool:}}` resolution |
