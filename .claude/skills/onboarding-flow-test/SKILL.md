---
name: onboarding-flow-test
description: Run the Reins onboarding bot end-to-end test via Playwright MCP on Telegram Web. Use when the user asks to "test the onboarding flow", "run the onboarding test", "verify the bot flow works", or "test signup".
---

# Onboarding Flow Test — Telegram Bot E2E

Tests the full user onboarding flow: qualification → approval → Gmail OAuth → MiniMax key → bot token → notify bot → agent deployment.

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
| Notify bot | `@ReinsVerification_bot` |
| Existing test bot token | `8366850213:AAFt9w_bREQ5NljZlKsa-tDxNEv1_bM3nJ8` (`@fsaintPA_bot`) |
| MiniMax key | `sk-cp-_zlONXjCyfdV-hnNIIWC98OG_p1PNEip3vpYb6LAlwxxmofd9P9Y0VxqDgv6Ft9GloVLISOddADnohlm3BXwQYUaowLIFepLRX9r5q532JsT17LxH8M58cA` |
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

### 6. MiniMax key

- Bot shows: "Gmail connected. Head to platform.minimax.io..."
- Send the MiniMax key

### 7. Bot token

- Bot asks for a Telegram bot token from BotFather
- Send the existing `fsaintPA_bot` token (no need to create a new bot each run)
- Do NOT run `/newbot` — just paste the token directly

### 8. Notify bot

- Bot asks user to message `@ReinsVerification_bot`
- Search for `ReinsVerification` → click it
- Send any message (e.g. `hi`)
- Bot replies: "Got it. Heading back to set up your agent."

### 9. Verify success

Switch to Special Agent Helm chat. Expected final messages:
- "Your agent is spinning up. Stand by."
- "Deploying your agent. This takes a moment."
- **"You're all set. Your agent is live."**
- Link to `https://reins.btv.pw`

Also check `@fsaintPA_bot` — it should say: **"Your agent is online. I'm ready."**

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
