# LANGUAGE.md

Canonical terminology for the Reins / AgentHelm codebase.

When writing code, docs, or prompts: use these exact terms. Do not substitute synonyms.
Warnings are marked ⚠️ where drift is common.

---

## Core Entities

### Agent
An AI system (Claude, GPT, custom LLM) that connects to Reins via MCP.
- ✅ "the agent connects", "agent policy", "agent credentials"
- ⚠️ Not "bot", "model", "AI", or "client" — those mean different things

### Deployment
A running instance of an agent on a provider (Fly.io, Docker).
- ✅ "create a deployment", "deployment status", "deploymentId"
- ⚠️ Not "instance", "container", "app", or "machine" — those are provider-level concepts

### Provider
The deployment infrastructure backend (Fly.io or Docker).
- ✅ "deployment provider", "Fly provider", "Docker provider"
- ⚠️ Not "service provider" — Provider is always infrastructure, never an external API

### Policy
A YAML configuration file that defines what an agent is allowed to do.
- ✅ "evaluate a policy", "assign a policy", "policy YAML"
- ⚠️ Not "rules", "config", "permissions file", or "access control list"

### Permission
The evaluated result of applying a Policy to a specific tool call.
- ✅ "resolved permission", "effective permission"
- ⚠️ Not interchangeable with Policy — Policy is the definition, Permission is the result

### Tool Call
An agent's request to execute a tool. The unit of work that flows through the policy engine.
- ✅ "tool call", "incoming tool call", "tool call payload"
- ⚠️ Not "tool invocation", "tool execution", "tool request" — use "tool call" for the request

### Tool Execution
Reins forwarding an allowed tool call to a downstream MCP server.
- ✅ "tool execution", "execute the tool call"
- ⚠️ Not "tool call" — tool call is the request, tool execution is Reins running it

### Tool Decision
The output of policy evaluation for a tool call: `allow`, `block`, or `require_approval`.
- ✅ "policy returns a tool decision", "decision: allow"
- ⚠️ Not "result", "outcome", or "verdict"

### Service
An external API or system category (Gmail, Slack, GitHub, Postgres).
- ✅ "the Gmail service", "service policy", "serviceName"
- ⚠️ "Service" is a *category*, not an instance. A user's Gmail credentials are a Credential, not a Service.

### Credential
Authentication material for a specific user's access to a Service.
- ✅ "OAuth2 credential", "API key credential", "credential vault"
- ⚠️ Not "secret", "token", or "key" generically — those are components of a Credential

### Approval Request
A queued tool call that requires human review before execution.
- ✅ "approval request", "pending approval", "resolve an approval"
- ⚠️ Not "task", "job", or "review item"

### Deferred Job
An approved tool call queued for async execution. Created when an Approval Request is approved.
- ✅ "deferred job", "DeferredJobResult"
- ⚠️ Not "async job", "queued task", or "background job"

### Audit Entry
An immutable log record of every significant event in the system.
- ✅ "audit entry", "audit trail", "audit log"
- ⚠️ Not "log", "event", or "record" — those are too generic

### Budget
A spend limit (daily/weekly/monthly) assigned to an agent.
- ✅ "budget enforcement", "budget threshold", "spend against budget"
- ⚠️ Not "limit", "cap", or "quota"

### Spend Record
A single cost tracking entry logged when a tool execution incurs cost.
- ✅ "spend record", "log a spend record"
- ⚠️ Not "usage record", "billing entry", or "cost log"

---

## MCP Architecture

### MCP Gateway
The Reins system as a whole, acting as a transparent proxy between agents and downstream MCP servers.
- ✅ "the MCP gateway", "gateway layer"
- ⚠️ Not "MCP proxy" when referring to the whole system — use "gateway" for the system, "proxy" for the request path behavior

### Downstream MCP Server
An external MCP server that Reins proxies tool calls to (Gmail, Slack, GitHub, etc.).
- ✅ "downstream MCP server", "downstream server"
- ⚠️ Not "external server", "remote server", or "service server"

### Native MCP Server
An MCP server built into Reins itself (Gmail, Drive, Calendar, Web Search, Browser).
- ✅ "native MCP server", "built-in server"
- ⚠️ Not "internal server", "local server", or "embedded server"

### Transport
The protocol used to communicate with an MCP server: `stdio`, `http`, or `websocket`.
- ✅ "stdio transport", "configure the transport"
- ⚠️ Not "connection type", "protocol", or "channel"

### Connection
An active session between Reins and an MCP server via a Transport.
- ✅ "open a connection", "connection status", "AgentConnection"
- ⚠️ Transport is the mechanism; Connection is the active session

---

## Flows & Actions

### Provision
To create and configure a new Agent + Deployment on a Provider.
- ✅ "provision an agent", "provisioning flow"
- ⚠️ Not "deploy" (deploy = start a provisioned deployment), "create", or "spin up"

### Deploy
To start a provisioned Deployment on a Provider.
- ✅ "deploy the agent", "deployment status: running"
- ⚠️ Not "provision" — provisioning sets it up, deploying runs it

### Evaluate (a policy)
To run a tool call through the policy engine and return a Tool Decision.
- ✅ "evaluate the policy", "policy evaluation"
- ⚠️ Not "check", "validate", or "authorize"

### Approve / Reject
Human actions on an Approval Request.
- ✅ "approve the request", "reject with comment"
- ⚠️ Not "accept/decline", "allow/deny", or "pass/fail"

### Claim (an agent)
The self-registration flow where an agent uses a claim code to register itself with Reins.
- ✅ "claim code", "agent claims itself", "claim flow"
- ⚠️ Not "register", "connect", or "auth" — those describe different steps

---

## Status Values

Use these exact strings in code and docs:

| Entity | Status values |
|--------|--------------|
| Agent | `active` \| `suspended` \| `pending` |
| Deployment | `pending` \| `starting` \| `running` \| `stopped` \| `error` |
| Approval Request | `pending` \| `approved` \| `rejected` \| `expired` |
| Tool Decision | `allow` \| `block` \| `require_approval` |
| Credential Health | `valid` \| `expired` \| `invalid` \| `unknown` |
| MCP Server Health | `healthy` \| `degraded` \| `down` \| `unknown` |

---

## Identifiers

| Identifier | What it identifies |
|------------|-------------------|
| `agentId` | An Agent record |
| `deploymentId` | A running Deployment |
| `policyId` | A Policy assigned to an Agent |
| `serviceId` | A specific Credential instance for a Service |
| `credentialId` | A Credential record |
| `approvalId` | An Approval Request |
| `claimCode` | Bootstrap token for agent self-registration |

---

## What Reins Is Not

Do not describe Reins using these terms:
- ❌ "AI platform" — it's an MCP gateway with policy enforcement
- ❌ "agent framework" — agents run independently, Reins governs them
- ❌ "middleware" — too vague
- ❌ "proxy" alone — always qualify: "MCP proxy layer" or use "gateway"
