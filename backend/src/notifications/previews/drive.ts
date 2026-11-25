/**
 * Previews for Drive writes. A file is shown by name and folder rather than by
 * id, and a share says in words who gets access.
 */
import type { ApprovalRequest } from '@reins/shared';
import { registerPreview, type ApprovalPreview } from '../approval-preview.js';
import { argsOf, bearer, byteSize, fetchJson, shortDate, str, strList, tokenFor, type Args } from './shared.js';

const DRIVE_API = 'https://www.googleapis.com/drive/v3/files';

const MIME_LABELS: Record<string, string> = {
  'application/vnd.google-apps.document': 'Google Doc',
  'application/vnd.google-apps.spreadsheet': 'Google Sheet',
  'application/vnd.google-apps.presentation': 'Google Slides',
  'application/vnd.google-apps.folder': 'Folder',
  'application/pdf': 'PDF',
  'text/plain': 'Text file',
  'text/markdown': 'Markdown file',
  'text/csv': 'CSV file',
};

const ROLE_LABELS: Record<string, string> = {
  reader: 'Can view',
  commenter: 'Can comment',
  writer: 'Can edit',
  owner: 'Becomes the owner',
};

interface DriveFile {
  name?: string;
  mimeType?: string;
  parents?: string[];
  size?: string;
  modifiedTime?: string;
  shared?: boolean;
  owners?: Array<{ displayName?: string; emailAddress?: string }>;
}

async function getFile(token: string | null, id: string | undefined, fields: string): Promise<DriveFile | null> {
  if (!token || !id) return null;
  return fetchJson<DriveFile>(
    `${DRIVE_API}/${encodeURIComponent(id)}?fields=${encodeURIComponent(fields)}&supportsAllDrives=true`,
    { headers: bearer(token) }
  );
}

/** A folder id as its name; the id itself when it cannot be read. */
async function folderName(token: string | null, id: string): Promise<string> {
  if (id === 'root') return 'My Drive';
  return (await getFile(token, id, 'name'))?.name ?? id;
}

/** Where a file's bytes come from, in words. */
function describeSource(file: Args): string {
  switch (file.source) {
    case 'upload':
      return 'A file uploaded from your machine';
    case 'url':
      return `Downloaded from ${str(file.url) ?? 'a URL'}`;
    case 'gmail':
      return 'An email attachment';
    case 'drive':
      return 'A copy of another Drive file';
    case 'base64':
    case 'text':
      return 'Supplied by the agent';
    default:
      return 'A staged file';
  }
}

const FILE_FIELDS = 'name,mimeType,parents,size,modifiedTime,shared,owners(displayName,emailAddress)';

async function buildDrivePreview(approval: ApprovalRequest): Promise<ApprovalPreview | null> {
  const args = argsOf(approval);
  const token = await tokenFor(approval, 'drive');
  const source = args.file && typeof args.file === 'object' ? (args.file as Args) : undefined;
  const content = str(args.content) ?? (source?.source === 'text' ? str(source.content) : undefined);

  if (approval.tool === 'drive_create_file') {
    const mimeType = str(args.mimeType) ?? str(source?.mimeType);
    const preview: ApprovalPreview = {
      icon: '📄',
      heading: 'Create file in Drive',
      rows: [
        { label: 'Name', value: str(args.name) ?? str(source?.filename) ?? '(named after the source file)' },
        { label: 'Folder', value: await folderName(token, str(args.parentId) ?? 'root') },
      ],
    };
    if (mimeType) preview.rows.push({ label: 'Type', value: MIME_LABELS[mimeType] ?? mimeType });
    if (source && !content) preview.rows.push({ label: 'Content', value: describeSource(source) });
    if (content) preview.body = { label: `Content (${byteSize(Buffer.byteLength(content))})`, text: content };
    return preview;
  }

  const fileId = str(args.fileId);
  if (!fileId) return null;
  const file = await getFile(token, fileId, FILE_FIELDS);
  const type = file?.mimeType ? MIME_LABELS[file.mimeType] ?? undefined : undefined;
  const isFolder = file?.mimeType === 'application/vnd.google-apps.folder';
  const thing = isFolder ? 'folder' : 'file';

  const preview: ApprovalPreview = {
    icon: '📄',
    heading: `Update ${thing}`,
    rows: [{ label: isFolder ? 'Folder' : 'File', value: file?.name ?? fileId }],
    warning: file ? undefined : 'Could not load this file. Approve only if you recognise its id.',
  };
  if (type && !isFolder) preview.rows.push({ label: 'Type', value: type });
  if (file?.parents?.[0]) preview.rows.push({ label: 'In', value: await folderName(token, file.parents[0]) });

  switch (approval.tool) {
    case 'drive_update_file': {
      preview.icon = '✏️';
      const newName = str(args.name);
      if (newName && newName !== file?.name) {
        preview.rows[0] = { label: 'Name', value: newName, was: file?.name ?? fileId };
      }
      const names = (ids: string[]) => Promise.all(ids.map((id) => folderName(token, id)));
      const add = strList(args.addParents);
      const remove = strList(args.removeParents);
      if (add.length > 0) preview.rows.push({ label: 'Move into', value: (await names(add)).join(', ') });
      if (remove.length > 0) preview.rows.push({ label: 'Take out of', value: (await names(remove)).join(', ') });
      if (content || source) preview.note = `Replaces the ${thing}'s content.`;
      if (source && !content) preview.rows.push({ label: 'New content', value: describeSource(source) });
      if (content) preview.body = { label: `New content (${byteSize(Buffer.byteLength(content))})`, text: content };
      return preview;
    }

    case 'drive_share_file': {
      const type = str(args.type) ?? 'user';
      const email = str(args.email);
      const everyone = type === 'anyone';
      preview.icon = '🔗';
      preview.heading = `Share ${thing}`;
      preview.rows.push({
        label: 'With',
        value: everyone
          ? 'Anyone with the link'
          : type === 'domain'
          ? `Everyone at ${str(args.domain) ?? email ?? 'the domain'}`
          : email ?? '(no address given)',
      });
      preview.rows.push({ label: 'Access', value: ROLE_LABELS[str(args.role) ?? ''] ?? str(args.role) ?? '' });
      if (!everyone) {
        preview.rows.push({ label: 'Notify', value: args.sendNotification === false ? 'No email is sent' : 'They get an email' });
      }
      if (everyone) {
        preview.note = 'Anyone who has the link can open this, signed in or not.';
        preview.destructive = true;
      } else if (args.role === 'owner') {
        preview.note = 'Ownership moves to this person. You cannot take it back yourself.';
        preview.destructive = true;
      } else if (isFolder) {
        preview.note = 'Sharing a folder shares everything inside it.';
      }
      return preview;
    }

    case 'drive_delete_file': {
      const permanent = args.permanent === true;
      preview.icon = '🗑';
      preview.heading = permanent ? `Delete ${thing} permanently` : `Move ${thing} to trash`;
      preview.note = permanent
        ? 'This skips the trash and cannot be undone.'
        : isFolder
        ? 'Everything inside the folder goes to the trash with it.'
        : 'It can be restored from the trash for 30 days.';
      preview.destructive = permanent;
      const owner = file?.owners?.[0];
      if (owner) preview.rows.push({ label: 'Owner', value: owner.displayName ?? owner.emailAddress ?? '' });
      if (file?.size) preview.rows.push({ label: 'Size', value: byteSize(Number(file.size)) });
      const modified = shortDate(file?.modifiedTime);
      if (modified) preview.rows.push({ label: 'Last changed', value: modified });
      if (file?.shared) preview.rows.push({ label: 'Shared', value: 'Yes — others lose access' });
      return preview;
    }

    default:
      return null;
  }
}

registerPreview(['drive_create_file', 'drive_update_file', 'drive_share_file', 'drive_delete_file'], buildDrivePreview);
