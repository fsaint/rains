/**
 * JSON Schema for the `attachments` parameter of gmail_create_draft and
 * gmail_send_message.
 *
 * Deliberately NOT a JSON-Schema `oneOf`. The inputSchema is forwarded to the
 * model verbatim (backend/src/mcp/agent-endpoint.ts), and Reins agents run on
 * Anthropic, OpenAI-compatible (LiteLLM router) and MiniMax backends — several
 * of which either reject or silently mangle `oneOf` inside function parameters.
 * Instead this follows the discriminator idiom already used in
 * ../memory/tools.ts: one flat object, a `source` enum, every variant field
 * optional, and precise runtime validation in attachments.ts.
 */

/**
 * Sources understood by the resolver. Extend this as each source lands — the
 * schema must only advertise what actually works, or the model will confidently
 * call a source that errors.
 */
export const ATTACHMENT_SOURCES = [
  'text',
  'gmail',
  'drive',
  'url',
  'upload',
  'base64',
] as const;

export const attachmentsSchema = {
  type: 'array',
  description:
    'Files to attach. Each item MUST set "source". Prefer references over raw bytes — ' +
    'referenced files are fetched server-side and never pass through your context.\n' +
    '• source="text" — a file you write yourself (CSV, markdown, plain text, HTML, JSON). ' +
    'Requires: filename, content. Optional: mimeType (inferred from the extension).\n' +
    '• source="gmail" — forward a file from an existing email WITHOUT downloading it. ' +
    'Requires: messageId, attachmentId (both come from gmail_get_message). ' +
    'Optional: filename to rename it.\n' +
    '• source="drive" — a file from Google Drive, fetched server-side. Requires: fileId ' +
    '(from drive_search or drive_list_files). Optional: filename, and exportMimeType for ' +
    'native Google Docs/Sheets/Slides (defaults to the Office equivalent).\n' +
    '• source="url" — a file at a public https:// address, fetched server-side. ' +
    'Requires: url. Optional: filename, mimeType. Only https is allowed, and addresses on ' +
    'private networks are refused.\n' +
    '• source="upload" — a file that exists in YOUR container (one you generated or ' +
    'downloaded). Upload it first with:\n' +
    '    curl -sS -X POST "$REINS_API_URL/api/agent-uploads?filename=NAME&mimeType=TYPE" \\\n' +
    '      -H "x-reins-agent-secret: $OPENCLAW_GATEWAY_TOKEN" \\\n' +
    '      -H "Content-Type: application/octet-stream" --data-binary @/path/to/file\n' +
    '  then pass the returned uploadId. Requires: uploadId. Uploads expire after 24 hours.\n' +
    '• source="base64" — raw bytes you encode inline. LAST RESORT: you must emit every ' +
    'byte as output, which is slow and corrupts easily above a few KB. Limit 384 KB. ' +
    'Requires: filename, mimeType, data.\n' +
    'To forward a file you received by email, ALWAYS use source="gmail" — never call ' +
    'gmail_get_attachment and paste the bytes back.',
  items: {
    type: 'object',
    properties: {
      source: {
        type: 'string',
        enum: [...ATTACHMENT_SOURCES],
        description: 'Where the file content comes from. Required.',
      },
      filename: {
        type: 'string',
        description:
          'File name including extension, e.g. "q3-report.csv". Required for ' +
          'source="text" and source="base64". Optional for source="gmail", which ' +
          'defaults to the original filename.',
      },
      mimeType: {
        type: 'string',
        description:
          'MIME type, e.g. "application/pdf". Required for source="base64". Inferred ' +
          'from the filename extension for source="text". Ignored for source="gmail".',
      },
      content: {
        type: 'string',
        description:
          'source="text" only. The literal text content of the file, written as-is. ' +
          'Do NOT base64-encode this.',
      },
      messageId: {
        type: 'string',
        description:
          'source="gmail" only. The message the file is attached to, from ' +
          'gmail_get_message or gmail_search.',
      },
      attachmentId: {
        type: 'string',
        description:
          'source="gmail" only. The attachmentId from the "attachments" array ' +
          'returned by gmail_get_message.',
      },
      fileId: {
        type: 'string',
        description:
          'source="drive" only. The Drive file ID, from drive_search or drive_list_files.',
      },
      exportMimeType: {
        type: 'string',
        description:
          'source="drive" only, optional. Export format for native Google Docs/Sheets/Slides, ' +
          'e.g. "application/pdf". Ignored for regular files.',
      },
      url: {
        type: 'string',
        description:
          'source="url" only. A public https:// address. Reins downloads it server-side, ' +
          'so the bytes never enter your context.',
      },
      uploadId: {
        type: 'string',
        description:
          'source="upload" only. The uploadId returned by POST /api/agent-uploads.',
      },
      data: {
        type: 'string',
        description:
          'source="base64" only. Standard base64 or a data-URL ' +
          '(data:<mimeType>;base64,<data>). Max 384 KB decoded.',
      },
    },
  },
} as const;
