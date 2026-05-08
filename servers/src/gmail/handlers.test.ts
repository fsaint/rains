/**
 * Gmail Handler Tests
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { ServerContext } from '../common/types.js';

// Mock googleapis
vi.mock('googleapis', () => {
  const mockGmail = {
    users: {
      messages: {
        list: vi.fn(),
        get: vi.fn(),
        send: vi.fn(),
        delete: vi.fn(),
      },
      drafts: {
        create: vi.fn(),
        send: vi.fn(),
      },
      labels: {
        list: vi.fn(),
      },
    },
  };

  return {
    google: {
      auth: {
        OAuth2: vi.fn().mockImplementation(() => ({
          setCredentials: vi.fn(),
        })),
      },
      gmail: vi.fn(() => mockGmail),
    },
  };
});

// Import after mocking
import { google } from 'googleapis';
import {
  handleListMessages,
  handleGetMessage,
  handleSearch,
  handleCreateDraft,
  handleSendDraft,
  handleSendMessage,
  handleDeleteMessage,
  handleListLabels,
} from './handlers.js';

describe('Gmail Handlers', () => {
  const mockContext: ServerContext = {
    requestId: 'test-request-id',
    accessToken: 'test-access-token',
  };

  let mockGmailClient: ReturnType<typeof google.gmail>;

  beforeEach(() => {
    vi.clearAllMocks();
    mockGmailClient = google.gmail({ version: 'v1' });
  });

  describe('handleListMessages', () => {
    it('should list messages with snippets', async () => {
      const mockMessages = [
        { id: 'msg1', threadId: 'thread1' },
        { id: 'msg2', threadId: 'thread2' },
      ];

      vi.mocked(mockGmailClient.users.messages.list).mockResolvedValueOnce({
        data: {
          messages: mockMessages,
          nextPageToken: 'next-token',
          resultSizeEstimate: 100,
        },
      } as never);

      vi.mocked(mockGmailClient.users.messages.get)
        .mockResolvedValueOnce({
          data: {
            snippet: 'First message snippet',
            payload: {
              headers: [
                { name: 'From', value: 'sender@example.com' },
                { name: 'Subject', value: 'First Subject' },
                { name: 'Date', value: '2024-01-01' },
              ],
            },
          },
        } as never)
        .mockResolvedValueOnce({
          data: {
            snippet: 'Second message snippet',
            payload: {
              headers: [
                { name: 'From', value: 'another@example.com' },
                { name: 'Subject', value: 'Second Subject' },
                { name: 'Date', value: '2024-01-02' },
              ],
            },
          },
        } as never);

      const result = await handleListMessages({}, mockContext);

      expect(result.success).toBe(true);
      expect(result.data.messages).toHaveLength(2);
      expect(result.data.messages[0]).toEqual({
        id: 'msg1',
        threadId: 'thread1',
        snippet: 'First message snippet',
        from: 'sender@example.com',
        subject: 'First Subject',
        date: '2024-01-01',
      });
      expect(result.data.nextPageToken).toBe('next-token');
    });

    it('should respect maxResults limit', async () => {
      vi.mocked(mockGmailClient.users.messages.list).mockResolvedValueOnce({
        data: { messages: [] },
      } as never);

      await handleListMessages({ maxResults: 200 }, mockContext);

      expect(mockGmailClient.users.messages.list).toHaveBeenCalledWith(
        expect.objectContaining({ maxResults: 100 })
      );
    });

    it('should pass query and labelIds', async () => {
      vi.mocked(mockGmailClient.users.messages.list).mockResolvedValueOnce({
        data: { messages: [] },
      } as never);

      await handleListMessages(
        {
          query: 'from:test@example.com',
          labelIds: ['INBOX', 'UNREAD'],
        },
        mockContext
      );

      expect(mockGmailClient.users.messages.list).toHaveBeenCalledWith(
        expect.objectContaining({
          q: 'from:test@example.com',
          labelIds: ['INBOX', 'UNREAD'],
        })
      );
    });

    it('should throw error when no access token', async () => {
      const contextWithoutToken: ServerContext = { requestId: 'test' };

      await expect(handleListMessages({}, contextWithoutToken)).rejects.toThrow(
        'No access token available'
      );
    });
  });

  describe('handleGetMessage', () => {
    it('should get message details', async () => {
      vi.mocked(mockGmailClient.users.messages.get).mockResolvedValueOnce({
        data: {
          id: 'msg1',
          threadId: 'thread1',
          labelIds: ['INBOX'],
          snippet: 'Message snippet',
          payload: {
            headers: [
              { name: 'From', value: 'sender@example.com' },
              { name: 'To', value: 'recipient@example.com' },
              { name: 'Subject', value: 'Test Subject' },
              { name: 'Date', value: '2024-01-01' },
            ],
            mimeType: 'text/plain',
            body: {
              data: Buffer.from('Hello World').toString('base64'),
            },
          },
        },
      } as never);

      const result = await handleGetMessage({ messageId: 'msg1' }, mockContext);

      expect(result.success).toBe(true);
      expect(result.data).toMatchObject({
        id: 'msg1',
        threadId: 'thread1',
        from: 'sender@example.com',
        to: 'recipient@example.com',
        subject: 'Test Subject',
        body: 'Hello World',
      });
    });

    it('should extract HTML content', async () => {
      vi.mocked(mockGmailClient.users.messages.get).mockResolvedValueOnce({
        data: {
          id: 'msg1',
          payload: {
            headers: [],
            mimeType: 'text/html',
            body: {
              data: Buffer.from('<p>Hello</p>').toString('base64'),
            },
          },
        },
      } as never);

      const result = await handleGetMessage({ messageId: 'msg1' }, mockContext);

      expect(result.data.body).toBe('<p>Hello</p>');
      expect(result.data.isHtml).toBe(true);
    });

    it('should extract attachments metadata', async () => {
      vi.mocked(mockGmailClient.users.messages.get).mockResolvedValueOnce({
        data: {
          id: 'msg1',
          payload: {
            headers: [],
            parts: [
              {
                filename: 'document.pdf',
                mimeType: 'application/pdf',
                body: { attachmentId: 'att1', size: 1024 },
              },
            ],
          },
        },
      } as never);

      const result = await handleGetMessage({ messageId: 'msg1' }, mockContext);

      expect(result.data.attachments).toEqual([
        { filename: 'document.pdf', mimeType: 'application/pdf', size: 1024, attachmentId: 'att1' },
      ]);
    });
  });

  describe('handleSearch', () => {
    it('should search messages', async () => {
      vi.mocked(mockGmailClient.users.messages.list).mockResolvedValueOnce({
        data: {
          messages: [{ id: 'msg1' }],
          resultSizeEstimate: 50,
        },
      } as never);

      vi.mocked(mockGmailClient.users.messages.get).mockResolvedValueOnce({
        data: {
          snippet: 'Found message',
          payload: {
            headers: [
              { name: 'From', value: 'test@example.com' },
              { name: 'Subject', value: 'Matching Subject' },
            ],
          },
        },
      } as never);

      const result = await handleSearch({ query: 'subject:test' }, mockContext);

      expect(result.success).toBe(true);
      expect(result.data.query).toBe('subject:test');
      expect(result.data.results).toHaveLength(1);
      expect(result.data.total).toBe(50);
    });
  });

  describe('handleCreateDraft', () => {
    it('should create a draft', async () => {
      vi.mocked(mockGmailClient.users.drafts.create).mockResolvedValueOnce({
        data: {
          id: 'draft1',
          message: { id: 'msg1', threadId: 'thread1' },
        },
      } as never);

      const result = await handleCreateDraft(
        {
          to: ['recipient@example.com'],
          subject: 'Test Draft',
          body: 'Draft content',
        },
        mockContext
      );

      expect(result.success).toBe(true);
      expect(result.data.draftId).toBe('draft1');
      expect(result.data.message).toBe('Draft created successfully');
    });

    it('should support CC, BCC, and HTML body', async () => {
      vi.mocked(mockGmailClient.users.drafts.create).mockResolvedValueOnce({
        data: { id: 'draft1' },
      } as never);

      await handleCreateDraft(
        {
          to: ['to@example.com'],
          cc: ['cc@example.com'],
          bcc: ['bcc@example.com'],
          subject: 'Test',
          htmlBody: '<p>HTML content</p>',
        },
        mockContext
      );

      expect(mockGmailClient.users.drafts.create).toHaveBeenCalled();
    });
  });

  describe('handleSendDraft', () => {
    it('should send a draft', async () => {
      vi.mocked(mockGmailClient.users.drafts.send).mockResolvedValueOnce({
        data: {
          id: 'sent-msg1',
          threadId: 'thread1',
          labelIds: ['SENT'],
        },
      } as never);

      const result = await handleSendDraft({ draftId: 'draft1' }, mockContext);

      expect(result.success).toBe(true);
      expect(result.data.messageId).toBe('sent-msg1');
      expect(result.data.message).toBe('Draft sent successfully');
    });
  });

  describe('handleSendMessage', () => {
    it('should send a message', async () => {
      vi.mocked(mockGmailClient.users.messages.send).mockResolvedValueOnce({
        data: {
          id: 'sent-msg1',
          threadId: 'thread1',
          labelIds: ['SENT'],
        },
      } as never);

      const result = await handleSendMessage(
        {
          to: ['recipient@example.com'],
          subject: 'Direct Message',
          body: 'Message content',
        },
        mockContext
      );

      expect(result.success).toBe(true);
      expect(result.data.messageId).toBe('sent-msg1');
      expect(result.data.message).toBe('Message sent successfully');
    });
  });

  describe('handleDeleteMessage', () => {
    it('should delete a message', async () => {
      vi.mocked(mockGmailClient.users.messages.delete).mockResolvedValueOnce({} as never);

      const result = await handleDeleteMessage({ messageId: 'msg1' }, mockContext);

      expect(result.success).toBe(true);
      expect(result.data.messageId).toBe('msg1');
      expect(result.data.message).toBe('Message deleted permanently');
    });
  });

  describe('handleListLabels', () => {
    it('should list labels', async () => {
      vi.mocked(mockGmailClient.users.labels.list).mockResolvedValueOnce({
        data: {
          labels: [
            {
              id: 'INBOX',
              name: 'INBOX',
              type: 'system',
              messageListVisibility: 'show',
              labelListVisibility: 'labelShow',
            },
            {
              id: 'Label_1',
              name: 'My Label',
              type: 'user',
            },
          ],
        },
      } as never);

      const result = await handleListLabels({}, mockContext);

      expect(result.success).toBe(true);
      expect(result.data.labels).toHaveLength(2);
      expect(result.data.labels[0]).toMatchObject({
        id: 'INBOX',
        name: 'INBOX',
        type: 'system',
      });
    });
  });
});
