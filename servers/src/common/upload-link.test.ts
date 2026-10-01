/**
 * create_upload_link, the tool half.
 *
 * The handler is a thin call to Helm, so what matters is what it refuses and
 * what it tells the model next. A failure here must say why in terms the
 * model can act on, because the alternative it will otherwise fall back to is
 * inline base64 — the route that corrupts large files.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { ServerContext } from './types.js';
import { createUploadLinkTool, handleCreateUploadLink } from './upload-link.js';

const ctx = (over: Partial<ServerContext> = {}): ServerContext => ({
  requestId: 'req-1',
  gatewayToken: 'gw-token',
  ...over,
});

const LINK = {
  url: 'https://app.helm.mom/api/agent-uploads',
  token: 'cap-token',
  expiresAt: '2026-10-01T12:15:00.000Z',
  maxBytes: 25 * 1024 * 1024,
  curl: "curl -fsS -X POST \"https://app.helm.mom/api/agent-uploads\" -H \"Authorization: Bearer cap-token\" -H \"Content-Type: application/octet-stream\" --data-binary @'/Users/f/roi.pdf'",
};

/** Record every fetch, answering with `body` at `status`. */
function api(status = 201, body: unknown = { data: LINK }) {
  const calls: Array<{ url: string; init: RequestInit }> = [];
  vi.stubGlobal('fetch', vi.fn(async (url: string, init: RequestInit) => {
    calls.push({ url: String(url), init: init ?? {} });
    return new Response(JSON.stringify(body), { status });
  }));
  return calls;
}

const bodyOf = (call: { init: RequestInit }) => JSON.parse(String(call.init.body ?? '{}'));

beforeEach(() => {
  vi.clearAllMocks();
  vi.unstubAllGlobals();
  delete process.env.REINS_API_URL;
  delete process.env.REINS_GATEWAY_TOKEN;
});

describe('handleCreateUploadLink', () => {
  it('asks Helm for a link and hands back the command', async () => {
    const calls = api();

    const result = await handleCreateUploadLink(
      { filename: 'ROI - MCDS.pdf', mimeType: 'application/pdf', localPath: '/Users/f/roi.pdf' },
      ctx()
    );

    expect(result.success).toBe(true);
    const data = result.data as Record<string, unknown>;
    expect(data.curl).toBe(LINK.curl);
    expect(data.upload_url).toBe(LINK.url);
    expect(data.max_bytes).toBe(25 * 1024 * 1024);
    expect(data.expires_at).toBe(LINK.expiresAt);
    expect(calls[0].url).toBe('https://app.helm.mom/api/agent-uploads/link');
    expect(calls[0].init.method).toBe('POST');
    expect(bodyOf(calls[0])).toEqual({
      filename: 'ROI - MCDS.pdf',
      mimeType: 'application/pdf',
      localPath: '/Users/f/roi.pdf',
    });
  });

  /** The capability is minted inside Helm; the agent authenticates as itself. */
  it('authenticates with the gateway token, not the capability', async () => {
    const calls = api();

    await handleCreateUploadLink({ filename: 'a.pdf' }, ctx());

    expect((calls[0].init.headers as Record<string, string>)['x-reins-agent-secret']).toBe('gw-token');
  });

  /** The model has to know what to do with the id, or the link is wasted. */
  it('says how to use the upload id afterwards', async () => {
    api();

    const result = await handleCreateUploadLink({ filename: 'a.pdf' }, ctx());

    const nextStep = (result.data as Record<string, string>).next_step;
    expect(nextStep).toMatch(/data\.id/);
    expect(nextStep).toMatch(/"source":"upload"/);
  });

  it('requires a filename', async () => {
    const calls = api();

    const result = await handleCreateUploadLink({ localPath: '/Users/f/roi.pdf' }, ctx());

    expect(result.success).toBe(false);
    expect(result.error).toMatch(/filename/i);
    expect(calls).toHaveLength(0);
  });

  it('refuses when the agent has no gateway token', async () => {
    const calls = api();

    const result = await handleCreateUploadLink({ filename: 'a.pdf' }, ctx({ gatewayToken: undefined }));

    expect(result.success).toBe(false);
    expect(result.error).toMatch(/no gateway token/i);
    expect(calls).toHaveLength(0);
  });

  it('surfaces the reason Helm refused rather than a bare status', async () => {
    api(400, { error: 'filename is required' });

    const result = await handleCreateUploadLink({ filename: 'a.pdf' }, ctx());

    expect(result.success).toBe(false);
    expect(result.error).toContain('filename is required');
  });

  it('reports a status when the refusal carries no JSON', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('gateway timeout', { status: 504 })));

    const result = await handleCreateUploadLink({ filename: 'a.pdf' }, ctx());

    expect(result.success).toBe(false);
    expect(result.error).toContain('504');
  });

  it('reports a network failure instead of throwing', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => { throw new Error('ECONNREFUSED'); }));

    const result = await handleCreateUploadLink({ filename: 'a.pdf' }, ctx());

    expect(result.success).toBe(false);
    expect(result.error).toContain('ECONNREFUSED');
  });

  it('honours REINS_API_URL for local development', async () => {
    process.env.REINS_API_URL = 'http://localhost:5001/';
    const calls = api();

    await handleCreateUploadLink({ filename: 'a.pdf' }, ctx());

    expect(calls[0].url).toBe('http://localhost:5001/api/agent-uploads/link');
  });

  it('omits an absent mimeType rather than sending null', async () => {
    const calls = api();

    await handleCreateUploadLink({ filename: 'a.pdf' }, ctx());

    expect(bodyOf(calls[0])).toEqual({ filename: 'a.pdf' });
  });
});

describe('createUploadLinkTool', () => {
  it.each([
    ['gmail_' as const, 'gmail_create_upload_link'],
    ['drive_' as const, 'drive_create_upload_link'],
  ])('registers under the %s prefix', (prefix, expected) => {
    const tool = createUploadLinkTool(prefix);

    expect(tool.name).toBe(expected);
    expect(tool.inputSchema.required).toEqual(['filename']);
  });

  /**
   * The description is the only thing steering the model away from base64,
   * which is what produced a corrupted file in the report behind this tool.
   */
  it('tells the model to prefer this over base64', () => {
    expect(createUploadLinkTool('gmail_').description).toMatch(/base64/);
  });

  /** Forwarding a file already in Gmail or Drive must not route through here. */
  it('says it does not apply to files already on the server', () => {
    const description = createUploadLinkTool('gmail_').description;

    expect(description).toMatch(/source="gmail"/);
    expect(description).toMatch(/source="drive"/);
  });
});
