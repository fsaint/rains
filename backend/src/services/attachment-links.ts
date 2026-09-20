/**
 * Short-lived download links for Gmail attachments.
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

/** Distinguishes this token from a session or a magic link. */
export const ATTACHMENT_TOKEN_TYPE = 'gmail_attachment' as const;

/** Long enough for an agent to run the curl, short enough to limit a leak. */
export const ATTACHMENT_LINK_TTL_SECONDS = 10 * 60;

/**
 * Below this, `gmail_get_attachment` still inlines base64 so reading a small
 * text file or thumbnail stays a single call. Above it, only the link.
 */
export const INLINE_ATTACHMENT_MAX_BYTES = 256 * 1024;

/** Path the download is served from. Must stay in the auth-guard allowlist. */
export const ATTACHMENT_DOWNLOAD_PATH = '/api/gmail/attachments/download';

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
  type: typeof ATTACHMENT_TOKEN_TYPE;
}

export interface AttachmentLink {
  url: string;
  token: string;
  expiresAt: string;
  /** A ready-to-run command, so the model does not have to assemble one. */
  curl: string;
}

export function mintAttachmentToken(claims: AttachmentTokenClaims): string {
  return jwt.sign({ ...claims, type: ATTACHMENT_TOKEN_TYPE }, config.sessionSecret, {
    expiresIn: ATTACHMENT_LINK_TTL_SECONDS,
  });
}

/**
 * Verify a download token. Returns null for anything that is not a live,
 * correctly typed, fully populated attachment token — never throws.
 */
export function verifyAttachmentToken(token: string): AttachmentTokenPayload | null {
  if (!token) return null;
  let decoded: unknown;
  try {
    decoded = jwt.verify(token, config.sessionSecret);
  } catch {
    return null;
  }
  if (typeof decoded !== 'object' || decoded === null) return null;

  const payload = decoded as Record<string, unknown>;
  if (payload.type !== ATTACHMENT_TOKEN_TYPE) return null;

  const required = ['agentId', 'credentialId', 'messageId', 'attachmentId'] as const;
  for (const key of required) {
    if (typeof payload[key] !== 'string' || (payload[key] as string).length === 0) return null;
  }

  return {
    type: ATTACHMENT_TOKEN_TYPE,
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
 * shell argument and a Content-Disposition header: no path, no quotes, no
 * control characters.
 */
export function safeAttachmentFilename(filename: string | undefined): string {
  const base = (filename ?? '').split(/[/\\]/).pop() ?? '';
  // eslint-disable-next-line no-control-regex
  const clean = base.replace(/["'`\\$\r\n\t\x00-\x1f]/g, '').trim();
  return clean === '' ? 'attachment.bin' : clean.slice(0, 200);
}

export function buildAttachmentLink(claims: AttachmentTokenClaims): AttachmentLink {
  const token = mintAttachmentToken(claims);
  const base = (config.publicUrl || config.dashboardUrl).replace(/\/+$/, '');
  const url = `${base}${ATTACHMENT_DOWNLOAD_PATH}`;
  const filename = safeAttachmentFilename(claims.filename);

  return {
    url,
    token,
    expiresAt: new Date(Date.now() + ATTACHMENT_LINK_TTL_SECONDS * 1000).toISOString(),
    curl: `curl -fsSL -H "Authorization: Bearer ${token}" -o "${filename}" "${url}"`,
  };
}
