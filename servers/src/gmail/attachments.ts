/**
 * Parsing and resolution of the `attachments` parameter.
 *
 * Every source converges on a ResolvedAttachment (real bytes) before MIME
 * construction, so mime.ts never knows where the bytes came from.
 */

import type { drive_v3, gmail_v1 } from 'googleapis';
import type { DrivePathRule } from '../common/types.js';
import { canRead, resolvePermission, type PermissionLevel } from '../drive/path-rules.js';
import {
  DEFAULT_MIME_TYPE,
  MAX_BASE64_ATTACHMENT_BYTES,
  MAX_TEXT_ATTACHMENT_BYTES,
  MIME_TYPE_PATTERN,
  TEXT_ATTACHMENT_MIME_ALLOWLIST,
  formatBytes,
  inferMimeFromFilename,
} from './limits.js';
import {
  decodeBase64Attachment,
  sanitizeFilename,
  validateAttachmentLimits,
  type ResolvedAttachment,
} from './mime.js';
import { SafeFetchError, safeFetchAttachment, type SafeFetchResult } from './safe-fetch.js';

export type AttachmentSource = 'text' | 'gmail' | 'base64' | 'url' | 'drive' | 'upload';

export interface AttachmentSpec {
  source: AttachmentSource;
  filename?: string;
  mimeType?: string;
  content?: string;
  messageId?: string;
  attachmentId?: string;
  data?: string;
  url?: string;
  fileId?: string;
  exportMimeType?: string;
  uploadId?: string;
}

/** Signals a caller-fixable problem; the message is surfaced to the model. */
export class AttachmentError extends Error {}

/** Metadata for one attachment part of a Gmail message. */
export interface AttachmentPartInfo {
  filename: string;
  mimeType: string;
  size: number;
  attachmentId: string;
}

/**
 * Walk a message payload and collect every attachment part.
 *
 * Shared by handleGetMessage and the gmail attachment resolver — the
 * attachments.get endpoint returns only { data, size }, so filename and MIME
 * type can only come from the message structure.
 */
export function collectAttachmentParts(
  payload: gmail_v1.Schema$MessagePart
): AttachmentPartInfo[] {
  const found: AttachmentPartInfo[] = [];
  const walk = (part: gmail_v1.Schema$MessagePart): void => {
    if (part.filename && part.body?.attachmentId) {
      found.push({
        filename: part.filename,
        mimeType: part.mimeType ?? DEFAULT_MIME_TYPE,
        size: part.body.size ?? 0,
        attachmentId: part.body.attachmentId,
      });
    }
    part.parts?.forEach(walk);
  };
  walk(payload);
  return found;
}

// ---------------------------------------------------------------------------
// Parsing
// ---------------------------------------------------------------------------

/**
 * Infer the source for an item that omits `source`.
 *
 * This is what keeps the pre-existing {filename, mimeType, data} shape working:
 * agents deployed before the union existed still have it in their cached tool
 * schema, and their calls must not start failing.
 */
function inferSource(item: Record<string, unknown>, index: number): AttachmentSource {
  if (typeof item.data === 'string') return 'base64';
  if (typeof item.content === 'string') return 'text';
  if (typeof item.attachmentId === 'string') return 'gmail';
  throw new AttachmentError(
    `Attachment ${index + 1} has no "source" and no recognisable content. Use one of: ` +
      '{"source":"text",filename,content}, {"source":"gmail",messageId,attachmentId}, ' +
      'or {"source":"base64",filename,mimeType,data}.'
  );
}

function requireString(
  item: Record<string, unknown>,
  field: string,
  source: string,
  index: number
): string {
  const value = item[field];
  if (typeof value !== 'string' || value.trim() === '') {
    throw new AttachmentError(
      `Attachment ${index + 1} (source="${source}") is missing required field "${field}".`
    );
  }
  return value;
}

/** Validate the raw argument into typed specs. Throws AttachmentError. */
export function parseAttachments(raw: unknown): AttachmentSpec[] {
  if (raw === undefined || raw === null) return [];
  if (!Array.isArray(raw)) {
    throw new AttachmentError('"attachments" must be an array.');
  }

  return raw.map((entry, index) => {
    if (typeof entry !== 'object' || entry === null) {
      throw new AttachmentError(`Attachment ${index + 1} must be an object.`);
    }
    const item = entry as Record<string, unknown>;

    const declared = item.source;
    if (declared !== undefined && typeof declared !== 'string') {
      throw new AttachmentError(`Attachment ${index + 1}: "source" must be a string.`);
    }
    const source = (declared as AttachmentSource | undefined) ?? inferSource(item, index);

    switch (source) {
      case 'text':
        return {
          source,
          filename: requireString(item, 'filename', source, index),
          content: requireString(item, 'content', source, index),
          mimeType: typeof item.mimeType === 'string' ? item.mimeType : undefined,
        };

      case 'gmail':
        return {
          source,
          messageId: requireString(item, 'messageId', source, index),
          attachmentId: requireString(item, 'attachmentId', source, index),
          filename: typeof item.filename === 'string' ? item.filename : undefined,
        };

      case 'base64':
        return {
          source,
          filename: requireString(item, 'filename', source, index),
          data: requireString(item, 'data', source, index),
          mimeType: typeof item.mimeType === 'string' ? item.mimeType : undefined,
        };

      case 'url':
        return {
          source,
          url: requireString(item, 'url', source, index),
          filename: typeof item.filename === 'string' ? item.filename : undefined,
          mimeType: typeof item.mimeType === 'string' ? item.mimeType : undefined,
        };

      case 'drive':
        return {
          source,
          fileId: requireString(item, 'fileId', source, index),
          filename: typeof item.filename === 'string' ? item.filename : undefined,
          exportMimeType:
            typeof item.exportMimeType === 'string' ? item.exportMimeType : undefined,
        };

      case 'upload':
        return {
          source,
          uploadId: requireString(item, 'uploadId', source, index),
          filename: typeof item.filename === 'string' ? item.filename : undefined,
          mimeType: typeof item.mimeType === 'string' ? item.mimeType : undefined,
        };

      default:
        throw new AttachmentError(
          `Attachment ${index + 1}: unknown source "${String(source)}". ` +
            'Supported sources are "text", "gmail", "drive", "url", "upload" and "base64".'
        );
    }
  });
}

// ---------------------------------------------------------------------------
// Resolution
// ---------------------------------------------------------------------------

export interface AttachmentResolverContext {
  gmail: gmail_v1.Gmail;
  /**
   * Lazily builds a Drive client. A factory rather than an instance so an
   * ordinary email send never constructs one — source="drive" is the only
   * caller, and it is rare.
   */
  drive?: () => drive_v3.Drive;
  /** Drive permission context, mirrored from ServerContext. */
  driveDefaultLevel?: PermissionLevel;
  drivePathRules?: DrivePathRule[];
  /** Gateway token, used to read back agent uploads via the Reins API. */
  gatewayToken?: string;
}

/**
 * Native Google Workspace types have no binary content and must be exported.
 * Mirrors GOOGLE_DOC_MIMETYPES in ../drive/handlers.ts.
 */
const GOOGLE_DOC_EXPORT_DEFAULTS: Record<string, string> = {
  'application/vnd.google-apps.document':
    'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  'application/vnd.google-apps.spreadsheet':
    'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  'application/vnd.google-apps.presentation':
    'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  'application/vnd.google-apps.drawing': 'application/pdf',
};

/**
 * Coerce a googleapis binary response body to a Buffer.
 *
 * The typing for `responseType: 'arraybuffer'` is loose and the runtime may hand
 * back an ArrayBuffer, a typed array, or a Buffer. `Buffer.from(arrayBuffer)`
 * views the WHOLE backing buffer, so a typed array that is a view into a larger
 * pool must be sliced by its own byteOffset/byteLength or the attachment picks
 * up unrelated adjacent memory.
 */
function toBuffer(data: unknown): Buffer {
  if (Buffer.isBuffer(data)) return data;
  if (ArrayBuffer.isView(data)) {
    return Buffer.from(data.buffer, data.byteOffset, data.byteLength);
  }
  if (data instanceof ArrayBuffer) return Buffer.from(data);
  if (typeof data === 'string') return Buffer.from(data, 'binary');
  throw new Error('Unexpected response body type');
}

const GOOGLE_DOC_EXPORT_EXTENSIONS: Record<string, string> = {
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document': 'docx',
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet': 'xlsx',
  'application/vnd.openxmlformats-officedocument.presentationml.presentation': 'pptx',
  'application/pdf': 'pdf',
  'text/plain': 'txt',
  'text/csv': 'csv',
  'text/html': 'html',
};

function resolveTextAttachment(spec: AttachmentSpec, index: number): ResolvedAttachment {
  const filename = sanitizeFilename(spec.filename ?? `attachment-${index + 1}.txt`);
  const bytes = Buffer.from(spec.content ?? '', 'utf-8');

  if (bytes.length > MAX_TEXT_ATTACHMENT_BYTES) {
    throw new AttachmentError(
      `Attachment ${index + 1} ("${filename}") is ${formatBytes(bytes.length)} of text, over the ${formatBytes(MAX_TEXT_ATTACHMENT_BYTES)} limit for source="text".`
    );
  }

  let mimeType: string;
  if (spec.mimeType) {
    // Explicitly declared: hold the caller to the allowlist, so the model
    // cannot present its own prose as an executable type.
    if (!MIME_TYPE_PATTERN.test(spec.mimeType)) {
      throw new AttachmentError(
        `Attachment ${index + 1}: "${spec.mimeType}" is not a valid MIME type.`
      );
    }
    if (!(TEXT_ATTACHMENT_MIME_ALLOWLIST as readonly string[]).includes(spec.mimeType)) {
      throw new AttachmentError(
        `Attachment ${index + 1}: source="text" cannot declare mimeType "${spec.mimeType}". ` +
          `Allowed: ${TEXT_ATTACHMENT_MIME_ALLOWLIST.join(', ')}. ` +
          'For binary content, attach it from a reference source instead.'
      );
    }
    mimeType = spec.mimeType;
  } else {
    // Inferred: an extension implying a binary type just means the caller named
    // the file oddly, not that they tried something. Fall back rather than fail.
    const inferred = inferMimeFromFilename(filename);
    mimeType = (TEXT_ATTACHMENT_MIME_ALLOWLIST as readonly string[]).includes(inferred)
      ? inferred
      : 'text/plain';
  }

  return { filename, mimeType, bytes };
}

function resolveBase64Attachment(spec: AttachmentSpec, index: number): ResolvedAttachment {
  const resolved = decodeBase64Attachment({
    filename: spec.filename ?? `attachment-${index + 1}`,
    mimeType: spec.mimeType,
    data: spec.data ?? '',
  });

  if (resolved.bytes.length > MAX_BASE64_ATTACHMENT_BYTES) {
    throw new AttachmentError(
      `Attachment ${index + 1} ("${resolved.filename}") is ${formatBytes(resolved.bytes.length)} of inline base64, over the ${formatBytes(MAX_BASE64_ATTACHMENT_BYTES)} limit. ` +
        'Inline base64 has to pass through your context byte by byte. If this file came from ' +
        'an email, use {"source":"gmail","messageId":"…","attachmentId":"…"} instead — Reins ' +
        'fetches the bytes server-side and they never enter your context.'
    );
  }
  return resolved;
}

async function resolveGmailAttachment(
  spec: AttachmentSpec,
  index: number,
  ctx: AttachmentResolverContext
): Promise<ResolvedAttachment> {
  const messageId = spec.messageId as string;
  const attachmentId = spec.attachmentId as string;

  // Filename and MIME type live on the message structure, not on the
  // attachment endpoint, so the message has to be fetched either way.
  let parts: AttachmentPartInfo[];
  try {
    const message = await ctx.gmail.users.messages.get({
      userId: 'me',
      id: messageId,
      format: 'full',
    });
    parts = message.data.payload ? collectAttachmentParts(message.data.payload) : [];
  } catch {
    throw new AttachmentError(
      `Attachment ${index + 1}: could not read message "${messageId}". Check the messageId from gmail_get_message or gmail_search.`
    );
  }

  const meta = parts.find((part) => part.attachmentId === attachmentId);
  if (!meta) {
    throw new AttachmentError(
      `Attachment ${index + 1}: no attachment with id "${attachmentId}" on message "${messageId}". ` +
        'Gmail attachment ids are message-scoped and can change — call gmail_get_message ' +
        `on "${messageId}" again to get a fresh attachmentId.`
    );
  }

  let base64url: string;
  try {
    const response = await ctx.gmail.users.messages.attachments.get({
      userId: 'me',
      messageId,
      id: attachmentId,
    });
    base64url = response.data.data ?? '';
  } catch {
    throw new AttachmentError(
      `Attachment ${index + 1}: that attachment reference is no longer valid. ` +
        `Call gmail_get_message on "${messageId}" again to get a fresh attachmentId.`
    );
  }

  const bytes = Buffer.from(
    base64url.replace(/-/g, '+').replace(/_/g, '/'),
    'base64'
  );

  return {
    filename: sanitizeFilename(spec.filename ?? meta.filename),
    mimeType: MIME_TYPE_PATTERN.test(meta.mimeType) ? meta.mimeType : DEFAULT_MIME_TYPE,
    bytes,
  };
}

async function resolveUrlAttachment(
  spec: AttachmentSpec,
  index: number
): Promise<ResolvedAttachment> {
  let fetched: SafeFetchResult;
  try {
    fetched = await safeFetchAttachment(spec.url as string);
  } catch (error) {
    if (error instanceof SafeFetchError) {
      throw new AttachmentError(`Attachment ${index + 1}: ${error.message}`);
    }
    throw error;
  }

  // Prefer what the caller asked for, then what the server said, then the URL.
  const urlBasename = (() => {
    try {
      return decodeURIComponent(new URL(fetched.finalUrl).pathname.split('/').pop() ?? '');
    } catch {
      return '';
    }
  })();

  const filename = sanitizeFilename(
    spec.filename ?? fetched.filename ?? urlBasename,
    `attachment-${index + 1}`
  );

  const declared = spec.mimeType ?? fetched.mimeType;
  const mimeType =
    declared && MIME_TYPE_PATTERN.test(declared) ? declared : inferMimeFromFilename(filename);

  if (fetched.bytes.length === 0) {
    throw new AttachmentError(
      `Attachment ${index + 1}: "${fetched.finalUrl}" returned an empty file.`
    );
  }

  return { filename, mimeType, bytes: fetched.bytes };
}

async function resolveDriveAttachment(
  spec: AttachmentSpec,
  index: number,
  ctx: AttachmentResolverContext
): Promise<ResolvedAttachment> {
  if (!ctx.drive) {
    throw new AttachmentError(
      `Attachment ${index + 1}: Google Drive is not connected for this agent. ` +
        'Enable the Drive service in the Reins dashboard to attach files from Drive.'
    );
  }
  const drive = ctx.drive();
  const fileId = spec.fileId as string;

  let name: string;
  let driveMimeType: string;
  let parents: string[];
  try {
    const metadata = await drive.files.get({
      fileId,
      fields: 'id, name, mimeType, size, parents',
      supportsAllDrives: true,
    });
    name = metadata.data.name ?? 'file';
    driveMimeType = metadata.data.mimeType ?? DEFAULT_MIME_TYPE;
    parents = metadata.data.parents ?? [];
  } catch (error) {
    const message = (error as Error).message ?? '';
    if (/insufficient|scope|403/i.test(message)) {
      throw new AttachmentError(
        `Attachment ${index + 1}: this Google account is not authorized for Drive. ` +
          'Reconnect Google in the Reins dashboard with Drive enabled.'
      );
    }
    throw new AttachmentError(
      `Attachment ${index + 1}: could not read Drive file "${fileId}". Check the fileId from drive_search or drive_list_files.`
    );
  }

  // Enforce the agent's Drive folder rules here as well as in the Drive server.
  // Without this, attaching by fileId would launder a Drive read through a
  // Gmail tool, bypassing both the folder rules and the Drive service toggle.
  const levels = parents.length > 0
    ? parents.map((parent) =>
        resolvePermission(parent, ctx.drivePathRules, ctx.driveDefaultLevel ?? 'write')
      )
    : [resolvePermission(undefined, ctx.drivePathRules, ctx.driveDefaultLevel ?? 'write')];

  if (levels.includes('blocked') || !levels.some(canRead)) {
    throw new AttachmentError(
      `Attachment ${index + 1}: permission denied — this agent is not allowed to read "${name}" from Google Drive.`
    );
  }

  const isNativeDoc = driveMimeType.startsWith('application/vnd.google-apps.');
  let bytes: Buffer;
  let mimeType: string;
  let filename = spec.filename ?? name;

  try {
    if (isNativeDoc) {
      // Native docs carry no binary content — they have to be exported.
      const exportMimeType =
        spec.exportMimeType ?? GOOGLE_DOC_EXPORT_DEFAULTS[driveMimeType] ?? 'application/pdf';
      const response = await drive.files.export(
        { fileId, mimeType: exportMimeType },
        { responseType: 'arraybuffer' }
      );
      bytes = toBuffer(response.data);
      mimeType = exportMimeType;

      if (!spec.filename && !/\.[A-Za-z0-9]{1,5}$/.test(filename)) {
        const ext = GOOGLE_DOC_EXPORT_EXTENSIONS[exportMimeType];
        if (ext) filename = `${filename}.${ext}`;
      }
    } else {
      const response = await drive.files.get(
        { fileId, alt: 'media', supportsAllDrives: true },
        { responseType: 'arraybuffer' }
      );
      bytes = toBuffer(response.data);
      mimeType = driveMimeType;
    }
  } catch (error) {
    throw new AttachmentError(
      `Attachment ${index + 1}: could not download "${name}" from Drive: ${(error as Error).message}`
    );
  }

  return {
    filename: sanitizeFilename(filename, `attachment-${index + 1}`),
    mimeType: MIME_TYPE_PATTERN.test(mimeType) ? mimeType : DEFAULT_MIME_TYPE,
    bytes,
  };
}

/**
 * Read back a blob the agent uploaded from its own container.
 *
 * Goes through the Reins API rather than the database directly, mirroring
 * ../memory/handlers.ts — this package must not depend on backend internals.
 */
async function resolveUploadAttachment(
  spec: AttachmentSpec,
  index: number,
  ctx: AttachmentResolverContext
): Promise<ResolvedAttachment> {
  const token = ctx.gatewayToken ?? process.env.REINS_GATEWAY_TOKEN ?? '';
  if (!token) {
    throw new AttachmentError(
      `Attachment ${index + 1}: uploads are unavailable for this agent (no gateway token).`
    );
  }

  const apiBase = (process.env.REINS_API_URL ?? 'https://app.helm.mom').replace(/\/$/, '');
  const uploadId = spec.uploadId as string;

  let response: Response;
  try {
    response = await fetch(`${apiBase}/api/agent-uploads/${encodeURIComponent(uploadId)}`, {
      headers: { 'x-reins-agent-secret': token },
    });
  } catch (error) {
    throw new AttachmentError(
      `Attachment ${index + 1}: could not read upload "${uploadId}": ${(error as Error).message}`
    );
  }

  if (response.status === 404) {
    throw new AttachmentError(
      `Attachment ${index + 1}: upload "${uploadId}" was not found or has expired. ` +
        'Uploads are kept for 24 hours — upload the file again and use the new uploadId.'
    );
  }
  if (!response.ok) {
    throw new AttachmentError(
      `Attachment ${index + 1}: reading upload "${uploadId}" returned HTTP ${response.status}.`
    );
  }

  const bytes = Buffer.from(await response.arrayBuffer());
  const headerFilename = response.headers.get('x-upload-filename');
  const decodedFilename = headerFilename ? decodeURIComponent(headerFilename) : undefined;
  const filename = sanitizeFilename(
    spec.filename ?? decodedFilename ?? uploadId,
    `attachment-${index + 1}`
  );

  const declared = spec.mimeType ?? response.headers.get('content-type') ?? undefined;
  const mimeType =
    declared && MIME_TYPE_PATTERN.test(declared) ? declared : inferMimeFromFilename(filename);

  return { filename, mimeType, bytes };
}

/**
 * Resolve every spec to real bytes and enforce the aggregate limits.
 *
 * Throws AttachmentError with a message intended for the model.
 */
export async function resolveAttachments(
  specs: AttachmentSpec[],
  ctx: AttachmentResolverContext
): Promise<ResolvedAttachment[]> {
  const resolved: ResolvedAttachment[] = [];

  for (const [index, spec] of specs.entries()) {
    switch (spec.source) {
      case 'text':
        resolved.push(resolveTextAttachment(spec, index));
        break;
      case 'base64':
        resolved.push(resolveBase64Attachment(spec, index));
        break;
      case 'gmail':
        resolved.push(await resolveGmailAttachment(spec, index, ctx));
        break;
      case 'url':
        resolved.push(await resolveUrlAttachment(spec, index));
        break;
      case 'drive':
        resolved.push(await resolveDriveAttachment(spec, index, ctx));
        break;
      case 'upload':
        resolved.push(await resolveUploadAttachment(spec, index, ctx));
        break;
      default:
        throw new AttachmentError(
          `Attachment ${index + 1}: unsupported source "${String(spec.source)}".`
        );
    }
  }

  const error = validateAttachmentLimits(resolved);
  if (error) throw new AttachmentError(error);
  return resolved;
}

/** Convenience wrapper: parse the raw argument and resolve it in one step. */
export async function parseAndResolveAttachments(
  raw: unknown,
  ctx: AttachmentResolverContext
): Promise<ResolvedAttachment[]> {
  return resolveAttachments(parseAttachments(raw), ctx);
}
