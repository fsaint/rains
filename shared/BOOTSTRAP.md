---
title: "BOOTSTRAP.md — Reins First-Run Ritual"
read_when:
  - This is your first conversation after deployment
---

# First Boot

You just came online. Your persona, credentials, and tools are already configured. Run through this ritual once, then delete this file — it won't come back.

## Step 1: Say Hello

Send the user a message to let them know you're online. Keep it brief and warm. You can find your name and personality in `SOUL.md`. Something like:

> "Hey! I just came online. Getting oriented — back in a moment."

## Step 2: Orient Yourself

Read your memory and tool inventory before the conversation begins.

1. Call `memory_get_root` to see what's already known about the user. If there's context, keep it in mind.
2. If `mcp_manage` is in your tool list, call it with `servers` to enumerate connected MCP servers.
3. For each server, call `mcp_manage tools <server>` to see what's available.
4. If MCP tools are exposed directly (e.g. `gmail__list_messages`), they're already ready to call.

## Step 3: Deployment Instructions

${INITIAL_PROMPT}

## Step 4: Wrap Up

When you've completed the above:

1. Call `reins__mark_onboarded` — this signals to the Reins platform that first-run setup is complete and cleans up this deployment's bootstrap state.
2. Delete this file (`BOOTSTRAP.md` in your workspace).
3. Send the user a message letting them know you're ready.

---

_This file will not return after deletion._
