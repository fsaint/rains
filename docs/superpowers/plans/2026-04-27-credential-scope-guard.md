# Credential Scope Guard Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Prevent silent `Insufficient Permission` failures by (1) persisting updated `granted_services` when a credential is reconnected via OAuth, and (2) checking that a credential's `granted_services` covers the requested service before dispatching a tool call, returning a clean reauth prompt if not.

**Architecture:** Two independent changes. The vault gets a new `updateGrantedServices` method used by both OAuth callbacks. The `executeTool` function in `agent-endpoint.ts` gains a scope-guard step that fires after token validation, reading `grantedServices` via a Drizzle query and calling the existing `createMCPReauthApproval` helper when the scope is missing. The guard is null-safe: credentials with no `granted_services` recorded are allowed through (backward compat with tokens created before this feature).

**Tech Stack:** TypeScript, Drizzle ORM (postgres-js), Vitest

---

### Task 1: Add `updateGrantedServices` to `CredentialVault`

**Files:**
- Modify: `backend/src/credentials/vault.ts` (after the `update` method, ~line 334)
- Test: `backend/src/credentials/vault.test.ts`

- [ ] **Step 1: Write the failing test**

In `backend/src/credentials/vault.test.ts`, add inside `describe('CredentialVault')`:

```typescript
describe('updateGrantedServices', () => {
  it('should update granted_services for an existing credential', async () => {
    // Store a credential without granted_services
    const mockClient = (vault as unknown as { client: { execute: ReturnType<typeof vi.fn> } }).client;
    mockClient.execute.mockResolvedValueOnce({ rows: [], rowsAffected: 1 });

    const result = await vault.updateGrantedServices('cred-1', ['gmail', 'calendar']);
    expect(result).toBe(true);
    expect(mockClient.execute).toHaveBeenCalledWith(
      expect.objectContaining({
        sql: expect.stringContaining('UPDATE credentials SET granted_services'),
        args: expect.arrayContaining(['["gmail","calendar"]', 'cred-1']),
      })
    );
  });

  it('should return false when credential does not exist', async () => {
    const mockClient = (vault as unknown as { client: { execute: ReturnType<typeof vi.fn> } }).client;
    mockClient.execute.mockResolvedValueOnce({ rows: [], rowsAffected: 0 });

    const result = await vault.updateGrantedServices('nonexistent', ['gmail']);
    expect(result).toBe(false);
  });
});
```

- [ ] **Step 2: Run the test to confirm it fails**

```bash
cd /Users/fsaint/git/rains
npm test --workspace=backend -- --reporter=verbose vault.test
```
Expected: FAIL — `vault.updateGrantedServices is not a function`

- [ ] **Step 3: Implement the method**

In `backend/src/credentials/vault.ts`, add after the `update` method (after line 334):

```typescript
/**
 * Update the granted_services metadata for an existing credential.
 * Called after a successful OAuth reconnect to keep scope tracking current.
 */
async updateGrantedServices(credentialId: string, grantedServices: string[]): Promise<boolean> {
  const result = await client.execute({
    sql: `UPDATE credentials SET granted_services = ?, updated_at = ? WHERE id = ?`,
    args: [JSON.stringify(grantedServices), new Date().toISOString(), credentialId],
  });
  return result.rowsAffected > 0;
}
```

- [ ] **Step 4: Run the test to confirm it passes**

```bash
npm test --workspace=backend -- --reporter=verbose vault.test
```
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add backend/src/credentials/vault.ts backend/src/credentials/vault.test.ts
git commit -m "feat(credentials): add updateGrantedServices to CredentialVault"
```

---

### Task 2: Persist `granted_services` on Google OAuth reconnect

**Files:**
- Modify: `backend/src/api/routes.ts` (~line 1942, inside the `if (pendingFlow.reconnectCredentialId)` block)

- [ ] **Step 1: Locate the reconnect block**

Open `backend/src/api/routes.ts`. Find the Google OAuth callback handler (`/api/oauth/google/callback`). Inside it, find:

```typescript
if (pendingFlow.reconnectCredentialId) {
  // Reconnect: update existing credential with fresh tokens
  await credentialVault.update(pendingFlow.reconnectCredentialId, tokenData);
```

- [ ] **Step 2: Write a test (integration-style, routes.test.ts)**

There is currently no `routes.test.ts`. Add the test inline in the existing test suite that covers this callback, or skip if the project doesn't test OAuth callbacks in unit tests (they require real HTTP). In that case, manual verification (Step 5) replaces this step.

To verify manually later: after completing Step 3, reconnect the Google credential from the dashboard and confirm `granted_services` is set in the DB:
```sql
SELECT granted_services FROM credentials WHERE id = 'pdtokTsTxj3W3Qa40hsD3';
```
Expected: `["gmail","drive","calendar"]` (or the specific services from the OAuth flow)

- [ ] **Step 3: Add the `updateGrantedServices` call**

In the reconnect block (~line 1942), add one line after the `credentialVault.update` call:

```typescript
if (pendingFlow.reconnectCredentialId) {
  // Reconnect: update existing credential with fresh tokens
  await credentialVault.update(pendingFlow.reconnectCredentialId, tokenData);
  // Also refresh granted_services so scope tracking stays current
  await credentialVault.updateGrantedServices(pendingFlow.reconnectCredentialId, grantedServices);

  // Auto-resolve the reauth approval if one was associated with this OAuth flow
  if (pendingFlow.reauthApprovalId) {
```

- [ ] **Step 4: Run backend tests**

```bash
npm test --workspace=backend
```
Expected: all tests pass (no route tests exist for this path, so nothing new to break)

- [ ] **Step 5: Commit**

```bash
git add backend/src/api/routes.ts
git commit -m "fix(oauth): persist updated granted_services on Google credential reconnect"
```

---

### Task 3: Persist `granted_services` on Microsoft OAuth reconnect

**Files:**
- Modify: `backend/src/api/routes.ts` (~line 2155, inside the Microsoft reconnect block)

- [ ] **Step 1: Locate the Microsoft reconnect block**

In `backend/src/api/routes.ts`, find the Microsoft OAuth callback handler (`/api/oauth/microsoft/callback`). Inside it, find:

```typescript
if (pendingFlow.reconnectCredentialId) {
  await credentialVault.update(pendingFlow.reconnectCredentialId, tokenData);
```

- [ ] **Step 2: Add the `updateGrantedServices` call**

Note: `grantedServices` is set a few lines above as `const grantedServices = pendingFlow.grantedServices ?? ['outlook_mail', 'outlook_calendar'];` (line ~2152). Add one line after `credentialVault.update`:

```typescript
if (pendingFlow.reconnectCredentialId) {
  await credentialVault.update(pendingFlow.reconnectCredentialId, tokenData);
  // Also refresh granted_services so scope tracking stays current
  await credentialVault.updateGrantedServices(pendingFlow.reconnectCredentialId, grantedServices);
```

- [ ] **Step 3: Run backend tests**

```bash
npm test --workspace=backend
```
Expected: all tests pass

- [ ] **Step 4: Commit**

```bash
git add backend/src/api/routes.ts
git commit -m "fix(oauth): persist updated granted_services on Microsoft credential reconnect"
```

---

### Task 4: Add scope guard in `executeTool`

**Files:**
- Modify: `backend/src/mcp/agent-endpoint.ts` (two locations inside `executeTool`)
- Test: `backend/src/mcp/agent-endpoint.test.ts`

The guard fires after a valid access token is obtained. It reads `grantedServices` from the DB. If the field is populated AND does not include `serviceType`, it calls `createMCPReauthApproval` and returns `MISSING_CREDENTIALS`. If `grantedServices` is null/empty, it allows the call through (backward compat).

- [ ] **Step 1: Write the failing test**

In `backend/src/mcp/agent-endpoint.test.ts`, add a new `describe` block. The vault mock needs `getValidAccessToken` added (it's currently missing — add it alongside `retrieve`):

First, update the vault mock at line 175 to also stub `getValidAccessToken` and `submitReauth`:

```typescript
vi.mock('../credentials/vault.js', () => ({
  credentialVault: {
    retrieve: vi.fn().mockResolvedValue({
      serviceId: 'gmail',
      type: 'oauth2',
      data: { accessToken: 'test-token' },
    }),
    getValidAccessToken: vi.fn().mockResolvedValue('test-access-token'),
  },
}));
```

Also update the `db` mock to support the `grantedServices` lookup. The `db.select()` chain is already mocked; extend it to return a `grantedServices` field:

```typescript
vi.mock('../db/index.js', () => ({
  db: {
    select: vi.fn().mockReturnValue({
      from: vi.fn().mockReturnValue({
        where: vi.fn().mockResolvedValue([
          { id: 'agent-1', name: 'Test Agent', status: 'active', grantedServices: null },
        ]),
      }),
    }),
  },
}));
```

Then add the scope-guard test:

```typescript
describe('scope guard — insufficient granted_services', () => {
  it('returns MISSING_CREDENTIALS and triggers reauth when credential lacks required service scope', async () => {
    // Override the db mock to return a credential row with grantedServices that excludes 'calendar'
    const { db } = await import('../db/index.js');
    vi.mocked(db.select).mockReturnValueOnce({
      from: vi.fn().mockReturnValue({
        where: vi.fn().mockResolvedValue([
          { id: 'agent-1', name: 'Test Agent', status: 'active' },
        ]),
      }),
    } as ReturnType<typeof db.select>);

    // credentialVault.retrieve returns a calendar credential row with grantedServices = ['gmail']
    const { credentialVault } = await import('../credentials/vault.js');
    vi.mocked(credentialVault.retrieve).mockResolvedValueOnce({
      serviceId: 'google',
      type: 'oauth2',
      data: { accessToken: 'test-token', grantedServices: ['gmail'] },
    });
    vi.mocked(credentialVault.getValidAccessToken).mockResolvedValueOnce('test-access-token');

    const { approvalQueue } = await import('../approvals/queue.js');
    vi.mocked(approvalQueue.submitReauth).mockResolvedValueOnce({
      id: 'reauth-1',
      isNew: true,
      emailThrottled: false,
    });

    const request: MCPRequest = {
      jsonrpc: '2.0',
      id: 1,
      method: 'tools/call',
      params: {
        name: 'calendar_create_event',
        arguments: { summary: 'Test Event' },
      },
    };

    const response = await handleMCPRequest('agent-1', request);
    expect(response.error?.code).toBe(MCP_ERROR_CODES.MISSING_CREDENTIALS);
    expect(response.error?.message).toContain('insufficient scope');
  });
});
```

- [ ] **Step 2: Run the test to confirm it fails**

```bash
npm test --workspace=backend -- --reporter=verbose agent-endpoint.test
```
Expected: FAIL — the guard doesn't exist yet, so no `MISSING_CREDENTIALS` is returned

- [ ] **Step 3: Implement the scope guard helper**

In `backend/src/mcp/agent-endpoint.ts`, add a helper function just before `executeTool` (around line 395):

```typescript
/**
 * Check whether a credential's granted_services covers the requested serviceType.
 * Returns true (allowed) when granted_services is not recorded (null/empty — backward compat).
 * Returns false when granted_services is populated but does not include serviceType.
 */
async function credentialCoversService(credentialId: string, serviceType: string): Promise<boolean> {
  const [row] = await db
    .select({ grantedServices: credentials.grantedServices })
    .from(credentials)
    .where(eq(credentials.id, credentialId));
  if (!row?.grantedServices) return true; // no scope info recorded → allow through
  let scopes: string[];
  try {
    scopes = JSON.parse(row.grantedServices);
  } catch {
    return true; // malformed JSON → allow through
  }
  return scopes.includes(serviceType);
}
```

- [ ] **Step 4: Add the guard in the instance-based credential path**

In `executeTool`, find the instance path block (around line 486–503):

```typescript
if (targetInstance.credentialId) {
  const credential = await credentialVault.retrieve(targetInstance.credentialId);
  if (credential) {
    context.credential = credential;
    const accessToken = await credentialVault.getValidAccessToken(targetInstance.credentialId);
    if (accessToken) {
      context.accessToken = accessToken;
    } else {
      await createMCPReauthApproval(agentId, serviceType, targetInstance.credentialId).catch(() => {});
      return {
        success: false,
        errorCode: MCP_ERROR_CODES.MISSING_CREDENTIALS,
        errorMessage: `Credentials expired and could not be refreshed for service: ${serviceType}`,
        errorData: { service: serviceType },
      };
    }
  }
}
```

Replace it with:

```typescript
if (targetInstance.credentialId) {
  const credential = await credentialVault.retrieve(targetInstance.credentialId);
  if (credential) {
    context.credential = credential;
    const accessToken = await credentialVault.getValidAccessToken(targetInstance.credentialId);
    if (accessToken) {
      context.accessToken = accessToken;
      // Scope guard: reject early if the token doesn't cover this service
      const hasScope = await credentialCoversService(targetInstance.credentialId, serviceType);
      if (!hasScope) {
        await createMCPReauthApproval(agentId, serviceType, targetInstance.credentialId).catch(() => {});
        return {
          success: false,
          errorCode: MCP_ERROR_CODES.MISSING_CREDENTIALS,
          errorMessage: `Credential for ${serviceType} has insufficient scope — please re-authenticate`,
          errorData: { service: serviceType, reason: 'insufficient_scope' },
        };
      }
    } else {
      await createMCPReauthApproval(agentId, serviceType, targetInstance.credentialId).catch(() => {});
      return {
        success: false,
        errorCode: MCP_ERROR_CODES.MISSING_CREDENTIALS,
        errorMessage: `Credentials expired and could not be refreshed for service: ${serviceType}`,
        errorData: { service: serviceType },
      };
    }
  }
}
```

- [ ] **Step 5: Add the guard in the legacy credential path**

Find the legacy path block (around line 581–597):

```typescript
if (accessRecord?.credentialId) {
  const credential = await credentialVault.retrieve(accessRecord.credentialId);
  if (credential) {
    context.credential = credential;
    const accessToken = await credentialVault.getValidAccessToken(accessRecord.credentialId);
    if (accessToken) {
      context.accessToken = accessToken;
    } else {
      await createMCPReauthApproval(agentId, serviceType, accessRecord.credentialId).catch(() => {});
      return {
        success: false,
        errorCode: MCP_ERROR_CODES.MISSING_CREDENTIALS,
        errorMessage: `Credentials expired and could not be refreshed for service: ${serviceType}`,
        errorData: { service: serviceType },
      };
    }
  }
}
```

Replace with:

```typescript
if (accessRecord?.credentialId) {
  const credential = await credentialVault.retrieve(accessRecord.credentialId);
  if (credential) {
    context.credential = credential;
    const accessToken = await credentialVault.getValidAccessToken(accessRecord.credentialId);
    if (accessToken) {
      context.accessToken = accessToken;
      // Scope guard: reject early if the token doesn't cover this service
      const hasScope = await credentialCoversService(accessRecord.credentialId, serviceType);
      if (!hasScope) {
        await createMCPReauthApproval(agentId, serviceType, accessRecord.credentialId).catch(() => {});
        return {
          success: false,
          errorCode: MCP_ERROR_CODES.MISSING_CREDENTIALS,
          errorMessage: `Credential for ${serviceType} has insufficient scope — please re-authenticate`,
          errorData: { service: serviceType, reason: 'insufficient_scope' },
        };
      }
    } else {
      await createMCPReauthApproval(agentId, serviceType, accessRecord.credentialId).catch(() => {});
      return {
        success: false,
        errorCode: MCP_ERROR_CODES.MISSING_CREDENTIALS,
        errorMessage: `Credentials expired and could not be refreshed for service: ${serviceType}`,
        errorData: { service: serviceType },
      };
    }
  }
}
```

- [ ] **Step 6: Run the tests to confirm they pass**

```bash
npm test --workspace=backend -- --reporter=verbose agent-endpoint.test
```
Expected: PASS

- [ ] **Step 7: Run the full backend test suite**

```bash
npm test --workspace=backend
```
Expected: all tests pass

- [ ] **Step 8: Commit**

```bash
git add backend/src/mcp/agent-endpoint.ts backend/src/mcp/agent-endpoint.test.ts
git commit -m "feat(mcp): add scope guard in executeTool — reauth on insufficient granted_services"
```
