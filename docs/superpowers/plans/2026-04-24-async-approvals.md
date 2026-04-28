# Async Approval (Deferred Execution) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the blocking 5-minute approval wait with a fire-and-forget pattern — the agent gets a `jobId` immediately, Reins auto-executes the tool when approved, and the agent polls `reins_get_result` to retrieve the result.

**Architecture:** When a tool requires approval, `agent-endpoint.ts` submits the request, registers an in-memory executor closure, and returns `{ deferred: true, jobId }` immediately. When the human approves via dashboard or Telegram, `ApprovalQueue.approve()` calls the registered executor, runs the tool, and stores the result in a new `result_json` DB column. The agent calls the built-in `reins_get_result` MCP tool to poll for `pending | completed | rejected | expired`.

**Tech Stack:** TypeScript, Node.js, PostgreSQL (via `postgres.js` + Drizzle), Vitest

---

## File Map

| File | Change |
|------|--------|
| `backend/src/db/index.ts` | Add migration for `result_json TEXT` column on `approvals` |
| `backend/src/db/schema.ts` | Add `resultJson` field to `approvals` Drizzle table |
| `shared/src/types/index.ts` | Add `resultJson?: string` to `ApprovalRequest`; add `DeferredJobResult` type |
| `backend/src/approvals/queue.ts` | Add `pendingExecutors` map, `registerExecutor()`, `storeResult()`, call executor in `approve()` |
| `backend/src/mcp/agent-endpoint.ts` | Extract `executeTool()` helper; replace blocking wait with deferred response; inject `reins_get_result` into `tools/list`; handle `reins_get_result` in `tools/call` |
| `backend/src/approvals/queue.test.ts` | Add tests for `registerExecutor` + auto-execution on approve |
| `backend/src/mcp/agent-endpoint.test.ts` | Add tests for deferred approval response and `reins_get_result` |

---

### Task 1: DB migration — add `result_json` column

**Files:**
- Modify: `backend/src/db/index.ts` (after the `telegram_message_id` migration block, ~line 466)
- Modify: `backend/src/db/schema.ts` (approvals table, ~line 91)

- [ ] **Step 1: Write the failing test**

In `backend/src/approvals/queue.test.ts`, add at the top of the `describe('ApprovalQueue')` block:

```typescript
it('storeResult should update result_json in DB', async () => {
  vi.mocked(client.execute).mockResolvedValueOnce({
    rows: [], rowsAffected: 1, lastInsertRowid: 0n, columns: [],
  });
  await queue.storeResult('test-approval-id', { message: 'done' });
  expect(vi.mocked(client.execute)).toHaveBeenCalledWith(
    expect.objectContaining({
      sql: expect.stringContaining('result_json'),
    })
  );
});
```

- [ ] **Step 2: Run the test to verify it fails**

```bash
cd /Users/fsaint/git/reins
npm test --workspace=backend -- --reporter=verbose src/approvals/queue.test.ts
```

Expected: FAIL — `queue.storeResult is not a function`

- [ ] **Step 3: Add `result_json` column to DB schema**

In `backend/src/db/schema.ts`, update the `approvals` table (after `telegramMessageId`):

```typescript
// Approval queue table
export const approvals = pgTable('approvals', {
  id: text('id').primaryKey(),
  agentId: text('agent_id').notNull(),
  tool: text('tool').notNull(),
  argumentsJson: text('arguments_json'),
  context: text('context'),
  status: text('status').default('pending').notNull(),
  requestedAt: text('requested_at').default(sql`now()`).notNull(),
  expiresAt: text('expires_at').notNull(),
  resolvedAt: text('resolved_at'),
  resolvedBy: text('resolved_by'),
  resolutionComment: text('resolution_comment'),
  telegramChatId: text('telegram_chat_id'),
  telegramMessageId: text('telegram_message_id'),
  resultJson: text('result_json'),      // stored after executor runs
});
```

- [ ] **Step 4: Add migration in `backend/src/db/index.ts`**

After the existing `telegram_chat_id` / `telegram_message_id` migration block (~line 466), add:

```typescript
// Add result_json for async deferred tool execution results
await sql`
  DO $$ BEGIN
    ALTER TABLE approvals ADD COLUMN IF NOT EXISTS result_json TEXT;
  EXCEPTION WHEN duplicate_column THEN NULL;
  END $$
`;
```

- [ ] **Step 5: Add `storeResult` method to `ApprovalQueue` in `backend/src/approvals/queue.ts`**

Add after `markEmailSent`:

```typescript
/**
 * Store the result of an auto-executed tool call for later retrieval.
 */
async storeResult(id: string, result: unknown): Promise<void> {
  await client.execute({
    sql: `UPDATE approvals SET result_json = ? WHERE id = ?`,
    args: [JSON.stringify(result), id],
  });
}
```

- [ ] **Step 6: Add `resultJson` to `mapToRequest` in `queue.ts`**

Update the `mapToRequest` private method to include the new field:

```typescript
private mapToRequest(row: Record<string, unknown>): ApprovalRequest {
  return {
    id: row.id as string,
    agentId: row.agent_id as string,
    tool: row.tool as string,
    arguments: row.arguments_json ? JSON.parse(row.arguments_json as string) : {},
    context: row.context as string | undefined,
    status: row.status as ApprovalStatus,
    requestedAt: new Date(row.requested_at as string),
    expiresAt: new Date(row.expires_at as string),
    resolvedAt: row.resolved_at ? new Date(row.resolved_at as string) : undefined,
    resolvedBy: row.resolved_by as string | undefined,
    resolutionComment: row.resolution_comment as string | undefined,
    emailLastSentAt: row.email_last_sent_at ? new Date(row.email_last_sent_at as string) : undefined,
    telegramChatId: row.telegram_chat_id as string | undefined,
    telegramMessageId: row.telegram_message_id as string | undefined,
    resultJson: row.result_json as string | undefined,
  };
}
```

- [ ] **Step 7: Run the test to verify it passes**

```bash
npm test --workspace=backend -- --reporter=verbose src/approvals/queue.test.ts
```

Expected: PASS for the `storeResult` test

- [ ] **Step 8: Commit**

```bash
cd /Users/fsaint/git/reins
git add backend/src/db/index.ts backend/src/db/schema.ts backend/src/approvals/queue.ts backend/src/approvals/queue.test.ts
git commit -m "feat(approvals): add result_json column and storeResult method"
```

---

### Task 2: Add `resultJson` to shared types and add `DeferredJobResult`

**Files:**
- Modify: `shared/src/types/index.ts`

- [ ] **Step 1: Update `ApprovalRequest` interface**

In `shared/src/types/index.ts`, add `resultJson` to `ApprovalRequest`:

```typescript
export interface ApprovalRequest {
  id: string;
  agentId: string;
  tool: string;
  arguments: Record<string, unknown>;
  context?: string;
  status: ApprovalStatus;
  requestedAt: Date;
  expiresAt: Date;
  resolvedAt?: Date;
  resolvedBy?: string;
  resolutionComment?: string;
  emailLastSentAt?: Date;
  telegramChatId?: string;
  telegramMessageId?: string;
  resultJson?: string;   // populated after deferred execution completes
}
```

- [ ] **Step 2: Add `DeferredJobResult` type**

After `ApprovalDecision`, add:

```typescript
export type DeferredJobStatus = 'pending' | 'completed' | 'rejected' | 'expired';

export interface DeferredJobResult {
  status: DeferredJobStatus;
  jobId: string;
  /** Present when status === 'completed' */
  result?: unknown;
  /** Present when status === 'rejected' */
  reason?: string;
}
```

- [ ] **Step 3: Build shared package to verify no type errors**

```bash
cd /Users/fsaint/git/reins
npm run typecheck --workspace=shared
```

Expected: no errors

- [ ] **Step 4: Commit**

```bash
git add shared/src/types/index.ts
git commit -m "feat(shared): add resultJson to ApprovalRequest and DeferredJobResult type"
```

---

### Task 3: Add executor registration to `ApprovalQueue`

**Files:**
- Modify: `backend/src/approvals/queue.ts`
- Modify: `backend/src/approvals/queue.test.ts`

- [ ] **Step 1: Write failing tests**

In `backend/src/approvals/queue.test.ts`, add inside `describe('ApprovalQueue')`:

```typescript
describe('registerExecutor + auto-execution on approve', () => {
  it('runs the executor when approve() is called and stores result', async () => {
    // Mock: submit insert, get (after submit), then update for approve, then get (after approve), then storeResult update
    const mockApprovalRow = {
      id: 'test-approval-id',
      agent_id: 'agent-1',
      tool: 'gmail_send_email',
      arguments_json: '{}',
      context: null,
      status: 'pending',
      requested_at: '2024-06-15T12:00:00.000Z',
      expires_at: '2024-06-15T13:00:00.000Z',
      resolved_at: null,
      resolved_by: null,
      resolution_comment: null,
      email_last_sent_at: null,
      telegram_chat_id: null,
      telegram_message_id: null,
      result_json: null,
    };
    // submit: insert
    vi.mocked(client.execute)
      .mockResolvedValueOnce({ rows: [], rowsAffected: 1, lastInsertRowid: 0n, columns: [] })
      // submit: get
      .mockResolvedValueOnce({ rows: [mockApprovalRow], rowsAffected: 0, lastInsertRowid: 0n, columns: [] })
      // approve: update
      .mockResolvedValueOnce({ rows: [], rowsAffected: 1, lastInsertRowid: 0n, columns: [] })
      // approve: get (after update)
      .mockResolvedValueOnce({ rows: [{ ...mockApprovalRow, status: 'approved', resolved_by: 'alice@example.com' }], rowsAffected: 0, lastInsertRowid: 0n, columns: [] })
      // storeResult: update
      .mockResolvedValueOnce({ rows: [], rowsAffected: 1, lastInsertRowid: 0n, columns: [] });

    const executorFn = vi.fn().mockResolvedValue({ message: 'email sent' });
    await queue.submit('agent-1', 'gmail_send_email', {}, 'context');
    queue.registerExecutor('test-approval-id', executorFn);
    await queue.approve('test-approval-id', 'alice@example.com', 'looks good');

    expect(executorFn).toHaveBeenCalledOnce();
    // storeResult should have been called with the executor's result
    const calls = vi.mocked(client.execute).mock.calls;
    const storeCall = calls.find(([arg]) =>
      typeof arg === 'object' && 'sql' in arg && (arg as any).sql.includes('result_json')
    );
    expect(storeCall).toBeDefined();
    expect((storeCall![0] as any).args[0]).toBe(JSON.stringify({ message: 'email sent' }));
  });

  it('does not fail approve() if no executor is registered', async () => {
    const mockApprovalRow = {
      id: 'test-approval-id',
      agent_id: 'agent-1',
      tool: 'gmail_send_email',
      arguments_json: '{}',
      context: null,
      status: 'pending',
      requested_at: '2024-06-15T12:00:00.000Z',
      expires_at: '2024-06-15T13:00:00.000Z',
      resolved_at: null,
      resolved_by: null,
      resolution_comment: null,
      email_last_sent_at: null,
      telegram_chat_id: null,
      telegram_message_id: null,
      result_json: null,
    };
    vi.mocked(client.execute)
      .mockResolvedValueOnce({ rows: [], rowsAffected: 1, lastInsertRowid: 0n, columns: [] })
      .mockResolvedValueOnce({ rows: [mockApprovalRow], rowsAffected: 0, lastInsertRowid: 0n, columns: [] });
    // No registerExecutor call
    await expect(queue.approve('test-approval-id', 'alice@example.com')).resolves.not.toThrow();
  });
});
```

- [ ] **Step 2: Run to verify they fail**

```bash
npm test --workspace=backend -- --reporter=verbose src/approvals/queue.test.ts
```

Expected: FAIL — `queue.registerExecutor is not a function`

- [ ] **Step 3: Implement `registerExecutor` in `queue.ts`**

Add the `pendingExecutors` map to the class and the `registerExecutor` method:

```typescript
export class ApprovalQueue extends EventEmitter<ApprovalEvents> {
  private pendingWaiters: Map<string, {
    resolve: (decision: ApprovalDecision | null) => void;
    timeout: NodeJS.Timeout;
  }> = new Map();

  private pendingExecutors: Map<string, () => Promise<unknown>> = new Map();

  /**
   * Register an async function to auto-execute when approval is granted.
   * The result will be stored in result_json for later retrieval.
   */
  registerExecutor(id: string, executor: () => Promise<unknown>): void {
    this.pendingExecutors.set(id, executor);
  }
```

- [ ] **Step 4: Update `approve()` to call the executor**

In `approve()`, after `this.notifyWaiter(id, { approved: true, approver, comment })`, add the executor invocation:

```typescript
async approve(id: string, approver: string, comment?: string): Promise<boolean> {
  const now = new Date();

  const result = await client.execute({
    sql: `UPDATE approvals SET status = 'approved', resolved_at = ?, resolved_by = ?, resolution_comment = ?
          WHERE id = ? AND status = 'pending'`,
    args: [now.toISOString(), approver, comment ?? null, id],
  });

  if (result.rowsAffected > 0) {
    const request = await this.get(id);
    if (request) {
      this.emit('resolved', request);
      this.notifyWaiter(id, { approved: true, approver, comment });
    }

    // Auto-execute deferred tool if an executor was registered
    const executor = this.pendingExecutors.get(id);
    if (executor) {
      this.pendingExecutors.delete(id);
      try {
        const execResult = await executor();
        await this.storeResult(id, execResult);
      } catch (err) {
        await this.storeResult(id, { error: String(err) });
        console.error(`[approvals] executor failed for ${id}:`, err);
      }
    }

    return true;
  }

  return false;
}
```

- [ ] **Step 5: Run tests to verify they pass**

```bash
npm test --workspace=backend -- --reporter=verbose src/approvals/queue.test.ts
```

Expected: all tests PASS

- [ ] **Step 6: Commit**

```bash
git add backend/src/approvals/queue.ts backend/src/approvals/queue.test.ts
git commit -m "feat(approvals): add registerExecutor for async deferred tool auto-execution"
```

---

### Task 4: Extract `executeTool` helper in `agent-endpoint.ts`

This is the largest refactor. The goal is to factor out lines ~500–800 of `handleCallTool` into a standalone `executeTool` function so it can be called both inline (non-approval tools) and deferred (approval tools via executor closure).

**Files:**
- Modify: `backend/src/mcp/agent-endpoint.ts`

> **Read the file before editing.** The relevant section starts after the approval block (currently ~line 499) and ends at the closing `}` of `handleCallTool`.

- [ ] **Step 1: Define the `ToolExecutionResult` interface near the top of `agent-endpoint.ts`**

After the existing type imports and before `handleCallTool`, add:

```typescript
interface ToolExecutionResult {
  success: boolean;
  data?: unknown;
  errorCode?: number;
  errorMessage?: string;
  errorData?: Record<string, unknown>;
}
```

- [ ] **Step 2: Create `executeTool` function**

Add this new function before `handleCallTool`. It encapsulates the credential resolution and tool-call logic currently inline in `handleCallTool`:

```typescript
/**
 * Resolve credentials and call the tool. Returns a plain result (not an MCP response).
 * Used both for immediate execution and for deferred execution after approval.
 */
async function executeTool(
  agentId: string,
  serviceType: string,
  toolName: string,
  argsIn: Record<string, unknown>,
  hasInstances: boolean,
  serviceInstances: typeof agentServiceInstances.$inferSelect[],
): Promise<ToolExecutionResult> {
  let args = { ...argsIn };
  const context: ToolContext = {
    requestId: crypto.randomUUID(),
    agentId,
  };

  const isListAccountsTool = toolName.endsWith('_list_accounts');

  if (hasInstances) {
    if (isListAccountsTool) {
      const accounts: Array<{ email: string; name?: string; isDefault: boolean }> = [];
      for (const inst of serviceInstances) {
        if (inst.credentialId) {
          const [cred] = await db.select().from(credentials).where(eq(credentials.id, inst.credentialId));
          if (cred?.accountEmail) {
            accounts.push({ email: cred.accountEmail, name: cred.accountName ?? undefined, isDefault: inst.isDefault });
          }
        }
      }
      context.linkedAccounts = accounts;
    } else {
      const requestedAccount = args.account as string | undefined;
      let targetInstance = serviceInstances.find((i) => i.isDefault) ?? serviceInstances[0];

      if (requestedAccount) {
        let found = false;
        for (const inst of serviceInstances) {
          if (inst.credentialId) {
            const [cred] = await db.select().from(credentials).where(eq(credentials.id, inst.credentialId));
            if (cred?.accountEmail === requestedAccount) {
              targetInstance = inst;
              found = true;
              break;
            }
          }
        }
        if (!found) {
          return {
            success: false,
            errorCode: MCP_ERROR_CODES.MISSING_CREDENTIALS,
            errorMessage: `No credential found for account: ${requestedAccount}. Use ${serviceType}_list_accounts to see available accounts.`,
            errorData: { service: serviceType, requestedAccount },
          };
        }
      }

      const { account: _account, ...cleanArgs } = args;
      args = cleanArgs;

      if (!targetInstance.credentialId) {
        try {
          const { serviceDefinitions } = await import('@reins/servers');
          const def = serviceDefinitions.find((d) => d.type === serviceType);
          const [agentRow] = await db.select().from(agents).where(eq(agents.id, agentId));
          if (def && agentRow?.userId) {
            const serviceIds = def.auth.credentialServiceIds ?? [serviceType];
            const [matchingCred] = await db
              .select()
              .from(credentials)
              .where(and(inArray(credentials.serviceId, serviceIds), eq(credentials.userId, agentRow.userId)));
            if (matchingCred) {
              await db
                .update(agentServiceInstances)
                .set({ credentialId: matchingCred.id, updatedAt: new Date().toISOString() })
                .where(eq(agentServiceInstances.id, targetInstance.id));
              targetInstance = { ...targetInstance, credentialId: matchingCred.id };
            }
          }
        } catch (healErr) {
          console.warn(`[agent-endpoint] auto-heal failed for ${serviceType}:`, healErr);
        }
      }

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
    }
  } else {
    // Legacy credential resolution path
    const linkedCreds = await db
      .select()
      .from(agentServiceCredentials)
      .where(and(eq(agentServiceCredentials.agentId, agentId), eq(agentServiceCredentials.serviceType, serviceType)));

    if (isListAccountsTool && linkedCreds.length > 0) {
      const accounts: Array<{ email: string; name?: string; isDefault: boolean }> = [];
      for (const lc of linkedCreds) {
        const [cred] = await db.select().from(credentials).where(eq(credentials.id, lc.credentialId));
        if (cred?.accountEmail) {
          accounts.push({ email: cred.accountEmail, name: cred.accountName ?? undefined, isDefault: lc.isDefault });
        }
      }
      context.linkedAccounts = accounts;
    } else if (linkedCreds.length > 0) {
      const requestedAccount = args.account as string | undefined;
      let targetCredentialId: string | undefined;

      if (requestedAccount) {
        for (const lc of linkedCreds) {
          const [cred] = await db.select().from(credentials).where(eq(credentials.id, lc.credentialId));
          if (cred?.accountEmail === requestedAccount) {
            targetCredentialId = lc.credentialId;
            break;
          }
        }
        if (!targetCredentialId) {
          return {
            success: false,
            errorCode: MCP_ERROR_CODES.MISSING_CREDENTIALS,
            errorMessage: `No credential found for account: ${requestedAccount}. Use gmail_list_accounts to see available accounts.`,
            errorData: { service: serviceType, requestedAccount },
          };
        }
      } else {
        const defaultCred = linkedCreds.find((lc) => lc.isDefault);
        targetCredentialId = defaultCred?.credentialId ?? linkedCreds[0].credentialId;
      }

      const { account: _account, ...cleanArgs } = args;
      args = cleanArgs;

      const credential = await credentialVault.retrieve(targetCredentialId!);
      if (credential) {
        context.credential = credential;
        const accessToken = await credentialVault.getValidAccessToken(targetCredentialId!);
        if (accessToken) {
          context.accessToken = accessToken;
        } else {
          await createMCPReauthApproval(agentId, serviceType, targetCredentialId!).catch(() => {});
          return {
            success: false,
            errorCode: MCP_ERROR_CODES.MISSING_CREDENTIALS,
            errorMessage: `Credentials expired and could not be refreshed for service: ${serviceType}`,
            errorData: { service: serviceType },
          };
        }
      }
    } else {
      const [accessRecord] = await db
        .select()
        .from(agentServiceAccess)
        .where(and(eq(agentServiceAccess.agentId, agentId), eq(agentServiceAccess.serviceType, serviceType)));

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
      } else {
        const serviceDef = _registryLoaded
          ? (await import('@reins/servers')).serviceRegistry.get(serviceType)
          : null;
        const requiresAuth = serviceDef?.auth.required ?? false;
        if (requiresAuth) {
          return {
            success: false,
            errorCode: MCP_ERROR_CODES.MISSING_CREDENTIALS,
            errorMessage: `No credentials linked for service: ${serviceType}`,
            errorData: { service: serviceType },
          };
        }
      }
    }
  }

  const server = serverManager.getServer(serviceType);
  if (!server) {
    return {
      success: false,
      errorCode: MCP_ERROR_CODES.SERVICE_NOT_ENABLED,
      errorMessage: `Server not available: ${serviceType}`,
      errorData: { service: serviceType },
    };
  }

  const toolResult = await server.callTool(toolName, args, context);
  if (toolResult.success) {
    return {
      success: true,
      data: toolResult.data,
    };
  }

  return {
    success: false,
    errorCode: MCP_ERROR_CODES.TOOL_EXECUTION_ERROR,
    errorMessage: typeof toolResult.error === 'string' ? toolResult.error : 'Tool execution failed',
    errorData: { service: serviceType },
  };
}
```

> **Note:** `MCP_ERROR_CODES.TOOL_EXECUTION_ERROR` — check what error code is currently used in the `else` branch of `handleCallTool` for tool failures and use the same value.

- [ ] **Step 3: Replace the inline credential+execution block in `handleCallTool`**

After the approval block (after `await auditLogger.logApproval(...)`), replace all the credential resolution and tool execution code (lines ~500–end of function) with a call to `executeTool`:

```typescript
  // Execute the tool (credentials resolved internally)
  const toolResult = await executeTool(agentId, serviceType, toolName, args, hasInstances, serviceInstances);
  const durationMs = Date.now() - startTime;

  if (toolResult.success) {
    await auditLogger.logToolCall(agentId, toolName, args, 'success', durationMs, { serviceType });
    return {
      jsonrpc: '2.0',
      id: requestId,
      result: {
        content: [{
          type: 'text',
          text: typeof toolResult.data === 'string'
            ? toolResult.data
            : JSON.stringify(toolResult.data, null, 2),
        }],
      },
    };
  }

  await auditLogger.logToolCall(agentId, toolName, args, 'error', durationMs, {
    error: toolResult.errorMessage,
    serviceType,
  });

  return {
    jsonrpc: '2.0',
    id: requestId,
    error: {
      code: toolResult.errorCode ?? MCP_ERROR_CODES.TOOL_EXECUTION_ERROR,
      message: toolResult.errorMessage ?? 'Tool execution failed',
      data: toolResult.errorData,
    },
  };
```

- [ ] **Step 4: Run existing tests to verify behaviour is unchanged**

```bash
npm test --workspace=backend -- --reporter=verbose src/mcp/agent-endpoint.test.ts
```

Expected: all previously passing tests still PASS

- [ ] **Step 5: Typecheck**

```bash
npm run typecheck --workspace=backend
```

Expected: no errors

- [ ] **Step 6: Commit**

```bash
git add backend/src/mcp/agent-endpoint.ts
git commit -m "refactor(mcp): extract executeTool helper from handleCallTool"
```

---

### Task 5: Wire deferred approval response in `agent-endpoint.ts`

**Files:**
- Modify: `backend/src/mcp/agent-endpoint.ts`

- [ ] **Step 1: Write failing test**

In `backend/src/mcp/agent-endpoint.test.ts`, add a test that verifies approvals now return a deferred response (not a blocking wait/error):

```typescript
describe('tools/call with require_approval', () => {
  it('returns deferred response immediately instead of blocking', async () => {
    // Arrange: tool requires approval
    vi.mocked(canAccessTool).mockResolvedValueOnce({ allowed: true, requiresApproval: true });
    vi.mocked(approvalQueue.submit).mockResolvedValueOnce('job-abc-123');
    const registerSpy = vi.spyOn(approvalQueue, 'registerExecutor').mockImplementation(() => {});

    const response = await handleMCPRequest('agent-1', {
      jsonrpc: '2.0',
      id: 1,
      method: 'tools/call',
      params: { name: 'gmail_send_email', arguments: { to: 'bob@example.com', subject: 'Hi' } },
    });

    // Should return immediately with deferred=true
    expect(response.result).toBeDefined();
    expect(response.error).toBeUndefined();
    const content = JSON.parse(response.result.content[0].text);
    expect(content.deferred).toBe(true);
    expect(content.jobId).toBe('job-abc-123');
    expect(registerSpy).toHaveBeenCalledWith('job-abc-123', expect.any(Function));
  });
});
```

- [ ] **Step 2: Run to verify it fails**

```bash
npm test --workspace=backend -- --reporter=verbose src/mcp/agent-endpoint.test.ts
```

Expected: FAIL — response still shows `error.code` (the old blocking timeout behaviour) or the test mock wiring fails

- [ ] **Step 3: Replace blocking wait with deferred response in `handleCallTool`**

In `handleCallTool`, replace the approval block (currently lines ~468–498):

**Before:**
```typescript
if (requiresApproval) {
  const approvalId = await approvalQueue.submit(
    agentId, toolName, args, `MCP endpoint call for ${toolName}`
  );
  const decision = await approvalQueue.waitForDecision(approvalId, 5 * 60 * 1000);
  if (!decision || !decision.approved) {
    await auditLogger.logToolCall(agentId, toolName, args, 'blocked', Date.now() - startTime, {
      reason: decision ? 'Approval denied' : 'Approval timeout',
      approvalId, serviceType,
    });
    return {
      jsonrpc: '2.0', id: requestId,
      error: {
        code: MCP_ERROR_CODES.APPROVAL_DENIED,
        message: decision ? 'Approval denied' : 'Approval timed out',
        data: { tool: toolName, approvalId },
      },
    };
  }
  await auditLogger.logApproval(agentId, toolName, 'success', decision.approver);
}
```

**After:**
```typescript
if (requiresApproval) {
  const approvalId = await approvalQueue.submit(
    agentId, toolName, args, `MCP endpoint call for ${toolName}`
  );

  // Capture current args/instances snapshot for deferred execution
  const capturedArgs = { ...args };
  const capturedInstances = [...serviceInstances];
  const capturedHasInstances = hasInstances;

  approvalQueue.registerExecutor(approvalId, () =>
    executeTool(agentId, serviceType, toolName, capturedArgs, capturedHasInstances, capturedInstances)
  );

  await auditLogger.logToolCall(agentId, toolName, args, 'pending', Date.now() - startTime, {
    reason: 'Awaiting approval',
    approvalId, serviceType,
  });

  return {
    jsonrpc: '2.0',
    id: requestId,
    result: {
      content: [{
        type: 'text',
        text: JSON.stringify({
          deferred: true,
          jobId: approvalId,
          message: 'This action requires approval. Use reins_get_result to check when complete.',
        }),
      }],
    },
  };
}
```

- [ ] **Step 4: Run the test to verify it passes**

```bash
npm test --workspace=backend -- --reporter=verbose src/mcp/agent-endpoint.test.ts
```

Expected: new test PASS, existing tests PASS

- [ ] **Step 5: Commit**

```bash
git add backend/src/mcp/agent-endpoint.ts
git commit -m "feat(mcp): replace blocking approval wait with deferred job response"
```

---

### Task 6: Add `reins_get_result` MCP tool

**Files:**
- Modify: `backend/src/mcp/agent-endpoint.ts`
- Modify: `backend/src/mcp/agent-endpoint.test.ts`

- [ ] **Step 1: Write failing tests**

In `backend/src/mcp/agent-endpoint.test.ts`, add:

```typescript
describe('reins_get_result tool', () => {
  it('appears in tools/list for any agent', async () => {
    // tools/list should always include reins_get_result regardless of service config
    const response = await handleMCPRequest('agent-1', {
      jsonrpc: '2.0', id: 1, method: 'tools/list',
    });
    const toolNames = response.result.tools.map((t: { name: string }) => t.name);
    expect(toolNames).toContain('reins_get_result');
  });

  it('returns pending status for an unresolved job', async () => {
    vi.mocked(approvalQueue.get).mockResolvedValueOnce({
      id: 'job-1', agentId: 'agent-1', tool: 'gmail_send_email',
      arguments: {}, status: 'pending',
      requestedAt: new Date(), expiresAt: new Date(Date.now() + 3600_000),
    });

    const response = await handleMCPRequest('agent-1', {
      jsonrpc: '2.0', id: 1, method: 'tools/call',
      params: { name: 'reins_get_result', arguments: { jobId: 'job-1' } },
    });

    const content = JSON.parse(response.result.content[0].text);
    expect(content.status).toBe('pending');
    expect(content.jobId).toBe('job-1');
  });

  it('returns completed status with result when job is approved and executed', async () => {
    vi.mocked(approvalQueue.get).mockResolvedValueOnce({
      id: 'job-1', agentId: 'agent-1', tool: 'gmail_send_email',
      arguments: {}, status: 'approved',
      requestedAt: new Date(), expiresAt: new Date(Date.now() + 3600_000),
      resultJson: JSON.stringify({ messageId: 'msg-123' }),
    });

    const response = await handleMCPRequest('agent-1', {
      jsonrpc: '2.0', id: 1, method: 'tools/call',
      params: { name: 'reins_get_result', arguments: { jobId: 'job-1' } },
    });

    const content = JSON.parse(response.result.content[0].text);
    expect(content.status).toBe('completed');
    expect(content.result).toEqual({ messageId: 'msg-123' });
  });

  it('returns rejected status with reason', async () => {
    vi.mocked(approvalQueue.get).mockResolvedValueOnce({
      id: 'job-1', agentId: 'agent-1', tool: 'gmail_send_email',
      arguments: {}, status: 'rejected',
      requestedAt: new Date(), expiresAt: new Date(Date.now() + 3600_000),
      resolutionComment: 'Not allowed at this time',
    });

    const response = await handleMCPRequest('agent-1', {
      jsonrpc: '2.0', id: 1, method: 'tools/call',
      params: { name: 'reins_get_result', arguments: { jobId: 'job-1' } },
    });

    const content = JSON.parse(response.result.content[0].text);
    expect(content.status).toBe('rejected');
    expect(content.reason).toBe('Not allowed at this time');
  });

  it('returns error for unknown jobId', async () => {
    vi.mocked(approvalQueue.get).mockResolvedValueOnce(null);

    const response = await handleMCPRequest('agent-1', {
      jsonrpc: '2.0', id: 1, method: 'tools/call',
      params: { name: 'reins_get_result', arguments: { jobId: 'nonexistent' } },
    });

    expect(response.error).toBeDefined();
    expect(response.error.message).toMatch(/not found/i);
  });

  it('only returns results for jobs belonging to the calling agent', async () => {
    vi.mocked(approvalQueue.get).mockResolvedValueOnce({
      id: 'job-1', agentId: 'other-agent', tool: 'gmail_send_email',
      arguments: {}, status: 'approved',
      requestedAt: new Date(), expiresAt: new Date(Date.now() + 3600_000),
      resultJson: JSON.stringify({ secret: 'data' }),
    });

    const response = await handleMCPRequest('agent-1', {
      jsonrpc: '2.0', id: 1, method: 'tools/call',
      params: { name: 'reins_get_result', arguments: { jobId: 'job-1' } },
    });

    expect(response.error).toBeDefined();
    expect(response.error.message).toMatch(/not found/i);
  });
});
```

- [ ] **Step 2: Run to verify they fail**

```bash
npm test --workspace=backend -- --reporter=verbose src/mcp/agent-endpoint.test.ts
```

Expected: FAIL — `reins_get_result` not in tool list and not handled

- [ ] **Step 3: Inject `reins_get_result` into `tools/list`**

In `handleListTools`, after the `tools` array is fully populated (before the `return`), add:

```typescript
// Always inject the built-in reins_get_result polling tool
tools.push({
  name: 'reins_get_result',
  description:
    'Check the status of a deferred tool call that required approval. ' +
    'Returns status: pending | completed | rejected | expired. ' +
    'When completed, includes the result of the original tool call.',
  inputSchema: {
    type: 'object',
    properties: {
      jobId: {
        type: 'string',
        description: 'The jobId returned by the original deferred tool call',
      },
    },
    required: ['jobId'],
  },
});
```

- [ ] **Step 4: Handle `reins_get_result` in `handleCallTool`**

At the very top of `handleCallTool`, before the service type derivation, add:

```typescript
// Built-in tool: reins_get_result
if (toolName === 'reins_get_result') {
  const { jobId } = args as { jobId?: string };
  if (!jobId || typeof jobId !== 'string') {
    return {
      jsonrpc: '2.0', id: requestId,
      error: { code: -32602, message: 'jobId is required', data: {} },
    };
  }

  const approval = await approvalQueue.get(jobId);

  // Security: only return results for jobs belonging to this agent
  if (!approval || approval.agentId !== agentId) {
    return {
      jsonrpc: '2.0', id: requestId,
      error: { code: -32602, message: `Job not found: ${jobId}`, data: {} },
    };
  }

  let jobResult: import('@reins/shared').DeferredJobResult;

  if (approval.status === 'pending') {
    jobResult = { status: 'pending', jobId };
  } else if (approval.status === 'rejected') {
    jobResult = { status: 'rejected', jobId, reason: approval.resolutionComment };
  } else if (approval.status === 'expired') {
    jobResult = { status: 'expired', jobId };
  } else {
    // approved — return result if execution completed, or 'pending' if executor hasn't run yet
    if (approval.resultJson) {
      jobResult = { status: 'completed', jobId, result: JSON.parse(approval.resultJson) };
    } else {
      jobResult = { status: 'pending', jobId };
    }
  }

  return {
    jsonrpc: '2.0', id: requestId,
    result: {
      content: [{ type: 'text', text: JSON.stringify(jobResult) }],
    },
  };
}
```

- [ ] **Step 5: Run tests to verify they pass**

```bash
npm test --workspace=backend -- --reporter=verbose src/mcp/agent-endpoint.test.ts
```

Expected: all tests PASS

- [ ] **Step 6: Run full backend test suite**

```bash
npm test --workspace=backend
```

Expected: all tests PASS

- [ ] **Step 7: Typecheck everything**

```bash
npm run typecheck
```

Expected: no errors

- [ ] **Step 8: Commit**

```bash
git add backend/src/mcp/agent-endpoint.ts backend/src/mcp/agent-endpoint.test.ts
git commit -m "feat(mcp): add reins_get_result built-in tool for polling deferred approvals"
```

---

## Self-Review

### Spec coverage
- [x] Agent calls tool → gets `{ deferred: true, jobId }` immediately — Task 5
- [x] Approval auto-executes the tool — Task 3 (`executeTool`) + Task 4 (`registerExecutor`)
- [x] Result stored in DB — Task 1 (`result_json` column) + Task 4 (`storeResult`)
- [x] Agent polls with `reins_get_result` — Task 6
- [x] Returns `pending | completed | rejected | expired` — Task 6
- [x] Security: agents can only poll their own jobs — Task 6 (agentId check)
- [x] DB migration — Task 1
- [x] Shared types updated — Task 2

### Type consistency check
- `ToolExecutionResult` defined in Task 4 (agent-endpoint.ts), consumed in Tasks 4 and 5 ✓
- `DeferredJobResult` defined in Task 2 (shared/types), imported in Task 6 ✓
- `resultJson` added in Task 1 (schema + migration + mapToRequest), used in Task 6 ✓
- `registerExecutor` defined in Task 3, called in Task 5 ✓
- `storeResult` defined in Task 1, called in Task 3 ✓

### Placeholder scan
No TBDs, TODOs, or "similar to" references found.
