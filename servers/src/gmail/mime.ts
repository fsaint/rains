/**
 * RFC 822 / MIME message construction for the Gmail server.
 *
 * Extracted from handlers.ts so the encoding rules can be unit-tested against
 * real message bytes rather than only through mocked API calls.
 */

import { randomUUID } from 'node:crypto';
import {
  DEFAULT_MIME_TYPE,
  MAX_ATTACHMENT_BYTES,
  MAX_ATTACHMENT_COUNT,
  MAX_FILENAME_LENGTH,
  MAX_TOTAL_ATTACHMENT_BYTES,
  MIME_TYPE_PATTERN,
  formatBytes,
  inferMimeFromFilename,
} from './limits.js';

/** Soft line limit for headers (RFC 5322 recommends 78, hard limit is 998). */
const MAX_HEADER_LINE = 78;

/** RFC 2045 requires base64 body lines of at most 76 characters. */
const BASE64_LINE_LENGTH = 76;

/**
 * Max bytes of UTF-8 per RFC 2047 encoded-word. Base64 of 45 bytes is 60
 * characters, which keeps `=?UTF-8?B?<60>?=` at 73 — under the 75 limit.
 */
const ENCODED_WORD_CHUNK_BYTES = 45;

/**
 * An attachment with its bytes already resolved. Every attachment source
 * (text, gmail, drive, url, upload, base64) converges on this shape before
 * MIME construction, so the encoder never knows where the bytes came from.
 */
export interface ResolvedAttachment {
  filename: string;
  mimeType: string;
  bytes: Buffer;
  /** Reserved for inline images (multipart/related). Not emitted today. */
  contentId?: string;
  disposition?: 'attachment' | 'inline';
}

export interface EmailInput {
  to: string[];
  cc?: string[];
  bcc?: string[];
  subject: string;
  body?: string;
  htmlBody?: string;
  replyTo?: string;
  attachments?: ResolvedAttachment[];
}

// ---------------------------------------------------------------------------
// Header encoding
// ---------------------------------------------------------------------------

/**
 * Remove every character that could terminate a header line.
 *
 * Applied to EVERY value that reaches a header. This is the backstop against
 * header injection: a filename or subject containing CRLF would otherwise let
 * a caller append arbitrary headers (e.g. an extra Bcc recipient).
 */
export function sanitizeHeaderValue(value: string): string {
  return value.replace(/[\r\n\u0000]/g, ' ').trim();
}

function isPrintableAscii(value: string): boolean {
  return /^[\x20-\x7E]*$/.test(value);
}

/**
 * RFC 2047 encoded-word for header text containing non-ASCII characters.
 *
 * Long values are split into multiple encoded-words joined by folding
 * whitespace, since a single encoded-word may not exceed 75 characters. Splits
 * happen on code-point boundaries so multi-byte characters are never cut in
 * half (which would produce mojibake in the recipient's client).
 */
export function encodeHeaderWord(value: string): string {
  const clean = sanitizeHeaderValue(value);
  if (isPrintableAscii(clean)) return clean;

  const chunks: string[] = [];
  let current: string[] = [];
  let currentBytes = 0;

  for (const char of clean) {
    const charBytes = Buffer.byteLength(char, 'utf-8');
    if (currentBytes + charBytes > ENCODED_WORD_CHUNK_BYTES && current.length > 0) {
      chunks.push(current.join(''));
      current = [];
      currentBytes = 0;
    }
    current.push(char);
    currentBytes += charBytes;
  }
  if (current.length > 0) chunks.push(current.join(''));

  return chunks
    .map((chunk) => `=?UTF-8?B?${Buffer.from(chunk, 'utf-8').toString('base64')}?=`)
    .join('\r\n ');
}

/** Characters that force a display name to be quoted (RFC 5322 specials). */
const ADDRESS_SPECIALS = /[()<>[\]:;@\\,."]/;

/**
 * Encode a single address, encoding only the display name.
 *
 * The addr-spec itself must stay untouched — running the whole string through
 * an encoded-word would produce an address no mail server can route.
 */
export function encodeAddress(address: string): string {
  const clean = sanitizeHeaderValue(address);
  const match = clean.match(/^(.*?)\s*<([^>]*)>$/);
  if (!match) return clean;

  const [, rawName, addrSpec] = match;
  const display = rawName.replace(/^"(.*)"$/, '$1').trim();
  if (!display) return `<${addrSpec}>`;

  if (!isPrintableAscii(display)) {
    // Encoded-words must NOT be wrapped in quotes.
    return `${encodeHeaderWord(display)} <${addrSpec}>`;
  }
  if (ADDRESS_SPECIALS.test(display)) {
    return `"${display.replace(/(["\\])/g, '\\$1')}" <${addrSpec}>`;
  }
  return `${display} <${addrSpec}>`;
}

export function encodeAddressList(addresses: string[]): string {
  return addresses.map(encodeAddress).join(', ');
}

/**
 * Emit `Name: value`, folded onto continuation lines when it exceeds the soft
 * line limit. Folding only ever happens at existing spaces, so encoded-words
 * (which contain none) are never split.
 */
export function foldHeader(name: string, value: string): string {
  const full = `${name}: ${value}`;
  if (full.length <= MAX_HEADER_LINE && !full.includes('\r\n')) return full;

  const out: string[] = [];
  let line = '';
  for (const word of full.split(' ')) {
    if (line === '') {
      line = word;
    } else if (line.length + 1 + word.length > MAX_HEADER_LINE) {
      out.push(line);
      line = ` ${word}`;
    } else {
      line += ` ${word}`;
    }
  }
  if (line !== '') out.push(line);
  return out.join('\r\n');
}

/**
 * Encode a filename parameter per RFC 2231.
 *
 * Emits BOTH the ASCII-fallback `name="..."` and the extended
 * `name*=UTF-8''...` form — the same thing Gmail itself sends — so clients that
 * predate RFC 2231 still show something readable. The ASCII fallback has quotes
 * and backslashes replaced rather than escaped, because an escaped quote inside
 * a quoted-string is handled inconsistently across clients.
 */
export function encodeRfc2231Param(paramName: string, value: string): string {
  const clean = sanitizeHeaderValue(value);
  const asciiFallback = clean
    .replace(/[^\x20-\x7E]/g, '_')
    .replace(/["\\]/g, '_');
  const quoted = `${paramName}="${asciiFallback}"`;

  if (isPrintableAscii(clean) && !/["\\]/.test(clean)) return quoted;

  const extended = encodeURIComponent(clean).replace(
    /['()!*]/g,
    (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`
  );
  return `${quoted}; ${paramName}*=UTF-8''${extended}`;
}

/**
 * Strip anything path-like or header-breaking from a filename, then bound its
 * length while preserving the extension (so the recipient's client still picks
 * the right icon and default application).
 */
export function sanitizeFilename(filename: string, fallback = 'attachment'): string {
  // Take the basename: an attachment filename should never carry a path, and
  // discarding the directory portion outright is stricter than escaping it.
  const segments = sanitizeHeaderValue(filename).normalize('NFC').split(/[/\\]/);
  let clean = segments.filter((segment) => segment !== '' && segment !== '..').pop() ?? '';
  clean = clean.replace(/^\.+/, '').trim();
  if (clean === '') return fallback;

  if (clean.length > MAX_FILENAME_LENGTH) {
    const dot = clean.lastIndexOf('.');
    const ext = dot > 0 && clean.length - dot <= 12 ? clean.slice(dot) : '';
    clean = clean.slice(0, MAX_FILENAME_LENGTH - ext.length) + ext;
  }
  return clean;
}

// ---------------------------------------------------------------------------
// Body construction
// ---------------------------------------------------------------------------

/**
 * Unique per message part.
 *
 * randomUUID rather than Math.random: collision with body content is
 * negligible, and unlike a seeded PRNG the value cannot be predicted or
 * influenced by anything the caller supplies. We deliberately do NOT scan the
 * body for the boundary — that is an O(n) pass over multi-megabyte payloads to
 * guard against a ~2^-122 event.
 */
function newBoundary(): string {
  return `----=_Part_${randomUUID()}`;
}

function normalizeNewlines(text: string): string {
  return text.replace(/\r\n/g, '\n').replace(/\r/g, '\n').replace(/\n/g, '\r\n');
}

function foldBase64(base64: string): string {
  if (base64.length === 0) return '';
  const lines: string[] = [];
  for (let i = 0; i < base64.length; i += BASE64_LINE_LENGTH) {
    lines.push(base64.slice(i, i + BASE64_LINE_LENGTH));
  }
  return lines.join('\r\n');
}

/**
 * A text part, always base64-encoded.
 *
 * Encoding rather than emitting raw UTF-8 sidesteps two real failure modes:
 * a body line longer than the 998-octet RFC 5322 limit, and body text that
 * happens to contain the multipart boundary. Cost is ~33% on the body only.
 */
function buildTextPart(content: string, mimeType: string): string[] {
  const encoded = Buffer.from(normalizeNewlines(content), 'utf-8').toString('base64');
  return [
    `Content-Type: ${mimeType}; charset=utf-8`,
    'Content-Transfer-Encoding: base64',
    '',
    foldBase64(encoded),
  ];
}

/**
 * The message body, as multipart/alternative when both a plain and an HTML
 * version are supplied.
 *
 * The previous implementation dropped `body` entirely whenever `htmlBody` was
 * also present, so recipients on plain-text clients received nothing.
 */
function buildBodyPart(body?: string, htmlBody?: string): string[] {
  const hasText = typeof body === 'string' && body.length > 0;
  const hasHtml = typeof htmlBody === 'string' && htmlBody.length > 0;

  if (hasText && hasHtml) {
    const boundary = newBoundary();
    return [
      `Content-Type: multipart/alternative; boundary="${boundary}"`,
      '',
      // Least-preferred representation first, per RFC 2046.
      `--${boundary}`,
      ...buildTextPart(body, 'text/plain'),
      '',
      `--${boundary}`,
      ...buildTextPart(htmlBody, 'text/html'),
      '',
      `--${boundary}--`,
    ];
  }
  if (hasHtml) return buildTextPart(htmlBody, 'text/html');
  return buildTextPart(body ?? '', 'text/plain');
}

function buildAttachmentPart(attachment: ResolvedAttachment): string[] {
  const filename = sanitizeFilename(attachment.filename);
  const mimeType = MIME_TYPE_PATTERN.test(attachment.mimeType)
    ? attachment.mimeType
    : DEFAULT_MIME_TYPE;
  const disposition = attachment.disposition ?? 'attachment';

  const lines = [
    foldHeader('Content-Type', `${mimeType}; ${encodeRfc2231Param('name', filename)}`),
    foldHeader(
      'Content-Disposition',
      `${disposition}; ${encodeRfc2231Param('filename', filename)}`
    ),
    'Content-Transfer-Encoding: base64',
  ];
  if (attachment.contentId) {
    lines.push(`Content-ID: <${sanitizeHeaderValue(attachment.contentId)}>`);
  }
  lines.push('');
  lines.push(foldBase64(attachment.bytes.toString('base64')));
  return lines;
}

// ---------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------

/**
 * Enforce count and size caps. Returns an error message, or null when valid.
 *
 * Sizes are measured on decoded bytes; the caller should additionally check the
 * built message length, since base64 inflates the payload by 4/3 and Gmail
 * measures the encoded form.
 *
 * There is deliberately no MIME-type allowlist or magic-byte sniffing here. The
 * bytes are the user's own files, Gmail already rejects blocked executable
 * types server-side with a clear error, and a second weaker copy of that policy
 * would only block legitimate sends while teaching agents to misreport
 * mimeType. The real control is the human approval step, which is why the
 * approval preview renders attachments.
 */
export function validateAttachmentLimits(
  attachments: ResolvedAttachment[]
): string | null {
  if (attachments.length > MAX_ATTACHMENT_COUNT) {
    return `Too many attachments: ${attachments.length}. The limit is ${MAX_ATTACHMENT_COUNT} per message.`;
  }

  let total = 0;
  for (const [index, attachment] of attachments.entries()) {
    const size = attachment.bytes.length;
    if (size > MAX_ATTACHMENT_BYTES) {
      return `Attachment ${index + 1} ("${attachment.filename}") is ${formatBytes(size)}, over the ${formatBytes(MAX_ATTACHMENT_BYTES)} per-file limit.`;
    }
    total += size;
  }

  if (total > MAX_TOTAL_ATTACHMENT_BYTES) {
    return `Attachments total ${formatBytes(total)}, over the ${formatBytes(MAX_TOTAL_ATTACHMENT_BYTES)} limit for one message. Send fewer files, or share large files via a link instead.`;
  }
  return null;
}

// ---------------------------------------------------------------------------
// Entry points
// ---------------------------------------------------------------------------

/** Build the complete RFC 822 message. */
export function buildMimeMessage(email: EmailInput): Buffer {
  const lines: string[] = ['MIME-Version: 1.0'];

  lines.push(foldHeader('To', encodeAddressList(email.to ?? [])));
  if (email.cc?.length) lines.push(foldHeader('Cc', encodeAddressList(email.cc)));
  if (email.bcc?.length) lines.push(foldHeader('Bcc', encodeAddressList(email.bcc)));
  lines.push(foldHeader('Subject', encodeHeaderWord(email.subject ?? '')));

  if (email.replyTo) {
    const ref = sanitizeHeaderValue(email.replyTo);
    lines.push(foldHeader('In-Reply-To', ref));
    lines.push(foldHeader('References', ref));
  }

  const attachments = email.attachments ?? [];
  if (attachments.length === 0) {
    lines.push(...buildBodyPart(email.body, email.htmlBody));
  } else {
    const boundary = newBoundary();
    lines.push(`Content-Type: multipart/mixed; boundary="${boundary}"`);
    lines.push('');
    lines.push(`--${boundary}`);
    lines.push(...buildBodyPart(email.body, email.htmlBody));
    for (const attachment of attachments) {
      lines.push('');
      lines.push(`--${boundary}`);
      lines.push(...buildAttachmentPart(attachment));
    }
    lines.push('');
    lines.push(`--${boundary}--`);
  }

  return Buffer.from(lines.join('\r\n'), 'utf-8');
}

/** base64url-encode a built message for the Gmail JSON `raw` field. */
export function toRawBase64Url(message: Buffer): string {
  return message
    .toString('base64')
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '');
}

/**
 * Decode inline base64 attachment content, accepting either standard base64 or
 * a data-URL (`data:<mimeType>;base64,<data>`).
 */
export function decodeBase64Attachment(input: {
  filename: string;
  mimeType?: string;
  data: string;
}): ResolvedAttachment {
  const commaIndex = input.data.indexOf(',');
  const payload =
    input.data.startsWith('data:') && commaIndex !== -1
      ? input.data.slice(commaIndex + 1)
      : input.data;

  const filename = sanitizeFilename(input.filename);
  const mimeType =
    input.mimeType && MIME_TYPE_PATTERN.test(input.mimeType)
      ? input.mimeType
      : inferMimeFromFilename(filename);

  return {
    filename,
    mimeType,
    bytes: Buffer.from(payload.replace(/\s/g, ''), 'base64'),
  };
}
