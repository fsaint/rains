import type { ServiceDefinitionWithTools } from '../common/types.js';
import { driveTools } from './tools.js';

export const definition: ServiceDefinitionWithTools = {
  type: 'drive',
  name: 'Google Drive',
  description: 'List, read, and search files',
  icon: 'HardDrive',
  category: 'google',
  toolPrefix: 'drive_',
  auth: {
    type: 'oauth2',
    required: true,
    credentialServiceIds: ['drive', 'google'],
    oauthScopes: [
      'https://www.googleapis.com/auth/drive.readonly',
    ],
  },
  tools: driveTools,
  permissions: {
    read: ['drive_list_files', 'drive_get_file', 'drive_read_file', 'drive_search'],
    write: ['drive_create_file', 'drive_update_file'],
    blocked: ['drive_share_file', 'drive_delete_file'],
  },
  permissionDescriptions: {
    read: 'List, read, and search files',
    full: 'Read files freely. Creating and updating files require your approval.',
  },
};
