# Hermeneutix MCP Server

MCP server for the [Hermeneutix](https://studio.curl-newton.ts.net) meeting transcription platform. Provides read-only access to projects, meetings, instances, sessions (conversation transcripts), and speaker profiles.

## Authentication

Requires a Hermeneutix API token. Generate one from your account settings at `https://studio.curl-newton.ts.net` or via the mobile login endpoint.

Set the token via the environment variable `HERMENEUTIX_API_TOKEN` or pass it as `token` in the server config.

---

## Tools

### `hermeneutix_list_projects`

List all active projects available to the authenticated user.

**Parameters:** none

**Returns:** `{ projects: Project[] }`

---

### `hermeneutix_list_meetings`

List all recurring meeting series in a project. Each meeting includes a `recent_instances` array with the last 5 instance IDs for quick lookback without an extra call.

**Parameters:**

| Name | Type | Required | Description |
|------|------|----------|-------------|
| `project_id` | string (uuid) | yes | Project to list meetings for |

**Returns:** `{ meetings: Meeting[] }` where each meeting includes `recent_instances: string[]`

---

### `hermeneutix_list_meeting_instances`

List all occurrences (instances) of a recurring meeting. Supports both offset-based and cursor-based pagination.

**Parameters:**

| Name | Type | Required | Description |
|------|------|----------|-------------|
| `meeting_id` | string (uuid) | yes | Meeting series ID |
| `limit` | number | no | Max instances to return (default: 20) |
| `offset` | number | no | Instances to skip (offset pagination) |
| `before` | string (uuid) | no | Return instances before this ID (cursor pagination) |
| `after` | string (uuid) | no | Return instances after this ID (cursor pagination) |
| `sort_order` | `"asc"` \| `"desc"` | no | Sort by `scheduled_time` (default: `"desc"`) |

**Returns:** `{ instances: Instance[], total: number, ... }`

Each instance includes: `id`, `sequence_number`, `scheduled_time`, `status`, `duration_seconds`, `message_count`, `session_count`.

---

### `hermeneutix_get_meeting_instance`

Get full detail for a meeting instance including its sessions, transcriptions, and speaker assignments. Also returns `previous_instance_id` and `next_instance_id` for sequential traversal through meeting history.

**Parameters:**

| Name | Type | Required | Description |
|------|------|----------|-------------|
| `instance_id` | string (uuid) | yes | Meeting instance ID |

**Returns:** `{ instance: InstanceDetail }` with `previous_instance_id` and `next_instance_id` for navigation.

---

### `hermeneutix_list_sessions`

List sessions (conversation transcripts) either across an entire project or scoped to a specific meeting instance. Use `instance_id` to get all conversations recorded for one meeting occurrence.

**Parameters:**

| Name | Type | Required | Description |
|------|------|----------|-------------|
| `project_id` | string (uuid) | one of | List all sessions in this project |
| `instance_id` | string (uuid) | one of | List sessions assigned to this meeting instance |
| `include` | `"messages"` | no | Include full transcripts in the response |
| `page` | number | no | Page number for project-level listing (default: 1) |
| `page_size` | number | no | Results per page for project-level listing (default: 50, max: 200) |

> Either `project_id` or `instance_id` is required.

**API endpoints used:**
- By project: `GET /api/v1/projects/{project_id}/sessions/`
- By instance: `GET /api/v1/instances/{instance_id}/sessions/`

**Returns:** Paginated session list. When `include=messages`, each session contains its full transcript.

---

### `hermeneutix_list_speakers`

List project members available for speaker identification and assignment.

**Parameters:**

| Name | Type | Required | Description |
|------|------|----------|-------------|
| `project_id` | string (uuid) | yes | Project to list speakers for |

**Returns:** `{ speakers: Speaker[] }`

---

### `hermeneutix_get_conversation_preview`

Retrieve a conversation transcript with speaker labels. Returns the full transcript by default. Use `max_messages` to cap the result (e.g. `10` for a quick preview). The full transcript is also embedded in `hermeneutix_get_meeting_instance` sessions.

**Parameters:**

| Name | Type | Required | Description |
|------|------|----------|-------------|
| `conversation_id` | string (uuid) | yes | Conversation to retrieve |
| `max_messages` | number | no | Cap the number of messages returned. Omit for full transcript. |

**Returns:** `{ id, title, messages: Message[], audio_url, audio_filename }`

---

### `hermeneutix_search_profiles`

Search speaker profiles by name or email. Useful before assigning speakers to transcript segments.

**Parameters:**

| Name | Type | Required | Description |
|------|------|----------|-------------|
| `query` | string | no | Name or email search query |

**Returns:** `{ profiles: Profile[] }`

---

### `hermeneutix_search_instances`

Search across all meeting instances in a project by keyword, date range, or topic. Useful for finding relevant sessions without fetching every instance.

**Parameters:**

| Name | Type | Required | Description |
|------|------|----------|-------------|
| `project_id` | string (uuid) | yes | Project to search within |
| `q` | string | no | Keyword or topic query |
| `date_from` | string | no | Start date filter (ISO 8601, e.g. `2026-01-01`) |
| `date_to` | string | no | End date filter (ISO 8601, e.g. `2026-04-08`) |
| `limit` | number | no | Max results to return |
| `offset` | number | no | Results to skip for pagination |

**Returns:** Matching instances with relevance context.

---

## Typical Workflows

### Browse a project's meeting history
1. `hermeneutix_list_projects` — get `project_id`
2. `hermeneutix_list_meetings` — get meeting series; `recent_instances` gives you last 5 instance IDs
3. `hermeneutix_list_meeting_instances` — paginate further back if needed
4. `hermeneutix_get_meeting_instance` — full detail with transcripts; use `previous_instance_id` / `next_instance_id` to walk history

### List all conversations for a specific meeting occurrence
1. `hermeneutix_get_meeting_instance` or `hermeneutix_list_meeting_instances` — get `instance_id`
2. `hermeneutix_list_sessions` with `instance_id` — get all sessions for that instance
3. `hermeneutix_get_conversation_preview` — retrieve a full transcript if needed

### Find meetings about a topic
1. `hermeneutix_search_instances` with `project_id` and `q` — locate relevant instances
2. `hermeneutix_get_meeting_instance` — drill into the result
