/**
 * Outlook attachments.
 *
 * Outlook drafts took no attachments at all, so an agent asked to send a local
 * file from an Outlook account had no route. These tests drive the handlers
 * against a routed fake of Microsoft Graph and the Helm upload store.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { data } from '../common/test-helpers.js';
import type { ServerContext } from '../common/types.js';
import { handleCreateDraft, handleGetMessage, handleSendMessage } from './handlers.js';
import { outlookMailTools } from './tools.js';
import { definition } from './definition.js';
import { parseAttachments } from '../gmail/attachments.js';

const GRAPH = 'https://graph.microsoft.com/v1.0';
const UPLOAD_URL = 'https://outlook.office.com/api/v2.0/AttachmentSessions/s1?authtoken=pre';

const context: ServerContext = {
  requestId: 'req',
  accessToken: 'ms-token',
  gatewayToken: 'gateway-token',
};

interface Call {
  method: string;
  url: string;
  headers: Record<string, string>;
  body: unknown;
}

type Route = (call: Call) => Response | undefined;

let calls: Call[];
let routes: Route[];

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

/** Register a handler for one method + URL prefix. Later routes win. */
function on(method: string, urlPrefix: string, respond: (call: Call) => Response): void {
  routes.unshift((call) =>
    call.method === method && call.url.startsWith(urlPrefix) ? respond(call) : undefined
  );
}

function callsTo(method: string, urlPart: string): Call[] {
  return calls.filter((call) => call.method === method && call.url.includes(urlPart));
}

beforeEach(() => {
  calls = [];
  routes = [];

  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: string | URL, init: RequestInit = {}) => {
      const call: Call = {
        method: (init.method ?? 'GET').toUpperCase(),
        url: String(input),
        headers: Object.fromEntries(
          Object.entries((init.headers ?? {}) as Record<string, string>).map(([k, v]) => [
            k.toLowerCase(),
            v,
          ])
        ),
        body: init.body,
      };
      calls.push(call);
      for (const route of routes) {
        const response = route(call);
        if (response) return response;
      }
      return json({ error: { message: `unrouted ${call.method} ${call.url}` } }, 500);
    })
  );

  // The happy-path Graph surface. Individual tests override pieces of it.
  on('POST', `${GRAPH}/me/messages`, () => json({ id: 'draft-1', subject: 'Report' }, 201));
  on('POST', `${GRAPH}/me/messages/draft-1/attachments`, () => json({ id: 'att-new' }, 201));
  on('POST', `${GRAPH}/me/messages/draft-1/attachments/createUploadSession`, () =>
    json({ uploadUrl: UPLOAD_URL, nextExpectedRanges: ['0-'] }, 201)
  );
  on('POST', `${GRAPH}/me/messages/draft-1/send`, () => new Response(null, { status: 202 }));
  on('DELETE', `${GRAPH}/me/messages/draft-1`, () => new Response(null, { status: 204 }));
});

afterEach(() => {
  vi.unstubAllGlobals();
});

const BASE_ARGS = { to: ['ana@example.com'], subject: 'Report', body: 'See attached' };

describe('outlook_mail_create_draft — attachments', () => {
  it('still creates a plain draft with one request when nothing is attached', async () => {
    const result = await handleCreateDraft(BASE_ARGS, context);

    expect(result.success).toBe(true);
    expect(data(result).id).toBe('draft-1');
    expect(calls).toHaveLength(1);
  });

  it('attaches a file the agent wrote', async () => {
    const result = await handleCreateDraft(
      { ...BASE_ARGS, attachments: [{ source: 'text', filename: 'q3.csv', content: 'a,b\n1,2\n' }] },
      context
    );

    expect(result.success).toBe(true);
    const [attach] = callsTo('POST', '/me/messages/draft-1/attachments');
    expect(JSON.parse(attach.body as string)).toEqual({
      '@odata.type': '#microsoft.graph.fileAttachment',
      name: 'q3.csv',
      contentType: 'text/csv',
      contentBytes: Buffer.from('a,b\n1,2\n').toString('base64'),
    });
    expect(data(result).attachments).toEqual([{ filename: 'q3.csv', size: 8 }]);
  });

  it('attaches a file uploaded from the agent machine', async () => {
    on('GET', 'https://app.helm.mom/api/agent-uploads/up-1', () =>
      new Response(Buffer.from('%PDF-1.7'), {
        status: 200,
        headers: { 'Content-Type': 'application/pdf', 'x-upload-filename': 'ROI.pdf' },
      })
    );

    const result = await handleCreateDraft(
      { ...BASE_ARGS, attachments: [{ source: 'upload', uploadId: 'up-1' }] },
      context
    );

    expect(result.success).toBe(true);
    const [staged] = callsTo('GET', '/api/agent-uploads/up-1');
    expect(staged.headers['x-reins-agent-secret']).toBe('gateway-token');
    const [attach] = callsTo('POST', '/me/messages/draft-1/attachments');
    expect(JSON.parse(attach.body as string)).toMatchObject({
      name: 'ROI.pdf',
      contentType: 'application/pdf',
      contentBytes: Buffer.from('%PDF-1.7').toString('base64'),
    });
  });

  it('uploads a file of 3 MB or more through an upload session, in order', async () => {
    const big = Buffer.alloc(7 * 1024 * 1024, 7);
    on('GET', 'https://app.helm.mom/api/agent-uploads/big', () =>
      new Response(big, {
        status: 200,
        headers: { 'Content-Type': 'application/zip', 'x-upload-filename': 'site.zip' },
      })
    );
    on('PUT', UPLOAD_URL, (call) => {
      const range = call.headers['content-range'];
      const last = Number(range.split('-')[1].split('/')[0]) === big.length - 1;
      return last ? new Response(null, { status: 201 }) : json({ nextExpectedRanges: ['x'] });
    });

    const result = await handleCreateDraft(
      { ...BASE_ARGS, attachments: [{ source: 'upload', uploadId: 'big' }] },
      context
    );

    expect(result.success).toBe(true);

    const [session] = callsTo('POST', '/attachments/createUploadSession');
    expect(JSON.parse(session.body as string)).toEqual({
      AttachmentItem: {
        attachmentType: 'file',
        name: 'site.zip',
        size: big.length,
        contentType: 'application/zip',
      },
    });

    const puts = callsTo('PUT', 'outlook.office.com');
    expect(puts.length).toBeGreaterThan(1);
    // Contiguous ranges covering the whole file.
    let next = 0;
    for (const put of puts) {
      const [, start, end, total] = /bytes (\d+)-(\d+)\/(\d+)/.exec(put.headers['content-range'])!;
      expect(Number(start)).toBe(next);
      expect(Number(total)).toBe(big.length);
      expect((put.body as Uint8Array).byteLength).toBe(Number(end) - Number(start) + 1);
      expect((put.body as Uint8Array).byteLength).toBeLessThan(4 * 1024 * 1024);
      next = Number(end) + 1;
    }
    expect(next).toBe(big.length);
    // The upload URL is pre-authenticated; Microsoft rejects a bearer token on it.
    expect(puts.every((put) => put.headers.authorization === undefined)).toBe(true);
    // And the single-POST path was not used for it.
    expect(
      callsTo('POST', '/me/messages/draft-1/attachments').filter(
        (call) => !call.url.endsWith('createUploadSession')
      )
    ).toHaveLength(0);
  });

  it('forwards a file from another Outlook email without the agent downloading it', async () => {
    on('GET', `${GRAPH}/me/messages/src-1/attachments`, () =>
      json({
        value: [
          {
            '@odata.type': '#microsoft.graph.fileAttachment',
            id: 'a1',
            name: 'logo.png',
            contentType: 'image/png',
            size: 4,
          },
          {
            '@odata.type': '#microsoft.graph.fileAttachment',
            id: 'a2',
            name: 'contract.pdf',
            contentType: 'application/pdf',
            size: 8,
          },
        ],
      })
    );
    on('GET', `${GRAPH}/me/messages/src-1/attachments/a2/$value`, () =>
      new Response(Buffer.from('%PDF-1.4'), { status: 200 })
    );

    const result = await handleCreateDraft(
      {
        ...BASE_ARGS,
        attachments: [{ source: 'outlook', messageId: 'src-1', filename: 'contract.pdf' }],
      },
      context
    );

    expect(result.success).toBe(true);
    const [attach] = callsTo('POST', '/me/messages/draft-1/attachments');
    expect(JSON.parse(attach.body as string)).toMatchObject({
      name: 'contract.pdf',
      contentType: 'application/pdf',
      contentBytes: Buffer.from('%PDF-1.4').toString('base64'),
    });
  });

  it('lists what the source email carries when the wanted file is not there', async () => {
    on('GET', `${GRAPH}/me/messages/src-1/attachments`, () =>
      json({
        value: [
          { '@odata.type': '#microsoft.graph.fileAttachment', id: 'a1', name: 'a.pdf', size: 1 },
          { '@odata.type': '#microsoft.graph.fileAttachment', id: 'a2', name: 'b.pdf', size: 1 },
        ],
      })
    );

    const result = await handleCreateDraft(
      { ...BASE_ARGS, attachments: [{ source: 'outlook', messageId: 'src-1', filename: 'c.pdf' }] },
      context
    );

    expect(result.success).toBe(false);
    expect(result.error).toMatch(/"a\.pdf".*"b\.pdf"/);
    expect(callsTo('POST', '/me/messages')).toHaveLength(0);
  });

  it('refuses Gmail and Drive sources before creating anything', async () => {
    const result = await handleCreateDraft(
      { ...BASE_ARGS, attachments: [{ source: 'drive', fileId: 'f1' }] },
      context
    );

    expect(result.success).toBe(false);
    expect(result.error).toMatch(/"drive".*not available for Outlook/);
    expect(calls).toHaveLength(0);
  });

  it('removes the draft when a file cannot be attached, leaving nothing behind', async () => {
    on('POST', `${GRAPH}/me/messages/draft-1/attachments`, () =>
      json({ error: { message: 'Blocked file type' } }, 400)
    );

    const result = await handleCreateDraft(
      { ...BASE_ARGS, attachments: [{ source: 'text', filename: 'a.txt', content: 'hi' }] },
      context
    );

    expect(result.success).toBe(false);
    expect(result.error).toMatch(/a\.txt/);
    expect(result.error).toMatch(/Blocked file type/);
    expect(result.error).toMatch(/No draft was left behind/);
    expect(callsTo('DELETE', '/me/messages/draft-1')).toHaveLength(1);
  });
});

describe('outlook_mail_send_message — attachments', () => {
  it('keeps the one-request send when nothing is attached', async () => {
    on('POST', `${GRAPH}/me/sendMail`, () => new Response(null, { status: 202 }));

    const result = await handleSendMessage(BASE_ARGS, context);

    expect(result.success).toBe(true);
    expect(calls.map((call) => call.url)).toEqual([`${GRAPH}/me/sendMail`]);
  });

  it('attaches files and then sends, rather than silently dropping them', async () => {
    const result = await handleSendMessage(
      { ...BASE_ARGS, attachments: [{ source: 'text', filename: 'a.txt', content: 'hi' }] },
      context
    );

    expect(result.success).toBe(true);
    expect(data(result).sent).toBe(true);
    const order = calls.map((call) => `${call.method} ${call.url.replace(GRAPH, '')}`);
    expect(order).toEqual([
      'POST /me/messages',
      'POST /me/messages/draft-1/attachments',
      'POST /me/messages/draft-1/send',
    ]);
  });
});

describe('outlook_mail_get_message — attachment listing', () => {
  it('names the attachments so they can be forwarded', async () => {
    on('GET', `${GRAPH}/me/messages/m1`, () =>
      json({ id: 'm1', subject: 'Contract', hasAttachments: true, body: { content: 'x' } })
    );
    on('GET', `${GRAPH}/me/messages/m1/attachments`, () =>
      json({
        value: [
          {
            '@odata.type': '#microsoft.graph.fileAttachment',
            id: 'a1',
            name: 'contract.pdf',
            contentType: 'application/pdf',
            size: 2048,
          },
        ],
      })
    );

    const result = await handleGetMessage({ messageId: 'm1' }, context);

    expect(data(result).attachments).toEqual([
      { attachmentId: 'a1', filename: 'contract.pdf', mimeType: 'application/pdf', size: 2048 },
    ]);
    // Metadata only: the listing must not pull the file bytes into context.
    expect(callsTo('GET', '/me/messages/m1/attachments')[0].url).toContain('%24select=');
  });

  it('makes no second request for a message without attachments', async () => {
    on('GET', `${GRAPH}/me/messages/m2`, () =>
      json({ id: 'm2', subject: 'Hi', hasAttachments: false, body: { content: 'x' } })
    );

    const result = await handleGetMessage({ messageId: 'm2' }, context);

    expect(data(result).attachments).toEqual([]);
    expect(calls).toHaveLength(1);
  });
});

describe('Outlook Mail tools — registration and default permissions', () => {
  const byName = new Map(outlookMailTools.map((tool) => [tool.name, tool]));

  it('offers an upload link under its own prefix, with no approval', () => {
    expect(byName.has('outlook_mail_create_upload_link')).toBe(true);
    expect(definition.permissions.read).toContain('outlook_mail_create_upload_link');
  });

  it('points the upload link at Outlook, not Gmail or Drive', () => {
    const description = byName.get('outlook_mail_create_upload_link')!.description;

    expect(description).toMatch(/source="outlook"/);
    expect(description).not.toMatch(/source="gmail"|source="drive"/);
  });

  it.each(['outlook_mail_create_draft', 'outlook_mail_send_message'])(
    '%s advertises only the sources that work for Outlook',
    (name) => {
      const schema = byName.get(name)!.inputSchema as {
        properties: { attachments?: { items: { properties: { source: { enum: string[] } } } } };
      };

      expect(schema.properties.attachments?.items.properties.source.enum).toEqual([
        'text',
        'outlook',
        'url',
        'upload',
        'base64',
      ]);
    }
  );
});

describe('shared attachment parser', () => {
  it('does not let a Gmail call use the Outlook source', () => {
    expect(() => parseAttachments([{ source: 'outlook', messageId: 'm1' }])).toThrow(
      /unknown source "outlook"/
    );
  });
});
