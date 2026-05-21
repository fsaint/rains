---
name: inbox-distillation
description: Use when the user wants to identify important people from their inbox, build or refresh their VIP list, map relationships and companies, or surface who emails them. Triggers on phrases like "review my inbox", "find the important people in my email", "build my VIP list", "update my contacts", "who emails me", "set up my contacts", "refresh my VIPs".
---

# Inbox Distillation

Build a relationship graph from the user's recent inbox. This skill creates structured `person`, `company`, and `project` entries in memory and lets the user confirm which people are VIPs.

---

## Step 1 — Fetch recent email senders

Call `gmail_list_messages` to retrieve the 50–100 most recent messages. You do not need to fetch full bodies — subject and `From` header are sufficient for most senders. Call `gmail_get_message` only if the display name is missing from the header.

---

## Step 2 — Cluster and classify senders

Group messages by normalized email address. For each sender, note:
- Display name (use as canonical title)
- Email address
- Send frequency (count)
- Domain

Classify each as **real person** or **automated**. Mark as automated if any of these apply:
- Address starts with `no-reply`, `noreply`, `notifications`, `alerts`, `mailer`, `info`, `support`, `newsletter`
- Domain is a known bulk-mail provider (mailchimp, sendgrid, constantcontact, etc.)
- Display name contains "Team", "Bot", "System", "Alerts", or "Notifications"

Keep the top 10–15 real-person senders for memory writes.

---

## Step 3 — Create person entries

For each real-person sender (highest frequency first):

1. Call `memory_create`:
   ```
   type: "person"
   title: <canonical full name from display name>
   content: |
     ## Role
     <infer from domain or email thread context if possible, otherwise leave blank>

     ## Context
     Frequent email correspondent.

     ## Sources
     gmail — <YYYY-MM-DD>
   ```
2. Inspect the `created` field:
   - `true` → proceed.
   - `false` with a different returned title → add the submitted name as an alias: `memory_add_attribute({ entry_id, type: 'label', name: 'alias', value: <submitted name> })`.
3. Add the email address as a label attribute:
   ```
   memory_add_attribute({ entry_id, type: 'label', name: 'email', value: <email address> })
   ```
4. If the sender uses a nickname or shortened name, register it as an alias too.

---

## Step 4 — Create company entries and link people

For each sender domain that is **not** a personal mail provider (gmail.com, yahoo.com, hotmail.com, outlook.com, icloud.com, me.com, proton.me, etc.):

1. Derive a company name from the domain (e.g. `acme.com` → "Acme", `openai.com` → "OpenAI").
2. Call `memory_create({ type: 'company', title: <company name>, content: '## Sources\ngmail domain inference' })`.
3. Link the person to the company:
   ```
   memory_relate({ source_id: <person id>, relation: "works_at", target_id: <company id> })
   ```
4. In the person entry's content, reference the company with a wikilink: add `[[<company name>]]` to the Role or Context section via `memory_update` if not already present.

---

## Step 5 — Infer projects

Look for recurring subject-line keywords across 3 or more threads (e.g. "Project Phoenix", "Q3 Budget", "Rebrand"). For each identifiable named initiative:

1. Call `memory_create({ type: 'project', title: <project name>, content: '## Context\n<what you know>\n\n## Sources\ngmail subject threads' })`.
2. Link participants: `memory_relate({ source_id: <person id>, relation: "involves", target_id: <project id> })` for each person who appeared in those threads.

Only create a project entry when you have at least 3 corroborating threads and a clear name. Don't speculate.

---

## Step 6 — Ask the user to confirm VIPs

Present the top people (up to 10) as an inline Telegram button list. For each candidate, show: name, email, frequency (e.g. "12 emails").

Ask: *"Which of these people are VIPs — people whose emails you always want surfaced immediately?"*

Use inline buttons so the user can tap multiple names. Confirm before writing.

For each confirmed VIP, update their memory entry to add the `#vip` tag:
```
memory_update({
  id: <person id>,
  content: <existing content> + "\n\n#vip"
})
```

Retrieve the current content with `memory_get({ id })` before calling `memory_update` so you do not overwrite anything.

---

## Step 7 — Report

Send the user a summary:

- **X people** added to memory (list the top 5 by frequency)
- **Y companies** mapped
- **Z projects** identified (if any)
- **Your VIPs:** [names with #vip confirmed]

Keep it brief. Offer to refine: *"Would you like to add anyone I missed, or remove someone from this list?"*
