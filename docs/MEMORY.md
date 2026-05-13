# Memory System

Reins provides every user with a persistent memory vault — a knowledge base their agents read from and write to across all conversations. Memory is scoped to the **user**, not the agent: all of a user's agents share one vault.

---

## Architecture

```
┌─────────────────────────────────────────────────────┐
│                  Reins Backend                      │
│                                                     │
│  REST API (/api/memory/*)  ←─── Web Dashboard       │
│         │                                           │
│         ▼                                           │
│    memory service                                   │
│  (backend/src/services/memory.ts)                   │
│         │                                           │
│         ▼                                           │
│    PostgreSQL / libSQL                              │
│    memory_entries, memory_branches,                 │
│    memory_links, memory_attributes                  │
│         ▲                                           │
│         │                                           │
│  Memory handlers  ←─── MCP endpoint (/mcp/:agentId) │
│  (servers/src/memory/handlers.ts)                   │
└─────────────────────────────────────────────────────┘
```

Memory handlers are **native (in-process) servers** — they run inside the backend process, not as a separate service. When a handler needs data it makes a loopback HTTP call to the backend's own REST API.

---

## Database Schema

| Table | Purpose |
|-------|---------|
| `memory_entries` | All entries — title, type, markdown content, soft-delete flag |
| `memory_branches` | Parent-child tree relationships (`parent_entry_id`) |
| `memory_links` | `[[Wikilink]]` references parsed from content |
| `memory_attributes` | Key-value properties attached to an entry |

**Entry types:** `index` · `person` · `company` · `project` · `note`

Every user gets one root `index` entry created automatically on first access (`ensureMemoryRoot`). All other entries nest under it or alongside it in the tree.

---

## Two Access Paths

### 1. Web Dashboard (session auth)

The frontend calls the REST API with a session cookie. Any route that touches `/api/memory/*` goes through `resolveMemoryUserId()`, which reads the session → gets `userId`.

```
Browser → GET /api/memory/entries
        → resolveMemoryUserId() reads session cookie
        → returns entries for session user
```

### 2. Agent via MCP (gateway token auth)

When a deployed agent calls a memory tool, the request travels:

```
Agent (OpenClaw on Fly)
  │  MCP JSON-RPC over HTTP
  ▼
POST /mcp/:agentId
  │  x-reins-agent-secret: <gatewayToken>  (bypasses session auth)
  ▼
handleMCPRequest → executeTool
  │  looks up gateway_token from deployed_agents WHERE agent_id = ?
  │  injects into ToolContext.gatewayToken
  ▼
Memory native server (createServerWrapper → handler)
  │  HTTP loopback to /api/memory/*
  │  x-reins-agent-secret: <gatewayToken>
  ▼
resolveMemoryUserId()
  │  reads x-reins-agent-secret header
  │  looks up deployed_agents.gateway_token → gets user_id
  ▼
PostgreSQL — same tables, same user's vault
```

Both paths write to the same tables. There is no sync — they share a database.

---

## Auth: `resolveMemoryUserId()`

Located in `backend/src/api/routes.ts`. Dual-mode resolution:

1. **Session present** → use `request.session.userId` (web dashboard)
2. **`x-reins-agent-secret` header present** → look up `deployed_agents` by `gateway_token` → get `agent_id` → get `user_id` from `agents` table

The auth guard (`backend/src/auth/index.ts`) lets requests with `x-reins-agent-secret` pass through to route handlers without a valid session — the route itself validates the token.

---

## MCP Tools

Defined in `servers/src/memory/` and exposed to agents via the `memory` native server.

| Tool | Permission | Description |
|------|-----------|-------------|
| `memory_get_root` | read | Fetch the root index entry |
| `memory_list` | read | List all non-deleted entries, optionally filtered by type |
| `memory_search` | read | Full-text search across titles and content |
| `memory_get` | read | Fetch a single entry by ID |
| `memory_dream` | read | Fetch the dream manifest (all entries with parent/backlink metadata) |
| `memory_create` | write* | Create a new entry |
| `memory_update` | write* | Update title, type, or content of an existing entry |
| `memory_relate` | write* | Create a named relationship between two entries |
| `memory_set_parent` | write* | Move an entry in the tree (with circular reference guard) |
| `memory_delete` | blocked | Soft-delete an entry (blocked by default) |

*write tools default to `require_approval` unless overridden in `agent_tool_permissions`.

---

## REST API Routes

All routes require auth (session or gateway token) and are scoped to the resolved `userId`.

| Method | Path | Description |
|--------|------|-------------|
| `GET` | `/api/memory/entries` | List entries (`?q=`, `?type=`, `?limit=`) |
| `POST` | `/api/memory/entries` | Create entry |
| `GET` | `/api/memory/entries/:id` | Get single entry |
| `PUT` | `/api/memory/entries/:id` | Update entry (root index is read-only for session users) |
| `DELETE` | `/api/memory/entries/:id` | Soft-delete entry |
| `GET` | `/api/memory/tree` | Hierarchical tree (entries + branch relationships) |
| `GET` | `/api/memory/search` | Full-text search |
| `GET` | `/api/memory/dream` | Dream manifest (for agent dream process) |
| `PUT` | `/api/memory/entries/:id/parent` | Set parent entry (move in tree) |

---

## Root Index

The `index`-type root entry is created automatically by `ensureMemoryRoot()` on the first memory API call. It cannot be updated via the web UI (agents can update it freely). It serves as the agent's canonical map of the vault — agents are expected to update it when they create new entries.

---

## Dream Process

A nightly scheduler (`backend/src/services/dream.ts`) runs at 2am UTC. For each running OpenClaw agent, it opens an isolated chat session (`POST {management_url}/chat?session=dream`) and sends a prompt instructing the agent to review memory, consolidate notes, update the index, and set parent relationships. This keeps the vault organized without requiring explicit user instruction.

The scheduler starts with the backend:
```ts
// backend/src/index.ts
startDreamScheduler();
```

---

## Local Dev Setup

Memory handlers call back into the backend via HTTP. In local dev, set:

```bash
# .env
REINS_API_URL=http://localhost:5001
```

Without this, handlers default to `https://app.agenthelm.mom` (production).

Enable memory for an agent (dev convenience — normally done via dashboard):
```sql
INSERT INTO agent_service_access (id, agent_id, service_type, enabled, created_at, updated_at)
VALUES ('mem-access-01', '<agentId>', 'memory', true, now(), now())
ON CONFLICT (agent_id, service_type) DO UPDATE SET enabled = true;
```

To allow writes without approval during testing:
```sql
INSERT INTO agent_tool_permissions (id, agent_id, service_type, tool_name, permission, created_at, updated_at)
VALUES
  ('mtp-mc',  '<agentId>', 'memory', 'memory_create',     'allow', now(), now()),
  ('mtp-mu',  '<agentId>', 'memory', 'memory_update',     'allow', now(), now()),
  ('mtp-mr',  '<agentId>', 'memory', 'memory_relate',     'allow', now(), now()),
  ('mtp-msp', '<agentId>', 'memory', 'memory_set_parent', 'allow', now(), now())
ON CONFLICT (agent_id, service_type, tool_name) DO UPDATE SET permission = 'allow';
```
