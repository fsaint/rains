# Reauth Hold-and-Retry Design

**Date:** 2026-05-04
**Status:** Approved

## Problem

When an agent tool call is approved by the user but the underlying OAuth credential lacks the required scope (or has expired), the backend currently:

1. Runs the executor after user approval
2. Detects the scope/auth problem inside `executeTool`
3. Creates a separate reauth approval in Telegram
4. Returns an error to the agent ("insufficient scope")

The user sees two unrelated Telegram messages with no clear connection, the agent reports an error, and the original intent is lost. The user must re-trigger the action manually after completing reauth.

## Solution: Hold-after-approval

When `executeTool` detects a scope or token-expiry problem, it stores the tool call as a "held call" on the reauth approval record. After the user completes the OAuth flow, the backend automatically re-executes all held calls and stores their results against the original approval IDs. The agent receives its answer transparently — no second approval prompt, no manual retry.

## Data Model

Add one column to the `approvals` table:

```sql
ALTER TABLE approvals ADD COLUMN held_tool_calls_json TEXT;
```

Schema defined in `backend/src/db/schema.ts` (`approvals` table).

The column stores a JSON array of held call objects:

```ts
interface HeldToolCall {
  approvalId: string;      // original tool approval ID (to store result back)
  agentId: string;
  serviceType: string;     // e.g. "calendar"
  toolName: string;        // e.g. "calendar_create_event"
  args: Record<string, unknown>;
}
```

An array is used (rather than a single object) because the reauth approval is reused/throttled — multiple tool calls can fail before the user re-auths, and all must be retried.

## Components Changed

### 1. `backend/src/db/schema.ts`
Add `heldToolCallsJson: text('held_tool_calls_json')` to the `approvals` table definition.

### 2. `backend/src/mcp/agent-endpoint.ts` — `createMCPReauthApproval`

Add an optional `heldCall: HeldToolCall` parameter. When provided:
- On **create**: set `held_tool_calls_json` to `JSON.stringify([heldCall])`
- On **reuse**: parse existing array, append `heldCall`, write back

### 3. `backend/src/mcp/agent-endpoint.ts` — `executeTool`

Add an optional `callerApprovalId?: string` parameter.

At each scope-check failure site (three locations — instance path, legacy path, fallback path), pass the held call to `createMCPReauthApproval`:

```ts
await createMCPReauthApproval(agentId, serviceType, credentialId, {
  approvalId: callerApprovalId,
  agentId,
  serviceType,
  toolName,
  args,
});
```

Only attach the held call when `callerApprovalId` is provided (i.e. the tool was called via the approval executor, not directly).

### 4. `backend/src/approvals/queue.ts` — approval executor

Thread the approval ID into the `executeTool` call so it can be stored on the reauth:

```ts
const execResult = await executor();
// executor closure already has approvalId in scope — pass it to executeTool
```

The executor closure in `agent-endpoint.ts` is constructed with all needed context; `callerApprovalId` is added to that closure.

### 5. `backend/src/api/routes.ts` — OAuth callbacks (Google + Microsoft)

After `approvalQueue.approve(pendingFlow.reauthApprovalId, ...)`, add held-call execution:

```ts
const reauthApproval = await approvalQueue.get(pendingFlow.reauthApprovalId);
const heldCalls: HeldToolCall[] = JSON.parse(reauthApproval?.heldToolCallsJson ?? '[]');

for (const held of heldCalls) {
  // Verify original approval hasn't expired
  const original = await approvalQueue.get(held.approvalId);
  if (!original || original.status !== 'approved') continue;

  // Re-resolve hasInstances + serviceInstances fresh from DB
  const result = await executeTool(
    held.agentId, held.serviceType, held.toolName, held.args,
    /* callerApprovalId */ held.approvalId,
  );
  await approvalQueue.storeResult(held.approvalId, result);
  approvalQueue.notifyWaiter(held.approvalId, { approved: true });
}
```

`executeTool` re-resolves `hasInstances` and `serviceInstances` internally from `agentId` + `serviceType` using fresh DB state (post-reauth credential). This avoids serializing transient DB state into the held call.

## Flow After Change

```
Agent calls calendar_create_event
  → tool approval created, sent to Telegram
  → user approves
  → executor runs executeTool(agentId, 'calendar', 'calendar_create_event', args, callerApprovalId)
  → credentialCoversService() → false
  → createMCPReauthApproval(..., heldCall) — stores held call on reauth approval
  → executeTool returns MISSING_CREDENTIALS (reauth pending)
  → queue.ts stores error result temporarily (agent waits)

User clicks reauth link in Telegram → OAuth flow completes
  → OAuth callback: approvalQueue.approve(reauthApprovalId)
  → held calls retrieved from reauth approval
  → executeTool re-runs with fresh credential
  → result stored against original approvalId
  → notifyWaiter wakes agent-endpoint polling
  → agent receives calendar_create_event result transparently
```

## Error Handling

| Scenario | Behavior |
|----------|----------|
| Original approval expired before reauth completes | Skip: check `original.status !== 'approved'` before executing |
| Held call fails again after reauth (e.g. different error) | Store error result normally; agent receives error |
| Multiple held calls on same reauth approval | Execute sequentially; each stores its own result |
| Backend restarts between approval and reauth | Held calls persist in DB; execute on next OAuth callback |
| `notifyWaiter` called but no waiter registered (post-restart) | No-op; agent-endpoint picks up result on next poll |

## Out of Scope

- Retrying held calls that failed for non-auth reasons
- UI indication that execution is "pending reauth"
- Timeout/expiry of held calls (relies on existing approval expiry)
