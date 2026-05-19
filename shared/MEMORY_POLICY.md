# Memory Policy

This document governs how you use the Reins memory system. Read it before calling any `memory_*` tool.

## What memory is

Your memory is a per-user vault — a tree of Markdown entries shared by every agent the user owns. Each entry has: an `id`, a `title`, a `type` (`note` | `person` | `company` | `project` | `index`), Markdown `content`, and optional attributes (labels, relations, aliases). Entries form a tree via branches and a graph via wikilinks and typed relations. The root is an `index` entry titled "Memory Index" — start there when you don't know what's in the vault.

## Tools at a glance

Reads: `memory_get_root`, `memory_search`, `memory_list`, `memory_get`, `memory_list_tags`, `memory_dream`.
Writes: `memory_create`, `memory_update`, `memory_relate`, `memory_set_parent`, `memory_add_attribute`, `memory_remove_attribute`.
Destructive (default-blocked, requires approval): `memory_delete`.

---

## Storing data

### Always go through `memory_create` — never search-then-create

`memory_create` is idempotent. The server runs this resolution chain:

1. Exact match on `(user_id, type, title)`.
2. Alias match — an attribute `name='alias', value=<title>` on a same-typed entry.
3. Fuzzy match — Postgres trigram similarity > 0.7 against existing titles of the same type.

If any step hits, the existing entry is returned with `created: false`. **Always inspect the `created` field.** If it's `false` and the title you submitted differs from the returned entry's title, that's your signal to add the submitted title as an alias rather than create a duplicate.

```jsonc
memory_create({
  title: "Mariana Lopez",
  type: "person",
  content: "## Role\nVP Engineering at [[Acme Corp]].\n\n## Context\nMet 2026-05-10 at the Acme review. #intro #vendor"
})
// → { id: "…", title: "…", created: true | false, … }
```

### Pick the most specific type

Fuzzy duplicate detection is **scoped by type**. A `person` titled "Acme" will not collide with a `company` titled "Acme". So:

- `person` — a human. Title = canonical full name. Nicknames → aliases.
- `company` — an organization.
- `project` — a named effort with a beginning and (eventually) an end.
- `note` — anything else worth remembering as a distinct entity.
- `index` — hierarchical hubs. Don't create these without explicit user intent.

### Structure the content

Use Markdown headings. A reusable skeleton for `person` / `company` / `project`:

```markdown
## Role         <!-- who/what they are in one paragraph -->
## Context      <!-- when/where/why you encountered them -->
## Notes        <!-- free-form observations -->
## Sources      <!-- where each fact came from, with dates -->
```

Tag with `#tag` (lowercase, letter-first, kebab-case) outside heading lines. Tags are how the user filters and reorganizes later. Common tag families: status (`#active`, `#archived`), source (`#email`, `#telegram`), domain (`#vendor`, `#client`, `#friend`).

### Use attributes for structured key-values

`content` is for narrative. Use `memory_add_attribute` for facts that have a key and a value:

- `{ type: 'label', name: 'email', value: 'm@acme.com' }`
- `{ type: 'label', name: 'phone', value: '+1…' }`
- `{ type: 'label', name: 'birthday', value: '1985-03-12' }`
- `{ type: 'label', name: 'alias', value: 'Mari' }` ← see Aliases below

Use `memory_relate` for typed entity-to-entity edges:

```jsonc
memory_relate({ source_id: <Mariana>, relation: "works_at", target_id: <Acme Corp> })
```

A good record typically uses both: `[[Acme Corp]]` in the narrative AND a `works_at` relation.

### Aliases

When an entity has multiple common names, register each as an alias:

```jsonc
memory_add_attribute({ entry_id: <Mariana>, type: 'label', name: 'alias', value: 'Mari' })
```

Aliases are honored by `memory_create`'s duplicate detection and by transclusion (`![[Mari]]`). They are **not** honored by `memory_get({title: 'Mari'})` — that does case-insensitive exact title match only. When you don't have an id, use `memory_search`.

---

## Searching

### `memory_search` — by content

Postgres full-text over `title + content`, English stemming, no operators. Pass natural words/phrases, not boolean syntax.

```jsonc
memory_search({ query: "acme review may", limit: 10 })
// → { entries: [...], count: N }
```

Cap: 50 results. Use this for "have I noted anything about X?" before deciding to write. **No semantic search** — synonyms won't be found unless they share a stem.

### `memory_list` — by structure

Use for "browse this slice" rather than "find this term":

- `{ type: "person" }` — all people
- `{ tag: "vendor" }` — entries tagged `#vendor`
- `{ parent_id: <id> }` — direct children of a branch
- `{ since: "2026-05-01T00:00:00Z", order: "updated" }` — recently touched
- `{ order: "title" }` — alphabetical

Cap: 200 results.

### `memory_get_root` and `memory_dream`

- `memory_get_root` — returns the user's Memory Index entry. Read it once when you're new to the vault.
- `memory_dream` — compact manifest of every non-deleted entry (`id`, `title`, `type`, `parent_id`, `backlink_count`, `updated_at`). Use when you need a single-shot scan of the whole vault.

---

## Finding duplicates

The rule:

1. **Default** — call `memory_create`; act on the `created` flag.
2. **When you hold a fragment** (a nickname, a partial title) — first `memory_search` with the fragment; if a candidate is clearly the same entity, use its `id`.
3. **When you have an alternate name for a confirmed entity** — call `memory_add_attribute({ type: 'label', name: 'alias', value: <alternate> })`. Do **not** create a new entry.

If duplicates already exist, merge by moving content into the canonical entry, adding the other names as aliases, then ask the user before calling `memory_delete` (which is permission-blocked and will surface an approval prompt).

---

## Making references

### `[[Title]]` — plain wikilink

Inside content, write `[[Mariana Lopez]]` to reference another entry.

- **Write-time** (when content is saved): exact title match only. Misses are silent — they remain as plain text and may resolve later if the target is created.
- **Read-time** (when an entry is fetched): exact title **or** alias match.

Use wikilinks liberally. They power the user's backlinks panel and graph view.

### `[[Title#Heading]]` — heading-scoped

`[[Acme Corp#Q2 Plans]]` is a navigation anchor only. The heading is **not validated** against the target's content — don't rely on it for retrieval, only for the reader's eye.

### `![[Title]]` — transclusion / embed

`![[Customer Brief]]` inlines the referenced entry's content at read time. Max nesting depth 2, cycle-safe.

Use transclusion when the referenced content is genuinely the same fact you'd otherwise restate. Don't transclude long entries into short ones — link with `[[…]]` instead.

### Wikilinks vs. relations

- `[[Title]]` — narrative mention (e.g., "Met with [[Mariana Lopez]] about Q2…").
- `memory_relate({ relation: "works_at" })` — structured graph edge (e.g., Mariana → Acme).

A well-formed person entry typically uses both.

---

## Branching / hierarchy

- `memory_create({ parent_id })` — place the new entry as a child of `parent_id`.
- `memory_set_parent({ entry_id, parent_id })` — move an existing entry. `parent_id: null` promotes to top level. Cycles and self-parent are rejected server-side.

Keep the tree shallow. Rely on tags + wikilinks for cross-cutting structure rather than deep hierarchies.

---

## Pre-flight checklist

Before calling `memory_create`, verify:

- Most specific **type** picked?
- **Canonical title** (full name, not a nickname)?
- Content has **sections** (Role / Context / Sources)?
- At least one **wikilink** to an existing entity if context allows?
- You'll inspect `created` in the response and **add an alias** if it came back `false` with a different surface form?

If any are no, draft your content first and refine before writing.
