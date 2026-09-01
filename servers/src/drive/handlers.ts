/**
 * Google Drive MCP Server Tool Handlers
 */

import { Readable } from 'node:stream';
import { google, type drive_v3 } from 'googleapis';
import type { ServerContext, ToolResult } from '../common/types.js';
import { resolvePermission, canRead, canWrite, type PermissionLevel } from './path-rules.js';
import { parseAndResolveAttachments, AttachmentError } from '../gmail/attachments.js';
import type { ResolvedAttachment } from '../gmail/mime.js';

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
 * Resolve the optional `file` argument — one Gmail-style attachment spec — into
 * real bytes via the shared resolver (base64, upload, url, gmail, drive, text).
 * Returns null when absent; an AttachmentError becomes a failed ToolResult so
 * the model sees an actionable sentence rather than a stack trace (mirrors
 * resolveAttachmentsOrFail in ../gmail/handlers.ts).
 */
async function resolveFileSource(
  fileArg: unknown,
  context: ServerContext
): Promise<{ resolved: ResolvedAttachment } | { errorResult: ToolResult } | null> {
  if (fileArg === undefined || fileArg === null) return null;
  try {
    const [resolved] = await parseAndResolveAttachments([fileArg], {
      // Lazy getter: only a source:"gmail" file needs a Gmail client, and the
      // same Google token carries the Gmail scopes alongside Drive's.
      get gmail() {
        if (!context.accessToken) throw new AttachmentError('No access token available');
        const auth = new google.auth.OAuth2();
        auth.setCredentials({ access_token: context.accessToken });
        return google.gmail({ version: 'v1', auth });
      },
      drive: context.accessToken ? () => getDriveClient(context) : undefined,
      driveDefaultLevel: context.driveDefaultLevel,
      drivePathRules: context.drivePathRules,
      gatewayToken: context.gatewayToken,
    });
    if (!resolved) return { errorResult: { success: false, error: 'file resolved to no content' } };
    return { resolved };
  } catch (error) {
    if (error instanceof AttachmentError) {
      return { errorResult: { success: false, error: error.message } };
    }
    throw error;
  }
}

/**
 * Resolve the effective Drive permission for this context, using path rules if available.
 */
function drivePermission(context: ServerContext, folderId?: string): PermissionLevel {
  const defaultLevel: PermissionLevel = context.driveDefaultLevel ?? 'write';
  return resolvePermission(folderId, context.drivePathRules, defaultLevel);
}

/**
 * List files handler
 */
export async function handleListFiles(
  args: Record<string, unknown>,
  context: ServerContext
): Promise<ToolResult> {
  const folderId = args.folderId as string | undefined;
  if (!canRead(drivePermission(context, folderId))) {
    return { success: false, error: 'Permission denied: read access not granted for this folder' };
  }

  const drive = getDriveClient(context);

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
  if (!canRead(drivePermission(context))) {
    return { success: false, error: 'Permission denied: read access not granted' };
  }

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
  if (!canRead(drivePermission(context))) {
    return { success: false, error: 'Permission denied: read access not granted' };
  }

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
  if (!canRead(drivePermission(context))) {
    return { success: false, error: 'Permission denied: read access not granted' };
  }

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
  const parentId = args.parentId as string | undefined;
  if (!canWrite(drivePermission(context, parentId))) {
    return { success: false, error: 'Permission denied: write access not granted for this folder' };
  }

  const drive = getDriveClient(context);

  const name = args.name as string | undefined;
  const mimeType = args.mimeType as string | undefined;
  const content = args.content as string | undefined;

  if (content !== undefined && args.file !== undefined) {
    return { success: false, error: 'Pass either content (inline text) or file (a byte source), not both.' };
  }
  const fileSource = await resolveFileSource(args.file, context);
  if (fileSource && 'errorResult' in fileSource) return fileSource.errorResult;
  const resolved = fileSource?.resolved;

  const effectiveName = name ?? resolved?.filename;
  if (!effectiveName) {
    return { success: false, error: 'name is required when file does not carry a filename.' };
  }

  const fileMetadata: drive_v3.Schema$File = {
    name: effectiveName,
    // Still the TARGET type: with a file source, naming a Google Workspace
    // type here converts on upload (e.g. a .docx becomes a Google Doc).
    mimeType,
    parents: parentId ? [parentId] : undefined,
  };

  if (resolved) {
    // Upload real bytes. A stream, not the Buffer itself: googleapis' media
    // path treats a bare object unreliably, a Readable is the documented form.
    const media = {
      mimeType: resolved.mimeType,
      body: Readable.from(resolved.bytes),
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
  } else if (content) {
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
  if (!canWrite(drivePermission(context))) {
    return { success: false, error: 'Permission denied: write access not granted' };
  }

  const drive = getDriveClient(context);

  const fileId = args.fileId as string;
  const name = args.name as string | undefined;
  const content = args.content as string | undefined;
  const addParents = args.addParents as string[] | undefined;
  const removeParents = args.removeParents as string[] | undefined;

  const fileMetadata: drive_v3.Schema$File = {};
  if (name) fileMetadata.name = name;

  if (content !== undefined && args.file !== undefined) {
    return { success: false, error: 'Pass either content (inline text) or file (a byte source), not both.' };
  }
  const fileSource = await resolveFileSource(args.file, context);
  if (fileSource && 'errorResult' in fileSource) return fileSource.errorResult;
  const resolved = fileSource?.resolved;

  if (resolved) {
    const media = {
      mimeType: resolved.mimeType,
      body: Readable.from(resolved.bytes),
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
  } else if (content) {
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
  if (!canWrite(drivePermission(context))) {
    return { success: false, error: 'Permission denied: write access not granted' };
  }

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
  if (!canWrite(drivePermission(context))) {
    return { success: false, error: 'Permission denied: write access not granted' };
  }

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
