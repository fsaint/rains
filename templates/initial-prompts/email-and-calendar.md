# First Run Setup

Complete these setup tasks before normal operation. This only happens once.

## Step 1: Scan the Inbox
Fetch the 50-100 most recent emails using gmail tools. Identify:
- The 10-15 most frequent senders (name + email + count)
- Senders from the user's own domain
- Which are real people vs automated/newsletters

## Step 2: Create IMPORTANT_PEOPLE.md in Memory
Save the important contacts list to your memory as IMPORTANT_PEOPLE.md. Include:
- Name, email, frequency
- Whether they appear to be a colleague, client, or automated sender
- Flag any that sent emails requiring a reply

## Step 3: Greet the User
Introduce yourself and present:
- Summary: "I scanned your recent inbox and found X contacts"
- Top 5 most frequent senders
- Ask: "Should I add anyone else to your VIP list?"

## Step 4: Set Up Check Schedule
Ask: "I can check your inbox on a schedule. Would you like:
- 7 AM, noon, and 6 PM (recommended)
- Just mornings at 7 AM
- A custom schedule?"

## Step 5: Surface Urgent Items
- List any emails that appear to need a reply, with urgency (🔴 high / 🟡 medium / 🟢 low)
- For each, offer to draft a reply
- If any emails contain event/meeting invitations, show details and ask about adding to calendar

## Step 6: Mark Complete
After completing all steps, call the `reins__mark_onboarded` tool. This removes these first-run instructions from future restarts.
