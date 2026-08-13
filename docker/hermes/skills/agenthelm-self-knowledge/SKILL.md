---
name: agenthelm-self-knowledge
description: Answer questions about AgentHelm — what it is, how permissions work, how to add services, how to re-authenticate, how to submit feedback, and how to get support. Use when the user asks how the platform works, what you can do, or how to configure anything.
version: 1.0.0
metadata:
  hermes:
    tags: [agenthelm, helm, platform, onboarding, help]
    category: productivity
---

# AgentHelm Self-Knowledge

## When to Use

Use this skill whenever a user asks:
- What is AgentHelm / what is this agent?
- What can you do? What services do you have access to?
- How do I add Gmail / Calendar / Drive / GitHub / etc.?
- Why did a tool get blocked or pause for approval?
- How do I approve or deny a pending action?
- My authentication stopped working — what do I do?
- How do I give feedback or report a bug?
- Where do I get help?

## What AgentHelm Is

AgentHelm is a platform that deploys AI agents (OpenClaw and Hermes) in isolated containers. It acts as a trust layer between you and the agent: every connection to an external service (Gmail, Drive, Calendar, GitHub, browser, etc.) goes through an MCP-based permission system that you control.

Key properties:
- No terminal required. No config files. You onboard through Telegram.
- Each agent runs in its own container, isolated from other users.
- Permissions are scoped per-service and per-tool — you decide exactly what the agent can do.
- A human-in-the-loop approval flow pauses the agent before sensitive actions.

## How Permissions Work

Every tool call the agent makes falls into one of three permission levels:

**Allow** — the agent calls the tool freely, no interruption.

**Require approval** — the agent pauses and sends you a message via @AgentHelmApprovalsBot with **Approve**, **Deny**, and **Request changes** buttons. You have a 1-hour window to respond. Tapping *Request changes* asks you what to change; your reply goes back to the agent, which revises and asks again (up to 3 revisions). If the window expires with no answer, tell the user and ask them to retry the action after approving.

**Block** — the tool is unavailable. Tell the user clearly ("I can't do that — it's blocked by your permission policy") and point them at the support group if they want it changed.

## Services (MCP Servers)

Built-in services the user can enable from the dashboard (Agent → Services):

| Service | What it enables |
|---------|----------------|
| Gmail | Read, search, draft, and send email |
| Google Drive | Read and write files |
| Google Calendar | Read and create calendar events |
| GitHub | Read repos, create issues, open PRs |
| Linear | Project management |
| Notion | Read and write pages |
| Outlook Mail | Microsoft email |
| Outlook Calendar | Microsoft calendar |
| Browser | Web browsing and scraping |
| Web Search | Real-time search |
| Zendesk | Customer support tickets |

**Custom servers:** the owner can add any MCP server from the dashboard (Agent → MCP Servers → Add), then redeploy. If the user needs a server that isn't listed, suggest they submit a feature request.

## Re-authentication

If a service stops working with an authentication or credential error:
1. Reins has already emailed the owner automatically.
2. Direct the user to the dashboard: Services → [service name] → Re-authenticate.
3. Do not retry the failing call in a loop.

## Getting Support

Point the user to the Agent Helm Support group on Telegram (link sent during onboarding in the final "You're all set" message). That is the right channel for questions, bugs, and feedback that require human follow-up.

## Procedure

1. Identify what the user is asking about (permissions, services, approval, auth, feedback, general "what can you do").
2. Answer using the relevant section above.
3. If the question requires a dashboard action (adding a service, re-auth), give the exact navigation path.
4. If the user wants something that is blocked or not yet available, say so plainly and point them at the support group.
5. If unsure, direct the user to the Telegram support group rather than guessing.

## Pitfalls

- Do not invent tool names or service names that are not listed above.
- Do not tell users to edit config files or use a terminal — AgentHelm is no-terminal by design.
- Do not retry authentication errors in a loop.
- Do not expose internal container paths, env var names, or Fly.io infrastructure details.
