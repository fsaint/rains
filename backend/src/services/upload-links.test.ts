/**
 * Upload capability tokens.
 *
 * The token may only add bytes to one agent's staging area under one
 * filename. Two properties carry that: the `type` claim, which is all that
 * separates these from the sessions and download links signed with the same
 * secret, and the filename bound at mint time.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

vi.mock('../config/index.js', () => ({
  config: {
    sessionSecret: 'a'.repeat(40),
    publicUrl: 'https://app.helm.mom',
    dashboardUrl: 'https://dash.example.com',
  },
}));
vi.mock('../db/index.js', () => ({ client: { execute: vi.fn() } }));

import jwt from 'jsonwebtoken';
import {
  UPLOAD_LINK_TTL_SECONDS,
  UPLOAD_TOKEN_TYPE,
  buildUploadLink,
  mintUploadToken,
  verifyUploadToken,
} from './upload-links.js';

const CLAIMS = {
  agentId: 'agent-1',
  userId: 'user-1',
  filename: 'Amanda Bean PsyD ROI - MCDS.pdf',
  mimeType: 'application/pdf',
};

const SECRET = 'a'.repeat(40);

describe('upload tokens', () => {
  it('round-trips the claims it was minted with', () => {
    const payload = verifyUploadToken(mintUploadToken(CLAIMS));

    expect(payload).toMatchObject({ ...CLAIMS, type: UPLOAD_TOKEN_TYPE });
  });

  it('expires', () => {
    vi.useFakeTimers();
    const token = mintUploadToken(CLAIMS);
    vi.advanceTimersByTime((UPLOAD_LINK_TTL_SECONDS + 60) * 1000);

    expect(verifyUploadToken(token)).toBeNull();
    vi.useRealTimers();
  });

  /**
   * Sessions, magic links and download links are signed with this same
   * secret, so a valid signature proves nothing on its own.
   */
  it('refuses a session token replayed as an upload token', () => {
    const session = jwt.sign({ userId: 'u1', email: 'a@b.c', role: 'admin' }, SECRET);

    expect(verifyUploadToken(session)).toBeNull();
  });

  it('refuses a download token replayed as an upload token', () => {
    const download = jwt.sign(
      { agentId: 'agent-1', credentialId: 'c1', messageId: 'm1', attachmentId: 'a1', type: 'gmail_attachment' },
      SECRET
    );

    expect(verifyUploadToken(download)).toBeNull();
  });

  it('refuses a token signed with a different secret', () => {
    const forged = jwt.sign({ ...CLAIMS, type: UPLOAD_TOKEN_TYPE }, 'b'.repeat(40));

    expect(verifyUploadToken(forged)).toBeNull();
  });

  it.each([['agentId'], ['userId'], ['filename']])('refuses a token with no %s', (key) => {
    const claims: Record<string, unknown> = { ...CLAIMS, type: UPLOAD_TOKEN_TYPE };
    delete claims[key];

    expect(verifyUploadToken(jwt.sign(claims, SECRET))).toBeNull();
  });

  it('refuses an empty string without throwing', () => {
    expect(verifyUploadToken('')).toBeNull();
    expect(verifyUploadToken('not-a-jwt')).toBeNull();
  });
});

describe('buildUploadLink', () => {
  beforeEach(() => {
    vi.useFakeTimers().setSystemTime(new Date('2026-10-01T12:00:00Z'));
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('points at the public URL, not the dashboard', () => {
    expect(buildUploadLink(CLAIMS).url).toBe('https://app.helm.mom/api/agent-uploads');
  });

  it('dates the expiry from the TTL', () => {
    expect(buildUploadLink(CLAIMS).expiresAt).toBe('2026-10-01T12:15:00.000Z');
  });

  it('builds a command that sends the file and nothing else', () => {
    const link = buildUploadLink(CLAIMS, '/Users/f/Desktop/roi.pdf');

    expect(link.curl).toContain('-X POST "https://app.helm.mom/api/agent-uploads"');
    expect(link.curl).toContain(`-H "Authorization: Bearer ${link.token}"`);
    expect(link.curl).toContain('-H "Content-Type: application/octet-stream"');
    expect(link.curl).toContain("--data-binary @'/Users/f/Desktop/roi.pdf'");
  });

  /** The real file in the report that prompted this had spaces in its name. */
  it('quotes a path with spaces so the command does not split', () => {
    const link = buildUploadLink(CLAIMS, '/Users/f/Desktop/Amanda Bean PsyD ROI - MCDS.pdf');

    expect(link.curl).toContain("--data-binary @'/Users/f/Desktop/Amanda Bean PsyD ROI - MCDS.pdf'");
  });

  /** A single quote in a path must not end the quoting and run as a command. */
  it('escapes an apostrophe rather than letting it close the quote', () => {
    const link = buildUploadLink(CLAIMS, "/Users/f/Ana's notes.pdf");

    expect(link.curl).toContain(`--data-binary @'/Users/f/Ana'\\''s notes.pdf'`);
    expect(link.curl).not.toContain("@'/Users/f/Ana's notes.pdf'");
  });

  it('leaves a placeholder when the agent did not say where the file is', () => {
    expect(buildUploadLink(CLAIMS).curl).toContain(
      "--data-binary @'/path/to/Amanda Bean PsyD ROI - MCDS.pdf'"
    );
  });

  it('states the size ceiling so the agent can check before uploading', () => {
    expect(buildUploadLink(CLAIMS).maxBytes).toBe(25 * 1024 * 1024);
  });
});
