# Memory Dream Process — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Implement the nightly dream process — a backend cron that triggers OpenClaw agents to reorganize and reflect on their memory vault using two new MCP tools (`memory_dream`, `memory_set_parent`).

**Architecture:** The backend auth guard is extended to pass gateway-token requests through to route handlers. Two new service functions (`getDreamManifest`, `setEntryParent`) power two new API endpoints. Two new MCP tool handlers call those endpoints. A nightly chained-setTimeout scheduler fires at 2am UTC, queries running OpenClaw agents, and POSTs a dream prompt to each agent's `/chat?session=dream` endpoint.

**Tech Stack:** TypeScript, Fastify, postgres.js (`client.execute`), Vitest. No new dependencies.

---

## File Map

| File | Action |
|---|---|
| `backend/src/auth/index.ts` | Modify — add gateway-token bypass to `onRequest` hook |
| `backend/src/services/memory.ts` | Modify — add `getDreamManifest`, `setEntryParent` |
| `backend/src/services/memory.test.ts` | Modify — add tests for new service functions |
| `backend/src/api/routes.ts` | Modify — add `GET /api/memory/dream`, `PUT /api/memory/entries/:id/parent`, root read-only check in existing PUT |
| `backend/src/integration/memory.test.ts` | Modify — add E2E tests for new endpoints |
| `backend/src/services/dream.ts` | Create — `startDreamScheduler`, `runDreamProcess` |
| `backend/src/index.ts` | Modify — call `startDreamScheduler()` at startup |
| `servers/src/memory/handlers.ts` | Modify — add `handleDream`, `handleSetParent` |
| `servers/src/memory/handlers.test.ts` | Modify — add tests for new handlers |
| `servers/src/memory/tools.ts` | Modify — add `memory_dream`, `memory_set_parent` tool definitions |
| `servers/src/memory/definition.ts` | Modify — add new tools to `write` permissions |

---

## Task 1: Auth Guard — gateway token bypass

**Files:**
- Modify: `backend/src/auth/index.ts:500-509`
- Modify: `backend/src/integration/memory.test.ts` (add one test)

The auth guard currently blocks all `/api/memory/*` requests without a session cookie, preventing agents from reaching memory routes. The fix passes requests with an `x-reins-agent-secret` header through to the route handler, which validates the token against the DB.

- [ ] **Step 1: Add failing E2E test for gateway token reaching memory root**

In `backend/src/integration/memory.test.ts`, inside the existing `describe('Auth guard', ...)` block, add after the existing gateway token 401 test:

```ts
it('passes gateway token requests through to route handler for validation', async () => {
  // With the auth guard fixed, a valid gateway token should reach resolveMemoryUserId
  // and get a 200. An invalid token should get 401 from the route handler (not the guard).
  // We verify the guard passes it through by checking the invalid token gets 401 (not a
  // generic "UNAUTHORIZED" code — route handler returns plain { error: 'Unauthorized' }).
  const res = await app.inject({
    method: 'GET',
    url: '/api/memory/root',
    headers: { 'x-reins-agent-secret': 'invalid-token-should-reach-handler' },
  });
  // Route handler returns { error: 'Unauthorized' } (string), not { error: { code: 'UNAUTHORIZED' } }
  expect(res.statusCode).toBe(401);
  expect(res.json().error).toBe('Unauthorized');
});
```

- [ ] **Step 2: Run test to verify it currently fails**

```bash
cd /Users/fsaint/git/reins
npm test --workspace=backend -- --run src/integration/memory.test.ts 2>&1 | tail -20
```

Expected: FAIL — currently the guard returns `{ error: { code: 'UNAUTHORIZED' } }` (object, not string), so `res.json().error` is an object, not `'Unauthorized'`.

- [ ] **Step 3: Apply the auth guard fix**

In `backend/src/auth/index.ts`, find the section starting at line 500:

```ts
    // All other /api/* routes require auth
    if (path.startsWith('/api/')) {
      const session = getSession(request);
      if (!session) {
        return reply.code(401).send({ error: { code: 'UNAUTHORIZED', message: 'Not authenticated' } });
      }

      // Attach session to request for downstream use
      (request as any).session = session;
    }
```

Replace with:

```ts
    // All other /api/* routes require auth
    if (path.startsWith('/api/')) {
      const session = getSession(request);
      if (!session) {
        // Allow agent gateway tokens to pass through — route handlers validate them
        if (request.headers['x-reins-agent-secret']) return;
        return reply.code(401).send({ error: { code: 'UNAUTHORIZED', message: 'Not authenticated' } });
      }

      // Attach session to request for downstream use
      (request as any).session = session;
    }
```

- [ ] **Step 4: Run tests**

```bash
npm test --workspace=backend -- --run src/integration/memory.test.ts 2>&1 | tail -20
```

Expected: all tests pass (29 existing + 1 new = 30).

- [ ] **Step 5: Commit**

```bash
git add backend/src/auth/index.ts backend/src/integration/memory.test.ts
git commit -m "fix(auth): pass gateway token requests through to route handlers"
```

---

## Task 2: `getDreamManifest` service function

**Files:**
- Modify: `backend/src/services/memory.ts`
- Modify: `backend/src/services/memory.test.ts`

- [ ] **Step 1: Write failing unit tests**

In `backend/src/services/memory.test.ts`, add a new top-level `describe` block after the existing ones:

```ts
// ============================================================================
// getDreamManifest
// ============================================================================

describe('getDreamManifest', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(client.execute).mockResolvedValue({ rows: [], rowsAffected: 0, lastInsertRowid: 0n, columns: [] });
  });

  it('returns compact entries with backlink counts', async () => {
    vi.mocked(client.execute).mockResolvedValueOnce({
      rows: [
        { id: 'e1', title: 'Alice', type: 'person', parent_id: 'root-1', backlink_count: 3, updated_at: '2026-05-01T00:00:00Z' },
        { id: 'e2', title: 'Acme', type: 'company', parent_id: null, backlink_count: 1, updated_at: '2026-05-02T00:00:00Z' },
      ],
      rowsAffected: 0, lastInsertRowid: 0n, columns: [],
    });

    const result = await getDreamManifest('user-1');

    expect(result).toHaveLength(2);
    expect(result[0]).toEqual({ id: 'e1', title: 'Alice', type: 'person', parent_id: 'root-1', backlink_count: 3, updated_at: '2026-05-01T00:00:00Z' });
    expect(result[1].parent_id).toBeNull();
  });

  it('calls a single SQL query', async () => {
    vi.mocked(client.execute).mockResolvedValueOnce({ rows: [], rowsAffected: 0, lastInsertRowid: 0n, columns: [] });

    await getDreamManifest('user-1');

    expect(vi.mocked(client.execute)).toHaveBeenCalledTimes(1);
    const call = vi.mocked(client.execute).mock.calls[0][0] as { sql: string; args: unknown[] };
    expect(call.sql).toContain('FROM memory_entries');
    expect(call.sql).toContain('backlink_count');
    expect(call.args).toContain('user-1');
  });

  it('coerces backlink_count to number', async () => {
    // postgres.js may return COUNT() as string
    vi.mocked(client.execute).mockResolvedValueOnce({
      rows: [{ id: 'e1', title: 'Note', type: 'note', parent_id: null, backlink_count: '5', updated_at: '2026-05-01Z' }],
      rowsAffected: 0, lastInsertRowid: 0n, columns: [],
    });

    const result = await getDreamManifest('user-1');

    expect(typeof result[0].backlink_count).toBe('number');
    expect(result[0].backlink_count).toBe(5);
  });

  it('returns empty array when user has no entries', async () => {
    vi.mocked(client.execute).mockResolvedValueOnce({ rows: [], rowsAffected: 0, lastInsertRowid: 0n, columns: [] });

    const result = await getDreamManifest('user-1');

    expect(result).toEqual([]);
  });
});
```

Add `getDreamManifest` to the import at the top of the test file:

```ts
import { parseWikilinks, updateLinkIndex, ensureMemoryRoot, getDreamManifest } from './memory.js';
```

- [ ] **Step 2: Run to verify failure**

```bash
npm test --workspace=backend -- --run src/services/memory.test.ts 2>&1 | tail -15
```

Expected: FAIL — `getDreamManifest` is not exported.

- [ ] **Step 3: Implement `getDreamManifest`**

Append to `backend/src/services/memory.ts`:

```ts
export interface DreamManifestEntry {
  id: string;
  title: string;
  type: string;
  parent_id: string | null;
  backlink_count: number;
  updated_at: string;
}

/** Compact manifest of all entries for the dream process */
export async function getDreamManifest(userId: string): Promise<DreamManifestEntry[]> {
  const result = await client.execute({
    sql: `SELECT e.id, e.title, e.type,
                 b.parent_entry_id AS parent_id,
                 COUNT(ml.source_id) AS backlink_count,
                 e.updated_at
          FROM memory_entries e
          LEFT JOIN memory_branches b ON b.entry_id = e.id
          LEFT JOIN memory_links ml ON ml.target_id = e.id
          WHERE e.user_id = ? AND e.is_deleted = false
          GROUP BY e.id, e.title, e.type, b.parent_entry_id, e.updated_at
          ORDER BY e.type ASC, e.title ASC`,
    args: [userId],
  });
  return result.rows.map((r) => ({
    id: r.id as string,
    title: r.title as string,
    type: r.type as string,
    parent_id: (r.parent_id as string | null) ?? null,
    backlink_count: Number(r.backlink_count ?? 0),
    updated_at: r.updated_at as string,
  }));
}
```

- [ ] **Step 4: Run tests**

```bash
npm test --workspace=backend -- --run src/services/memory.test.ts 2>&1 | tail -15
```

Expected: all tests pass.

- [ ] **Step 5: Commit**

```bash
git add backend/src/services/memory.ts backend/src/services/memory.test.ts
git commit -m "feat(memory): add getDreamManifest service function"
```

---

## Task 3: `setEntryParent` service function

**Files:**
- Modify: `backend/src/services/memory.ts`
- Modify: `backend/src/services/memory.test.ts`

- [ ] **Step 1: Write failing unit tests**

Add to `backend/src/services/memory.test.ts` (update the import line too):

```ts
import { parseWikilinks, updateLinkIndex, ensureMemoryRoot, getDreamManifest, setEntryParent } from './memory.js';
```

Add a new `describe` block:

```ts
// ============================================================================
// setEntryParent
// ============================================================================

describe('setEntryParent', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(client.execute).mockResolvedValue({ rows: [], rowsAffected: 0, lastInsertRowid: 0n, columns: [] });
  });

  it('updates parent_entry_id on success', async () => {
    mockExecuteSequence([
      { rows: [{ id: 'entry-1' }] }, // ownership check
      { rows: [] },                   // UPDATE branches
    ]);

    const result = await setEntryParent('entry-1', 'user-1', 'parent-1');

    expect(result).toEqual({ ok: true });
    const updateCall = vi.mocked(client.execute).mock.calls[1][0] as { sql: string; args: unknown[] };
    expect(updateCall.sql).toContain('UPDATE memory_branches SET parent_entry_id = ?');
    expect(updateCall.args).toContain('parent-1');
    expect(updateCall.args).toContain('entry-1');
  });

  it('returns error when entry not found or not owned by user', async () => {
    vi.mocked(client.execute).mockResolvedValueOnce({ rows: [], rowsAffected: 0, lastInsertRowid: 0n, columns: [] });

    const result = await setEntryParent('entry-1', 'user-1', 'parent-1');

    expect(result).toMatchObject({ error: expect.any(String) });
  });

  it('returns error when setting parent to self', async () => {
    vi.mocked(client.execute).mockResolvedValueOnce({ rows: [{ id: 'entry-1' }], rowsAffected: 0, lastInsertRowid: 0n, columns: [] });

    const result = await setEntryParent('entry-1', 'user-1', 'entry-1');

    expect(result).toMatchObject({ error: expect.stringContaining('own parent') });
    // No UPDATE should have been called
    expect(vi.mocked(client.execute)).toHaveBeenCalledTimes(1);
  });

  it('returns error on circular reference', async () => {
    // entry-1 → parent-X → grandparent is entry-1 (circular)
    mockExecuteSequence([
      { rows: [{ id: 'entry-1' }] },             // ownership
      { rows: [{ parent_entry_id: 'entry-1' }] }, // walk: parent-X's parent is entry-1
    ]);

    const result = await setEntryParent('entry-1', 'user-1', 'parent-X');

    expect(result).toMatchObject({ error: expect.stringContaining('Circular') });
  });

  it('allows setting parent to null (top level)', async () => {
    mockExecuteSequence([
      { rows: [{ id: 'entry-1' }] }, // ownership
      { rows: [] },                   // UPDATE
    ]);

    const result = await setEntryParent('entry-1', 'user-1', null);

    expect(result).toEqual({ ok: true });
    const updateCall = vi.mocked(client.execute).mock.calls[1][0] as { sql: string; args: unknown[] };
    expect(updateCall.args[0]).toBeNull();
  });

  it('skips circular check when newParentId is null', async () => {
    mockExecuteSequence([
      { rows: [{ id: 'entry-1' }] }, // ownership only
      { rows: [] },                   // UPDATE
    ]);

    await setEntryParent('entry-1', 'user-1', null);

    // Only 2 DB calls: ownership + UPDATE (no ancestor walk)
    expect(vi.mocked(client.execute)).toHaveBeenCalledTimes(2);
  });
});
```

- [ ] **Step 2: Run to verify failure**

```bash
npm test --workspace=backend -- --run src/services/memory.test.ts 2>&1 | tail -15
```

Expected: FAIL — `setEntryParent` is not exported.

- [ ] **Step 3: Implement `setEntryParent`**

Append to `backend/src/services/memory.ts`:

```ts
/** Move an entry to a new parent in the tree */
export async function setEntryParent(
  entryId: string,
  userId: string,
  newParentId: string | null
): Promise<{ ok: true } | { error: string }> {
  // 1. Ownership check
  const ownerCheck = await client.execute({
    sql: `SELECT id FROM memory_entries WHERE id = ? AND user_id = ? AND is_deleted = false`,
    args: [entryId, userId],
  });
  if (ownerCheck.rows.length === 0) return { error: 'Entry not found' };

  // 2. Self-parent check
  if (newParentId === entryId) return { error: 'Cannot set an entry as its own parent' };

  // 3. Circular reference check — walk ancestors of newParentId
  if (newParentId !== null) {
    let current: string | null = newParentId;
    const visited = new Set<string>();
    while (current !== null) {
      if (current === entryId) return { error: 'Circular reference: entry is an ancestor of the new parent' };
      if (visited.has(current)) break; // infinite loop guard
      visited.add(current);
      const parentRow = await client.execute({
        sql: `SELECT parent_entry_id FROM memory_branches WHERE entry_id = ? LIMIT 1`,
        args: [current],
      });
      current = parentRow.rows.length > 0 ? (parentRow.rows[0].parent_entry_id as string | null) : null;
    }
  }

  // 4. Update
  await client.execute({
    sql: `UPDATE memory_branches SET parent_entry_id = ? WHERE entry_id = ?`,
    args: [newParentId, entryId],
  });
  return { ok: true };
}
```

- [ ] **Step 4: Run tests**

```bash
npm test --workspace=backend -- --run src/services/memory.test.ts 2>&1 | tail -15
```

Expected: all tests pass.

- [ ] **Step 5: Commit**

```bash
git add backend/src/services/memory.ts backend/src/services/memory.test.ts
git commit -m "feat(memory): add setEntryParent service function with circular reference check"
```

---

## Task 4: API routes — `GET /api/memory/dream` and `PUT /api/memory/entries/:id/parent`

**Files:**
- Modify: `backend/src/api/routes.ts` (add two routes and root read-only check)
- Modify: `backend/src/integration/memory.test.ts` (add E2E tests)

- [ ] **Step 1: Write failing E2E tests**

In `backend/src/integration/memory.test.ts`, add after the existing `describe('DELETE /api/memory/entries/:id', ...)` block:

```ts
// ── GET /api/memory/dream ────────────────────────────────────────────────────

describe('GET /api/memory/dream', () => {
  it('returns compact manifest of all entries', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/api/memory/dream',
      headers: { cookie: sessionCookie },
    });

    expect(res.statusCode).toBe(200);
    const { data } = res.json();
    expect(Array.isArray(data)).toBe(true);
    expect(data[0]).toMatchObject({
      id: expect.any(String),
      title: expect.any(String),
      type: expect.any(String),
      backlink_count: expect.any(Number),
      updated_at: expect.any(String),
    });
  });

  it('returns 401 without auth', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/memory/dream' });
    expect(res.statusCode).toBe(401);
  });
});

// ── PUT /api/memory/entries/:id/parent ───────────────────────────────────────

describe('PUT /api/memory/entries/:id/parent', () => {
  it('returns 200 and { ok: true } on success', async () => {
    const res = await app.inject({
      method: 'PUT',
      url: `/api/memory/entries/${ENTRY_ID}/parent`,
      headers: { cookie: sessionCookie },
      payload: { parent_id: ROOT_ID },
    });

    expect(res.statusCode).toBe(200);
    expect(res.json().data).toEqual({ ok: true });
  });

  it('returns 400 for self-parent', async () => {
    // Override: ownership check passes, then self-parent detected in service
    const res = await app.inject({
      method: 'PUT',
      url: `/api/memory/entries/${ENTRY_ID}/parent`,
      headers: { cookie: sessionCookie },
      payload: { parent_id: ENTRY_ID },
    });

    expect(res.statusCode).toBe(400);
    expect(res.json().error).toBeTruthy();
  });

  it('returns 404 when entry not found', async () => {
    mockExecute.mockImplementationOnce(async () => ({ rows: [], rowsAffected: 0, lastInsertRowid: 0n, columns: [] }));

    const res = await app.inject({
      method: 'PUT',
      url: '/api/memory/entries/nonexistent/parent',
      headers: { cookie: sessionCookie },
      payload: { parent_id: ROOT_ID },
    });

    expect(res.statusCode).toBe(404);
  });

  it('returns 401 without auth', async () => {
    const res = await app.inject({
      method: 'PUT',
      url: `/api/memory/entries/${ENTRY_ID}/parent`,
      payload: { parent_id: ROOT_ID },
    });
    expect(res.statusCode).toBe(401);
  });
});

// ── Root read-only enforcement ────────────────────────────────────────────────

describe('Root read-only enforcement', () => {
  it('returns 403 when session user tries to update root index entry', async () => {
    // Override: ownership check returns a root entry (type = 'index')
    mockExecute.mockImplementationOnce(async () => ({
      rows: [{ id: ROOT_ID, type: 'index' }],
      rowsAffected: 0, lastInsertRowid: 0n, columns: [],
    }));

    const res = await app.inject({
      method: 'PUT',
      url: `/api/memory/entries/${ROOT_ID}`,
      headers: { cookie: sessionCookie },
      payload: { content: 'hacked' },
    });

    expect(res.statusCode).toBe(403);
    expect(res.json().error).toContain('agent');
  });
});
```

- [ ] **Step 2: Run to verify failures**

```bash
npm test --workspace=backend -- --run src/integration/memory.test.ts 2>&1 | tail -20
```

Expected: 5 new tests fail (routes don't exist yet; root read-only returns 200 instead of 403).

- [ ] **Step 3: Add imports to routes.ts**

In `backend/src/api/routes.ts`, find the existing memory service import:

```ts
import { parseWikilinks, updateLinkIndex, ensureMemoryRoot } from '../services/memory.js';
```

Replace with:

```ts
import { parseWikilinks, updateLinkIndex, ensureMemoryRoot, getDreamManifest, setEntryParent } from '../services/memory.js';
```

- [ ] **Step 4: Add root read-only enforcement to existing PUT route**

In `backend/src/api/routes.ts`, find the existing PUT route ownership check (around line 5100):

```ts
    const existing = await client.execute({
      sql: `SELECT id FROM memory_entries WHERE id = ? AND user_id = ? AND is_deleted = false`,
      args: [id, userId],
    });
    if (existing.rows.length === 0) return reply.status(404).send({ error: 'Not found' });
```

Replace with:

```ts
    const existing = await client.execute({
      sql: `SELECT id, type FROM memory_entries WHERE id = ? AND user_id = ? AND is_deleted = false`,
      args: [id, userId],
    });
    if (existing.rows.length === 0) return reply.status(404).send({ error: 'Not found' });

    // Root index is read-only from dashboard sessions — only the agent (gateway token) may update it
    if (existing.rows[0].type === 'index' && getSession(request)) {
      return reply.status(403).send({ error: 'Root index can only be updated by the agent' });
    }
```

- [ ] **Step 5: Add new routes**

In `backend/src/api/routes.ts`, find the end of the memory routes section — just before the closing `};` of the plugin (after the `DELETE /api/memory/attributes/:attrId` route). Insert:

```ts
  // -------------------------------------------------------------------------
  // GET /api/memory/dream — compact manifest for dream process
  // -------------------------------------------------------------------------
  app.get('/api/memory/dream', async (request, reply) => {
    const userId = await resolveMemoryUserId(request);
    if (!userId) return reply.status(401).send({ error: 'Unauthorized' });

    const entries = await getDreamManifest(userId);
    return reply.send({ data: entries });
  });

  // -------------------------------------------------------------------------
  // PUT /api/memory/entries/:id/parent — reparent entry (dream reorganization)
  // -------------------------------------------------------------------------
  app.put<{ Params: { id: string } }>('/api/memory/entries/:id/parent', async (request, reply) => {
    const userId = await resolveMemoryUserId(request);
    if (!userId) return reply.status(401).send({ error: 'Unauthorized' });

    const { id } = request.params;
    const body = request.body as { parent_id?: string | null };
    const newParentId = body.parent_id ?? null;

    const result = await setEntryParent(id, userId, newParentId);
    if ('error' in result) {
      const status = result.error === 'Entry not found' ? 404 : 400;
      return reply.status(status).send({ error: result.error });
    }
    return reply.send({ data: result });
  });
```

- [ ] **Step 6: Run tests**

```bash
npm test --workspace=backend -- --run src/integration/memory.test.ts 2>&1 | tail -20
```

Expected: all tests pass (30 existing + 5 new = 35).

- [ ] **Step 7: Commit**

```bash
git add backend/src/api/routes.ts backend/src/integration/memory.test.ts
git commit -m "feat(memory): add dream manifest endpoint, set-parent endpoint, root read-only enforcement"
```

---

## Task 5: MCP handlers — `handleDream` and `handleSetParent`

**Files:**
- Modify: `servers/src/memory/handlers.ts`
- Modify: `servers/src/memory/handlers.test.ts`

- [ ] **Step 1: Write failing handler tests**

In `servers/src/memory/handlers.test.ts`, add to the imports:

```ts
import {
  handleGetRoot,
  handleCreate,
  handleUpdate,
  handleSearch,
  handleList,
  handleGet,
  handleRelate,
  handleDelete,
  handleDream,
  handleSetParent,
} from './handlers.js';
```

Add two new `describe` blocks at the end of the test file:

```ts
// ==========================================================================
// handleDream
// ==========================================================================

describe('handleDream', () => {
  it('calls GET /api/memory/dream with gateway token', async () => {
    const entries = [{ id: 'e1', title: 'Alice', type: 'person', parent_id: null, backlink_count: 2, updated_at: '2026-05-01Z' }];
    mockFetch.mockResolvedValueOnce({ ok: true, json: async () => ({ data: entries }) });

    await handleDream({}, mockContext);

    const [url, opts] = mockFetch.mock.calls[0];
    expect(url).toBe('https://test.helm.mom/api/memory/dream');
    expect(opts?.headers?.['x-reins-agent-secret']).toBe('test-gateway-token');
  });

  it('returns entries array with count', async () => {
    const entries = [
      { id: 'e1', title: 'Alice', type: 'person', parent_id: 'root', backlink_count: 3, updated_at: '2026Z' },
      { id: 'e2', title: 'Acme', type: 'company', parent_id: null, backlink_count: 0, updated_at: '2026Z' },
    ];
    mockFetch.mockResolvedValueOnce({ ok: true, json: async () => ({ data: entries }) });

    const result = await handleDream({}, mockContext);

    expect(result.success).toBe(true);
    expect(result.data.entries).toEqual(entries);
    expect(result.data.count).toBe(2);
  });

  it('returns error on non-200 response', async () => {
    mockFetch.mockResolvedValueOnce({ ok: false, status: 500, text: async () => 'Internal error' });

    const result = await handleDream({}, mockContext);

    expect(result.success).toBe(false);
    expect(result.error).toBeTruthy();
  });
});

// ==========================================================================
// handleSetParent
// ==========================================================================

describe('handleSetParent', () => {
  it('calls PUT /api/memory/entries/:entry_id/parent', async () => {
    mockFetch.mockResolvedValueOnce(makeOkResponse({ ok: true }));

    await handleSetParent({ entry_id: 'e1', parent_id: 'root-1' }, mockContext);

    const [url, opts] = mockFetch.mock.calls[0];
    expect(url).toBe('https://test.helm.mom/api/memory/entries/e1/parent');
    expect(opts?.method).toBe('PUT');
    const body = JSON.parse(opts?.body as string);
    expect(body.parent_id).toBe('root-1');
  });

  it('sends null parent_id to move entry to top level', async () => {
    mockFetch.mockResolvedValueOnce(makeOkResponse({ ok: true }));

    await handleSetParent({ entry_id: 'e1', parent_id: null }, mockContext);

    const body = JSON.parse(mockFetch.mock.calls[0][1]?.body as string);
    expect(body.parent_id).toBeNull();
  });

  it('returns { ok: true } on success', async () => {
    mockFetch.mockResolvedValueOnce(makeOkResponse({ ok: true }));

    const result = await handleSetParent({ entry_id: 'e1', parent_id: 'root' }, mockContext);

    expect(result.success).toBe(true);
    expect(result.data).toEqual({ ok: true });
  });

  it('returns error when entry not found', async () => {
    mockFetch.mockResolvedValueOnce(makeErrorResponse(404, 'Entry not found'));

    const result = await handleSetParent({ entry_id: 'missing', parent_id: 'root' }, mockContext);

    expect(result.success).toBe(false);
  });

  it('returns error on circular reference', async () => {
    mockFetch.mockResolvedValueOnce(makeErrorResponse(400, 'Circular reference'));

    const result = await handleSetParent({ entry_id: 'e1', parent_id: 'child-of-e1' }, mockContext);

    expect(result.success).toBe(false);
  });
});
```

- [ ] **Step 2: Run to verify failures**

```bash
npm test --workspace=servers -- --run src/memory/handlers.test.ts 2>&1 | tail -15
```

Expected: FAIL — `handleDream` and `handleSetParent` are not exported.

- [ ] **Step 3: Implement handlers**

In `servers/src/memory/handlers.ts`, append before the final empty line:

```ts
export async function handleDream(
  _args: Record<string, unknown>,
  context: ServerContext
): Promise<ToolResult> {
  try {
    const res = await memoryFetch(context, '/api/memory/dream');
    if (!res.ok) throw new Error(`Dream API returned ${res.status}: ${await res.text()}`);
    const json = await res.json() as { data: unknown[] };
    return { success: true, data: { entries: json.data, count: json.data.length } };
  } catch (err) {
    return { success: false, error: err instanceof Error ? err.message : String(err) };
  }
}

export async function handleSetParent(
  args: Record<string, unknown>,
  context: ServerContext
): Promise<ToolResult> {
  try {
    const result = await apiPut(context, `/api/memory/entries/${args.entry_id}/parent`, {
      parent_id: args.parent_id ?? null,
    });
    return { success: true, data: result };
  } catch (err) {
    return { success: false, error: err instanceof Error ? err.message : String(err) };
  }
}
```

- [ ] **Step 4: Run tests**

```bash
npm test --workspace=servers -- --run src/memory/handlers.test.ts 2>&1 | tail -15
```

Expected: all tests pass (26 existing + 8 new = 34).

- [ ] **Step 5: Commit**

```bash
git add servers/src/memory/handlers.ts servers/src/memory/handlers.test.ts
git commit -m "feat(memory): add handleDream and handleSetParent MCP handlers"
```

---

## Task 6: MCP tool definitions

**Files:**
- Modify: `servers/src/memory/tools.ts`
- Modify: `servers/src/memory/definition.ts`

No tests needed — these are pure configuration objects. Run the existing handler tests after to confirm nothing broke.

- [ ] **Step 1: Add tool definitions to `tools.ts`**

In `servers/src/memory/tools.ts`, add these imports alongside existing ones:

```ts
import {
  handleGetRoot,
  handleCreate,
  handleUpdate,
  handleSearch,
  handleList,
  handleGet,
  handleRelate,
  handleDelete,
  handleDream,
  handleSetParent,
} from './handlers.js';
```

Add the two tool definitions before `export const memoryTools`:

```ts
export const memoryDreamTool: ToolDefinition = {
  name: 'memory_dream',
  description:
    'Get a compact manifest of your entire memory vault — all entries with type, parent, and backlink count. ' +
    'Call this at the start of a dream session to survey what needs reorganization.',
  inputSchema: {
    type: 'object',
    properties: {},
  },
  handler: handleDream,
};

export const memorySetParentTool: ToolDefinition = {
  name: 'memory_set_parent',
  description:
    'Move a memory entry to a new parent. Use during dream sessions to reorganize the vault tree. ' +
    'Set parent_id to null to move an entry to the top level (below root).',
  inputSchema: {
    type: 'object',
    properties: {
      entry_id: { type: 'string', description: 'ID of the entry to move' },
      parent_id: {
        type: ['string', 'null'],
        description: 'New parent entry ID, or null to place at top level',
      },
    },
    required: ['entry_id', 'parent_id'],
  },
  handler: handleSetParent,
};
```

Add the two tools to the `memoryTools` array:

```ts
export const memoryTools: ToolDefinition[] = [
  memoryGetRootTool,
  memoryCreateTool,
  memoryUpdateTool,
  memorySearchTool,
  memoryListTool,
  memoryGetTool,
  memoryRelateTool,
  memoryDeleteTool,
  memoryDreamTool,
  memorySetParentTool,
];
```

- [ ] **Step 2: Add tools to `definition.ts` permissions**

In `servers/src/memory/definition.ts`, find the `permissions` block and add both tools under `write`:

```ts
  permissions: {
    read: [
      'memory_get_root',
      'memory_search',
      'memory_list',
      'memory_get',
      'memory_dream',
    ],
    write: [
      'memory_create',
      'memory_update',
      'memory_relate',
      'memory_set_parent',
    ],
    blocked: [
      'memory_delete',
    ],
  },
```

Note: `memory_dream` goes under `read` (it only reads) and `memory_set_parent` goes under `write` (it modifies structure).

- [ ] **Step 3: Run full servers test suite**

```bash
npm test --workspace=servers -- --run 2>&1 | tail -15
```

Expected: all tests pass.

- [ ] **Step 4: Commit**

```bash
git add servers/src/memory/tools.ts servers/src/memory/definition.ts
git commit -m "feat(memory): register memory_dream and memory_set_parent MCP tools"
```

---

## Task 7: Dream scheduler service

**Files:**
- Create: `backend/src/services/dream.ts`
- Modify: `backend/src/index.ts`

The dream service is difficult to unit test meaningfully (it POSTs to external Fly machines and uses setTimeout). We write a focused test for the `runDreamProcess` logic by exporting it and mocking `fetch` and `client.execute`.

- [ ] **Step 1: Write failing tests**

Create `backend/src/services/dream.test.ts`:

```ts
/**
 * Dream service tests
 *
 * Tests the runDreamProcess function by mocking fetch and client.execute.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../db/index.js', () => ({
  client: {
    execute: vi.fn().mockResolvedValue({ rows: [], rowsAffected: 0, lastInsertRowid: 0n, columns: [] }),
  },
}));

const mockFetch = vi.fn();
global.fetch = mockFetch;

import { client } from '../db/index.js';
import { runDreamProcess } from './dream.js';

const EMPTY = { rows: [], columns: [], rowsAffected: 0, lastInsertRowid: 0n };

describe('runDreamProcess', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockFetch.mockResolvedValue({ ok: true, json: async () => ({}) });
  });

  it('queries only running OpenClaw agents with a management URL', async () => {
    vi.mocked(client.execute).mockResolvedValueOnce(EMPTY);

    await runDreamProcess();

    const call = vi.mocked(client.execute).mock.calls[0][0] as { sql: string; args: unknown[] };
    expect(call.sql).toContain("runtime = 'openclaw'");
    expect(call.sql).toContain("status = 'running'");
    expect(call.sql).toContain('management_url IS NOT NULL');
  });

  it('POSTs to each agent management URL chat endpoint', async () => {
    vi.mocked(client.execute).mockResolvedValueOnce({
      rows: [
        { id: 'dep-1', management_url: 'https://agent1.fly.dev', gateway_token: 'tok-1' },
        { id: 'dep-2', management_url: 'https://agent2.fly.dev', gateway_token: 'tok-2' },
      ],
      columns: [], rowsAffected: 2, lastInsertRowid: 0n,
    });

    await runDreamProcess();

    expect(mockFetch).toHaveBeenCalledTimes(2);
    const urls = mockFetch.mock.calls.map((c) => c[0]);
    expect(urls).toContain('https://agent1.fly.dev/chat?session=dream');
    expect(urls).toContain('https://agent2.fly.dev/chat?session=dream');
  });

  it('sends gateway token as x-reins-gateway-token header', async () => {
    vi.mocked(client.execute).mockResolvedValueOnce({
      rows: [{ id: 'dep-1', management_url: 'https://agent1.fly.dev', gateway_token: 'secret-tok' }],
      columns: [], rowsAffected: 1, lastInsertRowid: 0n,
    });

    await runDreamProcess();

    const opts = mockFetch.mock.calls[0][1];
    expect(opts.headers['x-reins-gateway-token']).toBe('secret-tok');
  });

  it('sends the dream prompt in the request body', async () => {
    vi.mocked(client.execute).mockResolvedValueOnce({
      rows: [{ id: 'dep-1', management_url: 'https://agent1.fly.dev', gateway_token: 'tok' }],
      columns: [], rowsAffected: 1, lastInsertRowid: 0n,
    });

    await runDreamProcess();

    const body = JSON.parse(mockFetch.mock.calls[0][1].body);
    expect(body.message).toContain('memory_dream');
    expect(body.message).toContain('memory_set_parent');
  });

  it('does not call fetch when no eligible agents', async () => {
    vi.mocked(client.execute).mockResolvedValueOnce(EMPTY);

    await runDreamProcess();

    expect(mockFetch).not.toHaveBeenCalled();
  });

  it('continues processing remaining agents when one fetch fails', async () => {
    vi.mocked(client.execute).mockResolvedValueOnce({
      rows: [
        { id: 'dep-1', management_url: 'https://agent1.fly.dev', gateway_token: 'tok-1' },
        { id: 'dep-2', management_url: 'https://agent2.fly.dev', gateway_token: 'tok-2' },
      ],
      columns: [], rowsAffected: 2, lastInsertRowid: 0n,
    });
    mockFetch
      .mockRejectedValueOnce(new Error('Connection refused'))
      .mockResolvedValueOnce({ ok: true });

    // Should not throw
    await expect(runDreamProcess()).resolves.not.toThrow();
    expect(mockFetch).toHaveBeenCalledTimes(2);
  });
});
```

- [ ] **Step 2: Run to verify failure**

```bash
npm test --workspace=backend -- --run src/services/dream.test.ts 2>&1 | tail -15
```

Expected: FAIL — `dream.ts` does not exist.

- [ ] **Step 3: Create `backend/src/services/dream.ts`**

```ts
/**
 * Dream scheduler — nightly memory consolidation for OpenClaw agents.
 *
 * At 2am UTC, queries all running OpenClaw agents and POSTs a dream prompt
 * to each agent's isolated /chat?session=dream endpoint. The agent uses
 * memory MCP tools (memory_dream, memory_set_parent, memory_update) to
 * reorganize and reflect on its memory vault.
 */

import { client } from '../db/index.js';

const DREAM_PROMPT = `You are entering a memory dream session. Work through your memory vault systematically:

1. Call memory_dream to get the full manifest of your entries.
2. Review the structure — identify entries that belong under a different parent, orphaned notes, and logical groupings.
3. Use memory_set_parent to reorganize entries into a clear hierarchy.
4. Search for duplicates or closely related entries with memory_search. Merge them by updating one with memory_update and deleting the other.
5. Update the root index (Memory Index) with memory_update to reflect: key people, projects, and notes you know about, and a brief reflection on what you have learned recently.

Be decisive. Work through all entries. When done, stop.`;

const DREAM_TIMEOUT_MS = 5 * 60 * 1000; // 5 minutes

/** Query eligible agents and POST the dream prompt to each. */
export async function runDreamProcess(): Promise<void> {
  const result = await client.execute({
    sql: `SELECT id, management_url, gateway_token
          FROM deployed_agents
          WHERE runtime = 'openclaw'
            AND status = 'running'
            AND management_url IS NOT NULL`,
    args: [],
  });

  const agents = result.rows;
  if (agents.length === 0) {
    console.log('[dream] No eligible OpenClaw agents — skipping');
    return;
  }

  console.log(`[dream] Starting dream process for ${agents.length} agent(s)`);

  for (const agent of agents) {
    const url = `${agent.management_url as string}/chat?session=dream`;
    try {
      await fetch(url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-reins-gateway-token': agent.gateway_token as string,
        },
        body: JSON.stringify({ message: DREAM_PROMPT }),
        signal: AbortSignal.timeout(DREAM_TIMEOUT_MS),
      });
      console.log(`[dream] Triggered agent ${agent.id as string}`);
    } catch (err) {
      console.error(`[dream] Failed to trigger agent ${agent.id as string}:`, err);
    }
  }

  console.log('[dream] Dream process complete');
}

/** Schedule dream to run nightly at 2am UTC using chained setTimeout. */
export function startDreamScheduler(): void {
  function scheduleNext() {
    const now = new Date();
    const next = new Date();
    next.setUTCHours(2, 0, 0, 0);
    if (next <= now) next.setUTCDate(next.getUTCDate() + 1);
    const delayMs = next.getTime() - now.getTime();
    const hoursUntil = Math.round(delayMs / 1000 / 60 / 60 * 10) / 10;
    console.log(`[dream] Next dream session in ${hoursUntil}h (${next.toUTCString()})`);
    setTimeout(async () => {
      await runDreamProcess();
      scheduleNext();
    }, delayMs);
  }
  scheduleNext();
}
```

- [ ] **Step 4: Run tests**

```bash
npm test --workspace=backend -- --run src/services/dream.test.ts 2>&1 | tail -15
```

Expected: all 6 tests pass.

- [ ] **Step 5: Wire scheduler into `backend/src/index.ts`**

In `backend/src/index.ts`, add the import after the existing service imports:

```ts
import { startDreamScheduler } from './services/dream.js';
```

After the `startTokenMonitor()` call, add:

```ts
// Start nightly dream scheduler (2am UTC)
startDreamScheduler();
app.log.info('Dream scheduler started (nightly at 2am UTC)');
```

- [ ] **Step 6: Run full backend tests**

```bash
npm test --workspace=backend -- --run 2>&1 | tail -15
```

Expected: all tests pass.

- [ ] **Step 7: Commit**

```bash
git add backend/src/services/dream.ts backend/src/services/dream.test.ts backend/src/index.ts
git commit -m "feat(memory): add nightly dream scheduler service"
```

---

## Task 8: Full suite verification + push

- [ ] **Step 1: Run all workspaces**

```bash
npm test --workspaces -- --run 2>&1 | grep -E "Tests|Test Files|failed"
```

Expected: all tests pass across backend and servers workspaces (onboarding workspace has no test script — that error is pre-existing and expected).

- [ ] **Step 2: TypeScript check**

```bash
npm run typecheck --workspace=backend 2>&1 | tail -20
npm run typecheck --workspace=servers 2>&1 | tail -20
```

Expected: no errors.

- [ ] **Step 3: Push**

```bash
git push
```
