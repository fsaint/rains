/**
 * Google Drive Handler Tests
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { data } from '../common/test-helpers.js';
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
      expect(data(result).files).toHaveLength(2);
      expect(data(result).nextPageToken).toBe('next-token');
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
      expect(data(result).id).toBe('file1');
      expect(data(result).name).toBe('Test Document');
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
      expect(data(result).content).toBe('Document content here');
      expect(data(result).exportedAs).toBe('text/plain');
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
      expect(data(result).message).toBe('Binary file - content not readable as text');
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
      expect(data(result).content).toBe('Text file content');
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
      expect(data(result).query).toBe("name contains 'test'");
      expect(data(result).files).toHaveLength(1);
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
      expect(data(result).message).toBe('File created successfully');
    });

    it('refuses content and file together, without calling the API', async () => {
      const result = await handleCreateFile(
        { name: 'x.txt', content: 'text', file: { source: 'base64', filename: 'x.txt', data: 'aGk=' } },
        mockContext
      );

      expect(result.success).toBe(false);
      expect(result.error).toContain('not both');
      expect(mockDriveClient.files.create).not.toHaveBeenCalled();
    });

    it('requires a name when the file carries no filename and none is given', async () => {
      const result = await handleCreateFile({ content: 'plain text' }, mockContext);

      expect(result.success).toBe(false);
      expect(result.error).toContain('name');
      expect(mockDriveClient.files.create).not.toHaveBeenCalled();
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
      expect(data(result).message).toBe('File updated successfully');
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
      expect(data(result).message).toBe('File shared successfully');
      expect(data(result).permission.emailAddress).toBe('user@example.com');
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
      expect(data(result).message).toBe('File moved to trash');
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
      expect(data(result).message).toBe('File permanently deleted');
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
      expect(data(result).drives).toHaveLength(2);
      expect(data(result).nextPageToken).toBe('next');
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

/** Collect a Readable media body back into a Buffer for assertions. */
async function readMediaBody(body: unknown): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const chunk of body as AsyncIterable<Buffer | string>) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  return Buffer.concat(chunks);
}

describe('Drive Handlers — file sources (real uploads)', () => {
  const mockContext: ServerContext = {
    requestId: 'test-request-id',
    accessToken: 'test-access-token',
    gatewayToken: 'secret-token',
  } as ServerContext;

  let mockDriveClient: ReturnType<typeof google.drive>;

  beforeEach(() => {
    vi.clearAllMocks();
    mockDriveClient = google.drive({ version: 'v3' });
  });

  it('uploads base64 bytes as a stream, naming the file from the spec', async () => {
    vi.mocked(mockDriveClient.files.create).mockResolvedValueOnce({
      data: { id: 'f1', name: 'report.pdf' },
    } as never);

    const bytes = Buffer.from('PDFDATA');
    const result = await handleCreateFile(
      {
        file: { source: 'base64', filename: 'report.pdf', mimeType: 'application/pdf', data: bytes.toString('base64') },
      },
      mockContext
    );

    expect(result.success).toBe(true);
    const call = vi.mocked(mockDriveClient.files.create).mock.calls[0][0] as unknown as {
      requestBody: { name: string; mimeType?: string };
      media: { mimeType: string; body: unknown };
    };
    expect(call.requestBody.name).toBe('report.pdf');
    expect(call.media.mimeType).toBe('application/pdf');
    expect((await readMediaBody(call.media.body)).equals(bytes)).toBe(true);
  });

  it('explicit name and target mimeType win — the conversion case', async () => {
    // requestBody.mimeType is the TARGET type (Google Doc); media.mimeType is
    // the source bytes' type. This is how Drive converts on upload.
    vi.mocked(mockDriveClient.files.create).mockResolvedValueOnce({ data: { id: 'f1' } } as never);

    await handleCreateFile(
      {
        name: 'Quarterly Notes',
        mimeType: 'application/vnd.google-apps.document',
        file: { source: 'base64', filename: 'notes.txt', mimeType: 'text/plain', data: Buffer.from('hi').toString('base64') },
      },
      mockContext
    );

    const call = vi.mocked(mockDriveClient.files.create).mock.calls[0][0] as unknown as {
      requestBody: { name: string; mimeType?: string };
      media: { mimeType: string };
    };
    expect(call.requestBody.name).toBe('Quarterly Notes');
    expect(call.requestBody.mimeType).toBe('application/vnd.google-apps.document');
    expect(call.media.mimeType).toBe('text/plain');
  });

  it('resolves source:"upload" via the agent-uploads API with the gateway token', async () => {
    const originalFetch = globalThis.fetch;
    const staged = Buffer.from('staged-bytes');
    const fetchMock = vi.fn(async () =>
      new Response(staged, {
        status: 200,
        headers: {
          'content-type': 'application/pdf',
          'x-upload-filename': encodeURIComponent('Q3 report.pdf'),
        },
      })
    );
    globalThis.fetch = fetchMock as never;

    try {
      vi.mocked(mockDriveClient.files.create).mockResolvedValueOnce({ data: { id: 'f1' } } as never);

      const result = await handleCreateFile(
        { file: { source: 'upload', uploadId: 'up-1' } },
        mockContext
      );

      expect(result.success).toBe(true);
      const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
      expect(url).toContain('/api/agent-uploads/up-1');
      expect((init.headers as Record<string, string>)['x-reins-agent-secret']).toBe('secret-token');

      const call = vi.mocked(mockDriveClient.files.create).mock.calls[0][0] as unknown as {
        requestBody: { name: string };
        media: { mimeType: string; body: unknown };
      };
      expect(call.requestBody.name).toBe('Q3 report.pdf');
      expect(call.media.mimeType).toBe('application/pdf');
      expect((await readMediaBody(call.media.body)).equals(staged)).toBe(true);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it("surfaces the resolver's limit error without calling the API", async () => {
    const oversized = Buffer.alloc(385 * 1024).toString('base64');

    const result = await handleCreateFile(
      { file: { source: 'base64', filename: 'big.bin', mimeType: 'application/octet-stream', data: oversized } },
      mockContext
    );

    expect(result.success).toBe(false);
    expect(result.error).toMatch(/limit/i);
    expect(mockDriveClient.files.create).not.toHaveBeenCalled();
  });

  it('a write-blocked folder refuses before resolving anything', async () => {
    const fetchSpy = vi.fn();
    const originalFetch = globalThis.fetch;
    globalThis.fetch = fetchSpy as never;
    try {
      const result = await handleCreateFile(
        { parentId: 'folder-1', file: { source: 'upload', uploadId: 'up-1' } },
        { ...mockContext, driveDefaultLevel: 'read' } as ServerContext
      );

      expect(result.success).toBe(false);
      expect(result.error).toContain('Permission denied');
      expect(fetchSpy).not.toHaveBeenCalled();
      expect(mockDriveClient.files.create).not.toHaveBeenCalled();
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it('drive_update_file replaces content from a file source with its real MIME type', async () => {
    vi.mocked(mockDriveClient.files.update).mockResolvedValueOnce({ data: { id: 'f1' } } as never);

    const bytes = Buffer.from('%PDF-1.4');
    const result = await handleUpdateFile(
      {
        fileId: 'f1',
        file: { source: 'base64', filename: 'new.pdf', mimeType: 'application/pdf', data: bytes.toString('base64') },
      },
      mockContext
    );

    expect(result.success).toBe(true);
    const call = vi.mocked(mockDriveClient.files.update).mock.calls[0][0] as unknown as {
      media: { mimeType: string; body: unknown };
    };
    // Not the legacy hardcoded text/plain: binary updates keep their type.
    expect(call.media.mimeType).toBe('application/pdf');
    expect((await readMediaBody(call.media.body)).equals(bytes)).toBe(true);
  });

  it('drive_update_file refuses content and file together', async () => {
    const result = await handleUpdateFile(
      { fileId: 'f1', content: 'x', file: { source: 'base64', filename: 'a', data: 'aGk=' } },
      mockContext
    );

    expect(result.success).toBe(false);
    expect(mockDriveClient.files.update).not.toHaveBeenCalled();
  });
});
