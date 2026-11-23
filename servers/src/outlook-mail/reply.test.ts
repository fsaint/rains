/**
 * outlook_mail_reply.
 *
 * The tool used to post `{ comment }` to Graph's /reply, which answers the
 * sender only: everyone in Cc was dropped without a word, no recipient could
 * be added, and line breaks were flattened. These tests drive the handler
 * against a routed fake of Microsoft Graph.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { data } from '../common/test-helpers.js';
import type { ServerContext } from '../common/types.js';
import { handleReplyToMessage } from './handlers.js';
import { replyToMessageTool } from './tools.js';

const GRAPH = 'https://graph.microsoft.com/v1.0';

const context: ServerContext = { requestId: 'req', accessToken: 'ms-token' };

interface Call {
  method: string;
  url: string;
  body: any;
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

/** Register a handler for one method + exact URL. Later routes win. */
function on(method: string, url: string, respond: (call: Call) => Response): void {
  routes.unshift((call) => (call.method === method && call.url === url ? respond(call) : undefined));
}

function callsTo(method: string, urlPart: string): Call[] {
  return calls.filter((call) => call.method === method && call.url.includes(urlPart));
}

const addr = (address: string, name?: string) => ({ emailAddress: { address, ...(name ? { name } : {}) } });

const QUOTED = '<html><head></head><body lang="en"><hr><div>On Monday Bob wrote: hello</div></body></html>';

/** The draft Graph builds for a reply-all to a message from Bob, Cc Ana and Carl. */
const REPLY_ALL_DRAFT = {
  id: 'reply-1',
  from: addr('me@example.com', 'Me'),
  toRecipients: [addr('bob@example.com', 'Bob')],
  ccRecipients: [addr('ana@example.com'), addr('carl@example.com')],
  body: { contentType: 'html', content: QUOTED },
};

/** The draft Graph builds for a reply to the sender only. */
const REPLY_DRAFT = { ...REPLY_ALL_DRAFT, ccRecipients: [] };

beforeEach(() => {
  calls = [];
  routes = [];

  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: string | URL, init: RequestInit = {}) => {
      const call: Call = {
        method: (init.method ?? 'GET').toUpperCase(),
        url: String(input),
        body: typeof init.body === 'string' ? JSON.parse(init.body) : init.body,
      };
      calls.push(call);
      for (const route of routes) {
        const response = route(call);
        if (response) return response;
      }
      return json({ error: { message: `unrouted ${call.method} ${call.url}` } }, 500);
    })
  );

  on('POST', `${GRAPH}/me/messages/m-1/createReplyAll`, () => json(REPLY_ALL_DRAFT, 201));
  on('POST', `${GRAPH}/me/messages/m-1/createReply`, () => json(REPLY_DRAFT, 201));
  on('PATCH', `${GRAPH}/me/messages/reply-1`, () => json({ id: 'reply-1' }));
  on('POST', `${GRAPH}/me/messages/reply-1/send`, () => new Response(null, { status: 202 }));
  on('DELETE', `${GRAPH}/me/messages/reply-1`, () => new Response(null, { status: 204 }));
});

afterEach(() => {
  vi.unstubAllGlobals();
});

const addresses = (list: Array<{ emailAddress: { address: string } }>) =>
  list.map((r) => r.emailAddress.address);

/** The one PATCH that sets the reply's recipients and body. */
function patched(): any {
  const patches = callsTo('PATCH', '/me/messages/reply-1');
  expect(patches).toHaveLength(1);
  return patches[0].body;
}

describe('outlook_mail_reply — recipients', () => {
  it('replies to the sender and everyone in Cc by default', async () => {
    const result = await handleReplyToMessage({ messageId: 'm-1', body: 'Thanks' }, context);

    expect(result.success).toBe(true);
    expect(callsTo('POST', '/createReplyAll')).toHaveLength(1);
    expect(callsTo('POST', '/reply-1/send')).toHaveLength(1);
    expect(addresses(patched().toRecipients)).toEqual(['bob@example.com']);
    expect(addresses(patched().ccRecipients)).toEqual(['ana@example.com', 'carl@example.com']);
  });

  it('reports who the reply went to', async () => {
    const result = await handleReplyToMessage({ messageId: 'm-1', body: 'Thanks' }, context);

    expect(data(result)).toMatchObject({
      replied: true,
      messageId: 'm-1',
      replyAll: true,
      to: ['bob@example.com'],
      cc: ['ana@example.com', 'carl@example.com'],
    });
  });

  it('answers the sender only when replyAll is false', async () => {
    const result = await handleReplyToMessage({ messageId: 'm-1', body: 'Thanks', replyAll: false }, context);

    expect(callsTo('POST', '/createReplyAll')).toHaveLength(0);
    expect(callsTo('POST', '/createReply')).toHaveLength(1);
    expect(data(result)).toMatchObject({ replyAll: false, to: ['bob@example.com'], cc: [] });
  });

  it('adds cc to the recipients already on the thread', async () => {
    const result = await handleReplyToMessage(
      { messageId: 'm-1', body: 'Thanks', cc: ['x@example.com'] },
      context
    );

    expect(addresses(patched().ccRecipients)).toEqual(['ana@example.com', 'carl@example.com', 'x@example.com']);
    expect(data(result).cc).toEqual(['ana@example.com', 'carl@example.com', 'x@example.com']);
  });

  it('adds to and bcc, and keeps the names Graph already had', async () => {
    const result = await handleReplyToMessage(
      { messageId: 'm-1', body: 'Thanks', to: ['dora@example.com'], bcc: ['boss@example.com'] },
      context
    );

    expect(patched().toRecipients).toEqual([addr('bob@example.com', 'Bob'), addr('dora@example.com')]);
    expect(addresses(patched().bccRecipients)).toEqual(['boss@example.com']);
    expect(data(result)).toMatchObject({ to: ['bob@example.com', 'dora@example.com'], bcc: ['boss@example.com'] });
  });

  it('does not list one address twice, whatever its case or field', async () => {
    const result = await handleReplyToMessage(
      { messageId: 'm-1', body: 'Thanks', to: ['ANA@example.com'], cc: ['Bob@Example.com', 'carl@example.com'] },
      context
    );

    // Ana is promoted to To; Bob is already in To, so he is not added to Cc.
    expect(data(result).to).toEqual(['bob@example.com', 'ANA@example.com']);
    expect(data(result).cc).toEqual(['carl@example.com']);
  });

  it("leaves the user's own address out of a reply-all", async () => {
    on('POST', `${GRAPH}/me/messages/m-1/createReplyAll`, () =>
      json(
        {
          ...REPLY_ALL_DRAFT,
          toRecipients: [addr('bob@example.com'), addr('Me@example.com')],
          ccRecipients: [addr('me@example.com'), addr('ana@example.com')],
        },
        201
      )
    );

    const result = await handleReplyToMessage({ messageId: 'm-1', body: 'Thanks' }, context);

    expect(data(result)).toMatchObject({ to: ['bob@example.com'], cc: ['ana@example.com'] });
  });

  it('keeps the own address when it is the only one the reply has', async () => {
    // Replying to a message the user sent to themselves.
    on('POST', `${GRAPH}/me/messages/m-1/createReplyAll`, () =>
      json({ ...REPLY_ALL_DRAFT, toRecipients: [addr('me@example.com')], ccRecipients: [] }, 201)
    );

    const result = await handleReplyToMessage({ messageId: 'm-1', body: 'Note to self' }, context);

    expect(data(result).to).toEqual(['me@example.com']);
  });
});

describe('outlook_mail_reply — body', () => {
  it('keeps line breaks and puts the reply above the quoted message', async () => {
    await handleReplyToMessage({ messageId: 'm-1', body: 'First paragraph.\n\nSecond paragraph.\nSame.' }, context);

    const { body } = patched();
    expect(body.contentType).toBe('HTML');
    expect(body.content).toContain('First paragraph.<br><br>Second paragraph.<br>Same.');
    // Inside <body>, before what Graph quoted.
    expect(body.content.indexOf('<body lang="en">')).toBeLessThan(body.content.indexOf('First paragraph.'));
    expect(body.content.indexOf('First paragraph.')).toBeLessThan(body.content.indexOf('On Monday Bob wrote'));
  });

  it('escapes HTML in a plain-text body', async () => {
    await handleReplyToMessage({ messageId: 'm-1', body: 'if a < b && c > d use <b>' }, context);

    expect(patched().body.content).toContain('if a &lt; b &amp;&amp; c &gt; d use &lt;b&gt;');
  });

  it('sends htmlBody as given', async () => {
    await handleReplyToMessage({ messageId: 'm-1', htmlBody: '<p>Hello <b>Bob</b></p>' }, context);

    expect(patched().body.content).toContain('<p>Hello <b>Bob</b></p>');
  });

  it('quotes a plain-text original as HTML', async () => {
    on('POST', `${GRAPH}/me/messages/m-1/createReplyAll`, () =>
      json({ ...REPLY_ALL_DRAFT, body: { contentType: 'text', content: 'Bob wrote:\n> a < b' } }, 201)
    );

    await handleReplyToMessage({ messageId: 'm-1', body: 'Thanks' }, context);

    const { content } = patched().body;
    expect(content.indexOf('Thanks')).toBeLessThan(content.indexOf('Bob wrote:'));
    expect(content).toContain('Bob wrote:<br>&gt; a &lt; b');
  });
});

describe('outlook_mail_reply — failures', () => {
  it('refuses a reply with no body before touching Graph', async () => {
    const result = await handleReplyToMessage({ messageId: 'm-1', body: '   ' }, context);

    expect(result.success).toBe(false);
    expect(result.error).toMatch(/body/);
    expect(calls).toHaveLength(0);
  });

  it('refuses a recipient list that is not a list of addresses', async () => {
    const result = await handleReplyToMessage({ messageId: 'm-1', body: 'Hi', cc: [42] }, context);

    expect(result.success).toBe(false);
    expect(result.error).toMatch(/cc/);
    expect(calls).toHaveLength(0);
  });

  it('reports a message that cannot be replied to', async () => {
    on('POST', `${GRAPH}/me/messages/m-1/createReplyAll`, () =>
      json({ error: { message: 'The specified object was not found in the store.' } }, 404)
    );

    const result = await handleReplyToMessage({ messageId: 'm-1', body: 'Hi' }, context);

    expect(result.success).toBe(false);
    expect(result.error).toContain('404');
    expect(callsTo('POST', '/send')).toHaveLength(0);
  });

  it('removes the draft when the reply cannot be sent', async () => {
    on('POST', `${GRAPH}/me/messages/reply-1/send`, () => json({ error: { message: 'Mailbox full' } }, 507));

    const result = await handleReplyToMessage({ messageId: 'm-1', body: 'Hi' }, context);

    expect(result.success).toBe(false);
    expect(result.error).toContain('Mailbox full');
    expect(result.error).toContain('No draft was left behind');
    expect(callsTo('DELETE', '/me/messages/reply-1')).toHaveLength(1);
  });

  it('says so when the unsent draft could not be removed', async () => {
    on('PATCH', `${GRAPH}/me/messages/reply-1`, () => json({ error: { message: 'Bad recipient' } }, 400));
    on('DELETE', `${GRAPH}/me/messages/reply-1`, () => json({ error: { message: 'nope' } }, 500));

    const result = await handleReplyToMessage({ messageId: 'm-1', body: 'Hi' }, context);

    expect(result.success).toBe(false);
    expect(result.error).toContain('reply-1');
    expect(callsTo('POST', '/send')).toHaveLength(0);
  });

  it('escapes the message id in the request path', async () => {
    on('POST', `${GRAPH}/me/messages/AAMk%2Fx%3D/createReplyAll`, () => json(REPLY_ALL_DRAFT, 201));

    const result = await handleReplyToMessage({ messageId: 'AAMk/x=', body: 'Hi' }, context);

    expect(result.success).toBe(true);
  });
});

describe('outlook_mail_reply — schema', () => {
  it('describes reply-all as the default and offers the recipient fields', () => {
    const props = replyToMessageTool.inputSchema.properties as Record<string, { type: string }>;

    expect(replyToMessageTool.description).toMatch(/all/i);
    expect(props.replyAll.type).toBe('boolean');
    for (const field of ['to', 'cc', 'bcc']) expect(props[field].type).toBe('array');
    expect(props.htmlBody.type).toBe('string');
    expect(replyToMessageTool.inputSchema.required).toEqual(['messageId']);
  });
});
