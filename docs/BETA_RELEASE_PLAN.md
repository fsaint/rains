# AgentHelm — Beta Release Plan
**Target date:** May 5, 2026
**Beta cohort size:** 20–50 users (cost-gated)

---

## Part 1: Development Plan

### Timeline

```
Apr 21–24   Test suite — stability across all runtime × model combinations
            Fix gmail_send_draft bug (blocks primary Email & Calendar use case)
Apr 25      Branding rename: Reins → AgentHelm throughout (UI, errors, emails, docs)
Apr 25–27   Beta infrastructure: registration flow, invite system, onboarding wizard
            Privacy policy (one page — required before posts go live)
Apr 28–29   Metrics instrumentation (PostHog — must be live before first user)
            Status page (UptimeRobot), beta support Telegram group
Apr 29–30   Landing page finalized, posts drafted
Apr 29–30   Posts go live (Tue/Wed — avoid Friday)
May 2–3     Review submissions, send invite codes in batches of 10
            Watch for errors 48h before sending next batch
May 4       Onboard first wave (10–15 users)
May 5       ✓ Beta live
```

### Priority Order (if time compresses)

1. Fix `gmail_send_draft` — blocks the primary use case
2. Test suite — don't skip silent failure paths
3. Branding rename — must happen before posts go live
4. Privacy policy — necessary before public posts
5. Invite system + onboarding wizard
6. PostHog — must be live before first user arrives
7. Beta support Telegram group — before sending first invite code
8. Status page — 15 minutes, UptimeRobot
9. Posts + questionnaire live

---

### 1.1 Test Suite

Cover every supported combination before any user touches the product.

| Runtime | Model | Status |
|---|---|---|
| OpenClaw | Anthropic Claude | |
| OpenClaw | MiniMax M2.7 | |
| OpenClaw | OpenAI (token) | |
| Hermes | MiniMax M2.7 | |
| Hermes | Anthropic | |

**QA checklist per combination:**
- [ ] Agent creates and reaches `running` state
- [ ] Agent responds to first Telegram message within 60s
- [ ] MCP tool call succeeds end-to-end (Gmail or Calendar)
- [ ] Usage reporting fires correctly
- [ ] Agent survives redeploy without orphaned machines
- [ ] Dashboard reflects correct state (`running` / `stopped` / `error`)

**Critical silent failure paths to verify:**
- [ ] `models.json` registration failure surfaces an error (not swallowed by `|| true`)
- [ ] Empty `REINS_PUBLIC_URL` is caught at startup, not at first tool call
- [ ] Bad API key → reauth approval triggered with correct message
- [ ] Fly machine failure → `error` state visible in dashboard within 2 minutes

---

### 1.2 Beta Infrastructure

#### Invite System

Add to DB:

```sql
CREATE TABLE beta_invites (
  code        TEXT PRIMARY KEY,
  email       TEXT NOT NULL,
  sent_at     TIMESTAMP,
  used_at     TIMESTAMP,
  user_id     TEXT REFERENCES users(id)
);
```

- Each code is single-use
- Hard cap: 50 codes issued total
- Registration endpoint validates code before creating account

#### Registration Flow

```
/beta              → landing page with questionnaire link
/register?code=XYZ → invite-gated account creation
/onboarding        → 3-step wizard (see below)
/dashboard         → normal app
```

#### Onboarding Wizard (3 steps)

Goal: time-to-first-value under 5 minutes.

**Step 1 — Connect a service**
- Show Gmail and Google Calendar as primary options
- One OAuth click, confirm connection
- Track: `first_service_connected`

**Step 2 — Create your first agent**
- Pre-fill soul with the "Email & Calendar assistant" template
- Ask for Telegram bot token (link to @BotFather instructions)
- Default: Hermes runtime + MiniMax M2.7 (cheapest, fastest for beta)
- Track: `first_agent_created`

**Step 3 — Send it a message**
- Show the agent's Telegram username
- Prompt: "Send your agent a message — try 'What's on my calendar today?'"
- Completion detected via first usage webhook callback
- Track: `first_message_sent`

Do not let users skip the wizard. Redirect `/dashboard` to `/onboarding` until all 3 steps are complete.

---

### 1.3 Metrics — PostHog Instrumentation

**Setup:** PostHog JS snippet on frontend + server-side events from backend via PostHog Node SDK.

#### Acquisition Funnel

| Event | Source | Properties |
|---|---|---|
| `questionnaire_submitted` | Form webhook | `source` (reddit/linkedin/other) |
| `invite_sent` | Backend | `email` |
| `user_registered` | Backend | `invite_code` |
| `onboarding_step_completed` | Frontend | `step` (1/2/3) |
| `onboarding_completed` | Backend | `time_to_complete_ms` |

#### Agent Engagement

| Event | Source | Properties |
|---|---|---|
| `agent_created` | Backend | `runtime`, `model_provider`, `model_name` |
| `agent_message_received` | Usage webhook | `agent_id`, `input_tokens`, `output_tokens` |
| `agent_tool_called` | Backend/proxy | `tool_name`, `server_name`, `success` |
| `agent_error` | Backend | `agent_id`, `error_code`, `model_provider` |
| `agent_restarted` | Backend | `agent_id`, `reason` |

#### Permissions Engagement

| Event | Source | Properties |
|---|---|---|
| `permission_approval_shown` | Frontend | `tool_name`, `agent_id` |
| `permission_approved` | Backend | `tool_name`, `agent_id` |
| `permission_denied` | Backend | `tool_name`, `agent_id` |
| `service_connected` | Backend | `service_type`, `user_id` |

#### Retention

- **Daily active agents:** agents that received ≥1 message that day (PostHog insight)
- **Day-7 retention:** cohort analysis by registration week
- **Tool usage heatmap:** which tools are called most, which are never used

#### Cost Controls

- Track `input_tokens + output_tokens` per user per day
- Alert (Slack or email) if any user crosses 200k tokens/day
- Hard cap: `max_agents_per_user = 1` for beta duration
- Start with 20 users on Hermes + MiniMax (~$150–200/month); expand to 50 only if Day-7 retention > 40%

---

### 1.4 Landing Page

Single page at `agenthelm.ai` (or `/beta` route in the frontend).

**Must include:**
- One-sentence value prop
- 3 bullet points (what it does)
- "Limited to 25 testers" — scarcity is real, say it
- Link to questionnaire (Tally.so or Google Forms)
- No signup wall — just the form link

---

## Part 2: Beta User Acquisition

### Pre-Qualification Questionnaire

Host on **Tally.so** (free, clean embeds). 5 questions, 2 minutes to complete.

1. **What would you use your agent for?** *(open text — primary filter)*
2. **Do you use Telegram daily?** *(yes/no — hard requirement)*
3. **Which services matter most to you?** *(checkboxes: Gmail, Calendar, GitHub, Notion, Linear, other)*
4. **Have you used AI agents before?** *(yes/no + which ones)*
5. **How did you find AgentHelm?** *(Reddit / LinkedIn / referral / other)*

**Accept:** specific use case, Telegram user, at least one target service
**Reject:** no Telegram, vague use case ("just curious"), no existing AI experience

---

### Reddit Strategy

**Target subreddits** (check posting rules before submitting):

| Subreddit | Angle |
|---|---|
| r/SideProject | Builder story — what I built and why |
| r/artificial | The permission layer angle — AI that asks before it acts |
| r/selfhosted | Hermes runtime, open deployment model |
| r/MachineLearning | MCP protocol, multi-model support |

**Post copy:**

> **Title:** I built AgentHelm — deploy AI agents connected to Gmail, Calendar, GitHub via Telegram. Looking for 25 beta testers.
>
> Hey r/SideProject,
>
> I've been building AgentHelm — a platform for deploying personal AI agents that connect to your real tools.
>
> What it does:
> - Deploy an agent in ~2 minutes (Telegram-native)
> - Connect to Gmail, Google Calendar, GitHub, Notion via MCP
> - Built-in permission layer — the agent asks before it acts on anything sensitive
> - Supports Claude and MiniMax models
>
> Why I built it: I wanted an AI that could actually act on my behalf — triage emails, prep my calendar, file issues — without babysitting every step. But I also wanted to stay in control of what it touches.
>
> Opening 25 spots for a limited beta. Fill out a short form: [link]
>
> Requirements: Telegram + a specific use case in mind. Happy to answer questions here.

---

### LinkedIn Strategy

**Audience:** founders, operators, builders who use AI in daily workflows.

**Post copy:**

> I'm opening 25 spots for a limited beta of AgentHelm.
>
> AgentHelm lets you deploy personal AI agents connected to your real tools — Gmail, Calendar, GitHub, Notion — through Telegram.
>
> What makes it different: there's a permission layer built in. Your agent asks before it acts on anything sensitive. You stay in control.
>
> If you're a builder or operator who lives in Telegram and wants an agent that actually does things — fill out the form below.
>
> 25 spots. Link in first comment.

Post the form link as the first comment (LinkedIn penalizes posts with external links in the body).

---

### Timing

| Date | Action |
|---|---|
| Apr 29–30 | Finalize both posts, get questionnaire live (Tue/Wed — avoid Friday) |
| Apr 29–30 | Post to Reddit (2–3 subreddits simultaneously) and LinkedIn |
| May 2–3 | Review submissions daily, send invite codes in batches of 10 |
| May 4 | First 10–15 users onboarded |
| May 5 | Beta open |

**First batch:** send 10 invite codes on May 2. Watch for errors 48 hours before sending the next batch. Telegram is a hard filter — expect 60-70% of applicants to fail question 2. Post to multiple subreddits simultaneously to compensate.

**What beta users get (include in all posts):** free tier for the duration of beta + lifetime discount at GA. Say this clearly in the acquisition copy — scarcity without reward doesn't convert.

### Missing Infrastructure (add before May 1)

| Item | Why | Effort |
|---|---|---|
| Privacy policy | Storing Gmail/Calendar OAuth tokens — Reddit/LinkedIn audiences will ask | 30 min |
| Status page | UptimeRobot — prevents "is this broken or just me?" support noise | 15 min |
| Beta Telegram group | Support channel for beta users — critical for retention | 5 min |
| Rollback plan | Ability to pause signups + pinned message if something breaks in first 48h | 30 min |
| Rough pricing signal | Beta users will ask what it costs after GA — have a vague answer ready | — |

---

### Cost Model

| Config | Est. cost/agent/month |
|---|---|
| Hermes + MiniMax | ~$7–10 |
| OpenClaw + Claude | ~$15–20 |

| Cohort size | Monthly cost estimate |
|---|---|
| 20 users (Hermes) | ~$150–200 |
| 50 users (Hermes) | ~$350–500 |

**Decision rule:** start with 20, expand to 50 after Day-7 retention data (target: >40% retention before scaling).
