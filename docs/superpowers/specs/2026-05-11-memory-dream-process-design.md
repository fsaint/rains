# Memory Dream Process — Design Spec

**Date:** 2026-05-11
**Status:** Approved

---

## Overview

The dream process is a nightly background job that consolidates a user's memory vault. The backend triggers it by sending a dream prompt to each running OpenClaw agent's isolated chat session. The agent uses MCP memory tools to reorganize entries, synthesize duplicates, and write a reflection note to the root index — all silently, with no user-visible output.

---

## Scope

- **v1 runtime support:** OpenClaw only. Hermes agents are skipped (no management URL).
- **Trigger:** Nightly at 2am UTC, backend-initiated.
- **User-visible output:** None. Users see the updated memory on their next conversation.
- **Auth mechanism:** Gateway token (`x-reins-agent-secret`) for agent→backend calls; session cookie for dashboard users.

---

## Components

### 1. Auth Guard Fix (`backend/src/auth/index.ts`)

The global `onRequest` hook currently blocks any `/api/memory/*` request that lacks a session cookie. This prevents agents from reaching memory routes via their gateway token.

**Fix:** In the hook, pass through requests that have an `x-reins-agent-secret` header present — without validating it. The route handler's `resolveMemoryUserId()` already does DB validation and returns null for bad tokens, resulting in a 401 from the route itself. This is a one-line addition to the bypass condition.

```
onRequest:
  if path in bypass list → pass
  if has valid session cookie → pass (attach session)
  if has x-reins-agent-secret header → pass (route handler validates)
  else → 401
```

### 2. Service Functions (`backend/src/services/memory.ts`)

Two new exported functions alongside the existing `parseWikilinks`, `updateLinkIndex`, `ensureMemoryRoot`:

**`getDreamManifest(userId: string)`**

Returns a compact manifest of every non-deleted entry for the user — no content field, just structure:

```ts
{
  id: string;
  title: string;
  type: string;
  parent_id: string | null;
  backlink_count: number;
  updated_at: string;
}[]
```

Implementation: single SQL query joining `memory_entries`, `memory_branches` (for `parent_entry_id`), and a LEFT JOIN subquery on `memory_links` for backlink count. Ordered by `type ASC, title ASC`.

**`setEntryParent(entryId: string, userId: string, newParentId: string | null)`**

Moves an entry to a new parent in `memory_branches`. Returns `{ ok: true }` or `{ error: string }`.

Validation sequence:
1. Entry exists and belongs to userId
2. `newParentId !== entryId` (no self-parent)
3. If `newParentId` is not null: walk ancestors of `newParentId` upward via `memory_branches`; if `entryId` appears, reject (circular reference)
4. `UPDATE memory_branches SET parent_entry_id = ? WHERE entry_id = ?`

### 3. API Endpoints (`backend/src/api/routes.ts`)

Both authenticated via the existing `resolveMemoryUserId()` (session or gateway token).

**`GET /api/memory/dream`**

Calls `getDreamManifest(userId)`. Returns:

```json
{ "data": [ { "id": "...", "title": "...", "type": "...", "parent_id": "...", "backlink_count": 3, "updated_at": "..." } ] }
```

**`PUT /api/memory/entries/:id/parent`**

Body: `{ "parent_id": "<id> | null" }`. Calls `setEntryParent`. Returns:

```json
{ "data": { "ok": true } }
```

Returns 400 for self-parent or circular reference, 404 if entry not found.

**Root read-only enforcement** (modification to existing `PUT /api/memory/entries/:id`):

Before processing an update, check if the existing entry has `type = 'index'`. If so:
- Request has a session cookie → return 403 `{ error: 'Root index can only be updated by the agent' }`
- Request has a gateway token → allow (dream process writes the reflection)

### 4. MCP Tools (`servers/src/memory/`)

Two new tools added to `handlers.ts`, `tools.ts`, and registered in `memoryTools[]`:

**`memory_dream`**

- No inputs
- Calls `GET /api/memory/dream`
- Returns the full manifest as `{ entries: [...], count: N }`
- Description: *"Get a compact manifest of your entire memory vault — all entries with type, parent, and backlink count. Call this at the start of a dream session to survey what needs reorganization."*

**`memory_set_parent`**

- Inputs: `entry_id` (string, required), `parent_id` (string or null, required)
- Calls `PUT /api/memory/entries/:entry_id/parent`
- Returns `{ ok: true }` or `{ error: string }`
- Description: *"Move a memory entry to a new parent. Use during dream sessions to reorganize the vault tree. Set parent_id to null to move an entry to the top level."*

Both tools added to `definition.ts` permissions under `write`.

### 5. Dream Service (`backend/src/services/dream.ts`)

New file. Exports `startDreamScheduler()` called from `backend/src/index.ts` at startup.

**Scheduling:** Chained `setTimeout` pattern (consistent with `token-monitor.ts`):

```ts
function scheduleNextDream() {
  const now = new Date();
  const next = new Date();
  next.setUTCHours(2, 0, 0, 0);
  if (next <= now) next.setUTCDate(next.getUTCDate() + 1);
  setTimeout(async () => {
    await runDreamProcess();
    scheduleNextDream();
  }, next.getTime() - now.getTime());
}
```

**`runDreamProcess()`:**

1. Query all eligible agents:
   ```sql
   SELECT id, management_url, gateway_token
   FROM deployed_agents
   WHERE runtime = 'openclaw'
     AND status = 'running'
     AND management_url IS NOT NULL
   ```

2. For each agent, POST to `{management_url}/chat?session=dream`:
   - Header: `x-reins-gateway-token: <deployment.gateway_token>` — each OpenClaw machine receives its gateway token as the `OPENCLAW_GATEWAY_TOKEN` env var at boot; this header lets it authenticate the inbound dream trigger
   - Body: fixed dream prompt (see below)
   - Fire-and-forget: log errors, don't await completion
   - Timeout: 5 minutes per agent (OpenClaw runs the session async, but we cap the trigger call)

3. Log start/completion to console with agent count.

**Dream prompt:**

```
You are entering a memory dream session. Work through your memory vault systematically:

1. Call memory_dream to get the full manifest of your entries.
2. Review the structure — identify entries that belong under a different parent, orphaned notes, and logical groupings.
3. Use memory_set_parent to reorganize entries into a clear hierarchy.
4. Search for duplicates or closely related entries with memory_search. Merge them by updating one with memory_update and deleting the other.
5. Update the root index (Memory Index) with memory_update to reflect: key people, projects, and notes you know about, and a brief reflection on what you've learned recently.

Be decisive. Work through all entries. When done, stop.
```

---

## Data Flow

```
2am UTC
  → runDreamProcess()
    → SELECT deployed_agents (openclaw, running)
    → for each agent:
        POST {management_url}/chat?session=dream
          → OpenClaw receives prompt
          → LLM calls memory_dream (MCP tool)
              → GET /api/memory/dream (backend API)
                  ← auth guard: x-reins-agent-secret passes through
                  ← resolveMemoryUserId: validates token → gets userId
                  ← getDreamManifest(userId) → compact entry list
          → LLM calls memory_set_parent (MCP tool) × N
              → PUT /api/memory/entries/:id/parent
                  ← setEntryParent: validates, updates branch
          → LLM calls memory_update (existing tool) × N
              → PUT /api/memory/entries/:id
                  ← root read-only: gateway token → allowed
          → session ends
```

---

## Error Handling

| Scenario | Behavior |
|---|---|
| Agent machine asleep / unreachable | POST times out; logged; retried next night |
| Bad gateway token | `resolveMemoryUserId` returns null → 401 from route |
| Circular parent reference | `setEntryParent` returns error → MCP tool returns `{ success: false, error }` |
| Dream session crashes | OpenClaw handles internally; no impact on user's main session |
| Root update from dashboard | 403 returned; client shows error |

---

## Files to Create / Modify

| File | Change |
|---|---|
| `backend/src/auth/index.ts` | Add gateway-token bypass to `onRequest` hook |
| `backend/src/services/memory.ts` | Add `getDreamManifest`, `setEntryParent` |
| `backend/src/services/memory.test.ts` | Tests for new service functions |
| `backend/src/api/routes.ts` | Add `GET /api/memory/dream`, `PUT /api/memory/entries/:id/parent`, root read-only check |
| `backend/src/integration/memory.test.ts` | E2E tests for new endpoints + root read-only |
| `backend/src/services/dream.ts` | New — `startDreamScheduler`, `runDreamProcess` |
| `backend/src/index.ts` | Call `startDreamScheduler()` at startup |
| `servers/src/memory/handlers.ts` | Add `handleDream`, `handleSetParent` |
| `servers/src/memory/tools.ts` | Add tool definitions |
| `servers/src/memory/handlers.test.ts` | Tests for new handlers |

---

## What Is Not In Scope (v1)

- Hermes agent support
- User-configurable dream schedule
- Dream session result surfaced to dashboard or Telegram
- Dream history / audit log
- Dream on-demand trigger from dashboard
