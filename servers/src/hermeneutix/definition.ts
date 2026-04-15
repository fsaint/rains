/**
 * Hermeneutix Service Definition
 */

import type { ServiceDefinitionWithTools } from '../common/types.js';
import { hermeneutixTools } from './tools.js';

export const definition: ServiceDefinitionWithTools = {
  type: 'hermeneutix',
  name: 'Hermeneutix',
  description: 'Meeting transcription platform — browse projects, meetings, transcripts, and speaker profiles.',
  icon: 'Mic',
  category: 'productivity',
  toolPrefix: 'hermeneutix_',
  auth: {
    type: 'api_key',
    required: true,
    instructions: 'Log in to your Hermeneutix instance and generate an API token from your account settings.',
    keyUrl: 'https://studio.curl-newton.ts.net/api/mobile/login/',
  },
  tools: hermeneutixTools,
  permissions: {
    read: [
      'hermeneutix_list_projects',
      'hermeneutix_list_meetings',
      'hermeneutix_list_meeting_instances',
      'hermeneutix_get_meeting_instance',
      'hermeneutix_list_sessions',
      'hermeneutix_list_speakers',
      'hermeneutix_get_conversation_preview',
      'hermeneutix_search_profiles',
      'hermeneutix_search_instances',
    ],
    write: [],
    blocked: [],
  },
  permissionDescriptions: {
    read: 'Read-only access to projects, meetings, transcriptions, and speaker profiles.',
    full: 'Read-only access to all meeting data. No write operations are available.',
  },
};
