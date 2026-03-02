# ADR-001: Vendor-Agnostic Technology Stack

## Status

Accepted

## Date

2026-03-01

## Context

Reins is a trust layer for AI agents that will be deployed across diverse environments—from individual developer machines to enterprise Kubernetes clusters. We need to choose a technology stack that:

1. Avoids vendor lock-in to specific cloud providers
2. Supports self-hosting without external dependencies
3. Scales from single-node to multi-node deployments
4. Uses well-supported, standard technologies

## Decision

We will adopt the following technology stack:

### Core Runtime: TypeScript on Node.js 20+

**Rationale:**
- Native MCP SDK support (the protocol is TypeScript-first)
- Excellent async I/O for proxy workloads
- Strong type safety with TypeScript
- Large ecosystem for auth libraries, HTTP servers, etc.

**Alternatives rejected:**
- Go: Better raw performance but weaker MCP ecosystem support
- Rust: Maximum performance but steeper learning curve, slower iteration
- Python: Good AI ecosystem but weaker typing and concurrency model

### HTTP Server: Fastify

**Rationale:**
- Best-in-class performance for Node.js
- Built-in validation with JSON Schema
- Plugin architecture for extensibility
- No vendor lock-in—standard HTTP server

### Database: SQLite (default) / PostgreSQL (scaled)

**Rationale:**
- SQLite: Zero dependencies, embedded, perfect for single-node
- PostgreSQL: Standard, widely available, scales horizontally
- Both are open source with no licensing concerns
- Drizzle ORM provides TypeScript-first data access

### Encryption: Node.js crypto with AES-256-GCM

**Rationale:**
- Built into Node.js, no external dependencies
- FIPS-compliant algorithms
- Argon2id for key derivation (memory-hard, GPU-resistant)

### Frontend: React + Vite + TailwindCSS

**Rationale:**
- React: Largest ecosystem, easiest hiring
- Vite: Fast builds, ESM-native
- TailwindCSS: No runtime, fully tree-shaken

### Observability: OpenTelemetry + Pino + prom-client

**Rationale:**
- OpenTelemetry: Vendor-neutral standard for tracing
- Pino: Fast JSON logging
- prom-client: Prometheus format (de facto standard)

## Consequences

### Positive

- Self-hostable with zero external service dependencies
- Deploys anywhere: bare metal, VMs, containers, Kubernetes
- Familiar technologies for most backend engineers
- Clear upgrade path from single-node to multi-node

### Negative

- Node.js has lower raw throughput than Go/Rust (acceptable for proxy workload)
- SQLite requires migration to PostgreSQL for multi-node (planned abstraction)
- TypeScript compilation adds build step (mitigated by fast bundlers)

### Risks

- MCP protocol may evolve; our proxy must adapt
- Node.js LTS lifecycle requires periodic upgrades

## Related Documents

- [Architecture Overview](../architecture/ARCHITECTURE.md)
- [Security Requirements](./ADR-002-credential-encryption.md) (planned)
