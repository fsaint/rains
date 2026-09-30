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
  contentDispositionFor,
  mintAttachmentToken,
  safeAttachmentFilename,
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

/**
 * Filenames arrive from whoever sent the mail, and a name written on a Mac
 * carries its accents decomposed: "término" is t-e-U+0301-r-m-i-n-o. U+0301
 * is above latin1, and Node throws ERR_INVALID_CHAR rather than put it in a
 * header — which is how a 500 reached a caller asking for a real invoice.
 *
 * The composed form is the quieter half of the same bug: U+00E9 does not
 * throw, it just goes out as one latin1 byte and arrives as mojibake.
 */
describe('Content-Disposition for a sender-chosen filename', () => {
  const NFD = 'BANCO_ESTADO_fabrica_término al 30 09 2026.xlsx'.normalize('NFD');
  const NFC = 'BANCO_ESTADO_fabrica_término al 30 09 2026.xlsx'.normalize('NFC');

  /** What Node will accept in a header value without transcoding surprises. */
  const isAscii = (v: string) => /^[\x20-\x7e]*$/.test(v);

  it('leaves a plain ASCII name exactly as it was', () => {
    expect(contentDispositionFor('report.pdf')).toBe('attachment; filename="report.pdf"');
  });

  it.each([['decomposed', NFD], ['composed', NFC]])(
    'emits a header a socket can carry for a %s accent',
    (_label, name) => {
      const header = contentDispositionFor(name);
      expect(isAscii(header)).toBe(true);
    }
  );

  it('carries the real name as a percent-encoded UTF-8 parameter', () => {
    const header = contentDispositionFor(NFD);

    const star = /filename\*=UTF-8''([^;]+)/.exec(header);
    expect(star, 'expected a filename* parameter').not.toBeNull();
    // Decoding it must give back the accented name, composed.
    expect(decodeURIComponent(star![1])).toBe(NFC);
  });

  it('offers an ASCII fallback that keeps the name readable', () => {
    const header = contentDispositionFor(NFD);

    const plain = /filename="([^"]+)"/.exec(header);
    expect(plain![1]).toBe('BANCO_ESTADO_fabrica_termino al 30 09 2026.xlsx');
  });

  /** Both attachments in the report that produced this bug. */
  it('handles the second file from the same message', () => {
    const header = contentDispositionFor('BANCO_ESTADO_ITS_términa al 31 12 2026.xlsx'.normalize('NFD'));
    expect(isAscii(header)).toBe(true);
    expect(header).toContain('filename="BANCO_ESTADO_ITS_termina al 31 12 2026.xlsx"');
  });

  it('still refuses a path, a quote and a newline', () => {
    const header = contentDispositionFor('../../etc/pa"ss\nwd');
    expect(header).toBe('attachment; filename="passwd"');
  });

  it('names an empty filename rather than emitting an empty parameter', () => {
    expect(contentDispositionFor(undefined)).toBe('attachment; filename="attachment.bin"');
    // A name that is nothing but accents still needs an ASCII fallback.
    expect(contentDispositionFor('é'.normalize('NFD'))).toContain('filename="e"');
  });
});

describe('safeAttachmentFilename', () => {
  /** The curl the tool hands back writes this name to disk, so compose it. */
  it('composes the accents so the local file is named correctly', () => {
    expect(safeAttachmentFilename('término.xlsx'.normalize('NFD'))).toBe('término.xlsx'.normalize('NFC'));
  });

  it('keeps the non-ASCII name, unlike the header fallback', () => {
    const link = buildAttachmentLink({ ...CLAIMS, filename: 'término.xlsx'.normalize('NFD') });
    expect(link.curl).toContain('-o "término.xlsx"'.normalize('NFC'));
  });
});
