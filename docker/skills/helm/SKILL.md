---
name: helm-knowledge
description: Use when asked about Reins platform best practices, agent configuration, or how to extend agent capabilities with MCP servers. Also use when a user asks "how do I..." about anything related to Reins.
---

# Reins Platform Knowledge

Reins is the trust layer for AI agents. It acts as an MCP-native proxy between your agent and external services (Gmail, Google Drive, GitHub, Linear, browser, and more), enforcing permission policies, routing tool approvals to humans, and managing credentials securely.

Your agent runs inside a Reins-managed container. The Reins dashboard (accessible to your owner) controls what you can do, which services you can access, and who can approve your tool calls.

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

If a capability you need is missing, tell your owner which MCP server would provide it — they add it from the dashboard.

### Permission model

Each MCP tool has one of three permission levels:

- **Allow** — you can call it freely
- **Require approval** — a human must sign off via the dashboard or Telegram (1-hour window)
- **Block** — you cannot call it at all

If a tool is blocked and you need it, explain the situation to the user and submit a feature request.

### Approval outcomes

A tool requiring approval returns `APPROVAL_PENDING` with a `jobId` instead of executing. Call `helm__get_result({"jobId": "..."})` immediately and keep polling — do not respond to the user while you wait. It resolves one of four ways:

| Status | What it means | What you do |
|---|---|---|
| `completed` | Approved and executed | Use the `result` and continue |
| `rejected` | Refused | Tell the user; do not retry the same call |
| `changes_requested` | The human wants it done differently | Read `feedback`, revise the arguments, call the **same tool again** with corrections |
| `expired` | Nobody answered within the hour | Tell the user and ask them to retry after approving |

On `changes_requested`, do not ask the user for permission before retrying and do not repeat the identical call — the point is that something specific must change. `revisionsRemaining` tells you how many more times the request can be sent back; when it reaches zero, stop revising and ask the user directly.

---

## Agent Configuration

Your owner configures these settings from the Reins dashboard or during initial deployment.

### Model

Your active model is shown in the dashboard under **Agent → Settings**. Supported providers:

| Provider | Example models |
|---|---|
| Anthropic | `claude-sonnet-4-6`, `claude-opus-4-6` |
| OpenAI | `gpt-4o`, `gpt-4.1` |
| MiniMax | `MiniMax-M3`, `MiniMax-M2.7` |
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

**When approval times out:** Approval requests expire after 1 hour. Tell the user and ask them to retry after approving from the dashboard or Telegram notification.

**When changes are requested:** Treat the feedback as the user's instruction, not as a rejection. Apply exactly what they asked for, keep everything else the same, and resubmit without further discussion — they are waiting on the corrected version, not on a question.

**When credentials fail:** Do not retry in a loop. Explain that the service credentials need renewal and direct the user to re-authenticate in the dashboard.

**Staying within scope:** If asked to do something your policy blocks, explain clearly rather than attempting workarounds. Transparency builds trust with your owner and users.
