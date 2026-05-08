---
name: onboarding-flow-test
description: Run the Reins onboarding bot end-to-end test via Playwright MCP on Telegram Web. Use when the user asks to "test the onboarding flow", "run the onboarding test", "verify the bot flow works", or "test signup".
---

# Onboarding Flow Test — Telegram Bot E2E

Tests the full user onboarding flow: qualification → approval → Gmail OAuth → notify bot → agent deployment → ping → browser.

The platform provides the LLM API key (Anthropic) and the shared Telegram bot — users no longer supply a MiniMax key or create their own bot via BotFather.

## Prerequisites

| Requirement | Details |
|-------------|---------|
| Playwright MCP | Must be connected (`claude mcp list` shows `playwright: ✓ Connected`) |
| Backend | Running on port 5001 (`lsof -i :5001`) |
| Onboarding bot | Running on port 3001 (`lsof -i :3001`) |
| Telegram Web session | Already logged in at web.telegram.org |
| Test user ID | `5982613183` (fsaint's Telegram account) |

## Key Resources

| Resource | Value |
|----------|-------|
| Onboarding bot | `@SpecialAgentHelmBot` |
| Admin approval group | `Agent Helm Verifications` (group, not a bot — use search) |
| Notify bot (prod) | `@AgentHelmApprovalsBot` (chatlist href `#8781774032`) |
| Shared agent bot (dev) | `@AgentHelmDevPilot_bot` (chatlist href `#8578547339`) |
| Google account | `fsaint@gmail.com` |
| Test use case answer | `Email management and scheduling` |

## Test Steps

### 1. Reset state

**Delete old chat with SpecialAgentHelmBot:**
```js
// Right-click the chat via JS (Telegram Web ignores synthetic events for navigation,
// but contextmenu fires correctly)
const chat = [...document.querySelectorAll('.chatlist-chat')]
  .find(el => el.querySelector('.peer-title')?.textContent.includes('Special Agent Helm'));
chat.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, ... }));
// Then click "Delete chat" button via snapshot ref → confirm
```

**Reset user in Agent Helm Verifications:**
- Search for the group (it has no @username — use the search box)
- Click result via `page.mouse.click(x, y)` at the bounding box center (JS `.click()` doesn't trigger navigation in Telegram Web — always use real mouse events)
- Send: `/reset_5982613183`

### 2. Start fresh chat

- Search `SpecialAgentHelmBot` → find under "Global search" → click item
- URL becomes `https://web.telegram.org/k/#@SpecialAgentHelmBot`
- Click the `START` button (it has `role="button"` and name "START")

### 3. Qualification

- Bot asks: "What would you use a personal AI agent for?"
- Send any answer, e.g. `Email management and scheduling`
- Bot asks for Gmail address → send `fsaint@gmail.com`
- Bot responds: "Waiting on clearance."

### 4. Approve in Agent Helm Verifications

- Navigate back to Agent Helm Verifications (search → mouse click at bounding box)
- Send: `/approve_5982613183`
- Bot confirms: "Approved 5982613183"

### 5. Gmail OAuth

- Switch to Special Agent Helm chat (sidebar click at ~y=383 when it's the second item)
- Click "Connect Gmail →" button (get bounding box, use `page.mouse.click`)
- Telegram shows "Open Link" dialog → click the "Open" button (use snapshot ref)
- A new tab opens with Google OAuth
- Switch to tab 1: `browser_tabs({ action: 'select', index: 1 })`
- Google shows passkey prompt → click "Try another way" → "Tap Yes on your phone or tablet"
- Google sends push notification to iPhone/iPad → user taps Yes
- Wait for redirect in a polling loop (check `page.url()` every 2s)
- After redirect, page lands at `t.me/SpecialAgentHelmBot` — OAuth complete
- Switch back to tab 0 (Telegram Web)

### 6. Notify bot

- Bot shows: "Gmail connected." then the notify-bot instructions
- Bot asks user to message `@AgentHelmApprovalsBot` (dev: `@reins_dev_bot`)
- Dev: use `page.locator('a[href="#8641616936"]').click()` to navigate to `@reins_dev_bot`
- Send any message (e.g. `hi`)
- Bot replies: "Got it. Heading back to set up your agent."

### 7. Verify deployment success

Switch to the onboarding bot chat. Expected final messages:
- "Your agent is spinning up. Stand by."
- "Deploying your agent. This takes a moment."
- **"You're all set. Your agent is live."**
- Link to the dashboard

### 8. Ping test — agent is alive

The agent now runs on the **shared bot** (`@AgentHelmDevPilot_bot` in dev):
- Click `a[href="#8578547339"]` in the chatlist
- Send: `hello`
- **Pass:** agent replies within ~30s with any coherent response
- **Fail:** no response after 60s, or error message

Poll for response (check last message every 3s for up to 60s):
```js
const msgs = document.querySelectorAll('[class*="message "]');
const lastText = Array.from(msgs).at(-1)?.textContent;
// Pass if lastText doesn't match the 'hello' we just sent
```

### 9. Browser test — agent can use browser tool

Still in the shared bot chat, send:
```
Go to https://example.com and tell me the page title
```

**Pass:** agent replies with "Example Domain" (the actual title of example.com) within ~90s.
The response confirms:
- The browser MCP server is wired up correctly
- The agent can reach external URLs through Reins
- Shared-bot routing → OpenClaw → tool call pipeline is working end-to-end

Poll for response up to 90s. Accept any reply that contains "Example Domain" or "example.com".

## Playwright Navigation Notes

Telegram Web's custom event system requires **real mouse events**, not JS `.click()`:

```js
// ✅ Works — triggers Telegram's routing
const bbox = await element.boundingBox();
await page.mouse.click(bbox.x + bbox.width/2, bbox.y + bbox.height/2);

// ❌ Does NOT trigger navigation
element.click();  // JS synthetic click
await page.getByText('...').click();  // Playwright locator click (works for buttons/inputs, not chat rows)
```

**Exception:** Standard buttons (START, Delete chat confirm, OPEN link dialog) work fine with Playwright locator clicks.

## Quick Reset Script

To reset and rerun without writing new code, use the Telegram Bot API directly:

```bash
# Check onboarding bot username
curl -s "https://api.telegram.org/bot$(grep ONBOARDING_BOT_TOKEN /Users/fsaint/git/rains/onboarding/.env | cut -d= -f2)/getMe" | python3 -c "import sys,json; print(json.load(sys.stdin)['result']['username'])"
```
