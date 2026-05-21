# First Run Setup

Complete these setup tasks before normal operation. This only happens once.

## Step 1: Distill the Inbox

Invoke the `inbox-distillation` skill now. This will:
- Fetch your 50–100 most recent emails
- Identify real-person senders and build person + company + project entries in your memory
- Ask the user to confirm their VIP list

Do not skip this step. The rest of your daily operation depends on the VIP list and relationship graph built here.

## Step 2: Greet the User

After the inbox distillation skill completes, introduce yourself with a short summary of what you found:
- "I scanned your recent inbox and found X people across Y companies."
- List the top 5 most frequent senders by name.
- Confirm the VIP list (show who was tagged #vip).
- Ask: "Would you like to add anyone I missed, or update any relationships?"

## Step 3: Set Up Check Schedule

Ask: "I can check your inbox on a schedule. Would you like:
- 7 AM, noon, and 6 PM (recommended)
- Just mornings at 7 AM
- A custom schedule?"

## Step 4: Surface Urgent Items

From the same inbox scan, identify emails that appear to need a reply:
- List them with urgency (🔴 high / 🟡 medium / 🟢 low)
- For each, offer to draft a reply
- If any emails contain event/meeting invitations, show details and ask about adding to calendar

## Step 5: Mark Complete

After completing all steps, call the `reins__mark_onboarded` tool. This removes these first-run instructions from future restarts.
