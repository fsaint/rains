/**
 * Registry coverage tests
 *
 * Every tool exported by a service must be classified in def.permissions.read,
 * write, or blocked. If this test fails, add the missing tool to the appropriate
 * list in servers/src/<service>/definition.ts.
 */

import { describe, it, expect } from 'vitest';
import { serviceDefinitions } from './registry.js';

describe('service registry — tool permission coverage', () => {
  for (const def of serviceDefinitions) {
    it(`${def.type}: every tool is classified in def.permissions`, () => {
      const classified = new Set([
        ...def.permissions.read,
        ...def.permissions.write,
        ...def.permissions.blocked,
      ]);

      const unclassified = def.tools
        .map((t) => t.name)
        .filter((name) => !classified.has(name));

      expect(
        unclassified,
        `Service "${def.type}" has tools not listed in def.permissions.read|write|blocked: ${unclassified.join(', ')}. ` +
          `Add them to servers/src/${def.type}/definition.ts.`
      ).toHaveLength(0);
    });
  }
});
