# CONTEXT.md

Business and product domain context for AgentHelm / Reins.

This file covers the *what* and *why* — who uses this, what problem it solves, and how the product works. For technical terminology, see `LANGUAGE.md`.

---

## What AgentHelm Is

**AgentHelm** is a Telegram-native platform that lets users deploy personal AI agents that autonomously manage email, calendar, and other tools — with built-in permission control, approval workflows, and audit logs.

The core problem: users want AI agents that act on their behalf, but can't trust them with unlimited access. AgentHelm is the trust layer between agents and the services they operate.

**One-liner:** "Give your AI agents capabilities, not keys to the kingdom."

---

## Naming

| Name | What it refers to |
|------|------------------|
| **AgentHelm** | The product. User-facing brand, domain (agenthelm.ai), marketing. |
| **Reins** | The codebase. Internal reference, GitHub repo, package names, env vars. |

Post-rebrand (Apr 25, 2026): all user-facing copy says AgentHelm. Internal config/code may still say `reins-*`. These are the same product.

---

## The User

**Who:** Founders, operators, and builders who live in Telegram. They have specific, repetitive tasks they want an AI to handle autonomously (email triage, calendar management, issue filing).

**What they want:**
- An agent that acts — not one that asks permission for every step
- Control without babysitting — they want to set rules once and trust the system
- To stay in Telegram — not open a new dashboard to interact with their agent

**What they don't want:**
- An agent that accidentally sends email or deletes data
- Black-box behavior with no audit trail
- Complex setup that takes more than 5 minutes

---

## User Personas

### Beta Applicant
A qualified user in the onboarding pipeline. Has submitted the questionnaire, been approved by Felipe, and is going through the Telegram onboarding flow. Requirements: uses Telegram daily, has a specific use case, has at least one target service (Gmail, Calendar, etc.).

### Agent Owner
A fully onboarded user with an active account on agenthelm.ai. Owns one or more agents. Approves sensitive actions, edits agent SOUL, manages credentials and policies via the web dashboard.

### Special Agent Helm (`@SpecialAgentHelm`)
The onboarding Telegram bot. Runs qualification, guides users through the full setup flow. Terse, competent, dry. Not a chatbot — an agent. Owns the `applicants` table in the onboarding bot DB.

### AgentHelm Notify (`@AgentHelmNotify`)
A lightweight notification bot embedded in the AgentHelm backend. Proactively alerts users: credential expiry, agent going offline, reauth required. Silent unless there's something to say.

---

## Product Flow

### 1. Acquisition
User finds AgentHelm (Reddit, LinkedIn, word of mouth) → fills Tally.so questionnaire → Felipe reviews → approved applicants receive invite code.

### 2. Onboarding (via `@SpecialAgentHelm`)
State machine: `qualification` → `pending_approval` → `gmail_oauth` → `minimax_key` → `botfather` → `notify_bot` → `provisioning` → `validating` → `password_setup` → `done`.

By the end: user has a live Telegram bot (their personal agent), a connected Gmail account, and an AgentHelm dashboard account.

### 3. Daily Use
User sends a message to their agent in Telegram → agent decides what to do → calls tools through the Reins proxy gateway → policy engine allows/blocks/queues → if queued, user approves in dashboard → result returns to Telegram.

### 4. Control (Dashboard)
User manages their agent at agenthelm.ai: view activity, approve queued actions, edit the agent's SOUL, check credential health, configure Telegram groups.

---

## Key Product Concepts

### SOUL
The agent's system prompt and persona. A markdown file editable in the dashboard. Injected at agent startup. This is how users define their agent's personality, priorities, and behavior defaults.

### Policy (YAML)
What the agent is and isn't allowed to do. Defines allowed tools, blocked tools, tools requiring approval, and per-tool parameter constraints. Written in YAML, editable via dashboard.

### Approval Queue
When a tool call is flagged `require_approval`, it lands here. The agent pauses. The user reviews in the dashboard and approves or rejects. If approved, the tool executes and the agent continues.

### Credential Vault
Encrypted storage for OAuth tokens (Gmail, Google Calendar, etc.) and API keys. Auto-refreshes tokens before expiry. Users re-authenticate from the dashboard when refresh fails.

### Telegram Group Mode
An agent can be added to a Telegram supergroup. The owner must approve this and can configure per-topic instructions (for forum-style groups). The agent can be set to respond to all messages or only @mentions.

### Topic Instruction
A per-topic system prompt override when the agent is in a Telegram forum group. E.g., in `#support`, respond formally; in `#dev`, be technical and brief. Stored per agent per topic.

---

## Runtimes

| Runtime | Description | Cost/mo | Default? |
|---------|-------------|---------|---------|
| **Hermes** | Lightweight agent runtime. | ~$7–10 | ✅ Beta default |
| **OpenClaw** | Heavier runtime, more capable. Claude + advanced tool use. | ~$15–20 | No |

Beta users run Hermes + MiniMax M2.7 by default. This keeps costs manageable (~$7–10/user/mo for infrastructure).

---

## LLM Providers (Beta)

| Provider | Model | Default? |
|---------|-------|---------|
| **MiniMax** | MiniMax-M2.7 | ✅ Beta default |
| **OpenAI** | GPT-4o, etc. | Optional |
| **Anthropic** | Claude | Optional |

MiniMax is the default for beta because it's the cheapest per token. Users supply their own API keys.

---

## Infrastructure

Agents run on **Fly.io** (Fly machines). Each agent is a separate Fly app. Provisioning = creating and starting a Fly machine with the agent's runtime + config.

Docker is also supported for self-hosted deployments, but not documented for beta users.

---

## Primary Integrations (Beta)

| Service | What agents can do |
|---------|-------------------|
| **Gmail** | List/read/search emails, create drafts. Send is not enabled in beta. |
| **Google Calendar** | List events, create events. |
| **GitHub** | Create issues, read repos. |
| **Telegram** | Primary interface. All user interaction is here. |

---

## Beta Program

- **Cohort size:** 20 initial users, scale to 50 if Day-7 retention ≥ 40%
- **Invite codes:** Single-use, hard cap 50 total
- **Time to value:** Target < 5 minutes from invite to first agent message
- **Day-7 Retention:** % of users who sent ≥1 agent message in week 2. Target: >40%
- **Acquisition:** Reddit (`r/ClaudeAI`, `r/AIAssistants`), LinkedIn, direct outreach

---

## What AgentHelm Is Not

- ❌ Not an LLM — it doesn't run inference, it governs agents that do
- ❌ Not a chatbot platform — agents are autonomous and act on behalf of users, not just chat
- ❌ Not a no-code tool builder — users define behavior via SOUL and Policy YAML, not drag-and-drop
- ❌ Not an enterprise product (yet) — single-user, single-agent accounts in beta; team workspaces are future scope
- ❌ Not open source (yet) — Reins codebase is private; Hermes runtime governance is TBD
