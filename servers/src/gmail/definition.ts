import type { ServiceDefinitionWithTools } from '../common/types.js';
import { gmailTools } from './tools.js';

export const definition: ServiceDefinitionWithTools = {
  type: 'gmail',
  name: 'Gmail',
  description: 'Read, search, and draft emails',
  icon: 'Mail',
  category: 'google',
  toolPrefix: 'gmail_',
  auth: {
    type: 'oauth2',
    required: true,
    credentialServiceIds: ['gmail', 'google'],
    oauthScopes: [
      'https://www.googleapis.com/auth/gmail.readonly',
      'https://www.googleapis.com/auth/gmail.compose',
    ],
  },
  tools: gmailTools,
  permissions: {
    read: ['gmail_list_accounts', 'gmail_list_messages', 'gmail_get_message', 'gmail_search', 'gmail_list_labels'],
    write: ['gmail_create_draft', 'gmail_send_draft'],
    blocked: ['gmail_send_message', 'gmail_delete_message'],
  },
  permissionDescriptions: {
    read: 'List, read, and search emails',
    full: 'Read emails freely. Creating drafts and sending require your approval.',
  },
};
