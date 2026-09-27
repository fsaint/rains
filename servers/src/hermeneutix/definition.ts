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
    keyUrl: 'https://hermeneutix.btv.pw/api/mobile/login/',
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
      'hermeneutix_list_roles',
      'hermeneutix_get_role',
    ],
    // Writes land on a real person's record, so they keep the default
    // require_approval rather than setting defaultWritePermission: 'allow'.
    write: [
      'hermeneutix_set_role',
      'hermeneutix_remove_from_project',
      'hermeneutix_update_profile',
      'hermeneutix_set_coaching_notes',
    ],
    blocked: [],
  },
  permissionDescriptions: {
    read: 'Read projects, meetings, transcripts, speaker profiles, and who holds which role.',
    full:
      'Read all meeting data, and record what people are responsible for: set roles, correct ' +
      "profiles and coaching notes, remove someone from a project. Every change to a person's " +
      'record asks you to approve it first.',
  },
};
