# Memory System

Reins provides every user with a persistent memory vault — a knowledge base their agents read from and write to across all conversations.

A vault is **owned by a user** and **partitioned into scopes**. Every entry belongs to exactly one scope, and nothing crosses between them. By default a user has a single `default` scope holding everything, which is what a vault looked like before scopes existed; creating a second one keeps, say, client work apart from personal notes.

Two independent gates decide what an agent can reach. They are easy to conflate and are not the same thing:

| Gate | Question | Where |
|------|----------|-------|
| **Service** | Does this agent get memory tools at all? | `agent_service_instances` — the standard per-service enablement |
| **Scope** | Within memory, which scopes can it reach? | `agent_memory_scopes` — see [Scopes](#scopes) |

An agent with the memory service disabled sees no memory tools and scopes never arise. An agent with it enabled and **no scope grants recorded** reaches every scope its owner has — grants narrow, they do not enable.

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
│    memory_scopes, memory_entries, memory_branches,  │
│    memory_links, memory_attributes, memory_tags,    │
│    agent_memory_scopes                              │
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
| `memory_scopes` | The partitions. One per compartment, with `root_entry_id` naming its index |
| `memory_entries` | All entries — title, type, markdown content, `scope_id`, soft-delete flag |
| `memory_branches` | Parent-child tree relationships (`parent_entry_id`), carries `scope_id` |
| `memory_links` | `[[Wikilink]]` references parsed from content, carries `scope_id` |
| `memory_attributes` | Key-value properties attached to an entry |
| `memory_tags` | `#tag` index, rebuilt from content on every write |
| `agent_memory_scopes` | Per-agent scope grants. No rows = every scope the owner has |

**Entry types:** `index` · `person` · `company` · `project` · `note`

Each **scope** gets one root `index` entry, created on first access (`ensureMemoryRoot(userId, scopeId)`) and recorded on `memory_scopes.root_entry_id`. Other entries nest under it or alongside it in that scope's tree.

> The root is tracked by id rather than found with `type='index' LIMIT 1`, which was the old approach. `MEMORY_POLICY.md` explicitly sanctions extra `index` entries as hierarchical hubs, so that lookup returned whichever row came first — non-deterministic once an agent created one. It also ruled out a unique index on `type='index'`: applying one would fail at boot against existing data and take the backend down with it.

### Cross-scope integrity

The partition is enforced at three levels, deliberately overlapping:

| Rule | Enforced by |
|------|-------------|
| Parent in another scope | `setEntryParent` (400), `POST /entries` (409), **and** composite FK on `memory_branches` |
| Wikilink across scopes | `updateLinkIndex` scoped resolution **and** composite FK on `memory_links` |
| Transclusion across scopes | `lookupEntryByTitleOrAlias(scopeId, …)` |
| Relation across scopes | Route 409 + the `GET /graph` join — **no database constraint is possible** |
| Reads outside grants | Scope filter on every route |

The composite foreign keys are the load-bearing part: after them, no application-layer mistake can produce a cross-scope tree edge or wikilink. The exception is relations, whose target lives in `memory_attributes.value` — polymorphic text that also holds label values, so no foreign key can be declared on it. That one rule is code-enforced only.

Constraints are applied individually at boot and **logged rather than swallowed** if they fail (`[memory-scopes] could not apply …`). Boot must survive a straggler row, but a half-enforced partition nobody knows about is the worse outcome — grep for that prefix after a deploy.

### Migration

The backfill in `initializeDatabase()` is idempotent and stays in the boot path permanently, so it doubles as self-repair:

1. A `default` scope (`is_system`) for every user who has any memory. Its id is `md5('memscope:' || user_id)` — derived rather than random, so a concurrent boot cannot race a duplicate in ahead of the unique index.
2. Every unscoped entry assigned to its owner's default scope.
3. The user's existing index entry adopted as that scope's `root_entry_id`.
4. `scope_id` propagated onto branches and links.

Users with no entries get their scope lazily from `ensureDefaultScope` on first API touch, which keeps the boot block O(memory rows) rather than O(users).

Combined with "no grant rows means every scope", this is what makes the feature invisible on the deploy that ships it: every pre-existing agent reaches the default scope, and everything it used to see is in it.

---

## Scopes

### Choosing a scope

| Situation | Scope used |
|-----------|------------|
| Read, no `scope` given | Every scope the caller can reach; each result labelled |
| Read, `scope` given | That one |
| Write, no `scope` given | The caller's default scope |
| Write with `parent_id` | The parent's scope — inherited, so "create this under that entry" needs no reasoning about scopes |
| Write, `scope` **and** `parent_id` disagree | **409 `SCOPE_CONFLICT`** — never a silent choice |
| Any scope not granted | **403 `SCOPE_NOT_GRANTED`**, carrying `available_scopes` |

That 403 returns the list of usable slugs on purpose: a model that receives it can correct itself on the next call instead of failing the task.

### Grants

`agent_memory_scopes(agent_id, scope_id, is_default)`. **Zero rows means every scope the owner has.** Grants are opt-in narrowing.

Default-closed was considered and rejected: it would need a grant row written at all three agent-creation paths, and `bfce9eb` already demonstrated that such a hook gets dropped unnoticed — it silently removed `enableDefaultServices` from two of the three.

The `is_default` row is the agent's write target. Managed at `GET|PUT /api/permissions/:agentId/memory/scopes`, or in the dashboard under Permissions → memory → Memory scopes.

### What agents cannot do

- **Move an entry between scopes.** Owner-only, via `PUT /api/memory/entries/:id/scope`.
- **Delete or archive a scope.** Owner-only. Agents *can* create one (`memory_create_scope`), capped at 50 per user, with near-duplicate slugs refused and `created_by_agent_id` recorded for provenance.

---

## Two Access Paths

### 1. Web Dashboard (session auth)

The frontend calls the REST API with a session cookie. Any route that touches `/api/memory/*` goes through `resolveMemoryContext()`, which reads the session → gets `userId` and every scope that user owns.

```
Browser → GET /api/memory/entries
        → resolveMemoryContext() reads session cookie
        → returns entries across all of that user's scopes, each labelled
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
resolveMemoryContext()
  │  reads x-reins-agent-secret header
  │  looks up deployed_agents.gateway_token → gets agent_id AND user_id
  │  joins agent_memory_scopes → the scopes this agent may reach
  ▼
PostgreSQL — same tables, the granted scopes of that user's vault
```

Both paths write to the same tables. There is no sync — they share a database.

---

## Auth: `resolveMemoryContext()`

Located in `backend/src/services/memory-scopes.ts`, wrapped by `resolveMemoryScopeContext()` in `routes.ts`. Dual-mode resolution:

1. **Session present** → `request.session.userId`, with every non-archived scope that user owns
2. **`x-reins-agent-secret` header present** → look up `deployed_agents` by `gateway_token` → `agent_id` and `user_id` → join `agent_memory_scopes` for the granted set

It returns `{ userId, agentId, scopes, scopeIds, defaultScopeId, isSession }`. The predecessor, `resolveMemoryUserId`, resolved an agent's token to its owner and then **discarded the agent identity** — which is why every agent a user owned shared one vault. Scope grants are keyed on exactly that identity, so keeping it is the whole change.

The grant join is filtered to the owner's scopes as well as the agent's grants, so a grant pointing at another user's scope is inert rather than an escape hatch.

The auth guard (`backend/src/auth/index.ts`) lets requests with `x-reins-agent-secret` pass through to route handlers without a valid session — the route itself validates the token.

> Note the shape of that bypass: any `/api/*` route is reachable with a gateway token, and a session-only route reached that way throws rather than returning 401 (`getUserId` reads `request.session.userId` unconditionally). That is how `skill_authoring_list` came to return a 500.

---

## MCP Tools

Defined in `servers/src/memory/` and exposed to agents via the `memory` native server.

`scope` marks the tools that accept an optional scope argument. The rest address an
entry by id, and an entry's scope is a fact about it rather than a parameter.

| Tool | Permission | `scope` | Description |
|------|-----------|:-------:|-------------|
| `memory_get_root` | read | ✓ | Root index of each reachable scope |
| `memory_list` | read | ✓ | List entries, filtered by type / parent / tag / recency |
| `memory_search` | read | ✓ | Full-text search across titles and content |
| `memory_get` | read | ✓† | Fetch a single entry by id or title |
| `memory_dream` | read | ✓ | Dream manifest (entries with parent/backlink metadata) |
| `memory_list_tags` | read | ✓ | Distinct tags with counts |
| `memory_list_scopes` | read | — | The scopes this agent can reach |
| `memory_create` | write | ✓ | Create an entry (idempotent — check `created`) |
| `memory_create_scope` | write | — | Create a new scope |
| `memory_update` | write | — | Update title, type, or content — whole via `content`, or partial via `append` / `section {heading,text,mode}`; optional `if_version` refuses a concurrent overwrite (409 `VERSION_CONFLICT`) |
| `memory_relate` | write | — | Named relationship between two entries in the same scope |
| `memory_set_parent` | write | — | Move an entry in the tree, within its scope |
| `memory_add_attribute` | write | — | Add a label or relation |
| `memory_remove_attribute` | write | — | Remove an attribute by id |
| `memory_delete` | blocked | — | Soft-delete an entry |

† `memory_get` uses `scope` only to disambiguate a `title` lookup; it is ignored when `id` is given.

Write tools default to **`allow`** for memory (`defaultWritePermission: 'allow'` in
`servers/src/memory/definition.ts`) — not `require_approval`, which is the platform default
elsewhere. `memory_delete` is blocked outright. Per-tool overrides live in
`agent_tool_permissions`.

---

## REST API Routes

All routes require auth (session or gateway token) and are filtered to the caller's
granted scopes. An entry outside them returns **404**, not 403 — unreachable and
nonexistent are deliberately indistinguishable.

| Method | Path | Description |
|--------|------|-------------|
| `GET` | `/api/memory/root` | Root index per reachable scope (superset shape — see below) |
| `GET` | `/api/memory/entries` | List / search (`?q=`, `?title=` exact case-insensitive — takes precedence over `q`, `?type=`, `?parent_id=`, `?tag=`, `?since=`, `?order=`, `?scope=`, `?limit=`) |
| `POST` | `/api/memory/entries` | Create — idempotent, 200 + `created:false` on a match |
| `GET` | `/api/memory/entries/:id` | Entry with attributes, backlinks, tags, resolved links, transclusions |
| `PUT` | `/api/memory/entries/:id` | Update; one of `content`/`append`/`section` per call, optional `if_version` (409 on conflict). Root index is read-only for session users |
| `DELETE` | `/api/memory/entries/:id` | Soft-delete. A scope's root cannot be deleted |
| `PUT` | `/api/memory/entries/:id/parent` | Move in tree, within the scope |
| `PUT` | `/api/memory/entries/:id/scope` | **Session only.** Move between scopes |
| `GET` | `/api/memory/tree` | Hierarchical tree (`?scope=`) |
| `GET` | `/api/memory/graph` | Nodes + edges for the graph view (`?scope=`) |
| `GET` | `/api/memory/tags` | Distinct tags with counts (`?scope=`) |
| `GET` | `/api/memory/dream` | Dream manifest (`?scope=`) |
| `POST` | `/api/memory/entries/:id/attributes` | Add a label or relation |
| `DELETE` | `/api/memory/attributes/:attrId` | Remove an attribute |
| `GET` | `/api/memory/scopes` | Reachable scopes with entry counts |
| `POST` | `/api/memory/scopes` | Create a scope |
| `PUT` | `/api/memory/scopes/:id` | **Session only.** Rename, re-slug, set default, archive |
| `DELETE` | `/api/memory/scopes/:id` | **Session only.** `?archive=true` or `?reassign_to=<id>` |
| `GET\|PUT` | `/api/permissions/:agentId/memory/scopes` | Per-agent grants |

There is no `GET /api/memory/search` — search is `GET /api/memory/entries?q=`.

---

## Root Index

Each scope's `index`-type root entry is created by `ensureMemoryRoot(userId, scopeId)` on
first access and recorded on `memory_scopes.root_entry_id`. It cannot be updated via the web
UI (agents can update it freely), and it cannot be deleted. It serves as the agent's
canonical map of that scope — agents are expected to update it when they create entries.

`GET /api/memory/root` returns a **backward-compatible superset**: the top-level `id`,
`title` and `content` are still the default scope's root exactly as before, with
`default_scope` and a `scopes[]` array alongside. The shape does not change when a second
scope appears — a response that restructures on a data change is a prompt bug that only
surfaces in production.

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

Without this, handlers default to `https://app.helm.mom` (production).

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
