/**
 * Draft management: listing, editing in place, and deleting.
 *
 * Before these existed an agent could only create and send, so every revision
 * left another draft behind for the owner to clean up by hand.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { data } from '../common/test-helpers.js';
import type { ServerContext } from '../common/types.js';

vi.mock('googleapis', () => {
  const mockGmail = {
    users: {
      messages: {
        get: vi.fn(),
        delete: vi.fn(),
        attachments: { get: vi.fn() },
      },
      drafts: {
        create: vi.fn(),
        list: vi.fn(),
        get: vi.fn(),
        update: vi.fn(),
        delete: vi.fn(),
      },
    },
  };

  return {
    google: {
      auth: { OAuth2: vi.fn().mockImplementation(() => ({ setCredentials: vi.fn() })) },
      gmail: vi.fn(() => mockGmail),
    },
  };
});

import { google } from 'googleapis';
import { handleDeleteDraft, handleListDrafts, handleUpdateDraft } from './handlers.js';

const context: ServerContext = { requestId: 'req', accessToken: 'token' };

/** The RFC 822 text handed to the mocked drafts.update call. */
function updatedRaw(mockFn: { mock: { calls: unknown[][] } }): string {
  const call = mockFn.mock.calls.at(-1)?.[0] as
    | { requestBody?: { message?: { raw?: string } } }
    | undefined;
  return Buffer.from(call?.requestBody?.message?.raw ?? '', 'base64url').toString('utf-8');
}

/** An existing draft as drafts.get(format=full) returns it. */
function existingDraft(overrides: { parts?: unknown[]; headers?: unknown[] } = {}) {
  return {
    data: {
      id: 'd1',
      message: {
        id: 'old-msg',
        threadId: 'thread-9',
        payload: {
          mimeType: 'multipart/mixed',
          headers: overrides.headers ?? [],
          parts: overrides.parts ?? [],
        },
      },
    },
  } as never;
}

const PDF_PART = {
  filename: 'old.pdf',
  mimeType: 'application/pdf',
  body: { attachmentId: 'att-1', size: 5 },
};

describe('Gmail draft management', () => {
  let gmail: ReturnType<typeof google.gmail>;

  beforeEach(() => {
    vi.clearAllMocks();
    gmail = google.gmail({ version: 'v1' });
  });

  describe('handleListDrafts', () => {
    it('lists drafts with enough detail to tell them apart', async () => {
      vi.mocked(gmail.users.drafts.list).mockResolvedValueOnce({
        data: { drafts: [{ id: 'd1', message: { id: 'm1', threadId: 't1' } }], nextPageToken: 'next' },
      } as never);
      vi.mocked(gmail.users.drafts.get).mockResolvedValueOnce({
        data: {
          id: 'd1',
          message: {
            id: 'm1',
            threadId: 't1',
            snippet: 'Hello there',
            payload: {
              headers: [
                { name: 'To', value: 'ana@example.com' },
                { name: 'Subject', value: 'Quote v2' },
              ],
            },
          },
        },
      } as never);

      const result = await handleListDrafts({}, context);

      expect(result.success).toBe(true);
      expect(data(result).drafts).toEqual([
        expect.objectContaining({
          draftId: 'd1',
          messageId: 'm1',
          to: 'ana@example.com',
          subject: 'Quote v2',
          snippet: 'Hello there',
        }),
      ]);
      expect(data(result).nextPageToken).toBe('next');
    });

    it('passes a search query through', async () => {
      vi.mocked(gmail.users.drafts.list).mockResolvedValueOnce({ data: {} } as never);

      const result = await handleListDrafts({ query: 'subject:quote', maxResults: 5 }, context);

      expect(data(result).drafts).toEqual([]);
      expect(gmail.users.drafts.list).toHaveBeenCalledWith(
        expect.objectContaining({ q: 'subject:quote', maxResults: 5 })
      );
    });
  });

  describe('handleUpdateDraft', () => {
    it('rewrites the existing draft rather than creating another', async () => {
      vi.mocked(gmail.users.drafts.get).mockResolvedValueOnce(existingDraft());
      vi.mocked(gmail.users.drafts.update).mockResolvedValueOnce({
        data: { id: 'd1', message: { id: 'new-msg', threadId: 'thread-9' } },
      } as never);

      const result = await handleUpdateDraft(
        { draftId: 'd1', to: ['ana@example.com'], subject: 'Quote v3', body: 'Revised.' },
        context
      );

      expect(result.success).toBe(true);
      expect(data(result).draftId).toBe('d1');
      expect(gmail.users.drafts.create).not.toHaveBeenCalled();
      expect(gmail.users.drafts.update).toHaveBeenCalledWith(
        expect.objectContaining({ userId: 'me', id: 'd1' })
      );
      const raw = updatedRaw(vi.mocked(gmail.users.drafts.update));
      expect(raw).toContain('Subject: Quote v3');
      // The body part is base64-encoded on the wire.
      expect(raw).toContain(Buffer.from('Revised.').toString('base64'));
    });

    it('keeps the files already attached unless told otherwise', async () => {
      vi.mocked(gmail.users.drafts.get).mockResolvedValueOnce(existingDraft({ parts: [PDF_PART] }));
      vi.mocked(gmail.users.messages.attachments.get).mockResolvedValueOnce({
        data: { data: Buffer.from('%PDF-').toString('base64url') },
      } as never);
      vi.mocked(gmail.users.drafts.update).mockResolvedValueOnce({ data: { id: 'd1' } } as never);

      const result = await handleUpdateDraft(
        { draftId: 'd1', to: ['ana@example.com'], subject: 'Quote v3', body: 'x' },
        context
      );

      expect(gmail.users.messages.attachments.get).toHaveBeenCalledWith(
        expect.objectContaining({ messageId: 'old-msg', id: 'att-1' })
      );
      expect(updatedRaw(vi.mocked(gmail.users.drafts.update))).toContain('filename="old.pdf"');
      expect(data(result).attachments).toEqual(['old.pdf']);
    });

    it('adds new attachments alongside the kept ones', async () => {
      vi.mocked(gmail.users.drafts.get).mockResolvedValueOnce(existingDraft({ parts: [PDF_PART] }));
      vi.mocked(gmail.users.messages.attachments.get).mockResolvedValueOnce({
        data: { data: Buffer.from('%PDF-').toString('base64url') },
      } as never);
      vi.mocked(gmail.users.drafts.update).mockResolvedValueOnce({ data: { id: 'd1' } } as never);

      const result = await handleUpdateDraft(
        {
          draftId: 'd1',
          to: ['ana@example.com'],
          subject: 's',
          body: 'x',
          attachments: [{ source: 'text', filename: 'notes.csv', content: 'a,b\n' }],
        },
        context
      );

      expect(data(result).attachments).toEqual(['old.pdf', 'notes.csv']);
    });

    it('drops the existing attachments when keepAttachments is false', async () => {
      vi.mocked(gmail.users.drafts.get).mockResolvedValueOnce(existingDraft({ parts: [PDF_PART] }));
      vi.mocked(gmail.users.drafts.update).mockResolvedValueOnce({ data: { id: 'd1' } } as never);

      const result = await handleUpdateDraft(
        { draftId: 'd1', to: ['ana@example.com'], subject: 's', body: 'x', keepAttachments: false },
        context
      );

      expect(gmail.users.messages.attachments.get).not.toHaveBeenCalled();
      expect(updatedRaw(vi.mocked(gmail.users.drafts.update))).not.toContain('old.pdf');
      expect(data(result).attachments).toEqual([]);
    });

    it('keeps a reply draft attached to its conversation', async () => {
      vi.mocked(gmail.users.drafts.get).mockResolvedValueOnce(
        existingDraft({ headers: [{ name: 'In-Reply-To', value: '<orig@mail.example>' }] })
      );
      vi.mocked(gmail.users.drafts.update).mockResolvedValueOnce({ data: { id: 'd1' } } as never);

      await handleUpdateDraft(
        { draftId: 'd1', to: ['ana@example.com'], subject: 'Re: Quote', body: 'x' },
        context
      );

      const call = vi.mocked(gmail.users.drafts.update).mock.calls[0][0] as unknown as {
        requestBody: { message: { threadId?: string } };
      };
      expect(call.requestBody.message.threadId).toBe('thread-9');
      expect(updatedRaw(vi.mocked(gmail.users.drafts.update))).toContain(
        'In-Reply-To: <orig@mail.example>'
      );
    });

    it('refuses an unknown draft without writing anything', async () => {
      vi.mocked(gmail.users.drafts.get).mockRejectedValueOnce(new Error('Not Found'));

      const result = await handleUpdateDraft(
        { draftId: 'nope', to: ['ana@example.com'], subject: 's', body: 'x' },
        context
      );

      expect(result.success).toBe(false);
      expect(result.error).toMatch(/gmail_list_drafts/);
      expect(gmail.users.drafts.update).not.toHaveBeenCalled();
      expect(gmail.users.drafts.create).not.toHaveBeenCalled();
    });

    it('requires a draftId', async () => {
      const result = await handleUpdateDraft({ to: ['a@example.com'], subject: 's' }, context);

      expect(result.success).toBe(false);
      expect(result.error).toMatch(/draftId/);
      expect(gmail.users.drafts.get).not.toHaveBeenCalled();
    });
  });

  describe('handleDeleteDraft', () => {
    it('deletes every named draft in one call', async () => {
      vi.mocked(gmail.users.drafts.delete).mockResolvedValue({} as never);

      const result = await handleDeleteDraft({ draftIds: ['d1', 'd2', 'd3'] }, context);

      expect(result.success).toBe(true);
      expect(data(result).deleted).toEqual(['d1', 'd2', 'd3']);
      expect(gmail.users.drafts.delete).toHaveBeenCalledTimes(3);
      expect(gmail.users.drafts.delete).toHaveBeenCalledWith({ userId: 'me', id: 'd2' });
    });

    it('accepts a single draftId', async () => {
      vi.mocked(gmail.users.drafts.delete).mockResolvedValue({} as never);

      const result = await handleDeleteDraft({ draftId: 'd1' }, context);

      expect(data(result).deleted).toEqual(['d1']);
    });

    it('goes through the drafts endpoint only, so it cannot remove real mail', async () => {
      vi.mocked(gmail.users.drafts.delete).mockResolvedValue({} as never);

      await handleDeleteDraft({ draftIds: ['d1'] }, context);

      expect(gmail.users.messages.delete).not.toHaveBeenCalled();
    });

    it('names the drafts it could not delete and still deletes the rest', async () => {
      vi.mocked(gmail.users.drafts.delete)
        .mockResolvedValueOnce({} as never)
        .mockRejectedValueOnce(new Error('Not Found'))
        .mockResolvedValueOnce({} as never);

      const result = await handleDeleteDraft({ draftIds: ['d1', 'gone', 'd3'] }, context);

      expect(result.success).toBe(true);
      expect(data(result).deleted).toEqual(['d1', 'd3']);
      expect(data(result).failed).toEqual([{ draftId: 'gone', error: 'Not Found' }]);
    });

    it('fails when nothing could be deleted', async () => {
      vi.mocked(gmail.users.drafts.delete).mockRejectedValue(new Error('Not Found'));

      const result = await handleDeleteDraft({ draftIds: ['gone'] }, context);

      expect(result.success).toBe(false);
      expect(result.error).toMatch(/gone/);
    });

    it('rejects a call naming no drafts', async () => {
      const result = await handleDeleteDraft({ draftIds: [] }, context);

      expect(result.success).toBe(false);
      expect(gmail.users.drafts.delete).not.toHaveBeenCalled();
    });
  });
});

describe('Gmail draft tools — registration and default permissions', () => {
  it('exposes the three tools to agents', async () => {
    const { gmailTools } = await import('./tools.js');
    const names = gmailTools.map((tool) => tool.name);

    expect(names).toEqual(
      expect.arrayContaining(['gmail_list_drafts', 'gmail_update_draft', 'gmail_delete_draft'])
    );
  });

  it('gates editing and deleting behind approval, and leaves listing free', async () => {
    const { definition } = await import('./definition.js');

    expect(definition.permissions.read).toContain('gmail_list_drafts');
    expect(definition.permissions.write).toEqual(
      expect.arrayContaining(['gmail_update_draft', 'gmail_delete_draft'])
    );
  });

  it('tells the model to revise a draft rather than create a second one', async () => {
    const { createDraftTool } = await import('./tools.js');

    expect(createDraftTool.description).toMatch(/gmail_update_draft/);
  });
});
