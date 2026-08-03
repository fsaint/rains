import { describe, it, expect } from 'vitest';
import { redactToolArgs, MAX_PERSISTED_STRING } from './redact-args.js';

describe('redactToolArgs — attachments', () => {
  it('replaces base64 data with a marker and a byte count', () => {
    const data = Buffer.alloc(3000).toString('base64');
    const out = redactToolArgs({
      to: ['a@example.com'],
      attachments: [{ source: 'base64', filename: 'a.pdf', mimeType: 'application/pdf', data }],
    });

    const attachment = (out.attachments as Record<string, unknown>[])[0];
    expect(attachment.data).toBe('[payload omitted]');
    expect(attachment._bytes).toBe(3000);
    expect(attachment.filename).toBe('a.pdf');
    expect(attachment.mimeType).toBe('application/pdf');
  });

  it('replaces text content with a marker and a byte count', () => {
    const out = redactToolArgs({
      attachments: [{ source: 'text', filename: 'a.csv', content: 'a,b\n1,2\n' }],
    });

    const attachment = (out.attachments as Record<string, unknown>[])[0];
    expect(attachment.content).toBe('[payload omitted]');
    expect(attachment._bytes).toBe(8);
  });

  it('leaves reference attachments untouched — they carry no payload', () => {
    const out = redactToolArgs({
      attachments: [{ source: 'gmail', messageId: 'M1', attachmentId: 'ATT_1' }],
    });

    expect((out.attachments as unknown[])[0]).toEqual({
      source: 'gmail',
      messageId: 'M1',
      attachmentId: 'ATT_1',
    });
  });

  it('handles the legacy shape with no source field', () => {
    const out = redactToolArgs({
      attachments: [{ filename: 'a.txt', mimeType: 'text/plain', data: 'aGVsbG8=' }],
    });

    const attachment = (out.attachments as Record<string, unknown>[])[0];
    expect(attachment.data).toBe('[payload omitted]');
    expect(attachment._bytes).toBe(6);
  });

  it('does not mutate the input', () => {
    const args = { attachments: [{ filename: 'a.txt', data: 'aGVsbG8=' }] };
    redactToolArgs(args);
    expect(args.attachments[0].data).toBe('aGVsbG8=');
  });
});

describe('redactToolArgs — string truncation', () => {
  it('truncates strings over the limit and records how much was dropped', () => {
    const out = redactToolArgs({ htmlBody: 'x'.repeat(MAX_PERSISTED_STRING + 500) });
    const value = out.htmlBody as string;

    expect(value.length).toBeLessThan(MAX_PERSISTED_STRING + 60);
    expect(value).toContain('(500 chars omitted)');
  });

  it('leaves a normal email body intact', () => {
    // Must exceed BODY_PREVIEW_LIMIT (3000) so the approval preview, not
    // redaction, is what decides truncation.
    const body = 'x'.repeat(3200);
    expect(redactToolArgs({ body }).body).toBe(body);
  });
});

describe('redactToolArgs — passthrough', () => {
  it('preserves the scalar fields that JSONB lookups depend on', () => {
    // approvals/queue.ts and services/agent-bot-relay.ts query
    // arguments_json::jsonb->>'provider' and ->>'chatId'.
    const out = redactToolArgs({ provider: 'minimax', chatId: '-100123', count: 5, ok: true });

    expect(out).toEqual({ provider: 'minimax', chatId: '-100123', count: 5, ok: true });
  });

  it('returns an empty object for null or undefined', () => {
    expect(redactToolArgs(undefined)).toEqual({});
    expect(redactToolArgs(null)).toEqual({});
  });

  it('leaves a non-array attachments value alone', () => {
    expect(redactToolArgs({ attachments: 'nope' }).attachments).toBe('nope');
  });
});
