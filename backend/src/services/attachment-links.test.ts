import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

vi.mock('../config/index.js', () => ({
  config: {
    sessionSecret: 'a'.repeat(40),
    publicUrl: 'https://app.helm.mom',
    dashboardUrl: 'https://dash.example.com',
  },
}));

import jwt from 'jsonwebtoken';
import {
  ATTACHMENT_LINK_TTL_SECONDS,
  buildAttachmentLink,
  mintAttachmentToken,
  verifyAttachmentToken,
} from './attachment-links.js';

const CLAIMS = {
  agentId: 'agent-1',
  credentialId: 'cred-1',
  messageId: 'msg-1',
  attachmentId: 'att-1',
  filename: 'report.pdf',
  mimeType: 'application/pdf',
  size: 1024,
};

describe('attachment link tokens', () => {
  beforeEach(() => {
    vi.useRealTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('round-trips every claim the download needs', () => {
    const payload = verifyAttachmentToken(mintAttachmentToken(CLAIMS));

    expect(payload).toMatchObject(CLAIMS);
    expect(payload?.type).toBe('gmail_attachment');
  });

  it('rejects a token that has expired', () => {
    const token = mintAttachmentToken(CLAIMS);

    vi.useFakeTimers();
    vi.setSystemTime(Date.now() + (ATTACHMENT_LINK_TTL_SECONDS + 60) * 1000);

    expect(verifyAttachmentToken(token)).toBeNull();
  });

  /**
   * Sessions, magic links and download links are all signed with the same
   * secret, so the type claim is the only thing separating them. Without this
   * check a stolen session cookie would read any attachment, and a download
   * link would authenticate a dashboard session.
   */
  it('rejects a validly signed token of another kind', () => {
    const session = jwt.sign({ userId: 'u1', email: 'a@b.c', role: 'admin' }, 'a'.repeat(40), {
      expiresIn: '7d',
    });
    const magic = jwt.sign({ userId: 'u1', approvalId: 'ap1', type: 'magic_link' }, 'a'.repeat(40), {
      expiresIn: '1h',
    });

    expect(verifyAttachmentToken(session)).toBeNull();
    expect(verifyAttachmentToken(magic)).toBeNull();
  });

  it('rejects a token signed with a different secret', () => {
    const forged = jwt.sign({ ...CLAIMS, type: 'gmail_attachment' }, 'b'.repeat(40), { expiresIn: '10m' });

    expect(verifyAttachmentToken(forged)).toBeNull();
  });

  it('rejects malformed input rather than throwing', () => {
    expect(verifyAttachmentToken('')).toBeNull();
    expect(verifyAttachmentToken('not-a-jwt')).toBeNull();
  });

  it('rejects a token missing the identifiers the download needs', () => {
    const partial = jwt.sign({ type: 'gmail_attachment', agentId: 'agent-1' }, 'a'.repeat(40), {
      expiresIn: '10m',
    });

    expect(verifyAttachmentToken(partial)).toBeNull();
  });
});

describe('buildAttachmentLink', () => {
  it('returns a url, a token, an expiry and a runnable curl', () => {
    const link = buildAttachmentLink(CLAIMS);

    expect(link.url).toBe('https://app.helm.mom/api/gmail/attachments/download');
    expect(verifyAttachmentToken(link.token)).toMatchObject({ messageId: 'msg-1' });
    expect(Date.parse(link.expiresAt)).toBeGreaterThan(Date.now());
    expect(link.curl).toContain(`-H "Authorization: Bearer ${link.token}"`);
    expect(link.curl).toContain('-o "report.pdf"');
    expect(link.curl).toContain(link.url);
  });

  /** A quote or newline in a sender-chosen filename must not break out of the curl line. */
  it('neutralises a filename that would escape the curl command', () => {
    const link = buildAttachmentLink({ ...CLAIMS, filename: 'a"; rm -rf /; echo "\n.pdf' });

    expect(link.curl).not.toContain('rm -rf /;');
    expect(link.curl.split('\n')).toHaveLength(1);
  });
});
