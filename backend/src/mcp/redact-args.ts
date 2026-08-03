/**
 * Strip bulk payloads from tool arguments before they are persisted.
 *
 * Tool arguments are written to two tables — approvals.arguments_json and
 * audit_log.arguments_json — purely so they can be displayed later. An email
 * with an inline base64 attachment would otherwise store hundreds of kilobytes
 * of base64 in each, per call, forever.
 *
 * Safe by construction: handleCallTool captures `const capturedArgs = { ...args }`
 * and the deferred executor closes over that in-memory copy
 * (backend/src/mcp/agent-endpoint.ts), so the persisted row is never read back
 * to execute the tool. Every consumer of arguments_json is a renderer, or a
 * JSONB lookup of a short scalar field (`provider`, `chatId`) that this
 * function leaves untouched.
 */

/**
 * Strings longer than this are truncated. Set above BODY_PREVIEW_LIMIT (3000 in
 * ../notifications/approval-format.ts) so an email body preview is never
 * shortened by redaction rather than by the preview logic itself.
 */
export const MAX_PERSISTED_STRING = 4096;

/** Attachment fields that carry the actual file payload. */
const BULK_ATTACHMENT_FIELDS = ['data', 'content'] as const;

const REDACTED_MARKER = '[payload omitted]';

function truncateString(value: string): string {
  if (value.length <= MAX_PERSISTED_STRING) return value;
  const omitted = value.length - MAX_PERSISTED_STRING;
  return `${value.slice(0, MAX_PERSISTED_STRING)}…(${omitted} chars omitted)`;
}

/**
 * Replace an attachment's payload with a marker plus a `_bytes` count, so the
 * approval preview can still show the file's size without storing its content.
 */
function redactAttachment(entry: unknown): unknown {
  if (typeof entry !== 'object' || entry === null) return entry;
  const item = entry as Record<string, unknown>;

  let redacted: Record<string, unknown> | null = null;
  for (const field of BULK_ATTACHMENT_FIELDS) {
    const value = item[field];
    if (typeof value !== 'string') continue;

    // `data` is base64 (4 chars ≈ 3 bytes); `content` is literal UTF-8 text.
    const bytes =
      field === 'data'
        ? Math.floor((value.replace(/\s/g, '').length * 3) / 4)
        : Buffer.byteLength(value, 'utf-8');

    redacted ??= { ...item };
    redacted[field] = REDACTED_MARKER;
    redacted._bytes = bytes;
  }

  return redacted ?? item;
}

/** Produce a display-safe copy of tool arguments for persistence. */
export function redactToolArgs(
  args: Record<string, unknown> | undefined | null
): Record<string, unknown> {
  if (!args || typeof args !== 'object') return {};

  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(args)) {
    if (key === 'attachments' && Array.isArray(value)) {
      out[key] = value.map(redactAttachment);
    } else if (typeof value === 'string') {
      out[key] = truncateString(value);
    } else {
      out[key] = value;
    }
  }
  return out;
}
