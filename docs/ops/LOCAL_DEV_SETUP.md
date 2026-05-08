# Local Development Setup

## Prerequisites

- Node.js 20+
- A Cloudflare or ngrok tunnel (for Telegram webhooks)
- Access to Google Cloud Console (to register redirect URIs)

---

## 1. Environment Variables (`.env`)

Create a `.env` file at the repo root. It is gitignored and never deployed.

```bash
# ── Server ────────────────────────────────────────────────────────────────────
NODE_ENV=development
REINS_PORT=5001

# ── Database ──────────────────────────────────────────────────────────────────
DATABASE_URL=postgresql://localhost:5432/reins

# ── Security ──────────────────────────────────────────────────────────────────
REINS_ENCRYPTION_KEY=<32-byte hex>
REINS_SESSION_SECRET=<random string>
REINS_ADMIN_EMAIL=admin@reins.local
REINS_ADMIN_PASSWORD=<password>

# ── URLs ──────────────────────────────────────────────────────────────────────
# After Google SSO login, the backend redirects here.
# Set to your local frontend port (Vite picks the first available: 5173, 6173, 6174, 6175...)
REINS_DASHBOARD_URL=http://localhost:6175
REINS_PUBLIC_URL=http://localhost:5001

# ── Google OAuth ──────────────────────────────────────────────────────────────
GOOGLE_CLIENT_ID=<client-id>.apps.googleusercontent.com
GOOGLE_CLIENT_SECRET=<client-secret>
GOOGLE_REDIRECT_URI=http://localhost:5001/api/oauth/google/callback
GOOGLE_LOGIN_REDIRECT_URI=http://localhost:5001/api/auth/google/callback

# ── Microsoft OAuth ───────────────────────────────────────────────────────────
MICROSOFT_CLIENT_ID=<client-id>
MICROSOFT_CLIENT_SECRET=<client-secret>
MICROSOFT_REDIRECT_URI=http://localhost:5001/api/oauth/microsoft/callback

# ── Telegram — Dev Onboarding Bot ─────────────────────────────────────────────
# Bot: @AgentHelmDevOnboarding_bot (dev-only, created 2026-05-06)
ONBOARDING_BOT_TOKEN=8743877270:AAEljlqRVloCbs_ztR9VqOvTczD7nLncuCc

# ── Fly.io (agent provisioning) ───────────────────────────────────────────────
FLY_API_TOKEN=<dev org token>
FLY_ORG=reins-dev
OPENCLAW_APP=agentx-openclaw

# ── Anthropic ─────────────────────────────────────────────────────────────────
ANTHROPIC_API_KEY=<key>
```

---

## 2. Google Cloud Console — Authorized Redirect URIs

The same OAuth client ID is used for dev and prod. You must register **all** redirect
URIs in Google Cloud Console:

**Console → APIs & Services → Credentials → your OAuth 2.0 Client**

### Authorized JavaScript Origins
```
http://localhost:6175
https://app.agenthelm.mom
```

### Authorized Redirect URIs
```
http://localhost:5001/api/auth/google/callback      <- Dashboard login (dev)
http://localhost:5001/api/oauth/google/callback     <- Gmail credential flow (dev)
https://app.agenthelm.mom/api/auth/google/callback  <- Dashboard login (prod)
https://app.agenthelm.mom/api/oauth/google/callback <- Gmail credential flow (prod)
```

> **Error 400: redirect_uri_mismatch** means a URI is missing from this list.

---

## 3. Telegram Webhook Tunnel

A permanent Cloudflare tunnel routes `reins-dev.btv.pw → localhost:5001`.
Start it before running the backend:

```bash
cloudflared tunnel run development-tunnel > /tmp/cf-dev-tunnel.log 2>&1 &
```

Verify it's up:
```bash
tail -3 /tmp/cf-dev-tunnel.log
# Should show: Registered tunnel connection connIndex=...
```

The tunnel config lives at `~/.cloudflared/config.yml` — no changes needed.

---

## 4. Telegram Webhook

The dev onboarding bot webhook is permanently set to `https://reins-dev.btv.pw/telegram`.
No action needed on each restart — the URL is stable.

If you ever need to re-register it (e.g. after recreating the bot):

```bash
TOKEN=8743877270:AAEljlqRVloCbs_ztR9VqOvTczD7nLncuCc
curl "https://api.telegram.org/bot${TOKEN}/setWebhook?url=https://reins-dev.btv.pw/telegram"
```

Verify:
```bash
curl -s "https://api.telegram.org/bot${TOKEN}/getWebhookInfo" | python3 -m json.tool
```

---

## 5. Starting the Dev Servers

```bash
# Backend (port 5001)
npm run dev:backend

# Frontend (Vite — picks first available port starting at 5173)
npm run dev:frontend
# Note the port Vite selects and update REINS_DASHBOARD_URL in .env if needed
```

Or both together:
```bash
npm run dev
```

---

## 6. Dev Bot Reference

| Bot | Username | Purpose | Token env var |
|-----|----------|---------|---------------|
| `@AgentHelmDevOnboarding_bot` | Dev onboarding entry point | `ONBOARDING_BOT_TOKEN` |
| `@reins_dev_bot` | Dev approvals / notify bot | `REINS_TELEGRAM_BOT_TOKEN` |

Production bots (`@SpecialAgentHelmBot`, `@AgentHelmApprovalsBot`) are configured
via Fly secrets and are never touched locally.

---

## 7. Vite Port Note

Vite auto-increments the port if the default (5173) is in use. After starting the
frontend, check the terminal output for the actual port and make sure
`REINS_DASHBOARD_URL` in `.env` matches it. Common values: `5173`, `6173`, `6174`, `6175`.
