# Reins

The trust layer for AI agents. An MCP-native proxy gateway providing granular permission control, guided provisioning, credential health monitoring, and programmable spend authorization.

## Project Structure

```
reins/
├── frontend/          # React/TypeScript dashboard
├── backend/           # Node.js/TypeScript MCP proxy & API
├── shared/            # Shared types, schemas, utilities
├── servers/           # Native MCP server implementations
├── templates/         # Service provisioning templates & policies
└── docs/              # Architecture, ADRs, API specs, branding
```

## Getting Started

### Prerequisites

- Node.js 20+
- PostgreSQL (or use the Docker Compose setup)

### Install

```bash
npm install
```

### Development

```bash
npm run dev              # Start all services (frontend + backend)
npm run dev:backend      # Backend only (port 3000)
npm run dev:frontend     # Frontend only  (port 6173)
```

### Environment Variables

```bash
# Backend (.env)
REINS_PORT=3000
REINS_ENCRYPTION_KEY=<32-byte-hex>
DATABASE_URL=postgres://user:pass@localhost:5432/reins
ADMIN_EMAIL=admin@reins.local
ADMIN_PASSWORD=changeme

# Frontend (auto-proxied to backend in dev)
VITE_API_URL=http://localhost:3000
```

---

## Testing

### Run All Tests

```bash
npm test                    # All workspaces
```

### Run by Package

```bash
npm test --workspace=backend    # Backend only  (187 tests)
npm test --workspace=frontend   # Frontend only (41 tests)
npm test --workspace=servers    # Servers only  (96 tests)
```

### Watch Mode

```bash
cd backend  && npm run test:watch
cd frontend && npm run test:watch
cd servers  && npm run test:watch
```

### Coverage Report

```bash
cd backend  && npm run test:coverage
cd frontend && npm run test:coverage
cd servers  && npm run test:coverage
```

---

## Test Structure

### Backend (`backend/src/**/*.test.ts`)

Vitest unit tests with no Docker or external services required. All database and external calls are mocked.

| File | Coverage |
|------|----------|
| `audit/logger.test.ts` | Audit log write & query |
| `approvals/queue.test.ts` | Approval submit, wait, resolve |
| `credentials/vault.test.ts` | AES-256-GCM encrypt/decrypt |
| `mcp/agent-endpoint.test.ts` | JSON-RPC tool list & call routing |
| `policy/engine.test.ts` | YAML policy allow/block evaluation |
| `providers/fly.test.ts` | Fly.io machine lifecycle |
| `providers/provider.test.ts` | Provider selection & dispatch |
| `services/permissions.test.ts` | Permission matrix & presets |
| `services/registration.test.ts` | Agent registration & claim flow |
| `auth/auth.test.ts` | JWT session & bcrypt auth |
| `db/compat.test.ts` | postgres.js ↔ libsql compat layer |

### Frontend (`frontend/src/**/*.test.tsx`)

Vitest + React Testing Library tests in a jsdom environment. All API calls are mocked with `vi.mock`.

| File | Coverage |
|------|----------|
| `api/client.test.ts` | `ApiError`, `request()` error handling, HTTP methods |
| `pages/Login.test.tsx` | Form validation, submit, error display, success callback |
| `pages/Approvals.test.tsx` | Loading state, empty state, approve/reject mutations |

### Servers (`servers/src/**/*.test.ts`)

Handler-level unit tests for each native MCP server.

| File | Coverage |
|------|----------|
| `gmail/handlers.test.ts` | Gmail tool handlers |
| `drive/handlers.test.ts` | Google Drive tool handlers |
| `calendar/handlers.test.ts` | Calendar tool handlers |
| `web-search/handlers.test.ts` | Brave Search tool handlers |
| `browser/handlers.test.ts` | Playwright browser tool handlers |

---

## Architecture

See [`docs/architecture/ARCHITECTURE.md`](docs/architecture/ARCHITECTURE.md) for the full system design.

Key flows:

- **MCP Proxy**: Agent → Reins (policy check) → Downstream MCP server
- **Approval Queue**: Tool call blocked → human review → decision propagated back to agent
- **Credential Vault**: AES-256-GCM encrypted tokens with automatic OAuth refresh

## Tech Stack

| Layer | Stack |
|-------|-------|
| Frontend | React 18, TypeScript, Vite, TailwindCSS, React Query |
| Backend | Node.js 20, TypeScript, Fastify, Drizzle ORM, PostgreSQL |
| MCP Servers | Node.js, `@modelcontextprotocol/sdk` |
| Testing | Vitest, React Testing Library, jsdom |
| Deployment | Fly.io (agents), Docker (self-hosted) |
