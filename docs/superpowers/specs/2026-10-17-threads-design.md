# Threads: Intentional, Time-Bound Focus Topics

**Date:** 2026-10-17
**Status:** Approved 2026-10-17

## Problem

Helm's memory knows a lot, but it has no notion of *what matters right now*. Some topics need
sustained attention: a deal closing, a hire, a negotiation, a launch. Their material is spread
across memory entries, Gmail threads, and Hermeneutix meetings. Nothing ties that material
together over time, nothing tracks what has to happen next and by when, and an agent working on
the topic drifts as soon as the conversation moves on.

A **thread** is that missing object: a deliberately minted, time-bound topic that needs focus and
follow-up. A thread understands three tenses:

- **Past**: what happened (events, emails, meetings, decisions)
- **Now**: where things stand
- **Future**: goals, plans, projections, todos, deadlines, and timed reminders

Threads are intentional. A thread exists only after the user explicitly approves it. Once a
conversation picks a thread up, it stays on that thread until the thread is explicitly released.
Threads can come from any project, and in the dashboard they are first-class, with their own
left-nav item.

## Goals

- Mint threads only with explicit user consent, and make it impossible to configure that consent away.
- Store as much as possible in the memory system. The thread record stays thin and points at a root memory entry.
- Keep a well-defined timeline of past events and future obligations that a scheduler can act on.
- Collect new relevant email and meeting material without silently polluting the thread.
- Let a conversation hold one thread with discipline until it is explicitly released.

## Non-goals

- Cross-scope threads. A thread lives in one memory scope.
- Server-side conversation state. The server never records which conversation holds which thread.
- A general-purpose task manager. Todos exist only inside threads.
- Recurring reminders (v1 only fires one-shot reminders).

## Anti-goals

- Threads that appear without the user approving them, including through a permission override.
- Auto-attaching everything a watcher matches. The timeline must stay curated.
- A thread whose narrative lives only in thread tables, invisible to memory search and the dream process.

## Decisions

| Question | Decision |
|---|---|
| Where the "hold" lives | Per conversation, in the Helm plugin, mirroring the helm-session binding. A new chat starts unbound. |
| Scope | One memory scope per thread. A thread may still reference emails and meetings from any source the agent can reach. |
| Storage | Hybrid. Time items go in a table so they can be scheduled. Each item links to a memory entry. Narrative and history live in memory. |
| Aggregation | Watchers plus confirmation. Matches become *candidates*. The agent or the user accepts or dismisses each one. |
| Watcher access | A watcher can only cover sources the creating agent can already read (its Gmail account, its pinned Hermeneutix project). Adding a watcher always requires approval, and the approval shows exactly what will be scanned. |
| Who proposes | An agent may propose a thread on its own initiative (during triage, meeting intake, and so on). Nothing exists until the user approves. Creating a thread in the dashboard is itself the approval. |
| Active-thread limit | Soft cap of 5. Exceeding it is allowed, and the approval message shows the current count. |
| Reminder delivery | Telegram, iOS push, a dashboard badge, and the next-turn brief. |
| Closing | The agent writes a retrospective (outcome vs. goal, what's left). Closing requires approval. The thread becomes read-only. Each open item is cancelled or carried over. |

## Data model

All tables are created in `initializeDatabase()` (`backend/src/db/index.ts`).

**`threads`**
- `id`, `user_id`, `scope_id` (FK `memory_scopes`), `root_entry_id` (FK `memory_entries`)
- `title`, `goal`, `target_date` (nullable)
- `status` `active | paused | closed`
- `approval_id` (nullable: dashboard-created threads have none), `created_by_agent_id` (nullable)
- `created_at`, `updated_at`, `closed_at`

**`thread_items`**: the structured timeline
- `id`, `thread_id`, `kind` `event | todo | deadline | reminder | milestone`
- `title`, `body`
- `occurred_at` (events), `due_at` (todos, deadlines, milestones), `remind_at` (reminders, or a pre-deadline nudge on any item)
- `status` `open | done | cancelled`
- `nudge_fired_at` (the `remind_at` delivery), `fired_at` (the `due_at` delivery, or the `remind_at` delivery for a `reminder` item)
- `memory_entry_id` (nullable), `source_type` (`gmail | hermeneutix | memory | manual`), `source_ref`
- `acknowledged_at`, `created_at`

**`thread_watchers`**
- `id`, `thread_id`, `agent_id` (the creating agent, whose access bounds the watcher), `kind` `gmail_thread | gmail_query | gmail_sender | hx_project | hx_meeting`
- `value`, `account` (which Gmail account or Hermeneutix instance), `last_checked_at`
- `status` `active | suspended`

**`thread_candidates`**
- `id`, `thread_id`, `watcher_id`, `source_type`, `source_ref`, `summary`, `found_at`
- `status` `pending | accepted | dismissed`
- unique `(thread_id, source_ref)`, so a dismissed match never comes back

### Memory side

- A new entry type `thread`. Add it to the enum in `servers/src/memory/tools.ts`, to the backend validation on `/api/memory/entries`, and to `MemoryEntryType` in `frontend/src/api/client.ts`.
- The root entry has five sections: `## Goal`, `## Past`, `## Now`, `## Next`, `## Retrospective`. It is parented under the scope root via `setEntryParent()` (`backend/src/services/memory.ts`).
- Accepted candidates and session notes become child entries of the root.
- External identifiers go in `memory_attributes` labels: `gmail_thread_id`, `hx_instance_id`, `hx_session_id`. Relations cannot carry them, because a relation's value must be an entry id.
- Because the narrative is ordinary memory, it shows up in memory search, wikilinks, and the dream manifest without extra work.

## Lifecycle

```
propose ──(approval)──▶ active ⇄ paused ──(close + retrospective, approval)──▶ closed (read-only)
```

- **Propose.** `thread_propose` takes title, goal, scope, optional target date, initial Past and Now text, and optional watchers. The approval executor calls `mintThread()`.
- **Hold.** Any conversation calls `thread_get_brief` and announces `Helm thread held: <title>`. The plugin keeps it on that thread until `Helm thread released`. Several conversations may hold the same thread; the server neither knows nor cares.
- **Work.** While holding, the agent logs events, adds and updates items, keeps `## Now` / `## Next` current, and triages candidates.
- **Pause and resume.** Pausing stops watchers and reminders from firing. It is not approval-gated.
- **Close.** `thread_close` carries the retrospective text plus a cancel-or-carry decision for each open item. "Carry" either copies the item into a successor thread, which must already exist and be active (close never mints), or records it in the retrospective as an open loop. Writes to a closed thread are refused.

### Minting is only reachable through an approval

The approved `thread_propose` mints **in-process**. The approval executor calls `mintThread()` directly; it does not loop back through a REST route with the agent's gateway token. Mint and close both work this way.

The REST mint route (`POST /api/threads`) accepts a dashboard session only. No route accepts agent auth and mints or closes.

Test: an agent-secret request to the mint or close route is refused.

### Protecting the memory side

The narrative is ordinary memory, so the memory routes enforce the thread invariants:
- `DELETE /api/memory/entries/:id` and `PUT /api/memory/entries/:id/scope` refuse a thread root entry (`THREAD_ROOT_PROTECTED`).
- `DELETE /api/memory/scopes/:id` refuses a scope that holds a non-closed thread.
- For a **closed** thread, content writes to the root entry and its children are refused (`THREAD_CLOSED`).
- The dream flow skips `thread`-type entries in merge and rewrite candidates.
- `memory_update` on an active root stays allowed, because agents may edit the narrative. `getThreadBrief()` tolerates a missing heading by treating that section as empty, and the next `thread_update_now` re-adds it in place.

## Backend

**`backend/src/services/threads.ts`**
- `mintThread()` creates the root entry (from the template) and the row in one transaction.
- `getThreadBrief()` returns Goal/Past/Now/Next, the last N events, open todos, the next deadlines, fired-unacknowledged reminders, pending candidates, and the active-thread count.
- `addItem` / `updateItem` / `logEvent` / `updateSection` / `acceptCandidate` / `dismissCandidate` / `closeThread`.
- Section writes reuse `splitSections` / `replaceSection` from the memory update path. Do not reimplement them.

**Routes `/api/threads/*`** (`backend/src/api/routes.ts`)
- Accept either a dashboard session or `x-reins-agent-secret`, matching the memory routes.
- Resolve the scope with `resolveMemoryContext()` / `pickScope()` (`backend/src/services/memory-scopes.ts`), so an agent only sees threads in scopes it is granted.
- A dashboard `POST /api/threads` mints directly, since the user is the actor. An agent path that mints without an approval must not exist.

**Scheduler: `backend/src/services/thread-scheduler.ts`**, started from `backend/src/index.ts` like `startTrialReminderCron()`
- Reminder tick, every 60s, on `open` items of `active` threads. An item can deliver up to twice:
  - **nudge**: `remind_at <= now AND nudge_fired_at IS NULL` (on a `reminder` item, this is its only firing and it stamps `fired_at`)
  - **due**: `due_at <= now AND fired_at IS NULL` for `deadline`, `todo`, and `milestone`

  Delivery goes through `telegramNotifier` and APNs (`backend/src/notifications/`). Each stamp is made in an `UPDATE … WHERE … IS NULL RETURNING` before sending, which gives exactly-once delivery. This is safe because `agenthelm-core` runs exactly one machine.
- Changing `remind_at` or `due_at` (a snooze) clears the matching stamp and `acknowledged_at`.
- Items that came due while the thread was paused fire once, on the first tick after it resumes. They are not skipped.
- **APNs fix (prerequisite).** `APNsService.getIOSDevices()` currently selects every iOS device with no user filter. Reminder pushes must go only to the thread owner's devices: add a user filter, and skip devices with a null `user_id`. Pending-approval pushes are already user-specific, so filter those too.
- Watcher sweep, every ~15 min. Each watcher runs as its `agent_id`. Before every sweep, re-check that the agent still holds the source service with read access: for Gmail, the same account; for Hermeneutix, the watched project must equal the agent's pinned `instanceConfig.projectId`. If not, skip the watcher and mark it `suspended` so it shows in the UI. Gmail watchers reuse the gmail handlers' search logic with that agent's credential. `hx_project` / `hx_meeting` list sessions newer than `last_checked_at`. Matches are inserted as candidates with `ON CONFLICT DO NOTHING`.
- `thread_add_watcher` runs the same check before raising its approval, and again in the executor.
- Dashboard badge count = fired-unacknowledged items + pending candidates.

**Approval formatting** (`backend/src/notifications/approval-format.ts`)
- `THREAD_TOOLS` plus `formatThreadApprovalMessage()`, with a branch in `backend/src/notifications/telegram.ts`.
- A propose message shows title, goal, scope name, target date, watchers, and "N of 5 active" (with a warning when N ≥ 5).
- A watcher message names the source, account or project, and query, in plain words: "scan alice@x.com's inbox for `from:bob` every 15 minutes".
- A close message shows the retrospective and the per-item decisions.
- It must not fall back to the generic formatter, which truncates arguments at 200 characters.

## MCP service: `servers/src/threads/`

Scaffold this with the `/new-mcp-server` skill.

| Tool | Kind | Permission |
|---|---|---|
| `thread_list` | read | allow |
| `thread_get_brief` | read | allow |
| `thread_list_candidates` | read | allow |
| `thread_log_event`, `thread_add_item`, `thread_update_item` | write | allow |
| `thread_update_now` (rewrites `## Now` and/or `## Next`) | write | allow |
| `thread_attach_source` | write | allow |
| `thread_accept_candidate`, `thread_dismiss_candidate` | write | allow |
| `thread_pause`, `thread_resume` | write | allow |
| `thread_propose` | write | **always approval, locked** |
| `thread_close` | write | **always approval, locked** |
| `thread_add_watcher` | write | **always approval, locked** |

**The lock.** Today permission defaults are per service (`defaultWritePermission`), and users can set any tool to `allow` in `agent_tool_permissions`. The lock has two layers:
1. A per-tool default override, honoured in `getDefaultPermsFromDef` (`backend/src/services/permissions.ts`) and `getDefaultPermissions` (`servers/src/registry.ts`).
2. A hard `ALWAYS_APPROVE` set checked in `backend/src/mcp/agent-endpoint.ts` *after* permission resolution. It upgrades `allow` to `require_approval` for those tools whatever the stored override says. `block` stays `block`.

Add this as an invariant in CLAUDE.md next to the privileged-service rules.

**Enablement.** Add `threads` to `enableDefaultServices()` next to memory. Minting and watchers are approval-gated, so the service is safe to grant by default. It requires memory.

Do **not** add threads to the helm-admin compatible set. An admin agent stays memory-only.

## Skill and plugin

**`templates/skills/threads/SKILL.md`** (`requires: [memory, threads]`) covers:
- when to propose (a recurring topic with a deadline or an outcome to drive, not a one-off question)
- the pickup ritual: call `thread_get_brief`, summarise Past/Now/Next back to the user, then announce `Helm thread held: <title>`
- behaviour while holding: call `thread_get_brief` at the start of each working turn (this is the next-turn reminder channel), surface fired reminders and new candidates, route new facts into the thread, keep `## Now` current, log events
- don't drift: when the user raises something unrelated, say the thread is held and ask whether to release it
- release only on an explicit user request: `Helm thread released`
- the close flow: draft the retrospective, propose a decision for each open item, call `thread_close`

**The Helm plugin** (outside this repo; the synced plugin with `helm_state.py` / `scope_guard.py`) needs:
- parsing of the held/released announcement lines from the transcript
- a UserPromptSubmit hook that re-injects a static "holding thread X — refresh with `thread_get_brief`, stay on it or ask to release". The hook calls no API, so Reins needs no plugin endpoint.
- a Stop-hook nudge to log the turn's outcome into the thread
- a `helm:threads` stub skill

This ships as a follow-up change in the plugin's own repo.

## Frontend

- **Nav** (`frontend/src/App.tsx`): a **Threads** entry in `navItems` with a lucide icon and the badge count, plus routes `/threads` and `/threads/:id`.
- **`frontend/src/pages/Threads.tsx`:**
  - active / paused / closed tabs
  - cards show title, goal, next deadline, last activity, and the badge
  - a "New thread" form (title, goal, scope, target date)
- **`frontend/src/pages/ThreadDetail.tsx`:**
  - a horizontal timeline band: past events ← today marker → deadlines and milestones
  - a Now card (the rendered `## Now`) and a Goal / Next panel
  - Todos, Deadlines, and Reminders lists with inline edit, done, and acknowledge
  - a Candidates inbox (accept / dismiss)
  - a sources list, a link to the root memory entry, and a close dialog
- **API client:** a `threads` object in `frontend/src/api/client.ts`. React Query with `refetchInterval` polling, matching `Approvals.tsx`. Pull `ActivityItem` out of `Dashboard.tsx` into `src/components/` for reuse.

## Delivery

One branch, `feat/threads`, built in phases:

1. Schema, the `thread` memory type, `services/threads.ts`, REST routes, tests.
2. MCP service, approval lock, formatter, skill template.
3. Scheduler: reminders, then watchers and candidates.
4. Frontend: list, detail, nav badge.
5. Plugin hooks, in the plugin's repo.

## Testing

- Backend: mint, brief, items, and close; the lock test (`thread_propose` / `thread_close` / `thread_add_watcher` require approval even with an `allow` override); agent-auth requests to the mint and close routes are refused; watcher refused or suspended when the agent lacks the source; memory-route guards on thread roots and closed threads; APNs sends only to the owner's devices; nudge plus due fire separately; snooze resets; paused-then-resumed fires once; scheduler exactly-once under a fake clock; paused threads do not fire; formatter output; scope isolation (an agent cannot read a thread in an ungranted scope).
- Frontend: component tests for the list and detail pages.
- Manual end to end on localhost with `@reins_dev_bot` only. Never against production.

## Left to the builder

- Exact column types and indexes (index `thread_items(remind_at)` / `(due_at)` filtered to `fired_at IS NULL`).
- The nav icon.
- How many events the brief returns (start with 20).
- Watcher sweep cadence and per-sweep caps.
