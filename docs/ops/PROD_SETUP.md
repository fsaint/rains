# Production Setup Checklist

## Google OAuth (GCP)

OAuth client: the same client ID used for dev, or a separate prod client.

### Authorized JavaScript Origins
```
https://reins.btv.pw
```

### Authorized Redirect URIs
```
https://reins.btv.pw/api/oauth/google/callback   ← Gmail credential flow
https://reins.btv.pw/api/auth/google/callback    ← Dashboard login (Google SSO)
```

### Environment variables (prod backend)
```
GOOGLE_CLIENT_ID=<your-client-id>.apps.googleusercontent.com
GOOGLE_CLIENT_SECRET=<your-client-secret>
GOOGLE_REDIRECT_URI=https://reins.btv.pw/api/oauth/google/callback
GOOGLE_LOGIN_REDIRECT_URI=https://reins.btv.pw/api/auth/google/callback
```

### GCP App status
- Must be in **Testing** mode with all beta users added as test users, OR
- Published (requires OAuth verification for sensitive scopes like Gmail)

---

## Telegram Bots

| Bot | Purpose | Token env var |
|-----|---------|---------------|
| `@SpecialAgentHelmBot` | Onboarding bot (user-facing) | `ONBOARDING_BOT_TOKEN` (onboarding service) |
| `@ReinsVerification` | Approvals / notify bot (prod) | `REINS_TELEGRAM_BOT_TOKEN` (backend) |

Dev uses `@reins_dev_bot` for the approvals bot.

### Onboarding bot env vars (prod)
```
WEBHOOK_URL=https://<onboarding-service-url>
NODE_ENV=production
```

In production the onboarding bot registers a Telegram webhook instead of using long polling.

---

## Backend env vars (prod vs dev differences)

| Variable | Dev | Prod |
|----------|-----|------|
| `REINS_PUBLIC_URL` | `https://reins-dev.btv.pw` | `https://reins.btv.pw` |
| `REINS_DASHBOARD_URL` | `https://reins-dev.btv.pw` | `https://reins.btv.pw` |
| `GOOGLE_REDIRECT_URI` | `http://localhost:5001/api/oauth/google/callback` | `https://reins.btv.pw/api/oauth/google/callback` |
| `GOOGLE_LOGIN_REDIRECT_URI` | `http://localhost:5001/api/auth/google/callback` | `https://reins.btv.pw/api/auth/google/callback` |
| `REINS_TELEGRAM_BOT_TOKEN` | `@reins_dev_bot` token | `@ReinsVerification` token |
| `NODE_ENV` | `development` | `production` |

---

## Onboarding bot persona (prod vs dev differences)

In `onboarding/src/persona.ts`, the notify bot reference changes:
- Dev: `@reins_dev_bot`
- Prod: `@ReinsVerification`

The done message dashboard URL also needs to point to prod:
- Dev: `https://reins-dev.btv.pw`
- Prod: `https://reins.btv.pw`

Set these in the onboarding service `.env`:
```
NOTIFY_BOT_USERNAME=ReinsVerification
DASHBOARD_URL=https://reins.btv.pw
```
