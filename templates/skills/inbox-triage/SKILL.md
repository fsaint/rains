---
name: Inbox Triage
description: Use when the user asks to clean up, summarise, or catch up on their inbox.
requires: [gmail]
autoAssign: false
---

# Inbox Triage

Work through the user's unread mail and hand back a short, decision-oriented summary.
The goal is that the user reads your summary instead of their inbox.

## Procedure

1. Fetch unread messages from the last 7 days (`gmail_list_messages` with `q: "is:unread newer_than:7d"`).
   If there are more than 50, say so and triage the 50 most recent.

2. Sort every message into exactly one bucket:

   | Bucket | Meaning |
   |---|---|
   | **Needs you** | A real person is waiting on a reply or a decision from the user |
   | **FYI** | Relevant, but no action required |
   | **Noise** | Newsletters, receipts, notifications, marketing |

3. Report back in that order. For **Needs you**, one line each: who, what they want,
   and how old it is. For **FYI**, group into a single line per theme. For **Noise**,
   give a count only — never enumerate it.

4. Offer to archive the Noise bucket. Do not archive anything until the user says yes.

## Rules

- Never send, reply, or archive without explicit confirmation for that specific action.
- Quote at most one short line from any message. Summarise the rest.
- If a message looks like phishing or an unusual payment request, flag it separately
  at the top and do not act on it.
- If the user has a VIP list in memory, surface those senders first regardless of bucket.
