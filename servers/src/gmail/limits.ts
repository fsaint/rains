/**
 * Size and shape limits for Gmail attachments.
 *
 * Single home for every constant, mirroring the MAX_CONTENT_SIZE idiom in
 * ../drive/handlers.ts.
 */

/** Maximum number of attachments on a single message. */
export const MAX_ATTACHMENT_COUNT = 10;

/** Maximum decoded size of any single attachment. */
export const MAX_ATTACHMENT_BYTES = 20 * 1024 * 1024;

/**
 * Maximum decoded size of all attachments combined. Gmail accepts up to 25 MB
 * for a sent message, measured *after* base64 inflates the payload by 4/3, so
 * this sits well below that to leave headroom for the body and headers.
 */
export const MAX_TOTAL_ATTACHMENT_BYTES = 22 * 1024 * 1024;

/**
 * Maximum decoded size of an inline base64 attachment (source="base64").
 *
 * Deliberately far smaller than MAX_ATTACHMENT_BYTES. Inline base64 arrives as
 * part of the JSON-RPC body of POST /mcp/:agentId, which Fastify caps at its
 * 1 MiB default (backend/src/app.ts creates the instance with no bodyLimit
 * override). 384 KB decoded is ~512 KB of base64, which fits with room for the
 * rest of the envelope.
 *
 * The deeper reason it is small: inline base64 requires the *model* to emit
 * every byte as output tokens. Anything beyond a few KB is slow, expensive, and
 * prone to corruption. Reference sources exist so this path stays a last resort.
 */
export const MAX_BASE64_ATTACHMENT_BYTES = 384 * 1024;

/** Maximum size of a model-authored text attachment (source="text"). */
export const MAX_TEXT_ATTACHMENT_BYTES = 512 * 1024;

/** Maximum filename length, enforced while preserving the extension. */
export const MAX_FILENAME_LENGTH = 200;

/**
 * MIME types accepted for source="text".
 *
 * Restricted so the model cannot declare its own prose to be an executable
 * type. Binary content must come from a reference source instead.
 */
export const TEXT_ATTACHMENT_MIME_ALLOWLIST = [
  'text/plain',
  'text/csv',
  'text/markdown',
  'text/html',
  'text/xml',
  'text/tab-separated-values',
  'text/calendar',
  'application/json',
  'application/xml',
  'application/x-ndjson',
] as const;

/** Extension → MIME type, used when the caller omits mimeType. */
export const EXT_TO_MIME: Record<string, string> = {
  txt: 'text/plain',
  md: 'text/markdown',
  markdown: 'text/markdown',
  csv: 'text/csv',
  tsv: 'text/tab-separated-values',
  html: 'text/html',
  htm: 'text/html',
  xml: 'application/xml',
  json: 'application/json',
  ndjson: 'application/x-ndjson',
  ics: 'text/calendar',
  pdf: 'application/pdf',
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  gif: 'image/gif',
  webp: 'image/webp',
  svg: 'image/svg+xml',
  zip: 'application/zip',
  gz: 'application/gzip',
  doc: 'application/msword',
  docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  xls: 'application/vnd.ms-excel',
  xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  ppt: 'application/vnd.ms-powerpoint',
  pptx: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
};

export const DEFAULT_MIME_TYPE = 'application/octet-stream';

/** A syntactically valid MIME type with no characters that could break a header. */
export const MIME_TYPE_PATTERN = /^[\w.+-]+\/[\w.+-]+$/;

/** Human-readable byte size, e.g. "1.4 MB". */
export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

/** Infer a MIME type from a filename extension, falling back to octet-stream. */
export function inferMimeFromFilename(filename: string): string {
  const ext = filename.split('.').pop()?.toLowerCase() ?? '';
  return EXT_TO_MIME[ext] ?? DEFAULT_MIME_TYPE;
}
