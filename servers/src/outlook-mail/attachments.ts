/**
 * Outlook attachments: reading them off an existing message, and writing
 * resolved files onto a draft through Microsoft Graph.
 *
 * Resolution of every other source (text, url, upload, base64) is shared with
 * Gmail in ../gmail/attachments.ts. This file holds only what is Graph-specific.
 */

import {
  AttachmentError,
  parseAttachments,
  resolveAttachments,
  type AttachmentSpec,
} from '../gmail/attachments.js';
import { DEFAULT_MIME_TYPE, MIME_TYPE_PATTERN, formatBytes } from '../gmail/limits.js';
import { sanitizeFilename, type ResolvedAttachment } from '../gmail/mime.js';
import { OUTLOOK_ATTACHMENT_SOURCES } from './attachment-schema.js';

/**
 * Graph accepts a file under 3 MB as a single POST and refuses an upload
 * session for one (ErrorAttachmentSizeShouldNotBeLessThanMinimumSize); from
 * 3 MB up it requires the session.
 */
export const GRAPH_SINGLE_POST_MAX_BYTES = 3 * 1024 * 1024;

/** Bytes per PUT in an upload session. Microsoft asks for under 4 MB. */
export const GRAPH_UPLOAD_CHUNK_BYTES = 3 * 1024 * 1024;

/** Authenticated Graph call, as provided by handlers.ts. */
export type GraphRequest = (path: string, options?: RequestInit) => Promise<Response>;

/** Metadata for one file attached to an Outlook message. */
export interface OutlookAttachmentInfo {
  attachmentId: string;
  filename: string;
  mimeType: string;
  size: number;
}

async function graphErrorMessage(response: Response): Promise<string> {
  const body = (await response.json().catch(() => null)) as
    | { error?: { message?: string } }
    | null;
  return body?.error?.message || response.statusText || `HTTP ${response.status}`;
}

/**
 * List the file attachments on a message — metadata only.
 *
 * `$select` is what keeps this cheap: without it Graph returns contentBytes,
 * the whole file in base64, for every attachment.
 */
export async function listMessageAttachments(
  graph: GraphRequest,
  messageId: string
): Promise<OutlookAttachmentInfo[]> {
  const params = new URLSearchParams({ $select: 'id,name,contentType,size,isInline' });
  const response = await graph(
    `/me/messages/${encodeURIComponent(messageId)}/attachments?${params}`
  );
  if (!response.ok) throw new Error(await graphErrorMessage(response));

  const body = (await response.json()) as { value?: Array<Record<string, unknown>> };
  return (body.value ?? [])
    // Item attachments (a forwarded email, a calendar item) and links to cloud
    // files have no bytes to download, so they are not offered.
    .filter((entry) => entry['@odata.type'] === '#microsoft.graph.fileAttachment')
    .map((entry) => ({
      attachmentId: String(entry.id ?? ''),
      filename: typeof entry.name === 'string' ? entry.name : 'attachment',
      mimeType: typeof entry.contentType === 'string' ? entry.contentType : DEFAULT_MIME_TYPE,
      size: typeof entry.size === 'number' ? entry.size : 0,
    }));
}

/** Resolve source="outlook": a file already attached to another message. */
async function resolveOutlookAttachment(
  graph: GraphRequest,
  spec: AttachmentSpec,
  index: number
): Promise<ResolvedAttachment> {
  const messageId = spec.messageId as string;

  let available: OutlookAttachmentInfo[];
  try {
    available = await listMessageAttachments(graph, messageId);
  } catch {
    throw new AttachmentError(
      `Attachment ${index + 1}: could not read message "${messageId}". Check the messageId from outlook_mail_get_message or outlook_mail_search.`
    );
  }

  const wanted = spec.filename?.trim();
  const meta =
    (spec.attachmentId
      ? available.find((entry) => entry.attachmentId === spec.attachmentId)
      : undefined) ??
    (wanted
      ? available.find((entry) => entry.filename === wanted) ??
        available.find((entry) => entry.filename.toLowerCase() === wanted.toLowerCase())
      : undefined) ??
    // A lone attachment is used only when the caller named nothing. If they
    // named a file that is not there, attaching a different one would be worse
    // than refusing.
    (!wanted && !spec.attachmentId && available.length === 1 ? available[0] : undefined);

  if (!meta) {
    const listing = available.length
      ? available.map((entry) => `"${entry.filename}" (${formatBytes(entry.size)})`).join(', ')
      : 'none';
    throw new AttachmentError(
      `Attachment ${index + 1}: could not identify which attachment on message "${messageId}" you meant. ` +
        `That message has: ${listing}. Pass "filename" to name the one you want.`
    );
  }

  const response = await graph(
    `/me/messages/${encodeURIComponent(messageId)}/attachments/${encodeURIComponent(meta.attachmentId)}/$value`
  );
  if (!response.ok) {
    throw new AttachmentError(
      `Attachment ${index + 1}: could not download "${meta.filename}" from message "${messageId}": ${await graphErrorMessage(response)}`
    );
  }

  return {
    filename: sanitizeFilename(meta.filename, `attachment-${index + 1}`),
    mimeType: MIME_TYPE_PATTERN.test(meta.mimeType) ? meta.mimeType : DEFAULT_MIME_TYPE,
    bytes: Buffer.from(await response.arrayBuffer()),
  };
}

/**
 * Parse and resolve the raw `attachments` argument for an Outlook tool.
 *
 * Throws AttachmentError with a message intended for the model. Makes no
 * change to the mailbox, so it runs before the draft exists.
 */
export async function resolveOutlookAttachments(
  raw: unknown,
  graph: GraphRequest,
  gatewayToken: string | undefined
): Promise<ResolvedAttachment[]> {
  let specs: AttachmentSpec[];
  try {
    specs = parseAttachments(raw, OUTLOOK_ATTACHMENT_SOURCES);
  } catch (error) {
    // Name the reason for the two sources a model is most likely to carry
    // over from the Gmail tools.
    const source = Array.isArray(raw)
      ? raw
          .map((item) => (item as { source?: unknown } | null)?.source)
          .find((value) => value === 'gmail' || value === 'drive')
      : undefined;
    if (error instanceof AttachmentError && source) {
      throw new AttachmentError(
        `source="${source}" is not available for Outlook — it needs a Google account. ` +
          'Download the file and attach it with source="upload" ' +
          '(see outlook_mail_create_upload_link). ' +
          error.message
      );
    }
    throw error;
  }

  return resolveAttachments(specs, {
    gatewayToken,
    outlook: (spec, index) => resolveOutlookAttachment(graph, spec, index),
  });
}

/** Add one resolved file to an existing draft. Throws with Graph's reason. */
export async function addAttachmentToDraft(
  graph: GraphRequest,
  draftId: string,
  attachment: ResolvedAttachment
): Promise<void> {
  const base = `/me/messages/${encodeURIComponent(draftId)}/attachments`;

  if (attachment.bytes.length < GRAPH_SINGLE_POST_MAX_BYTES) {
    const response = await graph(base, {
      method: 'POST',
      body: JSON.stringify({
        '@odata.type': '#microsoft.graph.fileAttachment',
        name: attachment.filename,
        contentType: attachment.mimeType,
        contentBytes: attachment.bytes.toString('base64'),
      }),
    });
    if (!response.ok) throw new Error(await graphErrorMessage(response));
    return;
  }

  const session = await graph(`${base}/createUploadSession`, {
    method: 'POST',
    body: JSON.stringify({
      AttachmentItem: {
        attachmentType: 'file',
        name: attachment.filename,
        size: attachment.bytes.length,
        contentType: attachment.mimeType,
      },
    }),
  });
  if (!session.ok) throw new Error(await graphErrorMessage(session));

  const { uploadUrl } = (await session.json()) as { uploadUrl?: string };
  if (!uploadUrl) throw new Error('Microsoft Graph returned no upload URL');

  const total = attachment.bytes.length;
  for (let start = 0; start < total; start += GRAPH_UPLOAD_CHUNK_BYTES) {
    const end = Math.min(start + GRAPH_UPLOAD_CHUNK_BYTES, total) - 1;
    const chunk = attachment.bytes.subarray(start, end + 1);

    // Plain fetch, not the Graph helper: the upload URL is pre-authenticated
    // and lives on outlook.office.com, where a bearer token is rejected.
    const response = await fetch(uploadUrl, {
      method: 'PUT',
      headers: {
        'Content-Type': 'application/octet-stream',
        'Content-Length': String(chunk.length),
        'Content-Range': `bytes ${start}-${end}/${total}`,
      },
      // Copied into a plain Uint8Array: fetch's BodyInit does not accept a Buffer view.
      body: Uint8Array.from(chunk),
    });
    if (!response.ok) throw new Error(await graphErrorMessage(response));
  }
}
