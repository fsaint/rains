# DNS Configuration

## Provider

DNS is managed in **Vercel** under the team `fsaints-projects-a40eacec`.

Manage records at: Vercel Dashboard → Domains → `helm.mom` → DNS Records

CLI: `vercel dns ls helm.mom --scope fsaints-projects-a40eacec`

---

## Records

| Name | Type  | Value                      | Purpose                              |
|------|-------|----------------------------|--------------------------------------|
| `app` | CNAME | `agenthelm-core.fly.dev`  | Main dashboard + API (`app.helm.mom`) |
| `*`  | ALIAS | `cname.vercel-dns-017.com` | Vercel default wildcard              |

---

## Fly Apps → Hostnames

| Fly App          | Hostname                      | Purpose                    |
|------------------|-------------------------------|----------------------------|
| `agenthelm-core` | `agenthelm-core.fly.dev`      | Backend + frontend SPA     |
|                  | `app.helm.mom` (custom)  | Production-facing URL      |

**Important:** Only `agenthelm-core.fly.dev` maps to the `app.helm.mom` custom domain.

---

## Common Mistakes

**Wrong CNAME target:** Setting `app.helm.mom` to the wrong Fly app URL instead of `agenthelm-core.fly.dev`.

To fix:
```bash
# Find the wrong record ID
vercel dns ls helm.mom --scope fsaints-projects-a40eacec

# Remove it and re-add correctly
vercel dns rm <record-id> --scope fsaints-projects-a40eacec --yes
vercel dns add helm.mom app CNAME agenthelm-core.fly.dev --scope fsaints-projects-a40eacec

# Verify
nslookup app.helm.mom
# Should resolve to agenthelm-core.fly.dev
```

---

## Deployments

DNS does **not** need to be updated on deployments. `agenthelm-core.fly.dev` is a permanent Fly app name — deployments only update the container image, not the app name.
