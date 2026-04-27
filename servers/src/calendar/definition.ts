import type { ServiceDefinitionWithTools } from '../common/types.js';
import { calendarTools } from './tools.js';

export const definition: ServiceDefinitionWithTools = {
  type: 'calendar',
  name: 'Google Calendar',
  description: 'View and manage calendar events',
  icon: 'Calendar',
  category: 'google',
  toolPrefix: 'calendar_',
  auth: {
    type: 'oauth2',
    required: true,
    credentialServiceIds: ['calendar', 'google'],
    oauthScopes: [
      'https://www.googleapis.com/auth/calendar.events',
    ],
  },
  tools: calendarTools,
  permissions: {
    read: ['calendar_list_events', 'calendar_get_event', 'calendar_search_events', 'calendar_list_calendars'],
    write: ['calendar_create_event', 'calendar_update_event'],
    blocked: ['calendar_delete_event'],
  },
  permissionDescriptions: {
    read: 'List, view, and search events',
    full: 'View events freely. Creating and updating events require your approval.',
  },
};
