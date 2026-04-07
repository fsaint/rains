/**
 * Service Registry
 *
 * Thin aggregator — each server defines its own metadata in `definition.ts`.
 * To add a new service, create its definition and add one import here.
 */

import type { ServiceDefinitionWithTools } from './common/types.js';

import { definition as gmail } from './gmail/definition.js';
import { definition as drive } from './drive/definition.js';
import { definition as calendar } from './calendar/definition.js';
import { definition as webSearch } from './web-search/definition.js';
import { definition as browser } from './browser/definition.js';
import { definition as github } from './github/definition.js';
import { definition as linear } from './linear/definition.js';
import { definition as outlookMail } from './outlook-mail/definition.js';
import { definition as outlookCalendar } from './outlook-calendar/definition.js';
import { definition as notion } from './notion/definition.js';
import { definition as hermeneutix } from './hermeneutix/definition.js';
import { definition as zendesk } from './zendesk/definition.js';

// Re-export the type from its canonical location
export type { ServiceDefinitionWithTools } from './common/types.js';

export const serviceDefinitions: ServiceDefinitionWithTools[] = [
  gmail,
  drive,
  calendar,
  webSearch,
  browser,
  github,
  linear,
  outlookMail,
  outlookCalendar,
  notion,
  hermeneutix,
  zendesk,
];

/** Lookup map by service type */
export const serviceRegistry = new Map<string, ServiceDefinitionWithTools>(
  serviceDefinitions.map((def) => [def.type, def])
);

/** Resolve a tool name to its service type via prefix matching */
export function getServiceTypeFromToolName(toolName: string): string | null {
  for (const def of serviceDefinitions) {
    if (toolName.startsWith(def.toolPrefix)) return def.type;
  }
  return null;
}

/** Build default permission map for a service (read→allow, write→require_approval, blocked→block) */
export function getDefaultPermissions(serviceType: string): Record<string, 'allow' | 'require_approval' | 'block'> {
  const def = serviceRegistry.get(serviceType);
  if (!def) return {};
  const result: Record<string, 'allow' | 'require_approval' | 'block'> = {};
  for (const tool of def.permissions.read) result[tool] = 'allow';
  for (const tool of def.permissions.write) result[tool] = 'require_approval';
  for (const tool of def.permissions.blocked) result[tool] = 'block';
  return result;
}
