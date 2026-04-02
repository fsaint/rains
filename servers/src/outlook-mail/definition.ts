import type { ServiceDefinitionWithTools } from '../common/types.js';
import { outlookMailTools } from './tools.js';

export const definition: ServiceDefinitionWithTools = {
  type: 'outlook_mail',
  name: 'Outlook Mail',
  description: 'Read, search, and draft emails via Microsoft Outlook',
  icon: 'Mail',
  category: 'microsoft',
  toolPrefix: 'outlook_mail_',
  auth: {
    type: 'oauth2',
    required: true,
    credentialServiceIds: ['outlook_mail', 'microsoft'],
    oauthScopes: [
      'https://graph.microsoft.com/Mail.Read',
      'https://graph.microsoft.com/Mail.ReadWrite',
      'https://graph.microsoft.com/Mail.Send',
    ],
  },
  tools: outlookMailTools,
  permissions: {
    read: [
      'outlook_mail_get_profile',
      'outlook_mail_list_messages',
      'outlook_mail_get_message',
      'outlook_mail_search',
      'outlook_mail_list_folders',
    ],
    write: [
      'outlook_mail_create_draft',
      'outlook_mail_send_draft',
      'outlook_mail_reply',
      'outlook_mail_move_message',
    ],
    blocked: [
      'outlook_mail_send_message',
      'outlook_mail_delete_message',
    ],
  },
  permissionDescriptions: {
    read: 'List, read, and search emails',
    full: 'Read emails freely. Creating drafts, replying, and sending require your approval.',
  },
};
