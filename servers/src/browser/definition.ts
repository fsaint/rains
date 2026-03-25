import type { ServiceDefinitionWithTools } from '../common/types.js';
import { browserTools } from './tools.js';

export const definition: ServiceDefinitionWithTools = {
  type: 'browser',
  name: 'Browser',
  description: 'Headless browser automation via Playwright',
  icon: 'Globe',
  category: 'browser',
  toolPrefix: 'browser_',
  auth: {
    type: 'none',
    required: false,
  },
  tools: browserTools,
  permissions: {
    read: ['browser_navigate', 'browser_screenshot', 'browser_get_content', 'browser_close'],
    write: ['browser_click', 'browser_type'],
    blocked: ['browser_evaluate'],
  },
  permissionDescriptions: {
    read: 'Navigate pages and take screenshots',
    full: 'Navigate freely. Clicking and typing require your approval.',
  },
};
