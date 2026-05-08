# DNS Configuration

## Provider

DNS is managed in **Vercel** under the team `fsaints-projects-a40eacec`.

Manage records at: Vercel Dashboard → Domains → `agenthelm.mom` → DNS Records

CLI: `vercel dns ls agenthelm.mom --scope fsaints-projects-a40eacec`

---

## Records

| Name | Type  | Value                      | Purpose                              |
|------|-------|----------------------------|--------------------------------------|
| `app` | CNAME | `agenthelm-core.fly.dev`  | Main dashboard + API (`app.agenthelm.mom`) |
| `*`  | ALIAS | `cname.vercel-dns-017.com` | Vercel default wildcard              |

---

## Fly Apps → Hostnames

| Fly App          | Hostname                      | Purpose                    |
|------------------|-------------------------------|----------------------------|
| `agenthelm-core` | `agenthelm-core.fly.dev`      | Backend + frontend SPA     |
|                  | `app.agenthelm.mom` (custom)  | Production-facing URL      |
| `agenthelm-onboarding` | `agenthelm-onboarding.fly.dev` | Telegram onboarding bot |
| `reins-openclaw` | `reins-openclaw.fly.dev`      | OpenClaw image registry    |
| `reins-hermes`   | `reins-hermes.fly.dev`        | Hermes image registry      |
| `reins-*`        | `reins-<id>.fly.dev`          | Dynamically provisioned agent machines (NOT mapped to custom domain) |

**Important:** Only `agenthelm-core.fly.dev` maps to the `app.agenthelm.mom` custom domain.
Agent machines (`reins-*`) are internal Fly apps and must never be used as the CNAME target for any custom domain.

---

## Common Mistakes

**Wrong CNAME target:** Setting `app.agenthelm.mom` to a `reins-*.fly.dev` agent machine URL instead of `agenthelm-core.fly.dev`. This causes the OpenClaw console UI to be served instead of the AgentHelm dashboard.

To fix:
```bash
# Find the wrong record ID
vercel dns ls agenthelm.mom --scope fsaints-projects-a40eacec

# Remove it and re-add correctly
vercel dns rm <record-id> --scope fsaints-projects-a40eacec --yes
vercel dns add agenthelm.mom app CNAME agenthelm-core.fly.dev --scope fsaints-projects-a40eacec

# Verify
nslookup app.agenthelm.mom
# Should resolve to agenthelm-core.fly.dev
```

---

## Deployments

DNS does **not** need to be updated on deployments. `agenthelm-core.fly.dev` is a permanent Fly app name — deployments only update the container image, not the app name.
