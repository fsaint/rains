/**
 * Google Drive Handler Tests
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { ServerContext } from '../common/types.js';

// Mock googleapis
vi.mock('googleapis', () => {
  const mockDrive = {
    files: {
      list: vi.fn(),
      get: vi.fn(),
      create: vi.fn(),
      update: vi.fn(),
      delete: vi.fn(),
      export: vi.fn(),
    },
    permissions: {
      create: vi.fn(),
    },
    drives: {
      list: vi.fn(),
    },
  };

  return {
    google: {
      auth: {
        OAuth2: vi.fn().mockImplementation(() => ({
          setCredentials: vi.fn(),
        })),
      },
      drive: vi.fn(() => mockDrive),
    },
  };
});

// Import after mocking
import { google } from 'googleapis';
import {
  handleListFiles,
  handleGetFile,
  handleReadFile,
  handleSearch,
  handleCreateFile,
  handleUpdateFile,
  handleShareFile,
  handleDeleteFile,
  handleListSharedDrives,
} from './handlers.js';

describe('Drive Handlers', () => {
  const mockContext: ServerContext = {
    requestId: 'test-request-id',
    accessToken: 'test-access-token',
  };

  let mockDriveClient: ReturnType<typeof google.drive>;

  beforeEach(() => {
    vi.clearAllMocks();
    mockDriveClient = google.drive({ version: 'v3' });
  });

  describe('handleListFiles', () => {
    it('should list files with default parameters', async () => {
      vi.mocked(mockDriveClient.files.list).mockResolvedValueOnce({
        data: {
          files: [
            { id: 'file1', name: 'Document.docx', mimeType: 'application/vnd.google-apps.document' },
            { id: 'file2', name: 'Spreadsheet.xlsx', mimeType: 'application/vnd.google-apps.spreadsheet' },
          ],
          nextPageToken: 'next-token',
        },
      } as never);

      const result = await handleListFiles({}, mockContext);

      expect(result.success).toBe(true);
      expect(result.data.files).toHaveLength(2);
      expect(result.data.nextPageToken).toBe('next-token');
    });

    it('should filter by folder', async () => {
      vi.mocked(mockDriveClient.files.list).mockResolvedValueOnce({
        data: { files: [] },
      } as never);

      await handleListFiles({ folderId: 'folder123' }, mockContext);

      expect(mockDriveClient.files.list).toHaveBeenCalledWith(
        expect.objectContaining({
          q: expect.stringContaining("'folder123' in parents"),
        })
      );
    });

    it('should respect pageSize limit', async () => {
      vi.mocked(mockDriveClient.files.list).mockResolvedValueOnce({
        data: { files: [] },
      } as never);

      await handleListFiles({ pageSize: 200 }, mockContext);

      expect(mockDriveClient.files.list).toHaveBeenCalledWith(
        expect.objectContaining({ pageSize: 100 })
      );
    });

    it('should throw error when no access token', async () => {
      const contextWithoutToken: ServerContext = { requestId: 'test' };

      await expect(handleListFiles({}, contextWithoutToken)).rejects.toThrow(
        'No access token available'
      );
    });
  });

  describe('handleGetFile', () => {
    it('should get file metadata', async () => {
      vi.mocked(mockDriveClient.files.get).mockResolvedValueOnce({
        data: {
          id: 'file1',
          name: 'Test Document',
          mimeType: 'application/vnd.google-apps.document',
          size: '1024',
          modifiedTime: '2024-01-01T00:00:00Z',
        },
      } as never);

      const result = await handleGetFile({ fileId: 'file1' }, mockContext);

      expect(result.success).toBe(true);
      expect(result.data.id).toBe('file1');
      expect(result.data.name).toBe('Test Document');
    });

    it('should use custom fields', async () => {
      vi.mocked(mockDriveClient.files.get).mockResolvedValueOnce({
        data: { id: 'file1' },
      } as never);

      await handleGetFile({ fileId: 'file1', fields: ['id', 'name'] }, mockContext);

      expect(mockDriveClient.files.get).toHaveBeenCalledWith(
        expect.objectContaining({
          fields: 'id, name',
        })
      );
    });
  });

  describe('handleReadFile', () => {
    it('should export Google Docs to text', async () => {
      vi.mocked(mockDriveClient.files.get).mockResolvedValueOnce({
        data: {
          id: 'file1',
          name: 'Document',
          mimeType: 'application/vnd.google-apps.document',
          size: '500',
        },
      } as never);

      vi.mocked(mockDriveClient.files.export).mockResolvedValueOnce({
        data: 'Document content here',
      } as never);

      const result = await handleReadFile({ fileId: 'file1' }, mockContext);

      expect(result.success).toBe(true);
      expect(result.data.content).toBe('Document content here');
      expect(result.data.exportedAs).toBe('text/plain');
    });

    it('should return message for binary files', async () => {
      vi.mocked(mockDriveClient.files.get).mockResolvedValueOnce({
        data: {
          id: 'file1',
          name: 'Image.png',
          mimeType: 'image/png',
          size: '1024',
        },
      } as never);

      const result = await handleReadFile({ fileId: 'file1' }, mockContext);

      expect(result.success).toBe(true);
      expect(result.data.message).toBe('Binary file - content not readable as text');
    });

    it('should read text files directly', async () => {
      vi.mocked(mockDriveClient.files.get)
        .mockResolvedValueOnce({
          data: {
            id: 'file1',
            name: 'readme.txt',
            mimeType: 'text/plain',
            size: '100',
          },
        } as never)
        .mockResolvedValueOnce({
          data: 'Text file content',
        } as never);

      const result = await handleReadFile({ fileId: 'file1' }, mockContext);

      expect(result.success).toBe(true);
      expect(result.data.content).toBe('Text file content');
    });

    it('should fail if file too large', async () => {
      vi.mocked(mockDriveClient.files.get).mockResolvedValueOnce({
        data: {
          id: 'file1',
          name: 'large.txt',
          mimeType: 'text/plain',
          size: '2000000',
        },
      } as never);

      const result = await handleReadFile({ fileId: 'file1', maxSize: 1000000 }, mockContext);

      expect(result.success).toBe(false);
      expect(result.error).toContain('File too large');
    });
  });

  describe('handleSearch', () => {
    it('should search files', async () => {
      vi.mocked(mockDriveClient.files.list).mockResolvedValueOnce({
        data: {
          files: [{ id: 'file1', name: 'Test.docx' }],
        },
      } as never);

      const result = await handleSearch({ query: "name contains 'test'" }, mockContext);

      expect(result.success).toBe(true);
      expect(result.data.query).toBe("name contains 'test'");
      expect(result.data.files).toHaveLength(1);
    });

    it('should combine query with trashed filter', async () => {
      vi.mocked(mockDriveClient.files.list).mockResolvedValueOnce({
        data: { files: [] },
      } as never);

      await handleSearch({ query: "mimeType = 'text/plain'" }, mockContext);

      expect(mockDriveClient.files.list).toHaveBeenCalledWith(
        expect.objectContaining({
          q: "(mimeType = 'text/plain') and trashed = false",
        })
      );
    });
  });

  describe('handleCreateFile', () => {
    it('should create file with content', async () => {
      vi.mocked(mockDriveClient.files.create).mockResolvedValueOnce({
        data: {
          id: 'new-file-id',
          name: 'NewFile.txt',
        },
      } as never);

      const result = await handleCreateFile(
        {
          name: 'NewFile.txt',
          content: 'File content',
          mimeType: 'text/plain',
        },
        mockContext
      );

      expect(result.success).toBe(true);
      expect(result.data.message).toBe('File created successfully');
    });

    it('should create empty file', async () => {
      vi.mocked(mockDriveClient.files.create).mockResolvedValueOnce({
        data: {
          id: 'folder-id',
          name: 'NewFolder',
          mimeType: 'application/vnd.google-apps.folder',
        },
      } as never);

      const result = await handleCreateFile(
        {
          name: 'NewFolder',
          mimeType: 'application/vnd.google-apps.folder',
        },
        mockContext
      );

      expect(result.success).toBe(true);
    });

    it('should set parent folder', async () => {
      vi.mocked(mockDriveClient.files.create).mockResolvedValueOnce({
        data: { id: 'new-id' },
      } as never);

      await handleCreateFile(
        { name: 'file.txt', parentId: 'parent-folder' },
        mockContext
      );

      expect(mockDriveClient.files.create).toHaveBeenCalledWith(
        expect.objectContaining({
          requestBody: expect.objectContaining({
            parents: ['parent-folder'],
          }),
        })
      );
    });
  });

  describe('handleUpdateFile', () => {
    it('should update file name', async () => {
      vi.mocked(mockDriveClient.files.update).mockResolvedValueOnce({
        data: {
          id: 'file1',
          name: 'Renamed.txt',
        },
      } as never);

      const result = await handleUpdateFile(
        { fileId: 'file1', name: 'Renamed.txt' },
        mockContext
      );

      expect(result.success).toBe(true);
      expect(result.data.message).toBe('File updated successfully');
    });

    it('should update file content', async () => {
      vi.mocked(mockDriveClient.files.update).mockResolvedValueOnce({
        data: { id: 'file1' },
      } as never);

      await handleUpdateFile(
        { fileId: 'file1', content: 'New content' },
        mockContext
      );

      expect(mockDriveClient.files.update).toHaveBeenCalledWith(
        expect.objectContaining({
          media: expect.objectContaining({ body: 'New content' }),
        })
      );
    });

    it('should move file between folders', async () => {
      vi.mocked(mockDriveClient.files.update).mockResolvedValueOnce({
        data: { id: 'file1' },
      } as never);

      await handleUpdateFile(
        {
          fileId: 'file1',
          addParents: ['new-folder'],
          removeParents: ['old-folder'],
        },
        mockContext
      );

      expect(mockDriveClient.files.update).toHaveBeenCalledWith(
        expect.objectContaining({
          addParents: 'new-folder',
          removeParents: 'old-folder',
        })
      );
    });
  });

  describe('handleShareFile', () => {
    it('should share file with user', async () => {
      vi.mocked(mockDriveClient.permissions.create).mockResolvedValueOnce({
        data: {
          id: 'perm1',
          role: 'reader',
          type: 'user',
          emailAddress: 'user@example.com',
        },
      } as never);

      const result = await handleShareFile(
        {
          fileId: 'file1',
          email: 'user@example.com',
          role: 'reader',
          type: 'user',
        },
        mockContext
      );

      expect(result.success).toBe(true);
      expect(result.data.message).toBe('File shared successfully');
      expect(result.data.permission.emailAddress).toBe('user@example.com');
    });

    it('should share file with anyone', async () => {
      vi.mocked(mockDriveClient.permissions.create).mockResolvedValueOnce({
        data: { id: 'perm1', role: 'reader', type: 'anyone' },
      } as never);

      await handleShareFile(
        { fileId: 'file1', role: 'reader', type: 'anyone' },
        mockContext
      );

      expect(mockDriveClient.permissions.create).toHaveBeenCalledWith(
        expect.objectContaining({
          requestBody: expect.objectContaining({ type: 'anyone' }),
        })
      );
    });
  });

  describe('handleDeleteFile', () => {
    it('should move file to trash', async () => {
      vi.mocked(mockDriveClient.files.update).mockResolvedValueOnce({} as never);

      const result = await handleDeleteFile({ fileId: 'file1' }, mockContext);

      expect(result.success).toBe(true);
      expect(result.data.message).toBe('File moved to trash');
      expect(mockDriveClient.files.update).toHaveBeenCalledWith(
        expect.objectContaining({
          requestBody: { trashed: true },
        })
      );
    });

    it('should permanently delete file', async () => {
      vi.mocked(mockDriveClient.files.delete).mockResolvedValueOnce({} as never);

      const result = await handleDeleteFile(
        { fileId: 'file1', permanent: true },
        mockContext
      );

      expect(result.success).toBe(true);
      expect(result.data.message).toBe('File permanently deleted');
    });
  });

  describe('handleListSharedDrives', () => {
    it('should list shared drives', async () => {
      vi.mocked(mockDriveClient.drives.list).mockResolvedValueOnce({
        data: {
          drives: [
            { id: 'drive1', name: 'Team Drive 1' },
            { id: 'drive2', name: 'Team Drive 2' },
          ],
          nextPageToken: 'next',
        },
      } as never);

      const result = await handleListSharedDrives({}, mockContext);

      expect(result.success).toBe(true);
      expect(result.data.drives).toHaveLength(2);
      expect(result.data.nextPageToken).toBe('next');
    });

    it('should limit page size', async () => {
      vi.mocked(mockDriveClient.drives.list).mockResolvedValueOnce({
        data: { drives: [] },
      } as never);

      await handleListSharedDrives({ pageSize: 200 }, mockContext);

      expect(mockDriveClient.drives.list).toHaveBeenCalledWith(
        expect.objectContaining({ pageSize: 100 })
      );
    });
  });
});
