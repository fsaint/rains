/**
 * Short-lived upload links: the mirror of attachment-links.ts.
 *
 * An agent that holds a file on its own machine had no way to attach it. The
 * staging route authenticates on `agents.gateway_token`, which the hosted
 * container runtime injected as an environment variable; that runtime was
 * removed in September 2026, and the token is returned by no API and shown in
 * no dashboard. So `source: "upload"` became reachable only by an agent that
 * no longer exists, leaving inline base64 as the only local-file path — the
 * one the tool description itself calls a last resort.
 *
 * A tool call now mints a capability token and hands back a ready-to-run
 * curl. The agent pipes its local file straight into Helm and gets back an
 * uploadId, so the bytes never pass through the model's context in either
 * direction.
 *
 * The token is a capability, not a session. It names one agent, carries the
 * filename it was minted for, and may only add bytes: it cannot read an
 * upload back, and it cannot reach any other route.
 *
 * NOTE: sessions, magic links, download links and these all share
 * `config.sessionSecret`, so the `type` claim is the only thing that
 * distinguishes them. Every verify path must check it.
 */

import jwt from 'jsonwebtoken';
import { config } from '../config/index.js';
import { MAX_UPLOAD_BYTES } from './agent-uploads.js';

/** Distinguishes this token from a session, a magic link or a download link. */
export const UPLOAD_TOKEN_TYPE = 'agent_upload' as const;

/**
 * Longer than a download link's ten minutes: this one is spent sending bytes
 * rather than receiving them, and 25 MB over a domestic uplink is slow.
 */
export const UPLOAD_LINK_TTL_SECONDS = 15 * 60;

/** The route the bytes are POSTed to. Must stay in the auth-guard allowlist. */
export const UPLOAD_PATH = '/api/agent-uploads';

export interface UploadTokenClaims {
  agentId: string;
  userId: string;
  /** Bound at mint time so a leaked token cannot stage something else. */
  filename: string;
  mimeType?: string;
}

export interface UploadTokenPayload extends UploadTokenClaims {
  type: typeof UPLOAD_TOKEN_TYPE;
}

export interface UploadLink {
  url: string;
  token: string;
  expiresAt: string;
  maxBytes: number;
  /** A ready-to-run command, so the model does not have to assemble one. */
  curl: string;
}

export function mintUploadToken(claims: UploadTokenClaims): string {
  return jwt.sign({ ...claims, type: UPLOAD_TOKEN_TYPE }, config.sessionSecret, {
    expiresIn: UPLOAD_LINK_TTL_SECONDS,
  });
}

/**
 * Verify an upload token. Returns null for anything that is not a live,
 * correctly typed, fully populated upload token — never throws.
 */
export function verifyUploadToken(token: string): UploadTokenPayload | null {
  if (!token) return null;
  let decoded: unknown;
  try {
    decoded = jwt.verify(token, config.sessionSecret);
  } catch {
    return null;
  }
  if (typeof decoded !== 'object' || decoded === null) return null;

  const payload = decoded as Record<string, unknown>;
  if (payload.type !== UPLOAD_TOKEN_TYPE) return null;

  const required = ['agentId', 'userId', 'filename'] as const;
  for (const key of required) {
    if (typeof payload[key] !== 'string' || (payload[key] as string).length === 0) return null;
  }

  return {
    type: UPLOAD_TOKEN_TYPE,
    agentId: payload.agentId as string,
    userId: payload.userId as string,
    filename: payload.filename as string,
    mimeType: typeof payload.mimeType === 'string' ? payload.mimeType : undefined,
  };
}

/**
 * Quote a local path for the shell, so a name with a space or an apostrophe
 * does not split the command. Single quotes with the standard escape, because
 * inside them the shell expands nothing at all.
 */
function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

/**
 * Build the link and the command that uses it.
 *
 * `localPath` is the agent's own path, which the server never sees and never
 * stores — it only renders it into the command string. Without one the
 * command carries a placeholder for the agent to replace.
 */
export function buildUploadLink(
  claims: UploadTokenClaims,
  localPath?: string
): UploadLink {
  const token = mintUploadToken(claims);
  const base = (config.publicUrl || config.dashboardUrl).replace(/\/+$/, '');
  const url = `${base}${UPLOAD_PATH}`;
  const path = localPath && localPath.trim() !== '' ? localPath.trim() : `/path/to/${claims.filename}`;

  return {
    url,
    token,
    expiresAt: new Date(Date.now() + UPLOAD_LINK_TTL_SECONDS * 1000).toISOString(),
    maxBytes: MAX_UPLOAD_BYTES,
    curl:
      `curl -fsS -X POST "${url}" ` +
      `-H "Authorization: Bearer ${token}" ` +
      `-H "Content-Type: application/octet-stream" ` +
      `--data-binary @${shellQuote(path)}`,
  };
}
