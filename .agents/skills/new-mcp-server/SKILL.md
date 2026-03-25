---
name: new-mcp-server
description: Scaffold a new native MCP server in the Reins servers package. Creates the four-file structure (tools.ts, handlers.ts, definition.ts, index.ts), wires it into the registry, and updates package exports. Use when the user asks to "add a server", "create an MCP server", "add a new service", "scaffold a server", or "integrate [service name]".
---

# New MCP Server

## Identity

You are implementing a new native MCP server inside the `servers/` workspace of the Reins project. Every server follows an identical four-file pattern. Your job is to create all four files, then wire the server into the registry and package exports.

## Architecture

Each server lives at `servers/src/<server-name>/` and contains exactly four files:

```
servers/src/<server-name>/
├── tools.ts        # ToolDefinition[] — schema + handler references
├── handlers.ts     # Async handler functions (the actual logic)
├── definition.ts   # ServiceDefinitionWithTools — metadata, auth, permissions
└── index.ts        # Server class extending BaseServer + re-exports
```

Three existing files must be updated (one line each):

| File | Change |
|------|--------|
| `servers/src/registry.ts` | Add `import { definition as <name> } from './<server-name>/definition.js';` and add `<name>` to the `serviceDefinitions` array |
| `servers/src/index.ts` | Add export line for the new Server class, tools, and any helpers |
| `servers/package.json` | Add `"./<server-name>": "./dist/<server-name>/index.js"` to `exports` |

## Step-by-step

### 1. Gather requirements

Before writing any code, determine:

- **Service name** (kebab-case, e.g. `slack`, `notion`, `linear`)
- **Tool prefix** (e.g. `slack_`, `notion_`) — all tool names start with this
- **Auth type**: `oauth2`, `api_key`, or `none`
- **Tools to implement** — list each tool with read/write/blocked classification
- **API base URL** and authentication header format

### 2. Create `handlers.ts`

```typescript
import type { ServerContext, ToolResult } from '../common/types.js';

const API_BASE = 'https://api.example.com';

async function apiRequest(
  context: ServerContext,
  path: string,
  options: RequestInit = {}
): Promise<Response> {
  const token = context.accessToken;
  if (!token) throw new Error('No access token available');

  return fetch(`${API_BASE}${path}`, {
    ...options,
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
      ...(options.headers as Record<string, string> ?? {}),
    },
  });
}

export async function handleListItems(
  args: Record<string, unknown>,
  context: ServerContext
): Promise<ToolResult> {
  const response = await apiRequest(context, '/items');
  if (!response.ok) {
    return { success: false, error: `API error: ${response.status}` };
  }
  const data = await response.json();
  return { success: true, data };
}
```

Rules:
- Every handler has signature `(args: Record<string, unknown>, context: ServerContext) => Promise<ToolResult>`
- Access tokens come from `context.accessToken`
- Return `{ success: true, data }` or `{ success: false, error: "message" }`
- Extract and reshape API responses — don't return raw payloads
- No imports from other server directories

### 3. Create `tools.ts`

```typescript
import type { ToolDefinition } from '../common/base-server.js';
import { handleListItems } from './handlers.js';

export const listItemsTool: ToolDefinition = {
  name: 'example_list_items',
  description: 'List all items.',
  inputSchema: {
    type: 'object',
    properties: {
      limit: { type: 'number', description: 'Max results (default: 20)' },
    },
  },
  handler: handleListItems,
};

export const exampleTools: ToolDefinition[] = [
  listItemsTool,
];
```

Rules:
- Export each tool individually AND as a collected array
- Array name follows pattern: `<serverName>Tools` (camelCase)
- `inputSchema` must be valid JSON Schema with `type: 'object'`
- Use `required` array for mandatory parameters
- Tool names must start with the tool prefix from the definition

### 4. Create `definition.ts`

```typescript
import type { ServiceDefinitionWithTools } from '../common/types.js';
import { exampleTools } from './tools.js';

export const definition: ServiceDefinitionWithTools = {
  type: 'example',
  name: 'Example Service',
  description: 'Short description of what this service does',
  icon: 'IconName',            // Lucide icon name
  category: 'productivity',    // google | productivity | dev-tools | communication | search | browser
  toolPrefix: 'example_',
  auth: {
    type: 'api_key',           // oauth2 | api_key | none
    required: true,
    instructions: 'How to get credentials',
    keyUrl: 'https://example.com/settings/api-keys',
  },
  tools: exampleTools,
  permissions: {
    read: ['example_list_items', 'example_get_item'],
    write: ['example_create_item', 'example_update_item'],
    blocked: ['example_delete_item'],
  },
  permissionDescriptions: {
    read: 'What read-level access allows',
    full: 'What full access allows, noting which actions need approval.',
  },
};
```

Rules:
- `type` is the unique service key (kebab-case for multi-word, e.g. `web-search`)
- `toolPrefix` must match the prefix of every tool name
- Every tool name must appear in exactly one of `read`, `write`, or `blocked`
- `read` tools are auto-allowed, `write` tools require approval, `blocked` tools are denied
- For OAuth services, include `credentialServiceIds` and `oauthScopes` in `auth`

### 5. Create `index.ts`

For **API key** or **no-auth** servers:

```typescript
import { BaseServer } from '../common/base-server.js';
import type { ServerConfig, ServerContext } from '../common/types.js';
import { exampleTools } from './tools.js';

export interface ExampleServerConfig extends ServerConfig {
  token?: string;
}

export class ExampleServer extends BaseServer {
  private token?: string;

  constructor(config: ExampleServerConfig) {
    super(config);
    this.token = config.token ?? process.env.EXAMPLE_TOKEN;
  }

  protected registerTools(): void {
    for (const tool of exampleTools) {
      this.addTool(tool);
    }
  }

  protected async getContext(requestId: string): Promise<ServerContext> {
    return { requestId, accessToken: this.token };
  }

  isConfigured(): boolean {
    return !!this.token;
  }
}

export { exampleTools } from './tools.js';
export { definition } from './definition.js';
```

For **OAuth** servers (Google), follow the `GmailServer` pattern with `GoogleOAuthHandler`.

### 6. Wire into the project

**`servers/src/registry.ts`** — add import and array entry:
```typescript
import { definition as example } from './example/definition.js';

// Add to serviceDefinitions array:
export const serviceDefinitions: ServiceDefinitionWithTools[] = [
  // ... existing entries
  example,
];
```

**`servers/src/index.ts`** — add export:
```typescript
export { ExampleServer, exampleTools } from './example/index.js';
```

**`servers/package.json`** — add to `exports`:
```json
"./example": "./dist/example/index.js"
```

### 7. Verify

Run these commands to confirm everything compiles:
```bash
npm run build --workspace=servers
```

## Conventions

- Tool names: `<prefix>_<verb>_<noun>` (e.g. `slack_list_channels`, `github_get_issue`)
- Handler names: `handle<PascalVerb><PascalNoun>` (e.g. `handleListChannels`, `handleGetIssue`)
- Server class: `<PascalName>Server` (e.g. `SlackServer`, `NotionServer`)
- Tools array: `<camelName>Tools` (e.g. `slackTools`, `notionTools`)
- Config interface: `<PascalName>ServerConfig`
- All imports use `.js` extension (ESM)
- Never import from other server directories — only from `../common/`

## Auth patterns

| Auth type | `auth` shape | `getContext()` provides |
|-----------|-------------|------------------------|
| `none` | `{ type: 'none', required: false }` | Just `requestId` |
| `api_key` | `{ type: 'api_key', required: true, instructions, keyUrl }` | `accessToken` from config or env var |
| `oauth2` | `{ type: 'oauth2', required: true, credentialServiceIds, oauthScopes }` | `accessToken` via `GoogleOAuthHandler` |

## Checklist

Before marking the task complete:

- [ ] All four files created in `servers/src/<server-name>/`
- [ ] Every tool name starts with the `toolPrefix`
- [ ] Every tool appears in exactly one permissions bucket (read/write/blocked)
- [ ] `definition.ts` exports `const definition`
- [ ] `index.ts` re-exports `definition` and tools
- [ ] `registry.ts` imports and includes the definition
- [ ] `servers/src/index.ts` exports the Server class and tools
- [ ] `servers/package.json` has the new export entry
- [ ] `npm run build --workspace=servers` passes
