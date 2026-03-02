/**
 * Google Drive MCP Server Tool Handlers
 */

import { google, type drive_v3 } from 'googleapis';
import type { ServerContext, ToolResult } from '../common/types.js';

type DriveClient = drive_v3.Drive;

const DEFAULT_FIELDS =
  'id, name, mimeType, size, modifiedTime, createdTime, parents, webViewLink, iconLink';

const GOOGLE_DOC_MIMETYPES = {
  'application/vnd.google-apps.document': 'text/plain',
  'application/vnd.google-apps.spreadsheet': 'text/csv',
  'application/vnd.google-apps.presentation': 'text/plain',
  'application/vnd.google-apps.drawing': 'image/png',
};

const MAX_CONTENT_SIZE = 1024 * 1024; // 1MB default

/**
 * Get Drive client from context
 */
function getDriveClient(context: ServerContext): DriveClient {
  if (!context.accessToken) {
    throw new Error('No access token available');
  }

  const auth = new google.auth.OAuth2();
  auth.setCredentials({ access_token: context.accessToken });
  return google.drive({ version: 'v3', auth });
}

/**
 * List files handler
 */
export async function handleListFiles(
  args: Record<string, unknown>,
  context: ServerContext
): Promise<ToolResult> {
  const drive = getDriveClient(context);

  const folderId = args.folderId as string | undefined;
  const pageSize = Math.min((args.pageSize as number) ?? 20, 100);
  const pageToken = args.pageToken as string | undefined;
  const orderBy = (args.orderBy as string) ?? 'modifiedTime desc';
  const fields = args.fields as string[] | undefined;

  let query = 'trashed = false';
  if (folderId) {
    query += ` and '${folderId}' in parents`;
  }

  const fileFields = fields?.join(', ') ?? DEFAULT_FIELDS;

  const response = await drive.files.list({
    q: query,
    pageSize,
    pageToken,
    orderBy,
    fields: `nextPageToken, files(${fileFields})`,
    supportsAllDrives: true,
    includeItemsFromAllDrives: true,
  });

  return {
    success: true,
    data: {
      files: response.data.files ?? [],
      nextPageToken: response.data.nextPageToken,
    },
  };
}

/**
 * Get file metadata handler
 */
export async function handleGetFile(
  args: Record<string, unknown>,
  context: ServerContext
): Promise<ToolResult> {
  const drive = getDriveClient(context);

  const fileId = args.fileId as string;
  const fields = args.fields as string[] | undefined;

  const fileFields =
    fields?.join(', ') ??
    'id, name, mimeType, size, modifiedTime, createdTime, parents, webViewLink, owners, permissions, description';

  const response = await drive.files.get({
    fileId,
    fields: fileFields,
    supportsAllDrives: true,
  });

  return {
    success: true,
    data: response.data,
  };
}

/**
 * Read file content handler
 */
export async function handleReadFile(
  args: Record<string, unknown>,
  context: ServerContext
): Promise<ToolResult> {
  const drive = getDriveClient(context);

  const fileId = args.fileId as string;
  const requestedMimeType = args.mimeType as string | undefined;
  const maxSize = (args.maxSize as number) ?? MAX_CONTENT_SIZE;

  // First get file metadata
  const metadata = await drive.files.get({
    fileId,
    fields: 'id, name, mimeType, size',
    supportsAllDrives: true,
  });

  const fileMimeType = metadata.data.mimeType ?? 'application/octet-stream';
  const fileName = metadata.data.name ?? 'unknown';
  const fileSize = parseInt(metadata.data.size ?? '0', 10);

  // Check if it's a Google Workspace document
  const isGoogleDoc = fileMimeType.startsWith('application/vnd.google-apps.');

  if (isGoogleDoc) {
    // Export Google Docs to requested format
    const exportMimeType =
      requestedMimeType ??
      GOOGLE_DOC_MIMETYPES[fileMimeType as keyof typeof GOOGLE_DOC_MIMETYPES] ??
      'text/plain';

    const response = await drive.files.export(
      {
        fileId,
        mimeType: exportMimeType,
      },
      { responseType: 'text' }
    );

    const content = response.data as string;

    // Truncate if too large
    const truncated = content.length > maxSize;
    const truncatedContent = truncated ? content.slice(0, maxSize) : content;

    return {
      success: true,
      data: {
        fileId,
        name: fileName,
        mimeType: fileMimeType,
        exportedAs: exportMimeType,
        content: truncatedContent,
        truncated,
        originalLength: content.length,
      },
    };
  }

  // For regular files, check if it's readable text
  const textMimeTypes = [
    'text/',
    'application/json',
    'application/xml',
    'application/javascript',
    'application/typescript',
  ];
  const isText = textMimeTypes.some((t) => fileMimeType.startsWith(t));

  if (!isText) {
    return {
      success: true,
      data: {
        fileId,
        name: fileName,
        mimeType: fileMimeType,
        size: fileSize,
        message: 'Binary file - content not readable as text',
        webViewLink: metadata.data.webViewLink,
      },
    };
  }

  // Check file size
  if (fileSize > maxSize) {
    return {
      success: false,
      error: `File too large (${fileSize} bytes). Max size: ${maxSize} bytes`,
    };
  }

  // Download text content
  const response = await drive.files.get(
    {
      fileId,
      alt: 'media',
      supportsAllDrives: true,
    },
    { responseType: 'text' }
  );

  return {
    success: true,
    data: {
      fileId,
      name: fileName,
      mimeType: fileMimeType,
      content: response.data,
      size: fileSize,
    },
  };
}

/**
 * Search files handler
 */
export async function handleSearch(
  args: Record<string, unknown>,
  context: ServerContext
): Promise<ToolResult> {
  const drive = getDriveClient(context);

  const query = args.query as string;
  const pageSize = Math.min((args.pageSize as number) ?? 20, 100);
  const includeSharedDrives = args.includeSharedDrives as boolean ?? true;

  // Combine with trashed filter
  const fullQuery = `(${query}) and trashed = false`;

  const response = await drive.files.list({
    q: fullQuery,
    pageSize,
    fields: `nextPageToken, files(${DEFAULT_FIELDS})`,
    supportsAllDrives: true,
    includeItemsFromAllDrives: includeSharedDrives,
  });

  return {
    success: true,
    data: {
      query,
      files: response.data.files ?? [],
      nextPageToken: response.data.nextPageToken,
    },
  };
}

/**
 * Create file handler
 */
export async function handleCreateFile(
  args: Record<string, unknown>,
  context: ServerContext
): Promise<ToolResult> {
  const drive = getDriveClient(context);

  const name = args.name as string;
  const mimeType = args.mimeType as string | undefined;
  const content = args.content as string | undefined;
  const parentId = args.parentId as string | undefined;

  const fileMetadata: drive_v3.Schema$File = {
    name,
    mimeType,
    parents: parentId ? [parentId] : undefined,
  };

  if (content) {
    // Create with content
    const media = {
      mimeType: mimeType ?? 'text/plain',
      body: content,
    };

    const response = await drive.files.create({
      requestBody: fileMetadata,
      media,
      fields: DEFAULT_FIELDS,
      supportsAllDrives: true,
    });

    return {
      success: true,
      data: {
        ...response.data,
        message: 'File created successfully',
      },
    };
  } else {
    // Create empty file or folder
    const response = await drive.files.create({
      requestBody: fileMetadata,
      fields: DEFAULT_FIELDS,
      supportsAllDrives: true,
    });

    return {
      success: true,
      data: {
        ...response.data,
        message: 'File created successfully',
      },
    };
  }
}

/**
 * Update file handler
 */
export async function handleUpdateFile(
  args: Record<string, unknown>,
  context: ServerContext
): Promise<ToolResult> {
  const drive = getDriveClient(context);

  const fileId = args.fileId as string;
  const name = args.name as string | undefined;
  const content = args.content as string | undefined;
  const addParents = args.addParents as string[] | undefined;
  const removeParents = args.removeParents as string[] | undefined;

  const fileMetadata: drive_v3.Schema$File = {};
  if (name) fileMetadata.name = name;

  if (content) {
    // Update with new content
    const media = {
      mimeType: 'text/plain',
      body: content,
    };

    const response = await drive.files.update({
      fileId,
      requestBody: fileMetadata,
      media,
      addParents: addParents?.join(','),
      removeParents: removeParents?.join(','),
      fields: DEFAULT_FIELDS,
      supportsAllDrives: true,
    });

    return {
      success: true,
      data: {
        ...response.data,
        message: 'File updated successfully',
      },
    };
  } else {
    // Update metadata only
    const response = await drive.files.update({
      fileId,
      requestBody: fileMetadata,
      addParents: addParents?.join(','),
      removeParents: removeParents?.join(','),
      fields: DEFAULT_FIELDS,
      supportsAllDrives: true,
    });

    return {
      success: true,
      data: {
        ...response.data,
        message: 'File updated successfully',
      },
    };
  }
}

/**
 * Share file handler
 */
export async function handleShareFile(
  args: Record<string, unknown>,
  context: ServerContext
): Promise<ToolResult> {
  const drive = getDriveClient(context);

  const fileId = args.fileId as string;
  const email = args.email as string | undefined;
  const role = args.role as 'reader' | 'commenter' | 'writer' | 'owner';
  const type = args.type as 'user' | 'group' | 'domain' | 'anyone';
  const sendNotification = args.sendNotification as boolean ?? true;

  const permission: drive_v3.Schema$Permission = {
    role,
    type,
  };

  if (email && (type === 'user' || type === 'group')) {
    permission.emailAddress = email;
  }

  const response = await drive.permissions.create({
    fileId,
    requestBody: permission,
    sendNotificationEmail: sendNotification,
    supportsAllDrives: true,
    fields: 'id, type, role, emailAddress',
  });

  return {
    success: true,
    data: {
      fileId,
      permission: response.data,
      message: 'File shared successfully',
    },
  };
}

/**
 * Delete file handler
 */
export async function handleDeleteFile(
  args: Record<string, unknown>,
  context: ServerContext
): Promise<ToolResult> {
  const drive = getDriveClient(context);

  const fileId = args.fileId as string;
  const permanent = args.permanent as boolean | undefined;

  if (permanent) {
    // Permanently delete
    await drive.files.delete({
      fileId,
      supportsAllDrives: true,
    });

    return {
      success: true,
      data: {
        fileId,
        message: 'File permanently deleted',
      },
    };
  } else {
    // Move to trash
    await drive.files.update({
      fileId,
      requestBody: { trashed: true },
      supportsAllDrives: true,
    });

    return {
      success: true,
      data: {
        fileId,
        message: 'File moved to trash',
      },
    };
  }
}

/**
 * List shared drives handler
 */
export async function handleListSharedDrives(
  args: Record<string, unknown>,
  context: ServerContext
): Promise<ToolResult> {
  const drive = getDriveClient(context);

  const pageSize = Math.min((args.pageSize as number) ?? 10, 100);
  const pageToken = args.pageToken as string | undefined;

  const response = await drive.drives.list({
    pageSize,
    pageToken,
    fields: 'nextPageToken, drives(id, name, colorRgb, createdTime)',
  });

  return {
    success: true,
    data: {
      drives: response.data.drives ?? [],
      nextPageToken: response.data.nextPageToken,
    },
  };
}
