import type { ServiceDefinitionWithTools } from '../common/types.js';
import { outlookCalendarTools } from './tools.js';

export const definition: ServiceDefinitionWithTools = {
  type: 'outlook_calendar',
  name: 'Outlook Calendar',
  description: 'View, create, and manage calendar events via Microsoft Outlook',
  icon: 'Calendar',
  category: 'microsoft',
  toolPrefix: 'outlook_cal_',
  auth: {
    type: 'oauth2',
    required: true,
    credentialServiceIds: ['outlook_calendar', 'microsoft'],
    oauthScopes: [
      'https://graph.microsoft.com/Calendars.Read',
      'https://graph.microsoft.com/Calendars.ReadWrite',
    ],
  },
  tools: outlookCalendarTools,
  permissions: {
    read: [
      'outlook_cal_list_calendars',
      'outlook_cal_list_events',
      'outlook_cal_get_event',
      'outlook_cal_search_events',
      'outlook_cal_get_free_busy',
    ],
    write: [
      'outlook_cal_create_event',
      'outlook_cal_update_event',
      'outlook_cal_respond_to_event',
    ],
    blocked: [
      'outlook_cal_delete_event',
    ],
  },
  permissionDescriptions: {
    read: 'List calendars, view events, and check availability',
    full: 'Read events freely. Creating, updating, and responding to events require your approval.',
  },
};
