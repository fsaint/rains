import { describe, it, expect, vi, afterEach } from 'vitest';
import {
  AttachmentError,
  collectAttachmentParts,
  parseAttachments,
  resolveAttachments,
} from './attachments.js';

/** Minimal gmail client double exposing only what the resolver touches. */
function makeGmail(options: {
  parts?: unknown[];
  attachmentData?: string;
  messageGetFails?: boolean;
  attachmentGetFails?: boolean;
} = {}) {
  const attachmentsGet = vi.fn(async () => {
    if (options.attachmentGetFails) throw new Error('404 Not Found');
    return { data: { data: options.attachmentData ?? '', size: 0 } };
  });
  const messagesGet = vi.fn(async () => {
    if (options.messageGetFails) throw new Error('404 Not Found');
    return { data: { payload: { parts: options.parts ?? [] } } };
  });

  return {
    client: {
      users: { messages: { get: messagesGet, attachments: { get: attachmentsGet } } },
    } as never,
    messagesGet,
    attachmentsGet,
  };
}

const pdfPart = {
  filename: 'invoice.pdf',
  mimeType: 'application/pdf',
  body: { attachmentId: 'ATT_1', size: 11 },
};

describe('parseAttachments — backwards compatibility', () => {
  it('accepts the legacy {filename, mimeType, data} shape with no source', () => {
    // Non-negotiable: agents deployed before the union existed still have this
    // shape in their cached tool schema.
    const [spec] = parseAttachments([
      { filename: 'a.txt', mimeType: 'text/plain', data: 'aGVsbG8=' },
    ]);

    expect(spec.source).toBe('base64');
    expect(spec.filename).toBe('a.txt');
    expect(spec.data).toBe('aGVsbG8=');
  });

  it('infers source="text" from a content field', () => {
    const [spec] = parseAttachments([{ filename: 'a.csv', content: 'a,b' }]);
    expect(spec.source).toBe('text');
  });

  it('infers source="gmail" from an attachmentId', () => {
    const [spec] = parseAttachments([{ messageId: 'M1', attachmentId: 'ATT_1' }]);
    expect(spec.source).toBe('gmail');
  });

  it('treats undefined as an empty list', () => {
    expect(parseAttachments(undefined)).toEqual([]);
  });
});

describe('parseAttachments — validation', () => {
  it('names the missing field for source="gmail"', () => {
    expect(() => parseAttachments([{ source: 'gmail', messageId: 'M1' }])).toThrow(
      /missing required field "attachmentId"/
    );
  });

  it('names the missing field for source="text"', () => {
    expect(() => parseAttachments([{ source: 'text', filename: 'a.csv' }])).toThrow(
      /missing required field "content"/
    );
  });

  it('rejects an unknown source', () => {
    expect(() => parseAttachments([{ source: 'ftp', url: 'x' }])).toThrow(
      /unknown source "ftp"/
    );
  });

  it('rejects an item with nothing recognisable', () => {
    expect(() => parseAttachments([{ filename: 'a.txt' }])).toThrow(/no "source"/);
  });

  it('rejects a non-array', () => {
    expect(() => parseAttachments('nope')).toThrow(/must be an array/);
  });
});

describe('resolveAttachments — text', () => {
  const gmail = makeGmail().client;

  it('infers text/csv from a .csv extension', async () => {
    const [resolved] = await resolveAttachments(
      parseAttachments([{ source: 'text', filename: 'q3.csv', content: 'a,b\n1,2\n' }]),
      { gmail }
    );

    expect(resolved.mimeType).toBe('text/csv');
    expect(resolved.bytes.toString('utf-8')).toBe('a,b\n1,2\n');
  });

  it('rejects an explicitly declared binary MIME type', async () => {
    await expect(
      resolveAttachments(
        parseAttachments([
          {
            source: 'text',
            filename: 'notes.txt',
            content: 'hi',
            mimeType: 'application/octet-stream',
          },
        ]),
        { gmail }
      )
    ).rejects.toThrow(/cannot declare mimeType/);
  });

  it('falls back to text/plain when the extension implies a binary type', async () => {
    // Inferred, not declared — the caller just named the file oddly.
    const [resolved] = await resolveAttachments(
      parseAttachments([{ source: 'text', filename: 'weird.pdf', content: 'hi' }]),
      { gmail }
    );
    expect(resolved.mimeType).toBe('text/plain');
  });

  it('rejects text over the size limit', async () => {
    await expect(
      resolveAttachments(
        parseAttachments([
          { source: 'text', filename: 'big.txt', content: 'x'.repeat(600 * 1024) },
        ]),
        { gmail }
      )
    ).rejects.toThrow(/over the .* limit for source="text"/);
  });
});

describe('resolveAttachments — base64', () => {
  const gmail = makeGmail().client;

  it('decodes inline base64', async () => {
    const [resolved] = await resolveAttachments(
      parseAttachments([
        { source: 'base64', filename: 'a.txt', mimeType: 'text/plain', data: 'aGVsbG8=' },
      ]),
      { gmail }
    );
    expect(resolved.bytes.toString('utf-8')).toBe('hello');
  });

  it('rejects oversized inline base64 and points at the gmail source', async () => {
    const big = Buffer.alloc(500 * 1024).toString('base64');
    await expect(
      resolveAttachments(
        parseAttachments([
          { source: 'base64', filename: 'big.bin', mimeType: 'application/pdf', data: big },
        ]),
        { gmail }
      )
    ).rejects.toThrow(/source":"gmail"/);
  });
});

describe('resolveAttachments — gmail', () => {
  it('fetches bytes server-side using metadata from the message', async () => {
    const bytes = Buffer.from('pdf-bytes-here');
    const { client, messagesGet, attachmentsGet } = makeGmail({
      parts: [pdfPart],
      attachmentData: bytes.toString('base64url'),
    });

    const [resolved] = await resolveAttachments(
      parseAttachments([{ source: 'gmail', messageId: 'M1', attachmentId: 'ATT_1' }]),
      { gmail: client }
    );

    expect(messagesGet).toHaveBeenCalledTimes(1);
    expect(attachmentsGet).toHaveBeenCalledTimes(1);
    expect(resolved.filename).toBe('invoice.pdf');
    expect(resolved.mimeType).toBe('application/pdf');
    expect(resolved.bytes.equals(bytes)).toBe(true);
  });

  it('honours an explicit filename override', async () => {
    const { client } = makeGmail({ parts: [pdfPart], attachmentData: 'AAAA' });

    const [resolved] = await resolveAttachments(
      parseAttachments([
        { source: 'gmail', messageId: 'M1', attachmentId: 'ATT_1', filename: 'renamed.pdf' },
      ]),
      { gmail: client }
    );
    expect(resolved.filename).toBe('renamed.pdf');
  });

  it('tells the model to re-fetch when the attachmentId is stale', async () => {
    const { client } = makeGmail({ parts: [pdfPart] });

    await expect(
      resolveAttachments(
        parseAttachments([{ source: 'gmail', messageId: 'M1', attachmentId: 'GONE' }]),
        { gmail: client }
      )
    ).rejects.toThrow(/call gmail_get_message on "M1" again/i);
  });

  it('surfaces a friendly error when the message cannot be read', async () => {
    const { client } = makeGmail({ messageGetFails: true });

    await expect(
      resolveAttachments(
        parseAttachments([{ source: 'gmail', messageId: 'BAD', attachmentId: 'ATT_1' }]),
        { gmail: client }
      )
    ).rejects.toThrow(/could not read message "BAD"/);
  });

  it('surfaces a friendly error when the attachment fetch fails', async () => {
    const { client } = makeGmail({ parts: [pdfPart], attachmentGetFails: true });

    await expect(
      resolveAttachments(
        parseAttachments([{ source: 'gmail', messageId: 'M1', attachmentId: 'ATT_1' }]),
        { gmail: client }
      )
    ).rejects.toThrow(/no longer valid/);
  });

  it('throws AttachmentError, not a raw Google error', async () => {
    const { client } = makeGmail({ messageGetFails: true });

    await expect(
      resolveAttachments(
        parseAttachments([{ source: 'gmail', messageId: 'BAD', attachmentId: 'A' }]),
        { gmail: client }
      )
    ).rejects.toBeInstanceOf(AttachmentError);
  });
});

describe('resolveAttachments — url', () => {
  const gmail = makeGmail().client;

  it('names the missing field when url is absent', () => {
    expect(() => parseAttachments([{ source: 'url' }])).toThrow(
      /missing required field "url"/
    );
  });

  it('surfaces the egress guard rejection as an AttachmentError', async () => {
    await expect(
      resolveAttachments(
        parseAttachments([{ source: 'url', url: 'http://example.com/a.pdf' }]),
        { gmail }
      )
    ).rejects.toThrow(/only https:\/\/ URLs/);
  });

  it('refuses an internal host', async () => {
    await expect(
      resolveAttachments(
        parseAttachments([{ source: 'url', url: 'https://agenthelm-core.internal/x' }]),
        { gmail }
      )
    ).rejects.toBeInstanceOf(AttachmentError);
  });
});

function makeDrive(options: {
  name?: string;
  mimeType?: string;
  parents?: string[];
  body?: Buffer;
  getFails?: Error;
} = {}) {
  // Return an exactly-sized ArrayBuffer. `Buffer.from('x').buffer` would expose
  // Node's whole shared allocation pool, not just this Buffer's bytes.
  const asArrayBuffer = (buffer: Buffer) => new Uint8Array(buffer).buffer;

  const filesGet = vi.fn(async (params: Record<string, unknown>) => {
    if (options.getFails) throw options.getFails;
    if (params.alt === 'media') {
      return { data: asArrayBuffer(options.body ?? Buffer.from('drive')) };
    }
    return {
      data: {
        id: 'F1',
        name: options.name ?? 'plan.pdf',
        mimeType: options.mimeType ?? 'application/pdf',
        parents: options.parents ?? ['FOLDER_A'],
      },
    };
  });
  const filesExport = vi.fn(async () => ({ data: asArrayBuffer(Buffer.from('exported')) }));

  return {
    client: { files: { get: filesGet, export: filesExport } } as never,
    filesGet,
    filesExport,
  };
}

describe('resolveAttachments — drive', () => {
  const gmail = makeGmail().client;

  it('names the missing field when fileId is absent', () => {
    expect(() => parseAttachments([{ source: 'drive' }])).toThrow(
      /missing required field "fileId"/
    );
  });

  it('downloads a regular file server-side', async () => {
    const { client: drive } = makeDrive({ body: Buffer.from('pdf-content') });

    const [resolved] = await resolveAttachments(
      parseAttachments([{ source: 'drive', fileId: 'F1' }]),
      { gmail, drive: () => drive, driveDefaultLevel: 'read' }
    );

    expect(resolved.filename).toBe('plan.pdf');
    expect(resolved.mimeType).toBe('application/pdf');
    expect(resolved.bytes.toString()).toBe('pdf-content');
  });

  it('exports a native Google Doc and appends the right extension', async () => {
    const { client: drive, filesExport } = makeDrive({
      name: 'Team Plan',
      mimeType: 'application/vnd.google-apps.document',
    });

    const [resolved] = await resolveAttachments(
      parseAttachments([{ source: 'drive', fileId: 'F1' }]),
      { gmail, drive: () => drive, driveDefaultLevel: 'read' }
    );

    expect(filesExport).toHaveBeenCalled();
    expect(resolved.filename).toBe('Team Plan.docx');
    expect(resolved.bytes.toString()).toBe('exported');
  });

  it('honours an explicit exportMimeType', async () => {
    const { client: drive, filesExport } = makeDrive({
      name: 'Budget',
      mimeType: 'application/vnd.google-apps.spreadsheet',
    });

    const [resolved] = await resolveAttachments(
      parseAttachments([
        { source: 'drive', fileId: 'F1', exportMimeType: 'application/pdf' },
      ]),
      { gmail, drive: () => drive, driveDefaultLevel: 'read' }
    );

    expect(filesExport).toHaveBeenCalledWith(
      expect.objectContaining({ mimeType: 'application/pdf' }),
      expect.anything()
    );
    expect(resolved.filename).toBe('Budget.pdf');
  });

  // Without this, attaching by fileId would launder a Drive read through a
  // Gmail tool, past both the folder rules and the Drive service toggle.
  it('denies a file whose parent folder is blocked by a path rule', async () => {
    const { client: drive } = makeDrive({ parents: ['SECRET_FOLDER'] });

    await expect(
      resolveAttachments(parseAttachments([{ source: 'drive', fileId: 'F1' }]), {
        gmail,
        drive: () => drive,
        driveDefaultLevel: 'read',
        drivePathRules: [{ folderId: 'SECRET_FOLDER', permission: 'blocked' }],
      })
    ).rejects.toThrow(/permission denied/i);
  });

  it('denies when the default level is blocked and no rule grants access', async () => {
    const { client: drive } = makeDrive();

    await expect(
      resolveAttachments(parseAttachments([{ source: 'drive', fileId: 'F1' }]), {
        gmail,
        drive: () => drive,
        driveDefaultLevel: 'blocked',
      })
    ).rejects.toThrow(/permission denied/i);
  });

  it('allows a file in a folder explicitly granted read', async () => {
    const { client: drive } = makeDrive({ parents: ['SHARED'] });

    const [resolved] = await resolveAttachments(
      parseAttachments([{ source: 'drive', fileId: 'F1' }]),
      {
        gmail,
        drive: () => drive,
        driveDefaultLevel: 'blocked',
        drivePathRules: [{ folderId: 'SHARED', permission: 'read' }],
      }
    );
    expect(resolved.filename).toBe('plan.pdf');
  });

  it('explains how to fix a missing Drive scope', async () => {
    const { client: drive } = makeDrive({
      getFails: new Error('Request had insufficient authentication scopes.'),
    });

    await expect(
      resolveAttachments(parseAttachments([{ source: 'drive', fileId: 'F1' }]), {
        gmail,
        drive: () => drive,
        driveDefaultLevel: 'read',
      })
    ).rejects.toThrow(/Reconnect Google in the Reins dashboard with Drive enabled/);
  });

  it('explains when Drive is not connected at all', async () => {
    await expect(
      resolveAttachments(parseAttachments([{ source: 'drive', fileId: 'F1' }]), { gmail })
    ).rejects.toThrow(/Google Drive is not connected/);
  });

  // googleapis' typing for responseType:'arraybuffer' is loose; the runtime may
  // hand back a typed array that is a VIEW into a larger pool. Taking the whole
  // backing buffer would splice unrelated adjacent memory into the attachment.
  it('slices a pooled typed-array view to its own bytes', async () => {
    const pool = new Uint8Array(64).fill(0xaa);
    pool.set(Buffer.from('real'), 16);
    const view = new Uint8Array(pool.buffer, 16, 4);

    const drive = {
      files: {
        get: vi.fn(async (params: Record<string, unknown>) =>
          params.alt === 'media'
            ? { data: view }
            : { data: { name: 'a.bin', mimeType: 'application/octet-stream', parents: [] } }
        ),
        export: vi.fn(),
      },
    } as never;

    const [resolved] = await resolveAttachments(
      parseAttachments([{ source: 'drive', fileId: 'F1' }]),
      { gmail, drive: () => drive, driveDefaultLevel: 'read' }
    );

    expect(resolved.bytes.length).toBe(4);
    expect(resolved.bytes.toString()).toBe('real');
  });
});

describe('resolveAttachments — upload', () => {
  const gmail = makeGmail().client;
  const originalFetch = globalThis.fetch;

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  it('names the missing field when uploadId is absent', () => {
    expect(() => parseAttachments([{ source: 'upload' }])).toThrow(
      /missing required field "uploadId"/
    );
  });

  it('reads the blob back through the Reins API with the gateway token', async () => {
    const fetchMock = vi.fn(async () =>
      new Response(Buffer.from('generated-pdf'), {
        status: 200,
        headers: {
          'content-type': 'application/pdf',
          'x-upload-filename': encodeURIComponent('Q3 report.pdf'),
        },
      })
    );
    globalThis.fetch = fetchMock as never;

    const [resolved] = await resolveAttachments(
      parseAttachments([{ source: 'upload', uploadId: 'up-1' }]),
      { gmail, gatewayToken: 'secret-token' }
    );

    expect(resolved.filename).toBe('Q3 report.pdf');
    expect(resolved.mimeType).toBe('application/pdf');
    expect(resolved.bytes.toString()).toBe('generated-pdf');

    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect((init.headers as Record<string, string>)['x-reins-agent-secret']).toBe(
      'secret-token'
    );
  });

  it('tells the model to re-upload when the blob has expired', async () => {
    globalThis.fetch = vi.fn(async () => new Response('', { status: 404 })) as never;

    await expect(
      resolveAttachments(parseAttachments([{ source: 'upload', uploadId: 'gone' }]), {
        gmail,
        gatewayToken: 'secret-token',
      })
    ).rejects.toThrow(/not found or has expired/);
  });

  it('fails clearly when there is no gateway token', async () => {
    const previous = process.env.REINS_GATEWAY_TOKEN;
    delete process.env.REINS_GATEWAY_TOKEN;

    await expect(
      resolveAttachments(parseAttachments([{ source: 'upload', uploadId: 'up-1' }]), { gmail })
    ).rejects.toThrow(/no gateway token/);

    if (previous !== undefined) process.env.REINS_GATEWAY_TOKEN = previous;
  });
});

describe('collectAttachmentParts', () => {
  it('walks nested parts', () => {
    const parts = collectAttachmentParts({
      mimeType: 'multipart/mixed',
      parts: [
        { mimeType: 'text/plain', body: { size: 5 } },
        { mimeType: 'multipart/related', parts: [pdfPart] },
      ],
    } as never);

    expect(parts).toHaveLength(1);
    expect(parts[0]).toMatchObject({ filename: 'invoice.pdf', attachmentId: 'ATT_1' });
  });

  it('ignores parts without an attachmentId', () => {
    expect(
      collectAttachmentParts({ filename: 'inline.txt', body: { size: 3 } } as never)
    ).toEqual([]);
  });
});

describe('resolveAttachments — mixed sources', () => {
  it('resolves several sources in one call, preserving order', async () => {
    const { client } = makeGmail({
      parts: [pdfPart],
      attachmentData: Buffer.from('from-gmail').toString('base64url'),
    });

    const resolved = await resolveAttachments(
      parseAttachments([
        { source: 'text', filename: 'notes.csv', content: 'a,b' },
        { source: 'gmail', messageId: 'M1', attachmentId: 'ATT_1' },
        { filename: 'legacy.txt', mimeType: 'text/plain', data: 'aGk=' },
      ]),
      { gmail: client }
    );

    expect(resolved.map((r) => r.filename)).toEqual([
      'notes.csv',
      'invoice.pdf',
      'legacy.txt',
    ]);
    expect(resolved[1].bytes.toString('utf-8')).toBe('from-gmail');
  });
});
