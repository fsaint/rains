/**
 * JSON Schema for the `attachments` parameter of outlook_mail_create_draft and
 * outlook_mail_send_message.
 *
 * Same flat-object-plus-discriminator shape as ../gmail/attachment-schema.ts,
 * for the same reason: several model backends reject or mangle `oneOf` inside
 * function parameters. It is a separate schema rather than a shared one because
 * the sources differ — a Microsoft token cannot read Gmail or Google Drive, and
 * the schema must only advertise what actually works.
 */

import type { AttachmentSource } from '../gmail/attachments.js';

export const OUTLOOK_ATTACHMENT_SOURCES: readonly AttachmentSource[] = [
  'text',
  'outlook',
  'url',
  'upload',
  'base64',
];

export const outlookAttachmentsSchema = {
  type: 'array',
  description:
    'Files to attach. Each item MUST set "source". Prefer references over raw bytes — ' +
    'referenced files are fetched server-side and never pass through your context.\n' +
    '• source="upload" — a file on YOUR machine (one you generated, downloaded, or that ' +
    'the user has on disk). Call outlook_mail_create_upload_link with the filename and local ' +
    'path, run the curl command it returns, and pass the upload id from that command\'s output. ' +
    'Requires: uploadId. Staged uploads expire after 24 hours.\n' +
    '• source="text" — a file you write yourself (CSV, markdown, plain text, HTML, JSON). ' +
    'Requires: filename, content. Optional: mimeType (inferred from the extension).\n' +
    '• source="outlook" — forward a file from an existing Outlook email WITHOUT downloading ' +
    'it. Requires: messageId. Name the file with filename (from outlook_mail_get_message); a ' +
    'message with a single attachment needs neither filename nor attachmentId.\n' +
    '• source="url" — a file at a public https:// address, fetched server-side. ' +
    'Requires: url. Optional: filename, mimeType. Only https is allowed, and addresses on ' +
    'private networks are refused.\n' +
    '• source="base64" — raw bytes you encode inline. LAST RESORT: you must emit every ' +
    'byte as output, which is slow and corrupts easily above a few KB. Limit 384 KB. For a ' +
    'local file of any real size use source="upload" instead. Requires: filename, mimeType, data.\n' +
    'Limits: 10 files, 20 MB each, 22 MB in total.',
  items: {
    type: 'object',
    properties: {
      source: {
        type: 'string',
        enum: [...OUTLOOK_ATTACHMENT_SOURCES],
        description: 'Where the file content comes from. Required.',
      },
      filename: {
        type: 'string',
        description:
          'File name including extension, e.g. "q3-report.csv". Required for ' +
          'source="text" and source="base64". For source="outlook" it selects which ' +
          'attachment of the message to forward.',
      },
      mimeType: {
        type: 'string',
        description:
          'MIME type, e.g. "application/pdf". Required for source="base64". Inferred ' +
          'from the filename extension for source="text". Ignored for source="outlook".',
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
          'source="outlook" only. The message the file is attached to, from ' +
          'outlook_mail_get_message or outlook_mail_search.',
      },
      attachmentId: {
        type: 'string',
        description:
          'source="outlook" only, optional. The attachmentId from the "attachments" array ' +
          'returned by outlook_mail_get_message.',
      },
      url: {
        type: 'string',
        description:
          'source="url" only. A public https:// address. Helm downloads it server-side, ' +
          'so the bytes never enter your context.',
      },
      uploadId: {
        type: 'string',
        description:
          'source="upload" only. The upload id printed by the curl command from ' +
          'outlook_mail_create_upload_link.',
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
