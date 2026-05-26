# Adding Tools to an MCP Server

Every tool touches **six files**. Miss any one and you get the bugs that prompted this doc: tools that appear in the UI but can't be permission-managed, tools silently stuck at `allow` regardless of the level the user chose, or tools with a working UI that 403 because they were missing a required OAuth scope.

---

## Checklist

Use this for every new tool, in order.

### 1. `servers/src/<service>/handlers.ts` — implement the handler

```ts
export async function handleFooBar(
  args: Record<string, unknown>,
  context: ServerContext
): Promise<ToolResult> {
  const client = getServiceClient(context);  // always first
  const thingId = args.thingId as string;

  const response = await client.resource.action({ ... });

  return {
    success: true,
    data: { thingId, result: response.data },
  };
}
```

**Scope check:** confirm the underlying API call doesn't require a scope that isn't already in `definition.ts → auth.oauthScopes`. If it does, add the scope there **and** update the four scope lists described in step 6 below.

### 2. `servers/src/<service>/tools.ts` — add import + tool definition + register

**Import the handler** (alphabetical in the import block):
```ts
import {
  // ...existing...
  handleFooBar,
} from './handlers.js';
```

**Define the tool** (before the `export const <service>Tools` array):
```ts
export const fooBarTool: ToolDefinition = {
  name: 'service_foo_bar',
  description: 'One sentence. What it does and when to use it vs similar tools.',
  inputSchema: {
    type: 'object',
    properties: {
      ...accountProperty,   // include if service supports multi-account
      thingId: {
        type: 'string',
        description: 'The ID of the thing',
      },
    },
    required: ['thingId'],
  },
  handler: handleFooBar,
};
```

**Register in the tools array** (at the bottom of the file):
```ts
export const <service>Tools: ToolDefinition[] = [
  // ...existing...
  fooBarTool,   // ← add here
];
```

### 3. `servers/src/<service>/definition.ts` — classify in permissions

Every tool must appear in exactly one of `read`, `write`, or `blocked`.

| Category | Default permission | Blocked in Read mode? | Semantics |
|----------|-------------------|-----------------------|-----------|
| `read`   | `allow`           | No                    | Safe reads — no state change |
| `write`  | `require_approval`| Yes (→ `block`)       | Mutates state, requires `gmail.modify` or equivalent |
| `blocked`| `block`           | Yes                   | Dangerous by default; user must explicitly unblock |

```ts
permissions: {
  read: [..., 'service_foo_list'],
  write: [..., 'service_foo_bar'],   // ← new write tool
  blocked: [...],
},
```

Misclassifying here means the UI's Read/Full preset buttons silently skip the tool.

### 4. `templates/<service>.yaml` — add to the policy template

The policy template defines the default policy used by the agent. Add the tool under the right directive:

```yaml
tools:
  allow:
    - service_foo_list
  require_approval:
    - service_foo_bar    # ← new write tool
  block:
    - service_foo_nuke
```

Tools absent from the template are left to the policy engine's fallback (`allow`). This means a tool that should require approval will silently be allowed.

### 5. `backend/src/services/permissions.ts` — sync `PERMISSION_PRESETS`

`PERMISSION_PRESETS` is the static in-process mirror of `definition.ts`. Keep it in sync:

```ts
<service>: {
  read:    [..., 'service_foo_list'],
  write:   [..., 'service_foo_bar'],   // ← new write tool
  blocked: [...],
},
```

This is used by `setInstancePermissionLevel` to configure tool permissions when a user picks Read or Full in the UI.

### 6. OAuth scope (if the tool needs a new scope)

Some operations require a broader OAuth scope than what's already granted. If the handler calls an API that needs a new scope:

- Add the scope to `definition.ts → auth.oauthScopes`
- Add it to the **four** scope lists in `backend/src/api/routes.ts`:
  - Dynamic scope builder (iterates service definitions — covered by step above)
  - Registry-unavailable fallback list (`serviceScopes = [...]`)
  - Onboarding hardcoded scope string (`scope: '... https://...'`)
  - Microsoft analog if applicable

OAuth scope changes require existing users to **Reconnect** their credential (Dashboard → Credentials → Reconnect) to grant the new scope. Note this in your commit message.

---

## Why each step matters

| Step skipped | Symptom |
|---|---|
| Handler not exported | `Unknown tool` error at runtime |
| Tool not in `gmailTools` array | Tool invisible to agents (never registered in server manager) |
| Missing from `definition.ts` permissions | Tool appears in individual tool list with `allow`, unaffected by Read/Full preset |
| Missing from policy template | Tool silently allowed even when it should require approval |
| Missing from `PERMISSION_PRESETS` | `setInstancePermissionLevel` doesn't configure the tool; level shows as `custom` in UI |
| Missing OAuth scope | 403 from Google on every call; existing users need to reconnect |

---

## Quick reference: Gmail scope → permission category

| Scope needed | Category |
|---|---|
| `gmail.readonly` | `read` |
| `gmail.compose` | `write` |
| `gmail.modify` | `write` |
| `gmail.send` | `blocked` or `write` |
| destructive (delete) | `blocked` |
