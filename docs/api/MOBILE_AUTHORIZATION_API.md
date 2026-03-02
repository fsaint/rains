# Reins Mobile Authorization API

This document describes the API endpoints for mobile apps to authorize AI agent requests.

## Base URL

```
Production: https://api.reins.yourdomain.com
Development: http://localhost:3001
```

## Authentication

Mobile apps authenticate using JWT bearer tokens. Obtain a token via the authentication flow (see [Authentication](#authentication-flow) section).

```
Authorization: Bearer <jwt_token>
```

## Endpoints

### List Pending Approvals

Get all pending approval requests that need authorization.

```http
GET /api/approvals
```

**Query Parameters:**
| Parameter | Type | Description |
|-----------|------|-------------|
| `agentId` | string | Filter by specific agent (optional) |

**Response:**
```json
{
  "data": [
    {
      "id": "abc123",
      "agentId": "agent-456",
      "tool": "gmail_create_draft",
      "arguments": {
        "to": "user@example.com",
        "subject": "Meeting Follow-up",
        "body": "Thanks for meeting today..."
      },
      "context": "User asked to draft a follow-up email",
      "status": "pending",
      "requestedAt": "2026-03-02T01:15:00.000Z",
      "expiresAt": "2026-03-02T02:15:00.000Z"
    }
  ]
}
```

### Get Single Approval

Get details of a specific approval request.

```http
GET /api/approvals/:id
```

**Response:**
```json
{
  "data": {
    "id": "abc123",
    "agentId": "agent-456",
    "tool": "gmail_create_draft",
    "arguments": {
      "to": "user@example.com",
      "subject": "Meeting Follow-up",
      "body": "Thanks for meeting today..."
    },
    "context": "User asked to draft a follow-up email",
    "status": "pending",
    "requestedAt": "2026-03-02T01:15:00.000Z",
    "expiresAt": "2026-03-02T02:15:00.000Z"
  }
}
```

### Approve Request

Approve a pending authorization request.

```http
POST /api/approvals/:id/approve
```

**Request Body:**
```json
{
  "comment": "Approved via mobile app"
}
```

**Response:**
```json
{
  "data": {
    "id": "abc123",
    "agentId": "agent-456",
    "tool": "gmail_create_draft",
    "status": "approved",
    "requestedAt": "2026-03-02T01:15:00.000Z",
    "expiresAt": "2026-03-02T02:15:00.000Z",
    "resolvedAt": "2026-03-02T01:16:30.000Z",
    "resolvedBy": "user@example.com",
    "resolutionComment": "Approved via mobile app"
  }
}
```

### Reject Request

Reject a pending authorization request.

```http
POST /api/approvals/:id/reject
```

**Request Body:**
```json
{
  "reason": "Content not appropriate"
}
```

**Response:**
```json
{
  "data": {
    "id": "abc123",
    "agentId": "agent-456",
    "tool": "gmail_create_draft",
    "status": "rejected",
    "requestedAt": "2026-03-02T01:15:00.000Z",
    "expiresAt": "2026-03-02T02:15:00.000Z",
    "resolvedAt": "2026-03-02T01:16:45.000Z",
    "resolvedBy": "user@example.com",
    "resolutionComment": "Content not appropriate"
  }
}
```

## Real-time Updates

### WebSocket Connection

Connect to receive real-time approval notifications.

```
WebSocket: wss://api.reins.yourdomain.com/ws
Development: ws://localhost:3001/ws
```

**Events Received:**

#### New Approval Request
```json
{
  "type": "approval_request",
  "data": {
    "id": "abc123",
    "agentId": "agent-456",
    "tool": "gmail_create_draft",
    "arguments": { ... },
    "status": "pending",
    "requestedAt": "2026-03-02T01:15:00.000Z",
    "expiresAt": "2026-03-02T02:15:00.000Z"
  }
}
```

#### Approval Resolved (by another device)
```json
{
  "type": "approval_resolved",
  "data": {
    "id": "abc123",
    "status": "approved",
    "resolvedBy": "dashboard-user",
    "resolvedAt": "2026-03-02T01:16:30.000Z"
  }
}
```

### Push Notifications (Future)

Register for push notifications to receive alerts when new approvals are needed.

```http
POST /api/devices/register
```

**Request Body:**
```json
{
  "platform": "ios",
  "token": "device_push_token",
  "userId": "user@example.com"
}
```

## Data Models

### Approval Status

| Status | Description |
|--------|-------------|
| `pending` | Awaiting authorization |
| `approved` | Request was approved |
| `rejected` | Request was rejected |
| `expired` | Request expired before decision |

### Tool Categories

Common tools that may require approval:

| Category | Example Tools |
|----------|---------------|
| Email | `gmail_create_draft`, `gmail_send_message` |
| Calendar | `calendar_create_event`, `calendar_delete_event` |
| Files | `drive_upload_file`, `drive_share_file` |
| Communication | `slack_send_message`, `teams_post_message` |
| Code | `github_create_pr`, `github_merge_pr` |

## Error Responses

### Not Found (404)
```json
{
  "error": {
    "code": "NOT_FOUND",
    "message": "Approval not found"
  }
}
```

### Already Resolved (409)
```json
{
  "error": {
    "code": "ALREADY_RESOLVED",
    "message": "Approval has already been resolved"
  }
}
```

### Expired (410)
```json
{
  "error": {
    "code": "EXPIRED",
    "message": "Approval request has expired"
  }
}
```

### Validation Error (400)
```json
{
  "error": {
    "code": "VALIDATION_ERROR",
    "message": "reason is required"
  }
}
```

### Unauthorized (401)
```json
{
  "error": {
    "code": "UNAUTHORIZED",
    "message": "Invalid or expired token"
  }
}
```

## Authentication Flow

### 1. Device Registration

```http
POST /api/auth/device
```

**Request:**
```json
{
  "email": "user@example.com"
}
```

**Response:**
```json
{
  "data": {
    "verificationId": "verify-123",
    "expiresAt": "2026-03-02T01:25:00.000Z"
  }
}
```

A verification code is sent to the user's email.

### 2. Verify Code

```http
POST /api/auth/verify
```

**Request:**
```json
{
  "verificationId": "verify-123",
  "code": "123456"
}
```

**Response:**
```json
{
  "data": {
    "accessToken": "eyJhbGciOiJIUzI1NiIs...",
    "refreshToken": "refresh_token_here",
    "expiresIn": 3600,
    "user": {
      "id": "user-789",
      "email": "user@example.com",
      "name": "John Doe"
    }
  }
}
```

### 3. Refresh Token

```http
POST /api/auth/refresh
```

**Request:**
```json
{
  "refreshToken": "refresh_token_here"
}
```

**Response:**
```json
{
  "data": {
    "accessToken": "new_access_token",
    "expiresIn": 3600
  }
}
```

## Mobile App Integration Examples

### iOS (Swift)

```swift
import Foundation

class ReinsAPI {
    let baseURL = "http://localhost:3001"
    var token: String?

    func fetchPendingApprovals() async throws -> [Approval] {
        var request = URLRequest(url: URL(string: "\(baseURL)/api/approvals")!)
        request.setValue("Bearer \(token ?? "")", forHTTPHeaderField: "Authorization")

        let (data, _) = try await URLSession.shared.data(for: request)
        let response = try JSONDecoder().decode(ApprovalsResponse.self, from: data)
        return response.data
    }

    func approveRequest(id: String, comment: String?) async throws -> Approval {
        var request = URLRequest(url: URL(string: "\(baseURL)/api/approvals/\(id)/approve")!)
        request.httpMethod = "POST"
        request.setValue("Bearer \(token ?? "")", forHTTPHeaderField: "Authorization")
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")

        if let comment = comment {
            request.httpBody = try JSONEncoder().encode(["comment": comment])
        }

        let (data, _) = try await URLSession.shared.data(for: request)
        let response = try JSONDecoder().decode(ApprovalResponse.self, from: data)
        return response.data
    }

    func rejectRequest(id: String, reason: String) async throws -> Approval {
        var request = URLRequest(url: URL(string: "\(baseURL)/api/approvals/\(id)/reject")!)
        request.httpMethod = "POST"
        request.setValue("Bearer \(token ?? "")", forHTTPHeaderField: "Authorization")
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        request.httpBody = try JSONEncoder().encode(["reason": reason])

        let (data, _) = try await URLSession.shared.data(for: request)
        let response = try JSONDecoder().decode(ApprovalResponse.self, from: data)
        return response.data
    }
}
```

### Android (Kotlin)

```kotlin
import retrofit2.http.*

interface ReinsApiService {
    @GET("api/approvals")
    suspend fun getPendingApprovals(
        @Header("Authorization") token: String,
        @Query("agentId") agentId: String? = null
    ): ApprovalsResponse

    @POST("api/approvals/{id}/approve")
    suspend fun approveRequest(
        @Header("Authorization") token: String,
        @Path("id") id: String,
        @Body body: ApproveBody
    ): ApprovalResponse

    @POST("api/approvals/{id}/reject")
    suspend fun rejectRequest(
        @Header("Authorization") token: String,
        @Path("id") id: String,
        @Body body: RejectBody
    ): ApprovalResponse
}

data class ApproveBody(val comment: String?)
data class RejectBody(val reason: String)
```

### React Native

```typescript
import { useEffect, useState } from 'react';

const API_BASE = 'http://localhost:3001';

export function useApprovals(token: string) {
  const [approvals, setApprovals] = useState<Approval[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    fetchApprovals();

    // WebSocket for real-time updates
    const ws = new WebSocket('ws://localhost:3001/ws');
    ws.onmessage = (event) => {
      const message = JSON.parse(event.data);
      if (message.type === 'approval_request') {
        setApprovals(prev => [message.data, ...prev]);
      } else if (message.type === 'approval_resolved') {
        setApprovals(prev => prev.filter(a => a.id !== message.data.id));
      }
    };

    return () => ws.close();
  }, [token]);

  async function fetchApprovals() {
    const response = await fetch(`${API_BASE}/api/approvals`, {
      headers: { Authorization: `Bearer ${token}` }
    });
    const { data } = await response.json();
    setApprovals(data);
    setLoading(false);
  }

  async function approve(id: string, comment?: string) {
    await fetch(`${API_BASE}/api/approvals/${id}/approve`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({ comment })
    });
    setApprovals(prev => prev.filter(a => a.id !== id));
  }

  async function reject(id: string, reason: string) {
    await fetch(`${API_BASE}/api/approvals/${id}/reject`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({ reason })
    });
    setApprovals(prev => prev.filter(a => a.id !== id));
  }

  return { approvals, loading, approve, reject, refresh: fetchApprovals };
}
```

## Rate Limits

| Endpoint | Limit |
|----------|-------|
| `GET /api/approvals` | 60 requests/minute |
| `POST /api/approvals/:id/*` | 30 requests/minute |
| `WebSocket connections` | 5 per user |

## Best Practices

1. **Cache pending approvals** - Fetch on app launch and rely on WebSocket for updates
2. **Show expiration timers** - Display time remaining before request expires
3. **Confirm destructive actions** - Show confirmation dialog before rejecting
4. **Handle offline** - Queue approve/reject actions when offline
5. **Biometric auth** - Require Face ID/Touch ID for sensitive approvals
6. **Rich notifications** - Include tool name and context in push notifications
