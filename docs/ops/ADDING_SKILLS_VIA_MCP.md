# Adding Skills via the Helm MCP

Skills can be authored two ways: by hand in the dashboard, or programmatically over the
agent's MCP endpoint using the `skill_authoring_*` tools. This runbook covers the second —
the path to use when installing a set of skills at once, or when the skill bodies are kept
as files in a repo.

Verified end-to-end on 2026-08-12/13 installing six skills.

> **A skill does nothing until it is assigned.** Creating it only puts it in the user's
> library. `skill_authoring_create` returns a `next_step` reminding you of this; heed it.

## Prerequisites

- The agent's MCP endpoint URL, `https://app.helm.mom/mcp/<gateway-token>`. The token in the
  path *is* the credential — treat the URL as a secret.
- Telegram or `https://app.helm.mom/approvals` reachable by the owner. **Every
  write raises an approval** — create, update, delete, assign, unassign — one per
  call. A `scope: "system"` write is rendered with a **PLATFORM-WIDE** banner, so
  the owner can tell a change to their own library from one that ships to every
  account.
- Skill bodies with frontmatter. See `templates/skills/inbox-triage/SKILL.md` for the shape.

## Protocol notes

The endpoint speaks JSON-RPC 2.0 over HTTP POST. Two details bite if you are scripting it:

- Send `Accept: application/json, text/event-stream`. Some responses come back
  **SSE-framed** — a `data: {...}` line rather than a bare JSON body — so parse for the
  `data: ` prefix before `JSON.parse`.
- `initialize` is not required before `tools/call` against this endpoint, but is the
  cheapest way to confirm the token works. A healthy response reports
  `"serverInfo": {"name": "helm"}`.

```bash
curl -sS -X POST "$HELM_MCP_URL" \
  -H 'Content-Type: application/json' \
  -H 'Accept: application/json, text/event-stream' \
  -d '{"jsonrpc":"2.0","id":1,"method":"tools/list","params":{}}'
```

## Step-by-step

### 1. Check what exists

```jsonc
{"method":"tools/call","params":{"name":"skill_authoring_list","arguments":{}}}
```

Returns every skill the owner has, with ids, including ones not assigned to this agent.
Entries carrying `scope: "system"` are Helm platform skills; `read_only` marks the ones
*this caller* may not edit, which for a platform skill depends on whether the owner is an
admin. See **Scope** below. Bodies are omitted —
the list is for picking an id; pull one body at a time with `{{skill:slug}}` or the
dashboard.

Backed by `GET /api/skill-library`, which is gateway-token authenticated and scoped to the
calling agent's owner. Not the dashboard's `/api/skills`: that route resolves its caller
from a session, which an agent does not have.

### 2. Create

```jsonc
{"method":"tools/call","params":{"name":"skill_authoring_create","arguments":{
  "name": "Email Triage",
  "description": "Use when asked to triage, tag, or catch up on email.",
  "body": "<full Markdown instructions>",
  "requires": ["gmail"],
  "slug": "email-triage",
  "version": "1.0.0"
}}}
```

Map frontmatter to the payload directly: `name` → `name`, `description` → `description`,
`requires` → `requires`, directory name → `slug`, everything below the frontmatter → `body`.
Omitting `slug` derives one from `name`.

`description` is the **only** text an agent sees before deciding whether to open the skill.
Write it as a trigger ("Use when…"), not a summary.

`requires` is enforced at assignment, not creation. Declaring a service the target agent
lacks makes the skill uninstallable — see step 4.

### 3. Clear the approval

The create returns immediately with:

```
APPROVAL_PENDING — jobId: RcUkJbGbS7YBuVpzPKUu1
```

Poll until it resolves. Do not re-issue the create — the job is already queued.

```jsonc
{"method":"tools/call","params":{"name":"get_result","arguments":{"jobId":"<jobId>"}}}
```

Poll every 3–5 seconds. Outcomes:

| Status | Meaning | Action |
|---|---|---|
| `completed` | Created | Read `result.data.id` — this is the `skill_id` |
| `rejected` / `expired` | Owner declined or timed out | Stop; do not retry |
| `changes_requested` | Owner wants it different | Read `feedback`, revise arguments, call `skill_authoring_create` again |

A successful create returns:

```jsonc
{"status":"completed","result":{"success":true,"data":{
  "id":"C55xb-1c3KowyhHGUFHAC","slug":"helm-memory",
  "next_step":"Assign it to an agent with skill_authoring_assign — a skill has no effect until it is attached."}}}
```

**Capture every `id`.** You need it for assignment and for any later update. If you lose
one, `skill_authoring_list` gets it back.

### 4. Assign

```jsonc
{"method":"tools/call","params":{"name":"skill_authoring_assign","arguments":{
  "agent_id":"<target agent>","skill_id":"<id from step 3>"}}}
```

**This adds; it never replaces.** Unlike the dashboard's
`PUT /api/agents/:id/skills` — which does `DELETE FROM agent_skills` then re-inserts, so a
partial list silently unassigns everything else — `skill_authoring_assign` attaches one skill
and leaves the rest alone. No read-merge-write needed.

Assignment is refused if the target agent lacks a service named in `requires`. The error
names the missing service. Two ways out:

- Connect the service (Agents → your agent → Services), then retry; or
- Declare `requires: []` and have the skill detect the failure at runtime and tell the user
  to reconnect. Prefer this when the dependency is real but the service is *currently*
  broken — a hard `requires` on a broken service makes the skill uninstallable precisely
  when you most want it in place.

### 5. Verify

From the **target agent's** endpoint, not the authoring one:

```jsonc
{"method":"tools/call","params":{"name":"skills_list","arguments":{}}}
```

Assigned skills come back with `available` and, when a service is missing,
`missing_services`. If a skill is created but not attached, `skills_get` says so precisely:

```
Skill "helm-memory" exists but is not assigned to you. Ask your owner to assign it.
```

That message distinguishes "creation failed" from "assigned to a different agent" — worth
checking before re-uploading anything.

## Writing the body

### Tool and skill names must be tokens

`/api/agent-skills/:slug` runs both `description` and `body` through `resolveToolTokens`
against the **requesting agent's runtime**:

```ts
description: resolveToolTokens(skill.description ?? '', agent.runtime),
body:        resolveToolTokens(skill.body ?? '', agent.runtime),
```

So write `{{tool:gmail_search}}`, never `gmail_search` and never `helm__gmail_search` — the
model-visible name differs per runtime (OpenClaw sees `helm__gmail_search`, Hermes an
`mcp__` form), and a hardcoded name is wrong for one of them. Use `{{skill:its-slug}}` to
reference another skill.

Author with canonical names: `get_result`, `mark_onboarded`. Legacy spellings
(`reins_get_result`, `reins__mark_onboarded`) still resolve via `canonicalToolName` but are
no longer advertised.

**Malformed tokens render verbatim rather than erroring** — `{{tool:}}` and `{{ tool:x }}`
do not match the pattern and survive into the served body. Validate before uploading:

```bash
grep -oh "{{tool:[a-z_]*}}" */SKILL.md | sort -u   # cross-check against real tool names
```

and after installing, fetch the served body and assert no `{{tool:` survives. Note that
`sort`/`comm` in a non-C locale order underscores unintuitively — use `LC_ALL=C` for that
comparison or you will get false mismatches.

### Body content

Write a procedure another agent follows literally, not a description of one. Name the
blocked tools it must not plan around (`gmail_send_message`, `gmail_delete_message`,
`calendar_delete_event`, `memory_delete`) and include the approval-polling protocol from
step 3, since any write in the skill may return `APPROVAL_PENDING`.

## Reading

`skill_authoring_list` omits bodies — it is for picking an id. To read one, use
`skill_authoring_get`, which takes a `skill_id` **or a slug** (handy, since `{{skill:its-slug}}`
references inside a body give you slugs, not ids).

It reads any skill on the account, whether or not it is assigned to this agent and whatever
services the skill declares. That is the difference from `skills_get`, which an agent uses to
read skills it runs: that one serves only assigned skills and reports `available: false` when the
agent lacks a required service — correct for a consumer, useless for an author, since an
architect holds none of those services.

It returns the body **exactly as stored**, with `{{tool:…}}` and `{{skill:…}}` tokens intact.
`skills_get` renders those into the reading agent's runtime names, and if you round-tripped a
rendered body through `skill_authoring_update` you would write one runtime's spelling into the
stored skill and break it for the other. Keep the tokens as tokens.

Platform skills come back with `scope: "system"`. Whether they also carry `read_only: true`
depends on the caller: an admin owner's architect may edit them, anyone else's may not.

## Updating

`skill_authoring_update` **replaces the whole skill**. Send the complete `name`,
`description`, and `body` even when changing one line, and read the current version first with
`skill_authoring_get`. It needs the `skill_id` — from `skill_authoring_list`, `skill_authoring_get`,
or the one you captured at create time.

## Scope — account skills vs Helm skills

Every write takes an optional `scope`:

| `scope` | Writes | Requires |
|---|---|---|
| `"user"` (default) | A skill in the calling agent's owner's library | skill-authoring enabled on the agent |
| `"system"` | A **Helm platform skill** every account on the platform can load | the above, **plus** the owner holding `role = 'admin'` |

```jsonc
{"method":"tools/call","params":{"name":"skill_authoring_create","arguments":{
  "name": "Inbox Triage", "description": "Use when…", "body": "…",
  "slug": "inbox-triage", "scope": "system"
}}}
```

Two properties are load-bearing and worth understanding before using this:

- **Scope is never inferred.** Naming a platform skill's id without `scope: "system"` returns
  `409 SCOPE_REQUIRED` rather than editing it. The opt-in is the safety mechanism: an inferred
  escalation would reach the owner's phone looking like an ordinary skill edit.
- **Enabling skill-authoring does not grant platform authorship.** The role is checked against
  the database on every call, against the *owner*, and requires an active account. No agent can
  grant it to itself.

A non-admin owner's agent gets `403 ADMIN_REQUIRED`. Note that the approval is raised before
the route runs, so such a call still prompts the owner and then fails once granted.

A platform skill's **id is its slug**, permanently — it is the address the repo templates and
every `{{skill:…}}` reference use. A user's own skill with the same slug takes precedence for
that user, so publishing a platform skill does not displace one someone already has.

## Deleting

```jsonc
{"method":"tools/call","params":{"name":"skill_authoring_delete","arguments":{
  "skill_id": "<id>", "scope": "system"}}}
```

Deletes the skill and, by cascade, every assignment of it. The response reports
`detachedFrom` — how many agents just lost it. Not recoverable; prefer
`skill_authoring_unassign` when you only want one agent to stop using it.

**Deleting a platform skill does not necessarily stick.** Skills under
`templates/skills/<slug>/` are re-seeded on every deploy, so one with a template still in the
repo comes back. The response sets `reseeds: true` on any platform delete to say the condition
applies; retiring such a skill for good means removing its template directory.

Conversely, **editing** a template-backed platform skill takes it out of the seeder's hands
permanently — its `source` flips from `template` to `admin` and later deploys skip it, logging
the skip. That is deliberate: it is what stops a deploy reverting your edit. It also means the
skill stops receiving upstream fixes.

## Gotchas

| Symptom | Cause |
|---|---|
| `The skill-authoring service is not enabled on this agent.` | 403 `SERVICE_NOT_ENABLED` — enable skill-authoring on the agent in Permissions. Enforced on the HTTP routes, not only on tool exposure, so a direct call is refused too |
| `A skill with the slug "…" already exists` | 409 `DUPLICATE_SLUG`; update instead of create |
| `ADMIN_REQUIRED` | 403 — `scope: "system"` from an agent whose owner is not an active admin |
| `SCOPE_REQUIRED` | 409 — the id names a platform skill; retry with `scope: "system"` |
| A platform skill reappeared after I deleted it | A template still ships for its slug; remove `templates/skills/<slug>/` |
| A fix to a stock skill never reached an account | Someone edited it there, so `source` is `admin` and the seeder now skips it — see the `[skills] Skipped …` boot log |
| Assignment refused, names a service | Target agent lacks a `requires` entry |
| Skill installed but agent ignores it | Not assigned, or its `description` does not read as a trigger |
| `{{tool:...}}` visible in the agent's output | Malformed token — check the tool name exists |
| Agent calls a tool name that does not exist | Body hardcoded a runtime-specific name instead of a token |

## Related

- `docs/architecture/MCP_TOOL_INJECTION.md` — how tools reach the model
- `shared/src/mcp-naming.ts` — `MCP_SERVER_NAME`, `BUILTIN_TOOLS`, token resolution
- `templates/skills/inbox-triage/SKILL.md` — reference skill format
