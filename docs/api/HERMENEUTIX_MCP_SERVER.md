# Hermeneutix MCP Server

MCP server for the [Hermeneutix](https://hermeneutix.btv.pw) meeting transcription platform. Provides read-only access to projects, meetings, instances, sessions (conversation transcripts), and speaker profiles.

## Authentication

Requires a Hermeneutix API token. Generate one from your account settings at `https://hermeneutix.btv.pw` or via the mobile login endpoint, then connect it on the Credentials page (`POST /api/credentials/hermeneutix`). At call time the Reins vault decrypts it and hands it to the handler as `context.accessToken`; the agent never sees it. (`HERMENEUTIX_API_TOKEN` / `token` in the server config apply only to the standalone `HermeneutixServer` class.)

---

## Project scoping

When Hermeneutix is added to an agent, the instance can be pinned to **one project** (Permissions → Add service → Hermeneutix → pick a project; **All projects** leaves it unscoped, and the choice can be changed later in the service details). The pin is stored on the service instance as `config: { projectId, projectName }` and reaches the handlers as `context.instanceConfig`.

Hermeneutix itself authorizes at the *institution* level, so without a pin an agent can read every project in the institution. With a pin the server enforces, on every call, that the data returned belongs to that project:

| Tool | How the pin is enforced |
|------|-------------------------|
| `hermeneutix_list_projects` | Returns only the pinned project. Errors if the token can no longer reach it. |
| `hermeneutix_list_meetings`, `hermeneutix_list_speakers`, `hermeneutix_search_instances`, `hermeneutix_list_sessions` (by project) | `project_id` may be omitted and is filled in. Any other `project_id` is refused. |
| `hermeneutix_list_meeting_instances` | The response's `meeting.project.id` must match, or the payload is withheld. |
| `hermeneutix_get_meeting_instance` | The response's `meeting.project.id` must match; checked before the sibling look-ups. |
| `hermeneutix_list_sessions` (by instance) | The response's `meeting.project.id` must match. |
| `hermeneutix_get_conversation_preview` | The pinned project must appear in the response's `projects[]`. |
| `hermeneutix_search_profiles` | Not scoped: profiles are people, not project data. |

Checks **fail closed**: if the Hermeneutix API response does not report a project (an older deployment), the call is refused rather than passed through. Unpinned instances behave exactly as before.

---

## Tools

### `hermeneutix_list_projects`

List all active projects available to the authenticated user. On a project-pinned instance, returns only that project.

**Parameters:** none

**Returns:** `{ projects: Project[] }`

---

### `hermeneutix_list_meetings`

List recurring meeting series in a project, paginated. Pass `include_recent_instances: true` to attach the last 5 instances per meeting — one extra request per meeting, so leave it off for discovery.

**Parameters:**

| Name | Type | Required | Description |
|------|------|----------|-------------|
| `project_id` | string (uuid) | yes\* | Project to list meetings for |
| `limit` | number | no | Max meetings per page (default 25, max 100) |
| `offset` | number | no | Meetings to skip |
| `include_recent_instances` | boolean | no | Attach `recent_instances` (last 5) per meeting. Default false |

\*Optional on a project-pinned instance; it is filled in (see **Project scoping**).

**Returns:** `{ meetings: Meeting[], total, offset, limit, has_more }`; each meeting carries `recent_instances` only when requested

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

> Either `project_id` or `instance_id` is required. \*On a project-pinned instance `project_id` is optional and filled in (see **Project scoping**).

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
| `project_id` | string (uuid) | yes\* | Project to list speakers for |

\*Optional on a project-pinned instance.

**Returns:** `{ speakers: Speaker[] }`

---

### `hermeneutix_get_conversation_preview`

Retrieve a conversation transcript with speaker labels. Returns the full transcript by default. Use `max_messages` to cap the result (e.g. `10` for a quick preview). The full transcript is also embedded in `hermeneutix_get_meeting_instance` sessions.

**Parameters:**

| Name | Type | Required | Description |
|------|------|----------|-------------|
| `conversation_id` | string (uuid) | yes | Conversation to retrieve |
| `max_messages` | number | no | Cap the number of messages returned. Omit for full transcript. |

**Returns:** `{ id, title, projects: [{ id, name }], messages: Message[], audio_file }`

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
| `project_id` | string (uuid) | yes\* | Project to search within |
| `q` | string | no | Keyword or topic query |
| `date_from` | string | no | Start date filter (ISO 8601, e.g. `2026-01-01`) |
| `date_to` | string | no | End date filter (ISO 8601, e.g. `2026-04-08`) |
| `limit` | number | no | Max results to return |
| `offset` | number | no | Results to skip for pagination |

\*Optional on a project-pinned instance.

**Returns:** Matching instances with relevance context.

---

## Typical Workflows

### Browse a project's meeting history
1. `hermeneutix_list_projects` — get `project_id` (skip on a pinned instance)
2. `hermeneutix_list_meetings` — get meeting series (add `include_recent_instances: true` for the last 5 instance IDs)
3. `hermeneutix_list_meeting_instances` — paginate further back if needed
4. `hermeneutix_get_meeting_instance` — full detail with transcripts; use `previous_instance_id` / `next_instance_id` to walk history

### List all conversations for a specific meeting occurrence
1. `hermeneutix_get_meeting_instance` or `hermeneutix_list_meeting_instances` — get `instance_id`
2. `hermeneutix_list_sessions` with `instance_id` — get all sessions for that instance
3. `hermeneutix_get_conversation_preview` — retrieve a full transcript if needed

### Find meetings about a topic
1. `hermeneutix_search_instances` with `q` (and `project_id` unless pinned) — locate relevant instances
2. `hermeneutix_get_meeting_instance` — drill into the result
