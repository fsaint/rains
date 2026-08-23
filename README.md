# Reins

The trust layer for AI agents. An MCP-native proxy gateway providing granular permission control, guided provisioning, credential health monitoring, and programmable spend authorization.

**Using Helm rather than developing it?** [`docs/MULTI_AGENT_SETUP.md`](docs/MULTI_AGENT_SETUP.md) walks through running a separate agent per context — home, work, a project — each with its own memory scope, connected accounts, and approval rules, connected to Claude, Claude Code, or Cowork.

## Project Structure

```
reins/
├── frontend/          # React/TypeScript dashboard
├── backend/           # Node.js/TypeScript MCP proxy & API
├── shared/            # Shared types, schemas, tool-name resolution
├── servers/           # Native MCP server implementations (18 services)
├── onboarding/        # Telegram onboarding bot
├── admin/             # Python admin tools for production ops
├── e2e/               # Playwright browser journeys
├── templates/         # Service provisioning templates & starter skills
├── config/            # Per-environment non-secret config (development/production.yaml)
└── docs/              # Architecture, ADRs, ops runbooks, API specs, branding
```

`shared`, `backend`, `frontend`, `servers`, and `onboarding` are npm workspaces.

## Getting Started

### Prerequisites

- Node.js 20+
- PostgreSQL 16

### Install

```bash
npm install
npm run build --workspace=shared --workspace=servers
```

The build step is not optional. The backend imports `@reins/servers` by its **built** output, so a service added to `servers/src` is invisible — `Invalid service type` — until `dist` is rebuilt.

### Development

```bash
npm run dev              # All services
npm run dev:backend      # Backend only  (port 5001)
npm run dev:frontend     # Frontend only (port 6173, proxies /api → 5001)
```

### Environment Variables

Copy the essentials into `.env` at the repo root:

```bash
DATABASE_URL=postgres://user:pass@localhost:5432/reins
REINS_ENCRYPTION_KEY=<32-byte-hex>
REINS_ADMIN_EMAIL=admin@reins.local
REINS_ADMIN_PASSWORD=changeme

# Points the in-process MCP servers at your local backend. Without it they
# default to https://app.helm.mom — i.e. local dev silently calls production.
REINS_API_URL=http://localhost:5001

FLY_ORG=development-808          # never 'personal' outside production
FLY_API_TOKEN=<dev-scoped token>
```

Non-secret settings live in `config/development.yaml` and `config/production.yaml`; an environment variable of the same name always wins. Run `scripts/check-local-env.sh` as a pre-flight check.

See [`docs/ops/LOCAL_DEV_SETUP.md`](docs/ops/LOCAL_DEV_SETUP.md) for OAuth redirect URIs, Telegram tunnels, and dev bots.

---

## Testing

```bash
npm test                              # All workspaces
npm run typecheck --workspaces        # TypeScript, all workspaces
```

| Workspace | Tests | What it covers |
|---|---|---|
| `backend` | 697 | Routes, permissions, MCP endpoint, approvals, credentials, billing |
| `servers` | 373 | Handler-level tests per native MCP server |
| `frontend` | 75 | Components, pages, API client |
| `shared` | 19 | Tool-name resolution, schemas |

Watch mode and coverage are per package:

```bash
cd backend && npm run test:watch
cd backend && npm run test:coverage
```

### Reproducing a CI-only failure

CI has no `.env`. Several failures only appear without one, because config is read **once** at first import and tests that set `process.env` afterwards are silently inert. Move the file aside rather than guessing:

```bash
mv .env .env.hidden
NODE_ENV=test npm test
mv .env.hidden .env
```

### E2E

Playwright drives the built frontend against a live backend. Locally `npm test` does not run it; `npx playwright test` starts both servers itself. In CI the servers are started separately and the frontend is served with `vite preview` — **not** a static file server, which would return `index.html` for `/api/*` with a 200 and leave the app unable to sign in.

---

## Test Structure

### Backend (`backend/src/**/*.test.ts`)

Vitest, no Docker or external services. Database and network calls are mocked.

| Area | Files |
|---|---|
| API routes | `agent-admin-routes`, `approvals-routes`, `mcp-auth-routes`, `skills-routes`, `upload-body-limit` |
| MCP | `mcp/agent-endpoint`, `mcp/oauth/tokens`, `mcp/redact-args` |
| Permissions & services | `services/permissions`, `services/skills`, `services/memory`, `services/memory-scopes`, `services/registration`, `services/model-router` |
| Money & limits | `services/billing`, `services/spend` |
| Platform | `approvals/queue`, `audit/logger`, `auth/auth`, `credentials/vault`, `policy/engine`, `notifications/telegram`, `db/compat` |
| Providers | `providers/fly`, `providers/provider` |
| Integration | `integration/user-journey`, `integration/user-journey-shared-bot`, `integration/memory` |

Route-level tests matter here more than they usually do: the privilege boundaries live in the routes, not in tool exposure. Every deployed agent has a gateway token and the API URL in its environment, so a gate enforced only in `tools/list` enforces nothing.

### Servers (`servers/src/**/*.test.ts`)

| Service | Files |
|---|---|
| Gmail | `gmail/handlers`, `gmail/attachments`, `gmail/mime`, `gmail/safe-fetch` |
| Google | `drive/handlers`, `calendar/handlers` |
| Platform-facing | `memory/handlers`, `skills/handlers`, `skill-authoring/handlers` |
| Other | `browser/handlers`, `web-search/handlers`, `pipedrive/handlers`, `registry` |

### Frontend (`frontend/src/**/*.test.tsx`)

Vitest + React Testing Library in jsdom, API calls mocked.

`api/client`, `pages/Login`, `pages/Approvals`, `components/LogViewer`.

---

## Native MCP Servers

Eighteen services live in `servers/src`, each with a `definition.ts` declaring its tools, permission split, and auth requirements. `servers/src/registry.ts` aggregates them; the backend registers them in-process and also serves them to remote agents.

| Category | Services |
|---|---|
| Google | `gmail`, `drive`, `calendar` |
| Microsoft | `outlook_mail`, `outlook_calendar` |
| Work tools | `github`, `linear`, `notion`, `zendesk`, `pipedrive`, `hermeneutix` |
| Built-in | `browser`, `web-search`, `memory`, `skills` |
| Privileged | `skill-authoring`, `helm-admin` |
| Dev only | `dev-sandbox` |

**The two privileged services are different in kind.** `skill-authoring` writes the instructions other agents follow — and, when its owner is an admin, the Helm platform skills every account loads, which needs an explicit `scope: "system"` and the owner's role, neither of which enabling the service confers; `helm-admin` changes what other agents are allowed to do. An agent holding `helm-admin` may hold nothing else except `memory` — enforced in `backend/src/services/permissions.ts`, in both directions — and enabling it requires every agent on the account to have its unauthenticated MCP endpoint closed first. Without that second rule the first is decorative: an agent id is a credential on an open endpoint.

To add a service, use the `/new-mcp-server` skill, and read [`servers/ADDING_TOOLS.md`](servers/ADDING_TOOLS.md) — a tool touches six files, and missing one produces tools that appear in the UI but cannot be permission-managed.

---

## Architecture

See [`docs/architecture/ARCHITECTURE.md`](docs/architecture/ARCHITECTURE.md) for the full system design.

Key flows:

- **MCP Proxy**: Agent → Reins (policy check) → downstream MCP server or native handler
- **Approval Queue**: Tool call blocked → human review on Telegram or the dashboard → decision propagated back via `get_result`
- **Credential Vault**: AES-256-GCM encrypted tokens with automatic OAuth refresh
- **Scoped Memory**: One vault per user, partitioned into scopes that never mix, with per-agent grants
- **MCP Auth**: OAuth 2.1 (PKCE, dynamic client registration, resource indicators) alongside the original unauthenticated URLs, closable per agent

## Tech Stack

| Layer | Stack |
|-------|-------|
| Frontend | React 18, TypeScript, Vite, TailwindCSS, React Query |
| Backend | Node.js 20, TypeScript, Fastify, Drizzle ORM, PostgreSQL |
| MCP Servers | Node.js, `@modelcontextprotocol/sdk` |
| Testing | Vitest, React Testing Library, jsdom, Playwright |
| Deployment | Fly.io |

## Documentation

| Doc | For |
|---|---|
| [`CLAUDE.md`](CLAUDE.md) | Development guide, agent roles, deployment config, full doc index |
| [`docs/MULTI_AGENT_SETUP.md`](docs/MULTI_AGENT_SETUP.md) | Running one agent per context, as a user |
| [`docs/ops/COMMON_ERRORS.md`](docs/ops/COMMON_ERRORS.md) | Known traps and their fixes — read this before debugging anything odd |
| [`docs/ops/LOCAL_DEV_SETUP.md`](docs/ops/LOCAL_DEV_SETUP.md) | Local environment, OAuth, dev bots |
| [`docs/ops/ADDING_SKILLS_VIA_MCP.md`](docs/ops/ADDING_SKILLS_VIA_MCP.md) | Authoring, scoping, and assigning skills |
| [`TESTING.md`](TESTING.md) | Every test tier and when to run it |
| [`servers/ADDING_TOOLS.md`](servers/ADDING_TOOLS.md) | The six-file checklist for a new tool |

**⛔ Production:** pushing to `main` deploys automatically. `CLAUDE.md` documents the Fly permission lanes and the confirmation rules for production deploys and live tests.
