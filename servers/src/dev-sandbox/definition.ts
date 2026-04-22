import type { ServiceDefinitionWithTools } from '../common/types.js';
import { devSandboxTools } from './tools.js';

export const definition: ServiceDefinitionWithTools = {
  type: 'dev-sandbox',
  name: 'Dev Sandbox',
  description: 'Fake tools for end-to-end approval flow testing. No real API — accepts any token. Development only.',
  icon: 'FlaskConical',
  category: 'dev-tools',
  toolPrefix: 'sandbox_',
  auth: {
    type: 'api_key',
    required: false,
    instructions: 'Any value works — this is a fake service for development testing.',
  },
  tools: devSandboxTools,
  permissions: {
    // Always allowed — no approval needed
    read: [
      'sandbox_echo',
      'sandbox_list_items',
      'sandbox_get_item',
    ],
    // Require user approval before executing
    write: [
      'sandbox_create_item',
      'sandbox_send_message',
      'sandbox_update_item',
    ],
    // Blocked by default policy — always denied
    blocked: [
      'sandbox_delete_item',
      'sandbox_wipe_all',
    ],
  },
  permissionDescriptions: {
    read: 'Echo, list, and get sandbox items — always allowed, no approval needed.',
    full: 'Read freely. Creating items, sending messages, and updating require your approval. Deleting is always blocked.',
  },
};
