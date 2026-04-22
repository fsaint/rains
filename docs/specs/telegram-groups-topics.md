# Spec: Telegram Group & Topic Support

**Status:** Draft
**Date:** 2026-04-15
**Scope:** OpenClaw agent deployment on Reins — Telegram supergroups with forum topics

---

## 1. Overview

When a Reins-deployed agent is added to a Telegram supergroup (with or without forum topics enabled), it must:

1. Trigger an owner-approval flow before the agent starts participating.
2. Respond to all messages in every topic without requiring an `@mention` (opt-in per group, configurable post-approval).
3. Allow the owner to set a **base instruction (system prompt override)** for each topic independently, via the Reins web UI *and* via a direct in-topic conversation with the agent.
4. Provide an **MCP tool** the agent can invoke to read and write topic instructions, enabling the agent to self-configure when a user asks it to "act differently in this topic."

---

## 2. User Stories

| # | Story |
|---|-------|
| US-1 | As an agent owner, when my bot is added to a Telegram group, I receive an approval request via my linked Telegram account so I can decide how the agent participates. |
| US-2 | As an agent owner, I can configure the agent to respond to all messages in a group (not just @mentions) on a per-group basis. |
| US-3 | As an agent owner, I can write a base instruction (system prompt) for each forum topic so the agent behaves differently in #general vs #support vs #dev. |
| US-4 | As an agent owner, I can see all configured groups and their topics in the Reins dashboard and edit instructions inline. |
| US-5 | As a group member with appropriate permissions, I can ask the agent in a topic to "always respond in Spanish in this topic" and the agent will persist that as the topic's instruction. |
| US-6 | As a developer, the agent has access to an MCP tool (`set_topic_instruction`) so it can update instructions for the current or any topic without requiring a UI action. |

---

## 3. Feature Areas

### 3.1 Group Join Approval

**Trigger:** Telegram sends a `my_chat_member` update when the bot is added to a group.

**Flow:**
1. Reins intercepts the update via the agent-bot relay webhook (`/api/webhooks/agent-bot/:deploymentId`).
2. Reins queues an approval of type `telegram_group` with metadata: `chatId`, `chatTitle`, `chatType`, `threadCount` (if forum), `addedBy`.
3. The Reins notification bot sends a DM to the owner:

   > **"MyAgent" was added to group "Product Team"**
   > Added by: @johndoe
   > Forum topics: Yes (3 topics detected)
   > How should the agent participate?
   > `[💬 Respond to all]` `[📢 @Mention only]` `[🚫 Ignore group]`

4. Owner taps a button → approval resolved → `applyGroupConfig()` runs:
   - Sets `requireMention = true/false`.
   - Persists the group to `telegram_groups_json`.
   - Updates the Fly machine env var live (no redeploy).
5. Agent begins participating immediately after config is applied.

**No approval = agent stays silent.** The bot does not respond to messages in an unapproved group.

---

### 3.2 Per-Group `requireMention` Setting

Controls whether the agent responds to every message or only messages that `@mention` it.

- Default after "Respond to all" approval: `requireMention = false`
- Default after "@Mention only" approval: `requireMention = true`
- Editable post-approval from the web UI without redeployment.

For groups with forum topics, this setting applies **group-wide**. Per-topic overrides are not supported (simplify scope).

---

### 3.3 Per-Topic Base Instructions

Each forum topic (identified by `threadId`) can have an independent system prompt prepended to the agent's context when a message arrives from that thread.

**Data model:**

```typescript
interface TopicPrompt {
  threadId: number;      // Telegram forum thread ID (positive int)
  threadName?: string;   // Display label (resolved from Telegram or user-supplied)
  prompt: string;        // System prompt override, max 50,000 chars
  updatedAt?: string;    // ISO timestamp of last change
  updatedBy?: string;    // "ui" | "agent" | telegram user ID
}
```

**Constraints:**
- Max 50 topic prompts per group.
- `prompt` must be non-empty and ≤ 50,000 chars.
- `threadId` must be a positive integer.

**Delivery to agent:**
The `reins-thread-prompt` OpenClaw plugin (see §5) intercepts each incoming message, looks up the matching `threadId` in its config, and prepends the prompt as a system message before the conversation context is assembled.

---

### 3.4 Instruction Setting via In-Topic Chat

Users in a topic can instruct the agent directly without needing Reins dashboard access:

**Trigger phrases (intent-matched, not keyword-matched):**
- "From now on in this topic, always respond in formal English."
- "In this channel, act as a code reviewer."
- "Set your instructions for this topic to: ..."

**Flow:**
1. Agent recognises an intent to configure topic-level behaviour.
2. Agent calls the `set_topic_instruction` MCP tool (see §4) with:
   - `chatId`: current group chat ID
   - `threadId`: current forum thread ID
   - `instruction`: the derived instruction text
3. MCP tool writes the instruction to Reins backend via API.
4. Agent confirms: "Done — I'll use that instruction in this topic going forward."

**Who can trigger this?**
- Configurable. Default: any group member.
- Optional future: restrict to Telegram user IDs in `allowFrom`.

---

### 3.5 Web UI — Groups & Topics Management

Location: `DeploymentPanel` → "Telegram Groups" section (replaces current "Runtime Settings" tab or sits within it).

**Group list view:**
```
┌─ Telegram Groups ──────────────────────────────────────────────────┐
│                                                                      │
│  📢 Product Team                         [-1001234567890]            │
│     Respond to: ○ All messages  ● @Mentions only     [Remove]       │
│     Topics ▼                                                         │
│     ┌─ #general  (thread 1)  ──────────────────────────────────┐   │
│     │  [Instruction textarea...]                                 │   │
│     │  Last set: 2026-04-12 via agent                           │   │
│     └───────────────────────────────────────────────────────────┘   │
│     ┌─ #support  (thread 5)  ──────────────────────────────────┐   │
│     │  [Instruction textarea...]                                 │   │
│     └───────────────────────────────────────────────────────────┘   │
│     [+ Add topic instruction]                                        │
│                                                                      │
│  [+ Add group manually]                                              │
└──────────────────────────────────────────────────────────────────────┘
```

**Actions:**
- Edit `requireMention` toggle per group.
- Add / remove groups manually (by chat ID — for when auto-detection isn't used).
- Add / edit / remove per-topic instructions.
- Thread names auto-populated if known; user can type a label for unnamed topics.
- "Save & apply" → `PUT /api/agents/:id/settings` → live env update (no redeploy).
- `updatedAt` and `updatedBy` shown per topic instruction.

---

## 4. MCP Tool: `set_topic_instruction`

A new native Reins MCP server (or addition to an existing internal server) exposes this tool to all deployed agents.

### Tool Definition

```typescript
{
  name: "set_topic_instruction",
  description: "Set or update the base instruction (system prompt) for the current Telegram topic or a specific topic in a group. Use this when a user asks you to behave differently in this topic going forward.",
  inputSchema: {
    type: "object",
    properties: {
      instruction: {
        type: "string",
        description: "The new base instruction for the topic. Pass an empty string to clear the instruction."
      },
      chatId: {
        type: "string",
        description: "Telegram group chat ID (negative number). Defaults to the current conversation's group."
      },
      threadId: {
        type: "number",
        description: "Telegram forum thread ID. Defaults to the current thread."
      }
    },
    required: ["instruction"]
  }
}
```

### Handler Behaviour

1. Validates `chatId` is a known group for this agent.
2. Validates `threadId` is a positive integer.
3. Upserts the `TopicPrompt` entry in `telegram_groups_json` via the Reins internal API.
4. Triggers a live env update on the Fly machine.
5. Returns `{ success: true, threadId, chatId }`.

### Transport

- Exposed as a **Reins-internal MCP server** mounted at a well-known path in `openclaw.json`.
- The server authenticates requests using the deployment's `REINS_AGENT_SECRET` (already provisioned).
- Because this requires network access to the Reins backend, it is **not** a local stdio server — it uses the existing MCP-over-HTTP transport.

---

## 5. OpenClaw Plugin: `reins-thread-prompt`

This plugin is responsible for injecting the per-topic instruction into the agent's context at message time. It is already partially implemented as `docker/reins-thread-prompt-0.1.0.tgz`.

### Required Behaviour

1. Intercept incoming Telegram messages before they reach the LLM.
2. Extract `threadId` (and `chatId`) from the message metadata.
3. Look up the matching `TopicPrompt` entry from the plugin's config (loaded from env var or local config file).
4. If a match is found, prepend the instruction as a `system` message at the start of the context.
5. If no match, pass through unchanged.

### Configuration Source

The plugin reads topic prompts from one of:
- **Option A (current):** Baked into `openclaw.json` at deploy time from `TELEGRAM_GROUPS_JSON`.
- **Option B (needed for live updates):** Polls a Reins API endpoint (`GET /api/agents/:id/topic-prompts`) at startup and on a configurable TTL (e.g., 60s cache), so that instructions written via the MCP tool or UI take effect without a full restart.

**Option B is required** to make the in-topic configuration flow (§3.4) work without a redeploy.

### Known Issue: OpenClaw Doctor Strips Config

The OpenClaw "doctor" process rewrites `openclaw.json` on startup and strips custom fields including `channels.telegram.groups`. The current workaround re-patches groups after the Codex startup phase. This workaround must also cover the `reins-thread-prompt` plugin config.

**Recommended fix:** Move topic prompt storage out of `openclaw.json` entirely and use the polling API approach (Option B above), making the plugin resilient to config resets.

---

## 6. Backend API Changes

### New / Modified Endpoints

| Method | Path | Description |
|--------|------|-------------|
| `PUT` | `/api/agents/:id/settings` | Already exists. Ensure `topicPrompts[].updatedAt` and `updatedBy` are recorded. |
| `GET` | `/api/agents/:id/topic-prompts` | **New.** Returns `{ groups: TelegramGroup[] }` for the agent. Used by the plugin polling approach. Requires `REINS_AGENT_SECRET` auth. |
| `PUT` | `/api/agents/:id/topic-prompts` | **New.** Upserts a single topic prompt. Used by the `set_topic_instruction` MCP tool. Requires `REINS_AGENT_SECRET` auth. |

### DB Schema Changes

Add two columns to the `TopicPrompt` record (stored in JSON):

```json
{
  "threadId": 5,
  "prompt": "Always respond in formal English.",
  "updatedAt": "2026-04-15T10:22:00Z",
  "updatedBy": "agent"
}
```

No schema migration needed — this is within the existing `telegram_groups_json` JSON blob.

---

## 7. Gap Analysis: Current vs. Spec

### Implemented and Working

| Feature | Status |
|---------|--------|
| `my_chat_member` detection | ✅ Implemented |
| Owner DM approval with 3-button choice | ✅ Implemented |
| `requireMention` per group | ✅ Implemented |
| `telegram_groups_json` persistence + live Fly env update | ✅ Implemented |
| Per-topic prompts data model (`TopicPrompt`) | ✅ Implemented |
| `reins-thread-prompt` plugin (packaged) | ✅ Exists (partial) |
| Frontend UI: group list + requireMention toggle | ✅ Implemented |
| Frontend UI: per-topic prompt editing | ✅ Implemented |
| Server-side validation of topicPrompts | ✅ Implemented |

### Gaps / Not Implemented

| # | Gap | Priority | Notes |
|---|-----|----------|-------|
| G-1 | Agent responds silently in unapproved groups (no guard) | P0 | OpenClaw needs to enforce `groupPolicy: allowlist` — verify it does. If not, add a pre-message guard in the relay. |
| G-2 | Agent responds to all topics without `@mention` when `requireMention = false` | P0 | OpenClaw `requireMention` field is passed but needs confirmation it applies to forum topic messages (which have non-null `message_thread_id`). Needs integration test. |
| G-3 | `reins-thread-prompt` plugin — live update without redeploy | P0 | Currently baked into `openclaw.json` at deploy time. Needs polling API (§5 Option B) so MCP tool writes take effect immediately. |
| G-4 | `reins-thread-prompt` plugin — resilience to OpenClaw doctor config reset | P0 | Doctor strips plugin config. Workaround only covers groups, not topic prompts. Fix by moving to polling API. |
| G-5 | MCP tool: `set_topic_instruction` | P1 | Not implemented. New Reins MCP server (or extension of internal server) required. |
| G-6 | New API endpoints: `GET/PUT /api/agents/:id/topic-prompts` | P1 | Needed for both MCP tool and plugin polling. |
| G-7 | In-topic instruction setting via agent conversation | P1 | Depends on G-5. Agent needs prompt guidance (in SOUL.md or AGENTS.md) to recognise config intents. |
| G-8 | `threadName` display in UI | P2 | Currently `threadId` (integer) is shown. Thread names should be resolved from Telegram API or user-supplied. |
| G-9 | `updatedAt` / `updatedBy` tracking on topic prompts | P2 | Not stored today. Small addition to the JSON blob. |
| G-10 | `allowFrom` per-group UI | P2 | Data model exists, backend passes it through, but no UI to configure it. |
| G-11 | Docker provider live env update for topic prompts | P3 | `updateEnv` throws `LIVE_EDIT_NOT_SUPPORTED` for Docker. Acceptable limitation but should surface a clear error in UI. |
| G-12 | Forum topic count shown in approval DM | P3 | Nice-to-have context for the owner when approving. |

---

## 8. Implementation Phases

### Phase 1 — Core Correctness (P0 gaps)

1. **Verify G-1:** Confirm `groupPolicy: allowlist` in OpenClaw prevents responses in unapproved groups. Add integration test or explicit relay guard if not.
2. **Verify G-2:** Confirm `requireMention = false` applies to forum thread messages. Write a test with a mock `message_thread_id`.
3. **Fix G-3 + G-4:** Add `GET /api/agents/:id/topic-prompts` endpoint. Update `reins-thread-prompt` plugin to poll this endpoint with a 60s TTL instead of reading from `openclaw.json`.

### Phase 2 — MCP Self-Configuration (P1 gaps)

4. **Implement G-5:** Scaffold a `reins-config` MCP server (use `/new-mcp-server` skill) with the `set_topic_instruction` tool.
5. **Implement G-6:** Add `PUT /api/agents/:id/topic-prompts` endpoint; wire it to `set_topic_instruction` handler.
6. **Implement G-7:** Add guidance to `AGENTS.md` (or a dedicated agent instruction) for recognising topic configuration intents and calling the MCP tool.

### Phase 3 — UX Polish (P2 gaps)

7. **G-8:** Resolve thread names via Telegram Bot API (`getForumTopicIconStickers` / `getChatAdministrators`) or allow manual naming in UI.
8. **G-9:** Add `updatedAt` / `updatedBy` to `TopicPrompt`, display in `DeploymentPanel`.
9. **G-10:** Add `allowFrom` multi-value input to the group editor in `DeploymentPanel`.

---

## 9. Open Questions

| # | Question |
|---|----------|
| Q-1 | Should `set_topic_instruction` be restricted to group admins/owners, or any member? If restricted, the agent must check the sender's Telegram role before calling the tool. |
| Q-2 | Should clearing a topic instruction (passing empty string) remove the entry or store an empty prompt? (Recommend: remove the entry entirely.) |
| Q-3 | The `reins-thread-prompt` plugin is currently shipped as a `.tgz` in `docker/`. Should it be moved to an npm package or kept as a local artifact? |
| Q-4 | For groups without forum topics, is a "group-level" instruction (no `threadId`) useful? (Out of scope for this spec — address in a follow-on.) |
