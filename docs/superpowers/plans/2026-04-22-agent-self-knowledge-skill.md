# Agent Self-Knowledge Skill Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Bundle a Reins knowledge reference into both the OpenClaw and Hermes Docker images so deployed agents can answer questions about best practices, configuration, feedback submission, and MCP extension.

**Architecture:** OpenClaw supports on-demand skill files at `/app/skills/<name>/SKILL.md` — we COPY a comprehensive `reins/SKILL.md` into the image at build time and OpenClaw picks it up automatically. Hermes has no skill system, so a concise knowledge doc is COPYed into the image and appended to `SOUL.md` in the entrypoint so it's always in context. The two versions share the same topics; OpenClaw's is the full reference (no context cost since it's on-demand), Hermes gets a lean summary.

**Tech Stack:** Markdown (skill content), Bash (entrypoint), Docker (image bundling)

---

### Task 1: Create the OpenClaw skill file

**Files:**
- Create: `docker/skills/reins/SKILL.md`

- [ ] **Step 1: Create the file**

Create `docker/skills/reins/SKILL.md` with this exact content:

```markdown
---
name: reins-knowledge
description: Use when asked about Reins platform best practices, agent configuration, how to submit feedback or bug reports, or how to extend agent capabilities with MCP servers. Also use when a user asks "how do I..." about anything related to Reins.
---

# Reins Platform Knowledge

Reins is the trust layer for AI agents. It acts as an MCP-native proxy between your agent and external services (Gmail, Google Drive, GitHub, Linear, browser, and more), enforcing permission policies, routing tool approvals to humans, and managing credentials securely.

Your agent runs inside a Reins-managed container. The Reins dashboard (accessible to your owner) controls what you can do, which services you can access, and who can approve your tool calls.

---

## Submitting Feedback, Bug Reports & Feature Requests

You have a built-in tool for this: `reins_submit_feedback`. Use it proactively when you notice something broken, confusing, or worth improving — you don't need to wait for a user to ask.

**Tool parameters:**

| Parameter | Type | Required | Description |
|---|---|---|---|
| `type` | `bug` \| `feature_request` \| `general_feedback` | yes | Kind of report |
| `priority` | `low` \| `medium` \| `high` | yes | How urgent |
| `title` | string | yes | Short summary (one line) |
| `description` | string | yes | Full explanation |
| `steps_to_reproduce` | string | no | Step-by-step reproduction (bugs only) |

For `bug` reports, Reins automatically captures the last 400 lines of your container logs and attaches them to the ticket. You do not need to include log content yourself.

**Examples:**

Bug report:
```json
{
  "type": "bug",
  "priority": "high",
  "title": "Browser fails to navigate to HTTPS sites",
  "description": "Attempting to navigate to any HTTPS URL results in a connection refused error. HTTP sites work fine.",
  "steps_to_reproduce": "1. Call browser_navigate with an HTTPS URL\n2. Observe connection refused error\n3. Retry with HTTP — works correctly"
}
```

Feature request:
```json
{
  "type": "feature_request",
  "priority": "medium",
  "title": "Add Slack integration as an MCP server",
  "description": "It would be useful to send messages and read channels via Slack. Currently there is no Slack server in the registry."
}
```

General feedback:
```json
{
  "type": "general_feedback",
  "priority": "low",
  "title": "Approval notifications could include more context",
  "description": "When I request approval for a Gmail send, the notification to the user does not show the email subject or recipient. Adding that context would help users make faster decisions."
}
```

The admin team receives an email notification for every submission.

---

## Adding Functionality via MCP

MCP (Model Context Protocol) is how external tools and services connect to your agent. Everything you can do beyond conversation — browsing the web, reading email, writing to GitHub — comes through an MCP server.

### Built-in Reins MCP servers

The following servers are available and can be enabled from the Reins dashboard without any additional setup:

| Server | What it does |
|---|---|
| Gmail | Read, search, draft, and send email |
| Google Drive | Read and write files |
| Google Calendar | Read and create calendar events |
| GitHub | Repos, issues, PRs, code search |
| Linear | Issues, projects, cycles |
| Notion | Pages and databases |
| Outlook Mail | Microsoft email |
| Outlook Calendar | Microsoft calendar |
| Browser | Headless Chromium — navigate, screenshot, click, type |
| Web Search | Search the web |
| Zendesk | Support tickets |

Each server requires OAuth credentials set up by your owner in the Reins dashboard under **Services**.

### Adding a custom MCP server

1. Your owner opens the Reins dashboard → **Agent → MCP Servers**
2. They add a server with a name, URL or command, and transport type (`http` or `stdio`)
3. The agent is redeployed for the change to take effect
4. The new server's tools appear automatically in your tool list

Suggest specific MCP servers to your owner by submitting a feature request with `reins_submit_feedback`.

### Permission model

Each MCP tool has one of three permission levels:

- **Allow** — you can call it freely
- **Require approval** — execution pauses until a human approves via the dashboard or Telegram (5-minute window)
- **Block** — you cannot call it at all

If a tool is blocked and you need it, explain the situation to the user and submit a feature request. If an approval times out, tell the user and ask them to retry after approving from the dashboard.

---

## Agent Configuration

Your owner configures these settings from the Reins dashboard or during initial deployment.

### Model

Your active model is shown in the dashboard under **Agent → Settings**. Supported providers:

| Provider | Example models |
|---|---|
| Anthropic | `claude-sonnet-4-6`, `claude-opus-4-6` |
| OpenAI | `gpt-4o`, `gpt-4.1` |
| MiniMax | `MiniMax-M2.7` |
| OpenAI Codex | `gpt-5.4` |

Model changes require a redeploy.

### Telegram

Your owner sets the bot token and which users or groups can interact with you. Groups are opt-in — your owner adds them individually. You can be configured to respond only when mentioned (`@botname`) or to all messages in a group.

### Credentials and re-authentication

When a connected service's credentials expire, tool calls to that service will fail and Reins automatically emails your owner. Direct users to re-authenticate via the Reins dashboard under **Services → [service name] → Re-authenticate**.

---

## Best Practices

**Before modifying data:** Briefly describe what you are about to do before calling tools that write, send, or delete — email sends, file writes, calendar changes — even when approval is not required.

**When a tool is blocked:** Tell the user clearly that the tool is blocked by policy. Offer to submit a feature request if they want it enabled. Do not attempt workarounds.

**When approval times out:** Approval requests expire after 5 minutes. Tell the user and ask them to retry after approving from the dashboard or Telegram notification.

**When credentials fail:** Do not retry in a loop. Explain that the service credentials need renewal and direct the user to re-authenticate in the dashboard.

**Submitting feedback proactively:** If you notice something not working as expected — even if the user has not complained — use `reins_submit_feedback` to report it. This is how the platform improves.

**Staying within scope:** If asked to do something your policy blocks, explain clearly rather than attempting workarounds. Transparency builds trust with your owner and users.
```

- [ ] **Step 2: Verify the file exists and has correct frontmatter**

```bash
head -5 docker/skills/reins/SKILL.md
```

Expected output:
```
---
name: reins-knowledge
description: Use when asked about Reins platform best practices...
---
```

- [ ] **Step 3: Commit**

```bash
git add docker/skills/reins/SKILL.md
git commit -m "feat(docker): add reins self-knowledge skill for OpenClaw agents"
```

---

### Task 2: Wire the skill into the OpenClaw Dockerfile

**Files:**
- Modify: `docker/Dockerfile`

- [ ] **Step 1: Add the COPY instruction**

In `docker/Dockerfile`, find this line:

```dockerfile
COPY workspace/ /workspace-template/
```

Add immediately after it:

```dockerfile

# Bundle Reins knowledge skill so agents can answer platform questions on demand
RUN mkdir -p /app/skills/reins
COPY skills/reins/SKILL.md /app/skills/reins/SKILL.md
```

- [ ] **Step 2: Verify the change**

```bash
grep -A3 "knowledge skill" docker/Dockerfile
```

Expected:
```
# Bundle Reins knowledge skill so agents can answer platform questions on demand
RUN mkdir -p /app/skills/reins
COPY skills/reins/SKILL.md /app/skills/reins/SKILL.md
```

- [ ] **Step 3: Commit**

```bash
git add docker/Dockerfile
git commit -m "feat(docker): copy reins knowledge skill into OpenClaw image"
```

---

### Task 3: Create the Hermes knowledge doc

**Files:**
- Create: `docker/hermes/knowledge.md`

Hermes has no skill system — the knowledge goes into `SOUL.md` so it is always in context. Keep it concise.

- [ ] **Step 1: Create `docker/hermes/knowledge.md`**

```markdown
## Reins Platform Quick Reference

You run inside a Reins-managed container. Reins is a trust layer that connects you to external services (Gmail, Drive, GitHub, browser, etc.) via MCP, enforces permission policies, and manages credentials.

### Submitting feedback

Use the `reins_submit_feedback` MCP tool to report bugs, request features, or send general feedback.

Required fields: `type` (bug/feature_request/general_feedback), `priority` (low/medium/high), `title`, `description`.
Optional: `steps_to_reproduce` (bugs only).

For bug reports, container logs are captured automatically — do not include them yourself. The admin team is emailed on every submission.

Example:
```json
{
  "type": "bug",
  "priority": "high",
  "title": "Short description of the problem",
  "description": "What happened and what you expected instead.",
  "steps_to_reproduce": "1. Do X\n2. Observe Y"
}
```

### Adding MCP servers

Built-in servers (enabled from the Reins dashboard under Services): Gmail, Drive, Calendar, GitHub, Linear, Notion, Outlook Mail, Outlook Calendar, Browser, Web Search, Zendesk.

Custom servers: owner adds via dashboard (Agent → MCP Servers), then redeploys. Suggest servers via `reins_submit_feedback`.

### Permissions

- **Allow** — call freely
- **Require approval** — pauses for human sign-off (5-minute window); if it times out, tell the user and ask them to retry after approving
- **Block** — unavailable; tell the user and offer to submit a feature request

### Re-authentication

Credential errors mean a service token expired. Reins emails the owner automatically. Direct users to re-authenticate via the dashboard (Services → [service] → Re-authenticate). Do not retry in a loop.

### Best practices

- Describe what you are about to do before modifying data (email sends, file writes, calendar changes)
- Report anything broken proactively with `reins_submit_feedback`
- Be transparent about blocked tools rather than attempting workarounds
```

- [ ] **Step 2: Verify line count is reasonable**

```bash
wc -l docker/hermes/knowledge.md
```

Expected: ~50 lines

- [ ] **Step 3: Commit**

```bash
git add docker/hermes/knowledge.md
git commit -m "feat(docker): add reins knowledge doc for Hermes agents"
```

---

### Task 4: Wire the knowledge doc into the Hermes image

**Files:**
- Modify: `docker/hermes/Dockerfile`
- Modify: `docker/hermes/entrypoint.sh`

- [ ] **Step 1: Add COPY to Hermes Dockerfile**

In `docker/hermes/Dockerfile`, find:

```dockerfile
COPY entrypoint.sh /entrypoint.sh
RUN chmod +x /entrypoint.sh
```

Add immediately after:

```dockerfile
COPY knowledge.md /knowledge.md
```

- [ ] **Step 2: Update entrypoint to append knowledge to SOUL.md**

In `docker/hermes/entrypoint.sh`, find the persona section:

```sh
# ── Persona (SOUL.md) ──────────────────────────────────────────────────────────
if [ -n "$HERMES_PERSONA" ]; then
  printf '%s' "$HERMES_PERSONA" > ~/.hermes/SOUL.md
fi
```

Replace it with:

```sh
# ── Persona (SOUL.md) ──────────────────────────────────────────────────────────
if [ -n "$HERMES_PERSONA" ]; then
  printf '%s' "$HERMES_PERSONA" > ~/.hermes/SOUL.md
else
  : > ~/.hermes/SOUL.md
fi

# Append Reins platform knowledge so the agent can answer configuration and
# best-practice questions regardless of whether a persona was provided.
if [ -f /knowledge.md ]; then
  printf '\n\n' >> ~/.hermes/SOUL.md
  cat /knowledge.md >> ~/.hermes/SOUL.md
fi
```

- [ ] **Step 3: Verify both changes**

```bash
grep -A2 "knowledge" docker/hermes/Dockerfile
grep -A5 "knowledge.md" docker/hermes/entrypoint.sh
```

Expected: COPY line in Dockerfile; append block in entrypoint.

- [ ] **Step 4: Commit**

```bash
git add docker/hermes/Dockerfile docker/hermes/entrypoint.sh
git commit -m "feat(docker): inject reins knowledge into Hermes SOUL.md at startup"
```
