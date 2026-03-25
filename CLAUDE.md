# Reins Development Guide

## Project Overview

Reins is the trust layer for AI agents - an MCP-native proxy gateway providing granular permission control, guided provisioning, credential health monitoring, and programmable spend authorization.

## Project Structure

```
reins/
├── frontend/          # React/TypeScript dashboard
├── backend/           # Node.js/TypeScript MCP proxy & API
├── shared/            # Shared types, schemas, utilities
├── templates/         # Service provisioning templates & policies
├── docs/
│   ├── architecture/  # System architecture, component designs
│   ├── adr/           # Architecture Decision Records
│   ├── branding/      # Brand guidelines, visual assets
│   └── api/           # OpenAPI specs
└── scripts/           # Build, test, deployment scripts
```

## Development Workflow

### Planning First

All non-trivial tasks MUST use plan mode before implementation:

1. Enter plan mode to explore the codebase and design approach
2. Write implementation plan with clear steps
3. Get user approval before writing code
4. Execute plan, updating tasks as you go

### Task Management

Use the task system for all work:

- Create tasks before starting work
- Mark tasks `in_progress` when starting
- Mark tasks `completed` only when fully done (tests pass, no errors)
- Never mark incomplete work as done

## Agent Teams

This project uses Claude Code's experimental agent teams feature for parallel development with specialized agents.

### Enabling Agent Teams

Agent teams are enabled via `.claude/settings.local.json`:

```json
{
  "env": {
    "CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS": "1"
  },
  "teammateMode": "in-process"
}
```

### Spawning the Team

To start work with the full team:

```
Create an agent team with these specialized teammates:

1. **Frontend Agent** - Focus on frontend/ directory. React components, dashboard UI,
   state management. Run `npm test --workspace=frontend` before completing tasks.

2. **Backend Agent** - Focus on backend/ directory. MCP proxy, policy engine, API
   endpoints. Run `npm test --workspace=backend` before completing tasks.

3. **Architecture Agent** - Focus on docs/ and cross-cutting concerns. API contracts,
   ADRs, database schemas, system design decisions.

4. **Security Agent** - Review all changes for security issues. Credential encryption,
   OAuth flows, input validation, OWASP compliance.

5. **Branding Agent** - Focus on docs/branding/ directory. Brand identity, visual design,
   messaging, marketing materials. Use the /branding skill for brand-related tasks.

Use the shared task list to coordinate. Each agent should claim tasks in their domain.
```

### Team Coordination Rules

1. **Task ownership** - Each agent claims tasks in their scope before starting
2. **No file conflicts** - Agents work on separate directories to avoid edit collisions
3. **Blocking tasks** - Use task dependencies when one agent's work blocks another
4. **Testing gates** - Run tests before marking any task complete
5. **Security review** - Security agent reviews PRs touching credentials, auth, or encryption

### When to Use Teams vs Single Agent

**Use agent teams for:**
- Parallel feature development across frontend/backend
- Code reviews (multiple perspectives)
- Large refactoring efforts
- Initial project scaffolding

**Use single agent for:**
- Bug fixes in a single file
- Small, focused changes
- Sequential tasks with tight dependencies

## Specialized Agents

### Frontend Agent

**Scope:** `frontend/` directory

**Responsibilities:**
- React components and hooks
- State management (Zustand/Redux)
- UI/UX implementation
- Dashboard views: agent registry, connection status, activity feed, approval queue, spend overview
- Responsive design and accessibility

**Stack:**
- React 18+ with TypeScript
- Vite for bundling
- TailwindCSS for styling
- React Query for server state
- Vitest + React Testing Library for tests

**Testing requirements:**
- Component tests for all UI components
- Hook tests for custom hooks
- Integration tests for page flows
- Minimum 80% coverage

### Backend Agent

**Scope:** `backend/` directory

**Responsibilities:**
- MCP proxy server implementation
- Policy engine (YAML parsing, tool filtering)
- Credential storage and token refresh
- REST API for dashboard
- WebSocket for real-time updates
- Audit logging
- Native MCP servers (use `/new-mcp-server` skill to scaffold new servers)

**Stack:**
- Node.js 20+ with TypeScript
- Express or Fastify for HTTP
- MCP SDK for protocol handling
- YAML for policy files
- SQLite/PostgreSQL for persistence
- Vitest for tests

**Testing requirements:**
- Unit tests for policy engine
- Unit tests for tool filtering logic
- Integration tests for MCP proxy flow
- API endpoint tests
- Minimum 85% coverage

### Architecture Agent

**Scope:** Project-wide, `docs/architecture/`, `docs/adr/`

**Responsibilities:**
- System design decisions
- API contract definitions
- Database schema design
- Architecture Decision Records (ADRs)
- Cross-cutting concerns (logging, error handling, configuration)
- Performance optimization
- Integration patterns
- Vendor-agnostic technology selection

**Key Documents:**
- `docs/architecture/ARCHITECTURE.md` - System architecture overview
- `docs/adr/ADR-*.md` - Architecture decisions

**Artifacts:**
- OpenAPI specs in `docs/api/`
- ADRs in `docs/adr/`
- Sequence diagrams for key flows
- Data models and schemas

### Security Agent

**Scope:** Project-wide

**Responsibilities:**
- Credential encryption and storage
- OAuth flow security
- Input validation and sanitization
- OWASP compliance review
- Dependency vulnerability scanning
- Security-sensitive code review
- Rate limiting and abuse prevention

**Requirements:**
- All credentials encrypted at rest (AES-256-GCM)
- No secrets in logs or error messages
- CSP headers on frontend
- HTTPS only in production
- Regular dependency audits

### Branding Agent

**Scope:** `docs/branding/` directory, marketing materials

**Responsibilities:**
- Brand identity and visual design system
- Logo, color palette, and typography guidelines
- Voice and tone documentation
- Marketing copy and messaging
- README and documentation styling
- Social media and promotional assets
- Presentation templates

**Artifacts:**
- Brand guidelines in `docs/branding/BRAND_GUIDELINES.md`
- Logo files and visual assets in `docs/branding/assets/`
- Marketing copy templates
- README badges and social images

**Skills:**
- Use `/branding` skill for brand identity work
- Coordinate with Frontend Agent on UI implementation of brand
- Review all user-facing copy for brand consistency

**Deliverables:**
- [ ] Primary logo and variations
- [ ] Color palette with accessibility compliance
- [ ] Typography system
- [ ] Iconography guidelines
- [ ] Voice and tone guide
- [ ] Marketing website copy
- [ ] Social media assets

## Testing Standards

### Running Tests

```bash
# Run all tests
npm test

# Run with coverage
npm run test:coverage

# Run specific agent's tests
npm test --workspace=frontend
npm test --workspace=backend

# Watch mode during development
npm run test:watch
```

### Coverage Requirements

| Component | Minimum Coverage |
|-----------|------------------|
| Backend - Policy Engine | 90% |
| Backend - MCP Proxy | 85% |
| Backend - API | 80% |
| Frontend - Components | 80% |
| Frontend - Hooks | 85% |
| Shared - Utilities | 90% |

### Test Categories

1. **Unit Tests** - Run on every change
   - Fast, isolated, no external dependencies
   - Mock all I/O operations

2. **Integration Tests** - Run before commits
   - Test component interactions
   - Use test databases/fixtures

3. **E2E Tests** - Run in CI
   - Full flow testing
   - Real MCP server connections (sandbox)

### When to Run Tests

- **Before starting work:** Run relevant test suite to ensure clean baseline
- **After each significant change:** Run affected unit tests
- **Before marking task complete:** Run full test suite with coverage
- **Before committing:** All tests must pass

## Code Quality

### Before Committing

1. All tests pass
2. Coverage thresholds met
3. No TypeScript errors
4. Linting passes
5. Security agent review for sensitive changes

### Commit Messages

Follow conventional commits:
```
feat(backend): add policy engine with tool filtering
fix(frontend): resolve approval queue refresh issue
docs(arch): add ADR for credential storage approach
test(backend): add integration tests for MCP proxy
```

## Key Flows to Understand

### MCP Proxy Request Flow

```
1. Agent connects to Reins (MCP client)
2. Reins loads policy YAML for agent
3. Reins fetches tool schema from downstream MCP
4. Policy engine filters tools based on allow/block lists
5. Filtered schema returned to agent
6. Agent calls tool → Reins validates against policy
7. If approval required → queue for human review
8. If allowed → forward to downstream MCP
9. Log everything to audit trail
```

### Policy Evaluation

```yaml
# Policy structure
service: gmail
tools:
  allow: [list_messages, read_message, create_draft]
  block: [send_message, delete_message]
constraints:
  search_messages:
    max_results: 50
approval_required:
  - create_draft
```

## Phase 1 Priorities

1. **P0 - MCP proxy core** - Transparent proxy with tool filtering
2. **P0 - Policy engine** - YAML parsing, allow/block evaluation
3. **P0 - Gmail template** - Draft-only policy with OAuth guide
4. **P0 - Credential storage** - Encrypted token vault
5. **P1 - Basic dashboard** - Connection status, activity log

## Development Philosophy

### No Docker for Development

Development runs entirely on native Node.js without Docker:
- **Fast iteration** - No container rebuilds
- **Simple onboarding** - Just `npm install && npm run dev`
- **Direct debugging** - No container layers
- **SQLite by default** - Zero database setup

Docker is only used for production builds and deployment, not local development.

## Commands Reference

```bash
# Development (no Docker required)
npm run dev              # Start all services in dev mode
npm run dev:backend      # Backend only
npm run dev:frontend     # Frontend only

# Testing
npm test                 # Run all tests
npm run test:coverage    # With coverage report
npm run test:watch       # Watch mode

# Building
npm run build            # Production build
npm run typecheck        # TypeScript validation

# Linting
npm run lint             # Run ESLint
npm run lint:fix         # Auto-fix issues

# Security
npm audit                # Check dependencies
npm run security:scan    # Run security checks
```

## Environment Variables

```bash
# Backend
REINS_PORT=3000
REINS_ENCRYPTION_KEY=<32-byte-hex>
REINS_DB_PATH=./data/reins.db
REINS_LOG_LEVEL=info

# Frontend
VITE_API_URL=http://localhost:3000
```

## Getting Help

- Architecture questions → Architecture agent
- Security concerns → Security agent
- Frontend implementation → Frontend agent
- Backend/proxy logic → Backend agent
- Brand, marketing, visuals → Branding agent
- All significant changes → Plan mode first
