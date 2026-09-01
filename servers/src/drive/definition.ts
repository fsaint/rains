import type { ServiceDefinitionWithTools } from '../common/types.js';
import { driveTools } from './tools.js';

export const definition: ServiceDefinitionWithTools = {
  type: 'drive',
  name: 'Google Drive',
  description: 'List, read, search, create, and update files',
  icon: 'HardDrive',
  category: 'google',
  toolPrefix: 'drive_',
  auth: {
    type: 'oauth2',
    required: true,
    credentialServiceIds: ['drive', 'google'],
    oauthScopes: [
      // Full drive, not drive.file: drive_update_file targets arbitrary file
      // ids and drive_create_file arbitrary parent folders — under drive.file
      // Google hides every file the app did not create, so those 404 with no
      // hint that scope is the problem. Same "restricted" verification tier
      // as drive.readonly. Writes still require approval by default.
      'https://www.googleapis.com/auth/drive',
    ],
  },
  tools: driveTools,
  permissions: {
    read: ['drive_list_files', 'drive_get_file', 'drive_read_file', 'drive_search', 'drive_list_shared_drives'],
    write: ['drive_create_file', 'drive_update_file'],
    blocked: ['drive_share_file', 'drive_delete_file'],
  },
  permissionDescriptions: {
    read: 'List, read, and search files',
    full: 'Read files freely. Creating and updating files require your approval.',
  },
};
