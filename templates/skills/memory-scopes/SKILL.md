---
name: Memory Scopes
description: Use whenever you read or write memory. Explains how the vault is partitioned into scopes and what cannot cross between them.
requires: [memory]
autoAssign: false
version: 1.0.0
---

<!--
  autoAssign is deliberately false: it is inert. The UNION that used to hand
  every system skill to every agent was removed in d7c0bd0, which made per-agent
  assignment the exposure boundary. Setting it true here would claim a behaviour
  that does not happen.

  Assign this to any agent with memory enabled that needs to understand scopes,
  until the same guidance lands in shared/MEMORY_POLICY.md — which reaches agents
  only through an image rebuild.
-->


# Memory Scopes

The memory vault is divided into **scopes** — separate compartments that never mix.
Work memory and personal memory can sit side by side without leaking into each other.

This is a hard partition, not a filter. Two entries in different scopes are unrelated,
even if they have the same title.

## Finding out what you can reach

Call `{{tool:memory_list_scopes}}` before passing `scope` anywhere. Slugs cannot be
guessed, and naming one you cannot reach is refused. You will get back something like:

```
default   Default   12 entries   (your default)
work      Work       3 entries
```

## Reading

Reads span **every scope you can reach** unless you narrow them. Every result carries a
`scope` field. Pass `scope` when the question is clearly about one compartment:

- `{{tool:memory_search}}` with `query: "budget"` → hits from every scope, each labelled
- `{{tool:memory_search}}` with `query: "budget", scope: "work"` → work only

When results span scopes, **read the label before you use them**. "Alice" in `work` and
"Alice" in `default` may be different people.

## Writing

`{{tool:memory_create}}` writes to your **default scope** unless you say otherwise.

- Omit `scope` for ordinary notes.
- Pass `scope` when the user's context makes the compartment obvious — anything about a
  client engagement belongs in that engagement's scope.
- If you pass `parent_id`, the new entry inherits that parent's scope. Passing a `scope`
  that contradicts the parent is an error rather than a guess.

Every other write tool — update, relate, set_parent, add_attribute, remove_attribute —
takes **no** `scope`. They address an entry by id, and an entry's scope is a fact about
it, not something you choose per call.

## What cannot cross a scope

This is the part that will surprise you. Inside one scope everything works as before;
across scopes, these silently do nothing:

| Thing | Across scopes |
|---|---|
| `[[Wikilink]]` | Does not resolve. No link is created, no error is raised. |
| `![[Transclusion]]` | Does not resolve. |
| `{{tool:memory_relate}}` | Refused with a clear error. |
| `{{tool:memory_set_parent}}` | Refused with a clear error. |
| Backlinks and the graph | Only ever show entries from the same scope. |

So if you write `[[Acme Corp]]` in a personal note and Acme Corp lives in `work`, the
link quietly does not exist. **Link only to entries you can see in the same scope.** If
you need something in both places, record it in both — that is the intended cost of a
partition.

You cannot move an entry between scopes. Only the account owner can, from the dashboard.
If something is filed in the wrong scope, say so; do not try to work around it by
recreating and deleting.

## Creating a scope

`{{tool:memory_create_scope}}` exists, but reach for it rarely. Create one only when the
user has asked to keep a genuinely separate context apart — a new client, a new job.

Check `{{tool:memory_list_scopes}}` first. A slug that closely resembles an existing one
is refused, deliberately: a vault split across `acme` and `acme-corp` is worse than one
scope, and there is no way for you to merge them afterwards.

If you are unsure whether something deserves its own scope, it does not. Use a `#tag` or
a parent entry instead.

## When a scope is refused

Naming a scope you cannot reach returns the list of ones you can:

```
Scope "finance" is not available. Available: default, work.
```

Use that list. Do not retry the same slug, and do not invent a new scope to work around
the refusal — being restricted to certain scopes is a deliberate choice by the owner.
