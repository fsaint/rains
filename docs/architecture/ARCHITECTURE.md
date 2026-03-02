# Reins Architecture

## Overview

Reins is a vendor-agnostic MCP (Model Context Protocol) proxy gateway that provides the trust layer between AI agents and external services. This document defines the system architecture with explicit focus on avoiding vendor lock-in.

## Architecture Principles

### Vendor Agnosticism

1. **No cloud-specific services** - Use open standards and self-hostable alternatives
2. **Pluggable backends** - Abstract storage, messaging, and external integrations
3. **Container-native** - Deploy anywhere containers run
4. **Standard protocols** - HTTP/REST, WebSocket, OAuth 2.0, OpenID Connect
5. **Open formats** - JSON, YAML, SQLite/PostgreSQL, no proprietary formats

### Design Goals

- **Transparent proxy** - Zero modification to MCP protocol
- **Minimal latency** - Sub-10ms overhead for proxied requests
- **Horizontal scaling** - Stateless proxy nodes with shared state store
- **Offline capable** - Core functionality works without internet
- **Observable** - Built-in metrics, logging, tracing

## System Architecture

```
┌─────────────────────────────────────────────────────────────────────────────┐
│                              AI AGENTS                                       │
│         (Claude, GPT, Local LLMs, Custom Agents)                            │
└─────────────────────────────────────────────────────────────────────────────┘
                                    │
                                    │ MCP Protocol (stdio/HTTP)
                                    ▼
┌─────────────────────────────────────────────────────────────────────────────┐
│                           REINS GATEWAY                                      │
│  ┌─────────────┐  ┌─────────────┐  ┌─────────────┐  ┌─────────────┐        │
│  │   MCP       │  │   Policy    │  │  Approval   │  │  Credential │        │
│  │   Proxy     │  │   Engine    │  │  Queue      │  │  Vault      │        │
│  └─────────────┘  └─────────────┘  └─────────────┘  └─────────────┘        │
│  ┌─────────────┐  ┌─────────────┐  ┌─────────────┐  ┌─────────────┐        │
│  │   Spend     │  │   Audit     │  │   Health    │  │   API       │        │
│  │   Control   │  │   Logger    │  │   Monitor   │  │   Server    │        │
│  └─────────────┘  └─────────────┘  └─────────────┘  └─────────────┘        │
└─────────────────────────────────────────────────────────────────────────────┘
                                    │
                                    │ MCP Protocol (stdio/HTTP/SSE)
                                    ▼
┌─────────────────────────────────────────────────────────────────────────────┐
│                         DOWNSTREAM MCP SERVERS                               │
│     (Gmail, Slack, GitHub, Databases, File Systems, Custom Tools)           │
└─────────────────────────────────────────────────────────────────────────────┘
```

## Technology Stack

### Core Runtime

| Layer | Technology | Rationale |
|-------|------------|-----------|
| **Language** | TypeScript (Node.js 20+) | Type safety, async I/O, MCP SDK support, large ecosystem |
| **Runtime** | Node.js with ESM | Native MCP SDK compatibility, cross-platform |
| **Build** | esbuild / tsup | Fast builds, tree-shaking, single-file output |

**Alternatives considered:**
- Go: Excellent performance but less MCP ecosystem support
- Rust: Maximum performance but steeper learning curve
- Python: Good AI ecosystem but weaker typing and performance

### HTTP Server

| Component | Primary | Alternative |
|-----------|---------|-------------|
| **Framework** | Fastify | Express, Koa, Hono |
| **WebSocket** | ws + @fastify/websocket | Socket.io (heavier) |
| **Validation** | Zod | Joi, AJK, Yup |

**Rationale:** Fastify offers best-in-class performance with TypeScript support, schema validation, and plugin architecture. No vendor lock-in—standard HTTP server.

### Data Storage

| Use Case | Primary | Alternative |
|----------|---------|-------------|
| **Operational DB** | SQLite (libsql) | PostgreSQL |
| **Production Scale** | PostgreSQL | MySQL, CockroachDB |
| **Migrations** | Drizzle ORM | Prisma, Knex, TypeORM |
| **Cache** | In-memory LRU | Redis, Memcached |

**Rationale:**
- SQLite for single-node deployments (zero dependencies, embedded)
- PostgreSQL for multi-node (standard, widely supported)
- Drizzle ORM: TypeScript-first, SQL-like syntax, no code generation

```typescript
// Storage interface - swap implementations freely
interface StorageAdapter {
  // Policies
  getPolicy(agentId: string): Promise<Policy | null>;
  savePolicy(policy: Policy): Promise<void>;

  // Credentials
  getCredential(serviceId: string): Promise<EncryptedCredential | null>;
  saveCredential(cred: EncryptedCredential): Promise<void>;

  // Audit logs
  appendAuditLog(entry: AuditEntry): Promise<void>;
  queryAuditLogs(filter: AuditFilter): Promise<AuditEntry[]>;

  // Approvals
  queueApproval(request: ApprovalRequest): Promise<string>;
  getApproval(id: string): Promise<ApprovalRequest | null>;
  resolveApproval(id: string, decision: Decision): Promise<void>;
}
```

### Credential Storage & Encryption

| Component | Technology | Rationale |
|-----------|------------|-----------|
| **Encryption** | Node.js crypto (AES-256-GCM) | Built-in, no dependencies, FIPS compliant |
| **Key Derivation** | Argon2id | Memory-hard, resistant to GPU attacks |
| **Secret Storage** | Encrypted SQLite/PostgreSQL | Self-contained, portable |

**Alternative integrations (optional):**
- HashiCorp Vault (via API)
- AWS Secrets Manager / GCP Secret Manager (via SDK)
- 1Password CLI
- SOPS for encrypted files

```typescript
// Encryption interface - plug in any backend
interface SecretStore {
  encrypt(plaintext: Buffer, context: string): Promise<EncryptedBlob>;
  decrypt(blob: EncryptedBlob, context: string): Promise<Buffer>;
  rotateKey(oldKey: Buffer, newKey: Buffer): Promise<void>;
}
```

### Authentication & Authorization

| Component | Technology | Rationale |
|-----------|------------|-----------|
| **OAuth 2.0 Client** | oauth4webapi | Minimal, spec-compliant, no dependencies |
| **JWT Validation** | jose | Standards-compliant, maintained |
| **Session** | Stateless JWT or encrypted cookies | No session store needed |

**Supported auth flows:**
- OAuth 2.0 Authorization Code + PKCE
- OAuth 2.0 Client Credentials
- API Keys (for machine-to-machine)
- OpenID Connect (for SSO integration)

### Frontend

| Component | Technology | Rationale |
|-----------|------------|-----------|
| **Framework** | React 18+ | Ecosystem, hiring, component libraries |
| **Build** | Vite | Fast HMR, ESM-native, good defaults |
| **Styling** | TailwindCSS | Utility-first, no runtime, tree-shaken |
| **State** | Zustand + React Query | Minimal boilerplate, server state separation |
| **Routing** | React Router or TanStack Router | Standard, flexible |

**Alternative frontend stacks:**
- Vue 3 + Vite + Pinia
- Svelte + SvelteKit
- Solid.js + Solid Start

### Real-time Communication

| Component | Technology | Rationale |
|-----------|------------|-----------|
| **Client ↔ Dashboard** | WebSocket | Bidirectional, low latency |
| **Event Broadcasting** | In-process EventEmitter | Simple, no external deps |
| **Scaled Deployment** | Redis Pub/Sub | Standard, widely available |

**Protocol:** JSON-RPC 2.0 over WebSocket (matches MCP conventions)

### Observability

| Component | Technology | Rationale |
|-----------|------------|-----------|
| **Logging** | Pino | Fast JSON logging, structured |
| **Metrics** | prom-client | Prometheus format, standard |
| **Tracing** | OpenTelemetry | Vendor-neutral, standard |
| **Health Checks** | Custom /health endpoint | Simple, universal |

**Export targets (all optional):**
- Prometheus + Grafana
- Jaeger / Zipkin
- ELK Stack / Loki
- Datadog, New Relic (via OTLP)

### Containerization (Production Only)

Docker is used **only for production deployment**, not local development.

| Component | Technology | Rationale |
|-----------|------------|-----------|
| **Container** | Docker | Universal standard |
| **Orchestration** | Kubernetes | Production scaling |
| **Base Image** | node:20-alpine | Small, secure |

```dockerfile
# Multi-stage build for minimal image
FROM node:20-alpine AS builder
WORKDIR /app
COPY package*.json ./
RUN npm ci --only=production

FROM node:20-alpine
WORKDIR /app
COPY --from=builder /app/node_modules ./node_modules
COPY dist ./dist
USER node
EXPOSE 3000
CMD ["node", "dist/server.js"]
```

## Component Architecture

### MCP Proxy

The core proxy transparently forwards MCP messages while applying policies.

```typescript
interface MCPProxy {
  // Connection management
  connect(downstream: MCPServerConfig): Promise<MCPConnection>;
  disconnect(connectionId: string): Promise<void>;

  // Message handling
  handleRequest(request: MCPRequest): Promise<MCPResponse>;
  handleNotification(notification: MCPNotification): Promise<void>;

  // Schema manipulation
  filterTools(tools: Tool[], policy: Policy): Tool[];
  filterResources(resources: Resource[], policy: Policy): Resource[];
}
```

**Transport support:**
- stdio (spawn child process)
- HTTP + SSE (remote servers)
- WebSocket (bidirectional)

### Policy Engine

Evaluates YAML policies against incoming requests.

```yaml
# Example policy structure
version: "1.0"
agent: my-agent
services:
  gmail:
    tools:
      allow:
        - gmail_list_messages
        - gmail_read_message
        - gmail_create_draft
      block:
        - gmail_send_message
        - gmail_delete_message
    constraints:
      gmail_search:
        max_results: 100
        query_prefix: "in:inbox"
    approval_required:
      - gmail_create_draft

  filesystem:
    tools:
      allow:
        - read_file
        - list_directory
      block:
        - write_file
        - delete_file
    constraints:
      read_file:
        allowed_paths:
          - "/home/user/documents/**"
          - "!/home/user/documents/.secrets/**"
```

```typescript
interface PolicyEngine {
  loadPolicy(yaml: string): Policy;
  validatePolicy(policy: Policy): ValidationResult;

  evaluateTool(tool: string, policy: Policy): ToolDecision;
  evaluateCall(call: ToolCall, policy: Policy): CallDecision;
  applyConstraints(call: ToolCall, constraints: Constraints): ToolCall;
}

type ToolDecision =
  | { action: 'allow' }
  | { action: 'block'; reason: string }
  | { action: 'require_approval'; approvers: string[] };
```

### Approval Queue

Human-in-the-loop approval for sensitive operations.

```typescript
interface ApprovalQueue {
  submit(request: ApprovalRequest): Promise<string>;

  // For dashboard
  listPending(filter?: ApprovalFilter): Promise<ApprovalRequest[]>;
  approve(id: string, approver: string, comment?: string): Promise<void>;
  reject(id: string, approver: string, reason: string): Promise<void>;

  // For proxy (blocking wait with timeout)
  waitForDecision(id: string, timeout: number): Promise<Decision>;
}

interface ApprovalRequest {
  id: string;
  agentId: string;
  tool: string;
  arguments: Record<string, unknown>;
  context: string;
  requestedAt: Date;
  expiresAt: Date;
}
```

### Credential Vault

Secure storage and automatic refresh for OAuth tokens.

```typescript
interface CredentialVault {
  // Storage
  store(serviceId: string, credential: Credential): Promise<void>;
  retrieve(serviceId: string): Promise<Credential | null>;
  delete(serviceId: string): Promise<void>;

  // Health
  checkHealth(serviceId: string): Promise<HealthStatus>;
  refreshIfNeeded(serviceId: string): Promise<Credential>;

  // OAuth flow support
  initiateOAuth(config: OAuthConfig): Promise<{ authUrl: string; state: string }>;
  completeOAuth(code: string, state: string): Promise<Credential>;
}

interface HealthStatus {
  valid: boolean;
  expiresAt?: Date;
  lastChecked: Date;
  error?: string;
}
```

### Spend Control

Budget enforcement for metered APIs.

```typescript
interface SpendController {
  // Budget management
  setBudget(agentId: string, budget: Budget): Promise<void>;
  getBudget(agentId: string): Promise<Budget>;

  // Usage tracking
  recordUsage(agentId: string, cost: Cost): Promise<void>;
  getUsage(agentId: string, period: Period): Promise<Usage>;

  // Authorization
  authorizeSpend(agentId: string, estimatedCost: Cost): Promise<SpendDecision>;
}

interface Budget {
  daily?: number;
  weekly?: number;
  monthly?: number;
  currency: string;
  alertThresholds: number[]; // e.g., [0.5, 0.8, 0.95]
}
```

### Audit Logger

Immutable audit trail for compliance.

```typescript
interface AuditLogger {
  log(entry: AuditEntry): Promise<void>;
  query(filter: AuditFilter): Promise<AuditEntry[]>;
  export(format: 'json' | 'csv', filter: AuditFilter): Promise<ReadableStream>;
}

interface AuditEntry {
  timestamp: Date;
  eventType: 'tool_call' | 'approval' | 'policy_change' | 'auth';
  agentId: string;
  tool?: string;
  arguments?: Record<string, unknown>;
  result?: 'success' | 'blocked' | 'error';
  duration?: number;
  metadata?: Record<string, unknown>;
}
```

## Data Models

### Core Entities

```typescript
// Agent registration
interface Agent {
  id: string;
  name: string;
  description?: string;
  policyId: string;
  credentials: string[]; // References to credential IDs
  status: 'active' | 'suspended' | 'pending';
  createdAt: Date;
  updatedAt: Date;
}

// Policy definition
interface Policy {
  id: string;
  version: string;
  name: string;
  yaml: string; // Raw YAML for editing
  parsed: ParsedPolicy; // Validated structure
  createdAt: Date;
  updatedAt: Date;
}

// Encrypted credential
interface StoredCredential {
  id: string;
  serviceId: string;
  type: 'oauth2' | 'api_key' | 'basic';
  encryptedData: Buffer;
  iv: Buffer;
  authTag: Buffer;
  expiresAt?: Date;
  createdAt: Date;
  updatedAt: Date;
}

// Downstream MCP server
interface MCPServer {
  id: string;
  name: string;
  transport: 'stdio' | 'http' | 'websocket';
  config: StdioConfig | HttpConfig | WebSocketConfig;
  healthStatus: 'healthy' | 'degraded' | 'down';
  lastHealthCheck: Date;
}
```

### Database Schema (SQLite/PostgreSQL)

```sql
-- Agents
CREATE TABLE agents (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  description TEXT,
  policy_id TEXT REFERENCES policies(id),
  status TEXT DEFAULT 'pending',
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- Policies
CREATE TABLE policies (
  id TEXT PRIMARY KEY,
  version TEXT NOT NULL,
  name TEXT NOT NULL,
  yaml TEXT NOT NULL,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- Credentials (encrypted)
CREATE TABLE credentials (
  id TEXT PRIMARY KEY,
  service_id TEXT NOT NULL,
  type TEXT NOT NULL,
  encrypted_data BLOB NOT NULL,
  iv BLOB NOT NULL,
  auth_tag BLOB NOT NULL,
  expires_at TIMESTAMP,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- Audit log (append-only)
CREATE TABLE audit_log (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  timestamp TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  event_type TEXT NOT NULL,
  agent_id TEXT,
  tool TEXT,
  arguments_json TEXT,
  result TEXT,
  duration_ms INTEGER,
  metadata_json TEXT
);

CREATE INDEX idx_audit_timestamp ON audit_log(timestamp);
CREATE INDEX idx_audit_agent ON audit_log(agent_id);

-- Approval queue
CREATE TABLE approvals (
  id TEXT PRIMARY KEY,
  agent_id TEXT NOT NULL,
  tool TEXT NOT NULL,
  arguments_json TEXT,
  context TEXT,
  status TEXT DEFAULT 'pending',
  requested_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  expires_at TIMESTAMP NOT NULL,
  resolved_at TIMESTAMP,
  resolved_by TEXT,
  resolution_comment TEXT
);

-- Spend tracking
CREATE TABLE spend_records (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  agent_id TEXT NOT NULL,
  service_id TEXT NOT NULL,
  amount DECIMAL(10, 6) NOT NULL,
  currency TEXT DEFAULT 'USD',
  recorded_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX idx_spend_agent_date ON spend_records(agent_id, recorded_at);
```

## API Design

### REST API (Dashboard)

```yaml
openapi: 3.0.3
info:
  title: Reins API
  version: 1.0.0

paths:
  # Agents
  /api/agents:
    get:
      summary: List agents
    post:
      summary: Register agent

  /api/agents/{id}:
    get:
      summary: Get agent details
    patch:
      summary: Update agent
    delete:
      summary: Remove agent

  # Policies
  /api/policies:
    get:
      summary: List policies
    post:
      summary: Create policy

  /api/policies/{id}:
    get:
      summary: Get policy
    put:
      summary: Update policy
    delete:
      summary: Delete policy

  /api/policies/{id}/validate:
    post:
      summary: Validate policy YAML

  # Credentials
  /api/credentials:
    get:
      summary: List credentials (metadata only)
    post:
      summary: Store credential

  /api/credentials/{id}/health:
    get:
      summary: Check credential health

  /api/credentials/{id}/refresh:
    post:
      summary: Force refresh token

  # OAuth flows
  /api/oauth/{service}/authorize:
    get:
      summary: Start OAuth flow

  /api/oauth/callback:
    get:
      summary: OAuth callback handler

  # Approvals
  /api/approvals:
    get:
      summary: List pending approvals

  /api/approvals/{id}/approve:
    post:
      summary: Approve request

  /api/approvals/{id}/reject:
    post:
      summary: Reject request

  # Audit
  /api/audit:
    get:
      summary: Query audit logs

  /api/audit/export:
    get:
      summary: Export audit logs

  # Health & Metrics
  /health:
    get:
      summary: Health check

  /metrics:
    get:
      summary: Prometheus metrics
```

### WebSocket API (Real-time Updates)

```typescript
// Client → Server
type ClientMessage =
  | { type: 'subscribe'; channels: string[] }
  | { type: 'unsubscribe'; channels: string[] };

// Server → Client
type ServerMessage =
  | { type: 'approval_request'; data: ApprovalRequest }
  | { type: 'approval_resolved'; data: { id: string; decision: Decision } }
  | { type: 'agent_status'; data: { agentId: string; status: string } }
  | { type: 'credential_health'; data: { serviceId: string; health: HealthStatus } }
  | { type: 'spend_alert'; data: { agentId: string; usage: number; budget: number } };
```

## Deployment Architectures

### Single Node (Development / Small Teams)

```
┌─────────────────────────────────────────┐
│           Single Container              │
│  ┌─────────────────────────────────┐   │
│  │     Reins Gateway + Dashboard    │   │
│  │     SQLite Database (embedded)   │   │
│  └─────────────────────────────────┘   │
└─────────────────────────────────────────┘
```

**Requirements:**
- 1 CPU, 512MB RAM
- 1GB disk for SQLite
- No external dependencies

### Multi-Node (Production)

```
                    ┌─────────────┐
                    │   Load      │
                    │   Balancer  │
                    └──────┬──────┘
                           │
         ┌─────────────────┼─────────────────┐
         │                 │                 │
    ┌────▼────┐       ┌────▼────┐       ┌────▼────┐
    │  Reins  │       │  Reins  │       │  Reins  │
    │  Node 1 │       │  Node 2 │       │  Node 3 │
    └────┬────┘       └────┬────┘       └────┬────┘
         │                 │                 │
         └────────────┬────┴─────────────────┘
                      │
              ┌───────▼───────┐
              │  PostgreSQL   │
              │  (Primary)    │
              └───────────────┘
```

**Requirements:**
- 2+ CPU, 1GB RAM per node
- PostgreSQL 14+
- Optional: Redis for pub/sub

### Kubernetes

```yaml
# Simplified k8s deployment
apiVersion: apps/v1
kind: Deployment
metadata:
  name: reins
spec:
  replicas: 3
  selector:
    matchLabels:
      app: reins
  template:
    spec:
      containers:
      - name: reins
        image: reins:latest
        ports:
        - containerPort: 3000
        env:
        - name: DATABASE_URL
          valueFrom:
            secretKeyRef:
              name: reins-secrets
              key: database-url
        - name: ENCRYPTION_KEY
          valueFrom:
            secretKeyRef:
              name: reins-secrets
              key: encryption-key
        livenessProbe:
          httpGet:
            path: /health
            port: 3000
        readinessProbe:
          httpGet:
            path: /health
            port: 3000
```

## Security Architecture

### Defense in Depth

```
┌─────────────────────────────────────────────────────────────────┐
│ Layer 1: Network                                                │
│   - TLS 1.3 everywhere                                          │
│   - Network policies (k8s) or firewall rules                    │
│   - Rate limiting at load balancer                              │
├─────────────────────────────────────────────────────────────────┤
│ Layer 2: Authentication                                         │
│   - JWT/session validation on every request                     │
│   - API key rotation support                                    │
│   - OAuth 2.0 with PKCE for user flows                         │
├─────────────────────────────────────────────────────────────────┤
│ Layer 3: Authorization                                          │
│   - Policy engine validates every tool call                     │
│   - RBAC for dashboard access                                   │
│   - Principle of least privilege                                │
├─────────────────────────────────────────────────────────────────┤
│ Layer 4: Data Protection                                        │
│   - AES-256-GCM encryption for credentials                      │
│   - Encryption keys separate from data                          │
│   - No secrets in logs                                          │
├─────────────────────────────────────────────────────────────────┤
│ Layer 5: Audit & Detection                                      │
│   - Immutable audit log                                         │
│   - Anomaly detection (optional)                                │
│   - Alerting on policy violations                               │
└─────────────────────────────────────────────────────────────────┘
```

### Credential Encryption Flow

```
┌──────────────┐     ┌──────────────┐     ┌──────────────┐
│   Plaintext  │────▶│   Argon2id   │────▶│   AES-256    │
│   Secret     │     │   Key Deriv  │     │   GCM        │
└──────────────┘     └──────────────┘     └──────┬───────┘
                                                  │
                                                  ▼
                                          ┌──────────────┐
                                          │  Encrypted   │
                                          │  Blob + IV   │
                                          │  + AuthTag   │
                                          └──────────────┘
                                                  │
                                                  ▼
                                          ┌──────────────┐
                                          │   Database   │
                                          └──────────────┘
```

## Extension Points

### Plugin Architecture

```typescript
// Plugin interface for custom integrations
interface ReinsPlugin {
  name: string;
  version: string;

  // Lifecycle hooks
  onLoad?(context: PluginContext): Promise<void>;
  onUnload?(): Promise<void>;

  // Request hooks
  beforeToolCall?(call: ToolCall): Promise<ToolCall | null>;
  afterToolCall?(call: ToolCall, result: ToolResult): Promise<void>;

  // Custom policy evaluators
  policyEvaluators?: Record<string, PolicyEvaluator>;

  // Custom credential providers
  credentialProviders?: Record<string, CredentialProvider>;
}

// Register plugins
reins.registerPlugin(myCustomPlugin);
```

### Webhook Integration

```typescript
interface WebhookConfig {
  url: string;
  secret: string;
  events: WebhookEvent[];
  retryPolicy: RetryPolicy;
}

type WebhookEvent =
  | 'approval.requested'
  | 'approval.resolved'
  | 'policy.violation'
  | 'credential.expiring'
  | 'spend.threshold';
```

## Development & Testing

### Local Development Stack

**No Docker Required for Development**

The development environment runs entirely on native Node.js without Docker. This ensures:
- Fast iteration cycles (no container rebuild)
- Simple onboarding (just Node.js)
- Direct debugging without container layers
- Works on any OS with Node.js support

```bash
# Required (development)
- Node.js 20+
- npm 10+

# NOT required for development
- Docker (only for production builds/deployment)
- PostgreSQL (SQLite used by default)
- Redis (in-memory for single-node dev)
```

**Development runs with:**
- SQLite (embedded, zero config)
- In-memory caching
- File-based credential storage (encrypted)
- Local MCP server spawning via stdio

### Getting Started (Development)

```bash
# Clone and install
git clone https://github.com/your-org/reins.git
cd reins
npm install

# Start development servers
npm run dev

# Run tests
npm test

# That's it - no Docker, no database setup, no external services
```

### Test Strategy

| Test Type | Tools | Coverage Target |
|-----------|-------|-----------------|
| Unit | Vitest | 85%+ |
| Integration | Vitest + Supertest | Key flows |
| E2E | Playwright | Critical paths |
| Load | k6, autocannon | Performance baselines |

### CI/CD Pipeline

```yaml
# Vendor-agnostic CI (works on GitHub Actions, GitLab CI, etc.)
stages:
  - lint
  - test
  - build
  - security
  - publish

lint:
  script:
    - npm run lint
    - npm run typecheck

test:
  script:
    - npm test -- --coverage
  coverage: /All files.*\|.*(\d+\.\d+)/

build:
  script:
    - npm run build
    - docker build -t reins:${CI_COMMIT_SHA} .

security:
  script:
    - npm audit --production
    - trivy image reins:${CI_COMMIT_SHA}

publish:
  script:
    - docker push reins:${CI_COMMIT_SHA}
  only:
    - main
```

## Migration Paths

### From Existing Solutions

| Source | Migration Strategy |
|--------|---------------------|
| Direct MCP connections | Point agents to Reins, configure pass-through policy |
| Custom auth wrappers | Import credentials to vault, map to policies |
| Manual approval workflows | Configure approval_required in policies |

### Future Compatibility

- **MCP protocol updates**: Proxy design allows version negotiation
- **New downstream services**: Add service templates without core changes
- **Scale requirements**: Swap SQLite → PostgreSQL, add Redis

## Appendix

### Configuration Reference

```typescript
interface ReinsConfig {
  // Server
  port: number;
  host: string;

  // Database
  database: {
    type: 'sqlite' | 'postgresql';
    url: string;
    poolSize?: number;
  };

  // Encryption
  encryption: {
    key: string; // 32-byte hex or env reference
    algorithm: 'aes-256-gcm';
  };

  // Logging
  logging: {
    level: 'debug' | 'info' | 'warn' | 'error';
    format: 'json' | 'pretty';
  };

  // Observability
  metrics: {
    enabled: boolean;
    path: string;
  };

  tracing: {
    enabled: boolean;
    exporter: 'otlp' | 'jaeger' | 'zipkin';
    endpoint?: string;
  };
}
```

### Environment Variables

```bash
# Required
REINS_ENCRYPTION_KEY=<32-byte-hex>

# Server
REINS_PORT=3000
REINS_HOST=0.0.0.0

# Database
REINS_DB_TYPE=sqlite
REINS_DB_URL=./data/reins.db
# Or for PostgreSQL:
# REINS_DB_TYPE=postgresql
# REINS_DB_URL=postgresql://user:pass@host:5432/reins

# Logging
REINS_LOG_LEVEL=info
REINS_LOG_FORMAT=json

# Metrics
REINS_METRICS_ENABLED=true
REINS_METRICS_PATH=/metrics

# Tracing (optional)
REINS_TRACING_ENABLED=false
REINS_TRACING_EXPORTER=otlp
REINS_TRACING_ENDPOINT=http://jaeger:4318
```
