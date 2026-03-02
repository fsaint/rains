# Reins Testing Guide

This guide will walk you through validating the first operational version of Reins.

## Prerequisites

- Node.js 20+
- npm 10+

## Quick Start

```bash
# 1. Install dependencies
npm install

# 2. Build the shared package
npm run build --workspace=shared

# 3. Start the backend (in terminal 1)
npm run dev --workspace=backend

# 4. Start the frontend (in terminal 2)
npm run dev --workspace=frontend
```

## Verification Steps

### 1. Backend Health Check

With the backend running, verify it's operational:

```bash
curl http://localhost:3000/health
```

Expected response:
```json
{"status":"ok","timestamp":"2026-03-01T..."}
```

### 2. Frontend Dashboard

Open your browser to: **http://localhost:5173**

You should see:
- Sidebar with navigation (Dashboard, Agents, Policies, Credentials, Approvals, Audit Log)
- Dashboard showing stats cards (Active Agents, Policies, Credentials, Pending Approvals)
- System status indicator showing "Online"

### 3. Create a Policy

1. Navigate to **Policies** in the sidebar
2. Click **Create Policy**
3. Enter the following:
   - **Name:** `Gmail Read-Only`
   - **YAML:**
   ```yaml
   version: "1.0"
   services:
     gmail:
       tools:
         allow:
           - gmail_list_messages
           - gmail_read_message
           - gmail_search
         block:
           - gmail_send_message
           - gmail_delete_message
       approval_required:
         - gmail_create_draft
   ```
4. Click **Create Policy**
5. Verify the policy appears in the list

### 4. Register an Agent

1. Navigate to **Agents** in the sidebar
2. Click **Add Agent**
3. Enter:
   - **Name:** `Test Agent`
   - **Description:** `Testing Reins functionality`
   - **Policy:** Select the "Gmail Read-Only" policy you created
4. Click **Create Agent**
5. Verify the agent appears in the list with "pending" status

### 5. Activate the Agent

1. In the Agents list, find your Test Agent
2. Click the power icon to activate it
3. Verify the status changes to "active"

### 6. Add a Credential

1. Navigate to **Credentials** in the sidebar
2. Click **Add Credential**
3. Enter:
   - **Service ID:** `gmail`
   - **Type:** `API Key`
   - **API Key:** `test-api-key-12345` (for testing only)
4. Click **Add Credential**
5. Verify the credential appears in the list
6. Click the refresh icon to check health (should show "Valid")

### 7. Verify Audit Log

1. Navigate to **Audit Log** in the sidebar
2. You should see entries for:
   - Policy creation
   - Agent registration
   - (Any other actions you performed)
3. Test the filters:
   - Filter by "Policy Changes"
   - Filter by "Success" results

### 8. API Testing

Test the REST API directly:

```bash
# List agents
curl http://localhost:3000/api/agents

# List policies
curl http://localhost:3000/api/policies

# List credentials (metadata only)
curl http://localhost:3000/api/credentials

# Get audit logs
curl http://localhost:3000/api/audit

# Validate a policy
curl -X POST http://localhost:3000/api/policies/test/validate \
  -H "Content-Type: application/json" \
  -d '{"yaml":"version: \"1.0\"\nservices:\n  test:\n    tools:\n      allow:\n        - read"}'
```

### 9. WebSocket Connection (Optional)

Test real-time updates by connecting to the WebSocket:

```javascript
// In browser console at http://localhost:5173
const ws = new WebSocket('ws://localhost:5173/ws');
ws.onmessage = (e) => console.log('Received:', JSON.parse(e.data));
ws.onopen = () => console.log('Connected');
```

Create an approval request via API to see real-time updates:
```bash
# This would normally be triggered by the MCP proxy
curl -X POST http://localhost:3000/api/approvals \
  -H "Content-Type: application/json" \
  -d '{"agentId":"test","tool":"gmail_create_draft","arguments":{}}'
```

## Expected Behaviors

### Policy Engine

| Tool | Policy Action | Expected Result |
|------|---------------|-----------------|
| `gmail_list_messages` | allow | Passes through |
| `gmail_send_message` | block | Returns blocked error |
| `gmail_create_draft` | approval_required | Queues for approval |

### Dashboard Features

| Feature | Expected Behavior |
|---------|-------------------|
| Stats cards | Update when data changes |
| Agent status toggle | Switches between active/suspended |
| Policy editor | Shows syntax validation errors |
| Credential health check | Shows valid/invalid/expired status |
| Approval queue | Lists pending approvals with approve/reject |
| Audit log | Paginated, filterable, exportable to CSV |

## Troubleshooting

### Backend won't start

```bash
# Check for port conflicts
lsof -i :3000

# Check logs
REINS_LOG_LEVEL=debug npm run dev --workspace=backend
```

### Frontend won't connect to backend

Verify the Vite proxy is working:
```bash
# Check that /api routes are proxied
curl http://localhost:5173/api/health
```

### Database errors

The database is auto-created at `./data/reins.db`. To reset:
```bash
rm -rf ./data/reins.db
npm run dev --workspace=backend
```

### TypeScript errors

```bash
# Rebuild shared types
npm run build --workspace=shared

# Check all workspaces
npm run typecheck
```

## Test Coverage (Future)

Run tests once implemented:
```bash
# Run all tests
npm test

# Run with coverage
npm run test:coverage

# Watch mode
npm run test:watch
```

## Success Criteria

The first version is operational when:

- [ ] Backend starts without errors
- [ ] Frontend loads and displays dashboard
- [ ] Can create policies with valid YAML
- [ ] Can register and manage agents
- [ ] Can store and check credentials
- [ ] Audit log captures all actions
- [ ] Real-time updates work via WebSocket
- [ ] All API endpoints return expected data

## Next Steps

Once validated, proceed to:

1. Implement MCP proxy connections to downstream servers
2. Add OAuth flow for service authentication
3. Implement spend tracking and budget enforcement
4. Add user authentication to dashboard
5. Write automated tests
