---
name: Threads
description: Use when the user asks you to pick up, continue, work on, or release a thread, or when a recurring topic with a goal and a deadline deserves one. Explains how to propose, hold, work and close a thread.
requires: [memory, threads]
autoAssign: false
version: 1.0.0
---

<!--
  autoAssign is deliberately false: it is inert. The UNION that used to hand
  every system skill to every agent was removed in d7c0bd0, which made per-agent
  assignment the exposure boundary. Setting it true here would claim a behaviour
  that does not happen.

  Assign this to any agent with memory and threads enabled.
-->

# Threads

A **thread** is a time-bound focus topic: a launch, a move, a hiring round. It has a goal,
a Past / Now / Next narrative, todos and deadlines, reminders, and watchers that look for
mail and meetings that belong to it. The user owns threads; you propose them, work inside
them, and help close them.

## Approval-locked tools

`{{tool:thread_propose}}`, `{{tool:thread_close}}` and `{{tool:thread_add_watcher}}` always go
to the user's phone for approval. You will get back `APPROVAL_PENDING` with a `jobId`. That is
not a failure: nothing has happened yet. Follow its instructions:

- Call `{{tool:get_result}}` with that `jobId` straight away, and poll every 3 to 5 seconds until the
  status is `completed`, `rejected` or `changes_requested`.
- Tell the user the request is waiting for their approval, then report the outcome. On
  `rejected` or `changes_requested`, say so and do not retry unchanged.
- Never call the locked tool again while it is pending. A second call raises a second approval.

## 1. When to propose a thread

Propose a thread for a recurring topic that has a deadline or an outcome to drive and will
take real attention over days or weeks. Do not propose one for a one-off question or a task
that fits in a single conversation.

Call `{{tool:thread_list}}` first so you do not duplicate an existing thread. Then call
`{{tool:thread_propose}}` with a `title` and a `goal` (what done looks like), and where you
know them a `target_date`, `past`, `now` and `next`. Pass `scope` if the topic belongs to a
specific scope (see `{{tool:memory_list_scopes}}`).

You may include `watchers`, or add one later with `{{tool:thread_add_watcher}}`. A watcher may
only point at a source you can already read without approval. If you cannot read that mailbox
or project yourself, do not propose a watcher on it.

## 2. Picking a thread up

When the user asks you to pick up or continue a thread:

1. Find it with `{{tool:thread_list}}` if you do not have its id.
2. Call `{{tool:thread_get_brief}}` with `thread_id`.
3. Summarise Past, Now and Next back to the user in at most 5 lines.
4. Print exactly this line, on its own: `Helm thread held: <title>`

Print it once, when you take the thread up, and nowhere else.

## 3. While you hold a thread

At the start of each working turn, call `{{tool:thread_get_brief}}` again. This is how reminders
that have fired and new candidates reach you.

- Surface anything due or fired first, before the user's request.
- If there are candidates, show them and ask. `{{tool:thread_accept_candidate}}` for ones that
  belong, `{{tool:thread_dismiss_candidate}}` for ones that do not
  (`{{tool:thread_list_candidates}}` lists them in full).
- Log decisions and things that happened with `{{tool:thread_log_event}}` (`thread_id`,
  `title`, optional `body`).
- Put things still to be done in `{{tool:thread_add_item}}` (`kind` is `todo`, `deadline`,
  `reminder` or `milestone`; `due_at` for a deadline, `remind_at` to nudge the user).
  Change or finish one with `{{tool:thread_update_item}}` (`item_id`, `status`).
- Attach an email, meeting or memory entry that matters with `{{tool:thread_attach_source}}`.
- Keep the narrative current with `{{tool:thread_update_now}}`: `now` and `next` replace those
  sections, `past_append` adds to Past. Update them whenever the situation changes.
- If the user asks you to stop the reminders for a while, `{{tool:thread_pause}}`; bring it back
  with `{{tool:thread_resume}}`.

## 4. Do not drift

While you hold a thread, stay on it. If the user asks about something unrelated, say that the
thread is held and ask whether they want to release it. Do not release it yourself, and do not
quietly fold unrelated work into the thread.

## 5. Releasing

Release a thread only when the user explicitly asks. Then print exactly this line, on its own:
`Helm thread released`

Releasing is not closing. A released thread stays active and can be picked up again.

## 6. Closing a thread

When the goal is met or the user wants it ended:

1. Call `{{tool:thread_get_brief}}` to see every open item.
2. Draft a retrospective: what happened, what worked, what to remember. Show it to the user.
3. For each open item, propose a decision: `cancel` it, or `carry` it to a successor thread
   (`successor_thread_id` is required for `carry`, and that thread must already exist). Every open item needs one.
4. Once the user agrees, call `{{tool:thread_close}}` with `thread_id`, `retrospective` and
   `decisions`. It goes to the user for approval (see above) and the thread closes only when
   they approve.
