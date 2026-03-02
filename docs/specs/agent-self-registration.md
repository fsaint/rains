# Agent Self-Registration Flow

## Overview

Users can delegate agent registration to their AI agents. The agent registers itself and provides a simple way for the user to claim it.

## User Experience

### Step 1: User Gives Agent Instructions

User provides their AI agent with a prompt like:

```
Register yourself with my Reins dashboard at: http://localhost:3000/api/agents/register

You'll receive a claim code and link. Share the link with me so I can complete registration.
```

### Step 2: Agent Self-Registers

Agent calls the registration endpoint:

```bash
curl -X POST http://localhost:3000/api/agents/register \
  -H "Content-Type: application/json" \
  -d '{"name": "My Claude Agent", "description": "Development assistant"}'
```

Response:
```json
{
  "agentId": "abc123",
  "claimCode": "XK7M2P",
  "claimUrl": "http://localhost:5173/claim/XK7M2P",
  "expiresAt": "2024-01-01T12:10:00Z",
  "expiresInSeconds": 600,
  "instructions": "Share this link with your user to complete registration: http://localhost:5173/claim/XK7M2P (expires in 10 minutes)"
}
```

### Step 3: Agent Shares Link

Agent tells the user:

> I've registered myself with Reins. Click this link to complete the registration:
> **http://localhost:5173/claim/XK7M2P**
>
> This link expires in 10 minutes.

### Step 4: User Claims Agent

User clicks the link → Dashboard opens with pre-filled claim code → One click to confirm.

Alternatively, user can manually enter the 6-character code in the dashboard.

### Step 5: Agent Polls for Confirmation

Agent can poll the status endpoint to confirm registration:

```bash
curl http://localhost:3000/api/agents/register/abc123/status
```

Response when claimed:
```json
{
  "status": "claimed",
  "agent": {
    "id": "abc123",
    "name": "My Claude Agent",
    "status": "active"
  }
}
```

## API Endpoints

### POST /api/agents/register
Register a new agent (no auth required).

**Request:**
```json
{
  "name": "Agent Name",
  "description": "Optional description"
}
```

**Response:**
```json
{
  "agentId": "string",
  "claimCode": "string (6 chars)",
  "claimUrl": "string (direct link)",
  "expiresAt": "ISO timestamp",
  "expiresInSeconds": 600,
  "instructions": "Human-readable instructions for agent to share"
}
```

### GET /api/agents/register/:agentId/status
Check registration status (no auth required).

**Response:**
```json
{
  "status": "pending | claimed | expired | not_found",
  "agent": { ... } // Only if claimed
}
```

### POST /api/agents/claim
Claim an agent with code (dashboard auth required).

**Request:**
```json
{
  "code": "XK7M2P"
}
```

## Frontend Routes

### /claim/:code
Direct claim page - pre-fills the claim code and shows agent details for one-click confirmation.

## Security Considerations

1. **No auth for registration** - Agents can register without credentials
2. **Claim requires dashboard access** - Only authenticated dashboard users can claim
3. **Short expiry** - Codes expire in 10 minutes
4. **Rate limiting** - Prevent registration spam (TODO)
5. **Claim code entropy** - 6 alphanumeric chars = ~1 billion combinations

## Example Agent Prompt

Users can give this to their AI agent:

```
Register yourself as an agent with my Reins dashboard:

1. Make a POST request to: http://localhost:3000/api/agents/register
   Body: {"name": "YOUR_NAME", "description": "Brief description of your purpose"}

2. You'll receive a response with a claimUrl. Share that URL with me.

3. After I click the link, you can verify registration by checking:
   GET http://localhost:3000/api/agents/register/{agentId}/status
```
