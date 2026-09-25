# Google OAuth Verification

Everything needed to get Helm's Google Cloud app verified so customers outside a
test list can connect Gmail, Drive and Calendar.

**Decision on file:** we submit asking for full `drive`. If Google pushes back,
we narrow — see [If Google pushes back](#if-google-pushes-back).

---

## Why this is needed

Unverified apps cannot serve customers:

| Publishing status | What users get |
|---|---|
| Testing | 100 test users, each added by email. **Refresh tokens expire after 7 days**, so a background agent stops working weekly. |
| In production, unverified | The "Google hasn't verified this app" interstitial, and a 100-user cap. |
| In production, verified | No warning, no cap. |

Helm requests four **restricted** scopes, which is Google's most demanding tier:
standard verification *plus* an annual third-party security assessment (CASA).
Reading a user's mailbox is inherently restricted and is the core of the
product, so CASA cannot be avoided.

| Scope | Tier |
|---|---|
| `gmail.readonly`, `gmail.compose`, `gmail.modify` | Restricted |
| `drive` | Restricted |
| `gmail.send`, `calendar.events`, `calendar.readonly` | Sensitive |
| `userinfo.email`, `userinfo.profile` | Basic |

---

## Already in place

- Homepage at `https://helm.mom`.
- Privacy policy at `https://helm.mom/privacy`, including the Limited Use
  disclosure.
- Terms at `https://app.helm.mom/terms` (a subdomain of the authorized domain,
  which is acceptable).
- Credentials encrypted at rest with AES-256-GCM.
- Every write is gated behind a human approval the owner receives on Telegram.

## To do before submitting

- [ ] Verify ownership of `helm.mom` in Google Search Console, **using the same
      Google account that owns the Cloud project**. Verification fails
      otherwise, and this is the most common avoidable rejection.
- [ ] Add `helm.mom` as an authorized domain on the consent screen.
- [ ] Upload a 120×120 PNG logo. The app name must match the branding on the
      homepage exactly: **Helm**.
- [ ] Record the demo video (script below) and publish it on YouTube.
- [ ] Paste the justifications below, one per scope.

---

## Console settings

OAuth consent screen, Google Cloud Console → APIs & Services.

| Field | Value |
|---|---|
| User type | External |
| Publishing status | In production |
| App name | Helm |
| Authorized domain | `helm.mom` |
| Homepage | `https://helm.mom` |
| Privacy policy | `https://helm.mom/privacy` |
| Terms of service | `https://app.helm.mom/terms` |
| Authorized redirect URIs | `https://app.helm.mom/api/oauth/google/callback`<br>`https://app.helm.mom/api/auth/google/callback` |

The two redirect URIs are distinct on purpose: the first connects a Google
account as a *credential an agent may use*, the second is dashboard sign-in.

---

## Scope justifications

Google asks, per scope: what the app does with it, and why a narrower scope will
not do. Keep these answers specific — naming the actual operations is what gets
them accepted. Update this file whenever the tool list changes.

### `gmail.readonly`

> Helm is an assistant that acts on a user's own mailbox on their instruction.
> This scope backs the read operations: listing and searching messages, opening
> a single message, and fetching an attachment the user asked about. Without it
> the assistant cannot see the message the user is referring to, which is the
> starting point of nearly every request ("what did Ana say about the invoice?",
> "reply to the last message in this thread").
>
> `gmail.metadata` is not sufficient: it omits message bodies, and the body is
> exactly the content the user is asking us to read, summarise, or reply to.

### `gmail.compose`

> Used to create drafts in the user's mailbox: the assistant writes a reply and
> leaves it as a draft for the user to review, edit and send themselves.
>
> This is a deliberate safety choice. Helm prefers drafting over sending, so the
> user sees the exact text before anything leaves their account. Removing this
> scope would push the product toward sending directly, which is strictly worse
> for the user.

### `gmail.modify`

> Backs the inbox triage the user explicitly asks for: archiving a message,
> marking it read, applying and removing labels, and creating or deleting a
> label. Each of these changes message state and therefore requires `modify`.
>
> `gmail.labels` is not sufficient: it covers label management but not archiving
> or read state, which are the two most common triage actions users request.

### `gmail.send`

> Sends a message, or sends a draft the user has already reviewed. Every send
> passes through an approval the account owner must grant before the call
> executes; the owner sees the rendered recipient, subject and body first.

### `drive` (full)

> Helm lets the account owner scope an agent to **specific folders they already
> own**, including shared drives, and the agent then reads and writes only
> inside them. The owner picks those folders in Helm's dashboard, and the
> restriction is enforced server-side on every call: a file outside the allowed
> folders is refused before any Drive request is made.
>
> The operations are listing and searching files, reading a file's contents,
> reading metadata, enumerating shared drives, and creating or updating a file
> in an allowed folder.
>
> `drive.file` is not sufficient. It reaches only files the app itself created
> or that the user selected one at a time through the Google Picker. It cannot
> express "this existing folder and everything under it", which is precisely the
> grant our users make, and it cannot enumerate shared drives at all. The
> narrowing users actually want is per-folder and durable, and Helm implements
> that narrowing itself rather than asking the user to re-pick files for every
> request.

### `calendar.events` and `calendar.readonly`

> Reading the user's calendar to answer scheduling questions and check
> availability (listing and searching events, opening an event, listing
> calendars, querying free/busy), and creating or updating events when the user
> asks. Event writes require the owner's approval, as with mail.

### `userinfo.email` and `userinfo.profile`

> Identifies the Google account being connected, so it can be shown to the
> owner as a named account in the dashboard and matched to their Helm account
> at sign-in. No profile data is used for anything else.

### Limited Use

> Helm's use of information received from Google APIs adheres to the Google API
> Services User Data Policy, including the Limited Use requirements. Google user
> data is used only to provide the features the user has asked for. It is never
> sold, never used for advertising, and never used to train generalised AI
> models. Human access occurs only with the user's explicit consent, for
> security purposes, or where required by law.

---

## Demo video script

Requirements Google enforces: in English, publicly viewable on YouTube, the
OAuth consent screen shown with the **client ID legible in the browser URL bar**,
and every requested scope demonstrated actually being used. Reviewers reject
videos that show the app but never the consent screen, and videos where the
client ID cannot be read.

1. **Identity.** `https://helm.mom`, showing the name and what the product does.
2. **Consent.** Start the Google connection from the dashboard. Zoom the URL bar
   so `client_id` is readable, then show the consent screen listing the scopes.
   Complete the grant.
3. **Connected account.** The Credentials page showing the account now linked.
4. **`gmail.readonly`.** Ask the agent to find and summarise an email. Show the
   message it read.
5. **`gmail.compose`.** Ask for a reply. Show the resulting draft in Gmail.
6. **`gmail.send`.** Approve the send. Show it in Sent.
7. **`gmail.modify`.** Ask it to archive and label a message. Show the label in
   Gmail.
8. **`drive`.** Show the folder picker, scope the agent to one folder, have it
   read a file there and write one back. Then show a file *outside* that folder
   being refused — this demonstrates the narrowing the justification claims.
9. **`calendar`.** Check free/busy, create an event, show it in Google Calendar.
10. **Human approval.** Show the Telegram approval prompt for a write, and a
    denial taking effect.
11. **Revocation.** Delete the credential in Helm, and show the same app listed
    under the user's Google account permissions.

Step 8's refusal and step 10 are the strongest parts of the submission. They
show restrictions working rather than asserted.

---

## CASA

Triggered by the restricted scopes, after the initial review.

- An assessor from Google's authorized list runs a Tier 2 assessment: a scan of
  the application, remediation of findings, then a Letter of Validation.
- Budget several thousand US dollars and roughly four to twelve weeks end to
  end, including Google's own review. Confirm current pricing directly, as it
  moves.
- **It repeats annually.** Put a reminder in the calendar at eleven months.
- Likely areas of scrutiny, given this codebase: credential encryption at rest,
  the OAuth token refresh path, access control between agents and their owner's
  data, and deletion on request.

---

## If Google pushes back

Expected, and the fallback is already scoped.

1. **Narrow Drive.** Move the services that can live with it to `drive.file`,
   and keep full `drive` only for shared-drive enumeration, or drop that feature
   for verification. This is the concession to make first, because full `drive`
   draws the most scrutiny.
2. **Make consent incremental.** `googleScopesFor` in
   `backend/src/api/routes.ts` currently falls back to requesting *every* Google
   scope when no service is named. The per-service path already exists — making
   it the default means a user connecting only Gmail is never asked for Drive or
   Calendar. Reviewers read a blanket request as over-asking, and this is a
   small change with real review value.
3. **Split the client.** If Drive remains contentious, a separate Cloud project
   for Drive keeps Gmail and Calendar verification unblocked.

---

## While verification is pending

If a customer is a Google Workspace organisation, their admin can allowlist
Helm's OAuth client in the Admin console under **Security → API controls → App
access control** and mark it trusted. Users in that tenant then skip the
unverified-app warning. This is the practical way to onboard business customers
before verification completes. Confirm with the customer's admin how it
interacts with the unverified-app user cap before relying on it for a large
rollout.
