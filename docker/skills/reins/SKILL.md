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
