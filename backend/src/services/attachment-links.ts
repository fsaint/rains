/**
 * Short-lived download links for Gmail and Outlook attachments.
 *
 * Gmail's attachments endpoint is not a media download: it answers with
 * base64url inside JSON. Returning that from a tool call puts the whole file
 * in the model's context — a 10 MB PDF is over three million tokens — so
 * instead the tool hands back a URL and a token, and the bytes are fetched
 * and streamed server-side when the agent curls it.
 *
 * The token is a capability, not a session. It names exactly one attachment
 * on one credential, lives ten minutes, and is re-authorized against the
 * agent's live access at download time, so detaching the account kills every
 * outstanding link.
 *
 * NOTE: sessions, magic links and these all share `config.sessionSecret`, so
 * the `type` claim is the only thing that distinguishes them. Every verify
 * path must check it — see verifyAttachmentToken.
 */

import jwt from 'jsonwebtoken';
import { config } from '../config/index.js';

/** Mail providers whose attachments are delivered through these links. */
export type AttachmentProvider = 'gmail' | 'outlook';

/** Distinguishes this token from a session or a magic link. */
export const ATTACHMENT_TOKEN_TYPE = 'gmail_attachment' as const;

/**
 * Outlook links carry their own type, so a Gmail token cannot be replayed
 * against the Outlook route (or the reverse). Each route verifies only its own.
 */
export const OUTLOOK_ATTACHMENT_TOKEN_TYPE = 'outlook_attachment' as const;

export type AttachmentTokenType = typeof ATTACHMENT_TOKEN_TYPE | typeof OUTLOOK_ATTACHMENT_TOKEN_TYPE;

const TOKEN_TYPES: Record<AttachmentProvider, AttachmentTokenType> = {
  gmail: ATTACHMENT_TOKEN_TYPE,
  outlook: OUTLOOK_ATTACHMENT_TOKEN_TYPE,
};

/** Long enough for an agent to run the curl, short enough to limit a leak. */
export const ATTACHMENT_LINK_TTL_SECONDS = 10 * 60;

/**
 * Below this, `gmail_get_attachment` still inlines base64 so reading a small
 * text file or thumbnail stays a single call. Above it, only the link.
 */
export const INLINE_ATTACHMENT_MAX_BYTES = 256 * 1024;

/** Path the download is served from. Must stay in the auth-guard allowlist. */
export const ATTACHMENT_DOWNLOAD_PATH = '/api/gmail/attachments/download';

/** Outlook's download path. Must stay in the auth-guard allowlist. */
export const OUTLOOK_ATTACHMENT_DOWNLOAD_PATH = '/api/outlook/attachments/download';

const DOWNLOAD_PATHS: Record<AttachmentProvider, string> = {
  gmail: ATTACHMENT_DOWNLOAD_PATH,
  outlook: OUTLOOK_ATTACHMENT_DOWNLOAD_PATH,
};

export interface AttachmentTokenClaims {
  agentId: string;
  /** The account the attachment was read from; the download uses the same one. */
  credentialId: string;
  messageId: string;
  attachmentId: string;
  filename?: string;
  mimeType?: string;
  size?: number;
}

export interface AttachmentTokenPayload extends AttachmentTokenClaims {
  type: AttachmentTokenType;
}

export interface AttachmentLink {
  url: string;
  token: string;
  expiresAt: string;
  /** A ready-to-run command, so the model does not have to assemble one. */
  curl: string;
}

export function mintAttachmentToken(
  claims: AttachmentTokenClaims,
  provider: AttachmentProvider = 'gmail'
): string {
  return jwt.sign({ ...claims, type: TOKEN_TYPES[provider] }, config.sessionSecret, {
    expiresIn: ATTACHMENT_LINK_TTL_SECONDS,
  });
}

/**
 * Verify a download token. Returns null for anything that is not a live,
 * fully populated attachment token of this provider's type — never throws.
 */
export function verifyAttachmentToken(
  token: string,
  provider: AttachmentProvider = 'gmail'
): AttachmentTokenPayload | null {
  const expectedType = TOKEN_TYPES[provider];
  if (!token) return null;
  let decoded: unknown;
  try {
    decoded = jwt.verify(token, config.sessionSecret);
  } catch {
    return null;
  }
  if (typeof decoded !== 'object' || decoded === null) return null;

  const payload = decoded as Record<string, unknown>;
  if (payload.type !== expectedType) return null;

  const required = ['agentId', 'credentialId', 'messageId', 'attachmentId'] as const;
  for (const key of required) {
    if (typeof payload[key] !== 'string' || (payload[key] as string).length === 0) return null;
  }

  return {
    type: expectedType,
    agentId: payload.agentId as string,
    credentialId: payload.credentialId as string,
    messageId: payload.messageId as string,
    attachmentId: payload.attachmentId as string,
    filename: typeof payload.filename === 'string' ? payload.filename : undefined,
    mimeType: typeof payload.mimeType === 'string' ? payload.mimeType : undefined,
    size: typeof payload.size === 'number' ? payload.size : undefined,
  };
}

/**
 * Strip a sender-chosen filename down to something safe to place inside a
 * shell argument: no path, no quotes, no control characters.
 *
 * Accents are composed (NFC) on the way through. A name written on a Mac
 * arrives decomposed — "término" is t, e, U+0301, r, m, i, n, o — and the
 * combining mark is both invisible in logs and, above latin1, unusable in a
 * header. Composing once here means every consumer sees the same string.
 *
 * The result may still be non-ASCII, which is correct: it is the name the
 * file should have on disk. Header values go through contentDispositionFor.
 */
export function safeAttachmentFilename(filename: string | undefined): string {
  const base = (filename ?? '').normalize('NFC').split(/[/\\]/).pop() ?? '';
  // eslint-disable-next-line no-control-regex
  const clean = base.replace(/["'`\\$\r\n\t\x00-\x1f]/g, '').trim();
  return clean === '' ? 'attachment.bin' : clean.slice(0, 200);
}

/**
 * Percent-encode a filename for the `filename*` parameter of RFC 5987.
 *
 * encodeURIComponent leaves ' ( ) * ! ~ alone; of those only ! and ~ are
 * attr-char, so the other four are escaped by hand. Over-escaping is always
 * safe here, under-escaping is not.
 */
function encodeExtendedFilename(name: string): string {
  return encodeURIComponent(name).replace(
    /['()*]/g,
    (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`
  );
}

/**
 * The ASCII half of the header: accents folded to their base letter, and
 * anything still outside printable ASCII replaced with an underscore.
 *
 * "término" becomes "termino" rather than "t_rmino" — a reader who only gets
 * the fallback should still recognise the file.
 */
function asciiFallbackFilename(name: string): string {
  const folded = name
    .normalize('NFD')
    // eslint-disable-next-line no-misleading-character-class
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^\x20-\x7e]/g, '_')
    .trim();
  return folded === '' ? 'attachment.bin' : folded;
}

/**
 * Build the Content-Disposition value for a download.
 *
 * Node refuses to write a header value containing anything above latin1 and
 * throws ERR_INVALID_CHAR, so interpolating a sender's filename straight into
 * the header turns any accented attachment into a 500. Even the characters it
 * does accept are written as latin1 bytes, which reach the client as mojibake.
 *
 * So the real name travels in `filename*` as percent-encoded UTF-8 (RFC 6266),
 * with a plain ASCII `filename=` for anything that does not understand it. A
 * name that is already ASCII gets the short form and nothing else.
 */
export function contentDispositionFor(filename: string | undefined): string {
  const name = safeAttachmentFilename(filename);
  const ascii = asciiFallbackFilename(name);
  const plain = `attachment; filename="${ascii}"`;

  if (ascii === name) return plain;
  return `${plain}; filename*=UTF-8''${encodeExtendedFilename(name)}`;
}

export function buildAttachmentLink(
  claims: AttachmentTokenClaims,
  provider: AttachmentProvider = 'gmail'
): AttachmentLink {
  const token = mintAttachmentToken(claims, provider);
  const base = (config.publicUrl || config.dashboardUrl).replace(/\/+$/, '');
  const url = `${base}${DOWNLOAD_PATHS[provider]}`;
  const filename = safeAttachmentFilename(claims.filename);

  return {
    url,
    token,
    expiresAt: new Date(Date.now() + ATTACHMENT_LINK_TTL_SECONDS * 1000).toISOString(),
    curl: `curl -fsSL -H "Authorization: Bearer ${token}" -o "${filename}" "${url}"`,
  };
}
