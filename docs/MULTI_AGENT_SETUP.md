# Running separate agents from Claude, Claude Code, and Cowork

Helm exposes each of your agents as a remote MCP server. Any MCP client can connect to one, which means you can keep a **separate assistant per context** — home, work, a specific project — each with its own memory, its own connected accounts, its own tools, and its own approval rules, all reachable from whichever Claude surface that context lives in.

This guide sets up three such agents and connects them. It covers the consumer side: pointing a client at an agent and using it. For authoring the skills those agents run, see [`docs/ops/ADDING_SKILLS_VIA_MCP.md`](ops/ADDING_SKILLS_VIA_MCP.md).

---

## What you get

```
home-agent   → /mcp/<id-1>  → scope: home      → personal Gmail, personal Calendar
work-agent   → /mcp/<id-2>  → scope: work      → work Gmail, Linear, Drive
project-x    → /mcp/<id-3>  → scope: project-x → Hermeneutix, work Drive

Claude Code in ~/work/acme   → work-agent only
Claude.ai (personal browser) → home-agent only
Cowork workspace for the project → project-x only
```

**The agent is the boundary, not the scope.** You could give one agent three memory scopes and have the model name the right one per call, but then separation depends on the model getting it right, and one credential set serves everything. One agent per context makes the partition structural: separate memory, separate credentials, separate tool surface, separate URL.

---

## Before you start: the URL is the credential

The MCP endpoint is **not authenticated**. `/mcp/*` is exempt from the API auth guard (`backend/src/auth/index.ts:523`) and the handler never reads request headers. The agent id in the URL is the whole secret.

**New agents require a token.** Every agent created from now on is born closed: `https://app.helm.mom/mcp/<agentId>` answers `401` until a client has authenticated (the OAuth flow your MCP client runs when you add the connector, which ends on a consent page in the dashboard). Tokens are per client and revocable one at a time from the agent's **Connected clients** panel.

**Agents deployed before this keep their open URL** until you close it from that same panel. While an agent is open, anyone holding its URL can, without any further credential:

- call every tool set to `allow` immediately, against your live Gmail, Drive, and Calendar;
- trigger approval prompts that arrive on your phone;
- read anything the agent's memory scope contains.

Their calls are attributed to the agent in the audit log, indistinguishable from the agent's own.

| | |
|---|---|
| **Treat the URL like a password** | It is a 21-character id with ~126 bits of entropy — unguessable, but plaintext and permanent |
| **Never commit it** | Not in `.mcp.json`, not in `claude_desktop_config.json`, not in a shared repo |
| **Revoking is coarse** | Deactivate or delete the agent. There is no per-client token to revoke |
| **Rotating means redeploying** | The id is baked into the agent's `MCP_CONFIG` |

This is the strongest argument for one agent per context: a leaked work URL exposes work, not home. Close older agents as soon as their clients have authenticated; until then, blast radius is the only control you have.

---

## 1. Create the agents

In the dashboard, create one agent per context and name it for the context rather than the client — `work`, not `claude-code`. The same agent can serve several clients, and you will want the name to still make sense when it does.

Each agent gets its MCP URL immediately, under **Agents → your agent → Deployment**. Copy it; every step below needs it.

---

## 2. Partition memory

Memory is one vault per user, divided into **scopes** that never mix. Full model in [`docs/MEMORY.md`](MEMORY.md).

**Create the scopes.** Memory page → the layers icon beside **New entry** → name each one. Everything that existed before scopes lives in `default`, which cannot be deleted.

**Grant each agent one scope.** Permissions → the agent → the **memory** service → **Memory scopes**. Tick the scope it should reach and pick its write default with the radio.

An agent with no grants recorded reaches **every** scope its owner has — grants narrow, they do not enable. So restricting is a deliberate act, and a new agent starts able to see everything until you narrow it.

**The part that will surprise you:** nothing crosses a scope. Parents, relations, transclusions, and wikilinks are all confined to one, and a `[[Wikilink]]` pointing at an entry in another scope **fails silently** — no link is created and no error is raised. If you need the same fact in two contexts, record it in both. That duplication is the intended cost of a hard partition.

---

## 3. Connect accounts

This is the part worth understanding, because it is what makes handing an agent to a client safe.

**The agent never receives your credentials.** Its configuration contains one URL. Its machine environment holds an LLM provider key and a gateway token — and no Gmail, Drive, Calendar, Notion, or Linear token, ever (`backend/src/providers/fly.ts:270-309`). When a tool runs, the platform decrypts the credential from its vault and injects a short-lived access token into the tool handler, server-side and in-process (`backend/src/mcp/agent-endpoint.ts:731-737`). Only the tool's output travels back.

The practical consequence: a client connected to your work agent can *send mail as you* if you let it, but it cannot *obtain your Gmail token*. Those are different risks, and only the first one is on the table.

Connect services under **Agents → your agent → Services**:

| Kind | Flow | Notes |
|---|---|---|
| Google, Microsoft | OAuth | Requests offline access, so tokens refresh without you |
| API-key services | Paste a key | Validated against the real API at connect time, so a bad key fails now rather than at first tool call |

You can attach several accounts of the same service to one agent — a personal and a work mailbox — one marked default. Tools then take an optional `account` argument, and `<service>_list_accounts` returns the metadata (address, display name, which is default) but never a token.

**Give each agent only the accounts its context needs.** This is the second half of the separation: the work agent physically cannot read personal mail if the personal mailbox was never attached to it.

---

## 4. Set the approval posture

Every tool on every agent resolves to one of three levels:

| Level | Behaviour |
|---|---|
| `allow` | Runs immediately |
| `require_approval` | Returns `APPROVAL_PENDING`; runs only after you approve, out of band |
| `block` | Hidden from the tool list *and* refused if called by name |

The default is **reads allowed, writes require approval**. Two services ship with writes on `allow` because they are internal to Helm and touch nothing outside it: `memory` and `skills`. `skill-authoring` deliberately does not follow them — a skill body is an instruction another agent will obey, so each edit is a policy change worth seeing before it lands.

Set levels per agent, per service, per tool under **Permissions**. A sensible starting posture:

- **work agent** — tighter. Anything that sends, deletes, or invites requires approval.
- **home agent** — looser on low-stakes reads and drafts.
- **project agent** — whatever the project actually needs; often read-only.

Because `block` also hides the tool, a blocked tool is one the model never learns exists — which is usually better than one it tries and fails to use.

---

## 5. Connect each client

The dashboard generates the config for you under **Agents → your agent → Deployment**.

### Claude Code

The reliable path is the CLI, which avoids hand-editing and picks the right transport:

```bash
# in the directory that should reach this agent
claude mcp add --transport http work-agent https://app.helm.mom/mcp/<agentId>
```

Or as project-scoped `.mcp.json`, which is what makes "this checkout gets the work agent" work:

```json
{
  "mcpServers": {
    "work-agent": {
      "type": "http",
      "url": "https://app.helm.mom/mcp/<agentId>"
    }
  }
}
```

> **The type must be `http`.** Claude Code recognises `http`, `sse`, and `stdio` only. Any other value is skipped with a warning that appears in `claude mcp list` and nowhere else — the server simply never loads, with no error at the point of use. Verify a new connection with `claude mcp list` and look for `✔ Connected`.

Add `.mcp.json` to `.gitignore` unless every person with repo access should be able to act as that agent.

### Claude.ai and Claude Desktop

Add the URL as a custom connector in settings. This works today — a Helm agent connected this way reports `✔ Connected` and its tools appear namespaced under the connector's name.

Scope is per-account rather than per-project, so use this for the context you live in most, typically home.

### Claude Cowork

Cowork accepts remote MCP servers; add the same URL you would give any other client.

> **Unverified:** the exact menu path in Cowork has not been checked against the live product, so treat the navigation as approximate. The URL and the protocol are the same as everywhere else.

### Which client gets which scope of config

| Client | Config lives in | Applies to |
|---|---|---|
| Claude Code (`--transport http`) | `~/.claude.json` or `.mcp.json` | The directory, or all projects, depending on `--scope` |
| Claude Desktop / Claude.ai | Account settings | Everything you do in that account |
| Cowork | Workspace settings | That workspace |

Project-scoped config is the mechanism that keeps contexts apart in practice: one checkout, one agent.

---

## 6. What your client actually sees

Four behaviours that surprise clients built against other MCP servers.

**Tool names arrive bare.** `tools/list` returns `memory_search`, not `helm__memory_search` (`backend/src/mcp/agent-endpoint.ts:390-393`). Your client applies its own prefix — Claude Code produces `mcp__<your-alias>__memory_search`. One consequence worth knowing: prose *inside* approval messages and skill descriptions names tools as `helm__…`, rendered for the agent's own runtime, so it will not match the alias you chose. The names in prose are illustrative; the names your client lists are authoritative.

**`tools/call` responses are SSE-framed.** Other methods return plain JSON. Send both:

```
Accept: application/json, text/event-stream
```

A `tools/call` response arrives as one `event: message` frame, possibly preceded by `: keep-alive` comments if the call is slow. Clients that assume JSON on every response will fail on tool calls specifically.

**The connection is stateless.** No session id is issued or required, and `initialize` is optional — you can POST `tools/call` cold.

**Blocked tools are invisible, not just refused.** They are filtered out of `tools/list` and independently refused on call, default-deny (`agent-endpoint.ts:1199`). Guessing a tool name gets you nothing.

---

## 7. How approvals feel from a client

A `require_approval` tool does not block. It returns immediately with an error-flagged result:

```
APPROVAL_PENDING — jobId: QOfvcK7TsJZVzQKr-Xph8
```

The call itself is frozen server-side and replayed the moment you approve — the arguments cannot drift between your decision and the execution, and credentials are resolved fresh at that point rather than captured earlier.

Meanwhile the request reaches you out of band: a Telegram message with **Approve / Deny / Request changes** buttons, the `/approvals` page in the dashboard, and an iOS push if you have the app. Link Telegram from the dashboard under Settings — it generates a one-time deep link, so you never need to know the bot's username.

Your client then polls `get_result` with that `jobId`:

| Status | Meaning | What the client should do |
|---|---|---|
| `pending` | Not yet decided | Call `get_result` again straight away |
| `completed` | Approved **and** the tool has run | Use `result` |
| `rejected` | Declined | Stop. Do not retry — `reason` says why |
| `changes_requested` | You asked for something different | Read `feedback`, revise the arguments, call the original tool again |
| `expired` | Nobody decided in time | Stop |

**On polling cadence:** `get_result` holds the connection for up to 30 seconds waiting for a decision (`agent-endpoint.ts:968-980`), so "call it again as soon as it returns `pending`" is the whole rule. Some in-product copy says "every 3–5 seconds", which double-counts that wait.

`changes_requested` can happen up to three times per request; after that you must approve or deny. Approvals expire after an hour by default, re-authentication requests after seven days.

---

## 8. Give each agent its skills

Skills are written procedures an agent reads before acting — how to triage mail, how to file a meeting, what your Areas and projects are called. Two read-only tools expose them, enabled by default: `skills_list` and `skills_get`.

**Assignment is the exposure boundary.** Nothing arrives automatically; a skill has no effect until it is attached to a specific agent. This is deliberate, and it is what lets the work agent and the home agent run different procedures against the same platform.

A skill can declare `requires: [gmail]`. Assignment is refused while that service is unconnected, and if the service is disconnected later the assignment survives but the skill reports `available: false` with `missing_services` naming exactly what to reconnect — so the agent can tell you what is wrong instead of improvising.

Keep the specifics out of skill bodies. A good skill is generic procedure that resolves your particulars — Areas, labels, project names — from memory at run time. That way one skill serves three agents, and changing your structure is a memory edit rather than a skill rewrite.

To author or update skills, see [`docs/ops/ADDING_SKILLS_VIA_MCP.md`](ops/ADDING_SKILLS_VIA_MCP.md).

---

## 8b. Optional: an agent that organizes the others

Once you have several agents, keeping them named and scoped sensibly is itself work. The **Helm Admin** service gives one agent tools to do it: list your agents and read what each can reach; create and destroy them; rename them and write descriptions; enable and disable services; and set access either per service (`read` / `full`) or per individual tool (`allow` / `require_approval` / `block`). Every change requires your approval, arriving like any other approval request.

Those approvals name the agent rather than showing its id, and a destroy lists what that agent can currently reach — so you are approving something you can recognise, and a request aimed at the wrong agent is visible as the wrong *name* on your phone.

An agent it creates is **born closed**: its MCP endpoint requires a token from the moment it exists, so knowing the id is not enough to use it. An agent you create in the dashboard keeps today's open default. The asymmetry is deliberate — an agent created by an agent is never born reachable by whoever learns its id.

Destroying is permanent: the runtime machine and every permission go. Notes the agent saved to memory survive, because those belong to your scope rather than to the agent. It cannot destroy itself, and it cannot destroy another agent that holds Helm Admin.

**This agent may hold nothing else except memory.** Not Gmail, not skills. The rule is enforced when you enable it, in both directions, and it is not a stylistic preference:

> An agent that can change permissions and also holds Gmail is not an agent with two services. It is an agent with every service, because it can grant itself the rest. Keeping it poor is the only thing that makes the capability safe to delegate.

It also cannot grant or remove Helm Admin itself — that stays in the dashboard, where you are present — and it never sees a gateway token, a credential, or an MCP URL.

**You must close your unauthenticated endpoints first.** Enabling it is refused while any agent on your account still answers MCP calls without a token, and the refusal names the agents that block it. The reason is section 2's point taken to its conclusion: while the URL is the credential, an agent id *is* a credential. An admin agent could grant Gmail to your home agent and then simply POST to that agent's endpoint — the restriction above would hold on paper while your account was wide open. For the same reason, re-opening an endpoint is refused while an admin agent exists; remove Helm Admin first.

An agent created *after* setup starts with no deployment row and is therefore open, so the admin agent is also refused any grant to an agent in that state until you close it.

If you would rather not run one, nothing changes — this is entirely opt-in, and the dashboard does everything it does.

---

## 9. Verify the setup

Do this once per agent. The URL is all you need.

```bash
AGENT=https://app.helm.mom/mcp/<agentId>

# 1. What tools does this agent expose?
curl -sS -X POST "$AGENT" \
  -H 'Content-Type: application/json' \
  -H 'Accept: application/json, text/event-stream' \
  -d '{"jsonrpc":"2.0","id":1,"method":"tools/list"}'

# 2. Which memory scopes can it reach? (should be only its own)
curl -sS -X POST "$AGENT" \
  -H 'Content-Type: application/json' \
  -H 'Accept: application/json, text/event-stream' \
  -d '{"jsonrpc":"2.0","id":2,"method":"tools/call",
       "params":{"name":"memory_list_scopes","arguments":{}}}'

# 3. Prove the partition: naming another agent's scope must be refused
curl -sS -X POST "$AGENT" \
  -H 'Content-Type: application/json' \
  -H 'Accept: application/json, text/event-stream' \
  -d '{"jsonrpc":"2.0","id":3,"method":"tools/call",
       "params":{"name":"memory_list","arguments":{"scope":"<another-scope>"}}}'
```

Step 3 should come back with `Scope "<name>" is not available. Available: <its own>.` — that refusal is the separation working. If it returns entries instead, the grant is wrong.

From Claude Code, confirm the client side too:

```bash
claude mcp list    # look for ✔ Connected, and read the diagnostics section
```

---

## 10. Known limitations

Current as of this writing, and worth knowing before you rely on any of it.

| Limitation | Consequence |
|---|---|
| **Pre-existing agents are open until closed** | An agent deployed before tokens existed still answers the plain URL; anyone holding it can act as the agent until you close it |
| **No rate limiting on the endpoint** | A leaked URL can be used as fast as the caller likes |
| **Revocation is per client only for authenticated clients** | On an open agent, the plain URL cannot be revoked short of closing the agent |
| **Rotation needs a redeploy** | The id is baked into the agent's configuration |
| `mark_onboarded` **is callable by any URL holder** | It mutates deployment state and sends you a "your agent is ready" message |
| **Approval prose names `helm__…` tools** | Those names will not match your client's alias; use the names from `tools/list` |
| **Setup skills are reported missing on every agent** | The bootstrap notice references an installer script that is not in the repo, and no `helm-boot` skill template ships with it. Assign skills explicitly |
| **Skill version checking is inert** | The version manifest is empty, so `update_available` is always false |

---

## Related

- [`docs/MEMORY.md`](MEMORY.md) — the memory and scope model in full
- [`docs/ops/ADDING_SKILLS_VIA_MCP.md`](ops/ADDING_SKILLS_VIA_MCP.md) — authoring and assigning skills
- [`docs/architecture/MCP_TOOL_INJECTION.md`](architecture/MCP_TOOL_INJECTION.md) — how tools reach a deployed agent
- `shared/src/mcp-naming.ts` — tool-name and token resolution
