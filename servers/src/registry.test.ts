/**
 * Registry coverage tests
 *
 * Every tool exported by a service must be classified in def.permissions.read,
 * write, or blocked. If this test fails, add the missing tool to the appropriate
 * list in servers/src/<service>/definition.ts.
 */

import { describe, it, expect } from 'vitest';
import { serviceDefinitions, getDefaultPermissions, getServiceTypeFromToolName } from './registry.js';

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

/**
 * Google scopes must cover the API methods the handlers actually call.
 * Each of these has failed in production as a runtime 403 that no dashboard
 * status reflected — the credential looked "connected" while every call died.
 */
describe('service registry — Google scopes cover the handlers', () => {
  const byType = new Map(serviceDefinitions.map((d) => [d.type, d]));

  it('calendar can list calendars and read a calendar time zone', () => {
    // calendarList.list (calendar_list_calendars) and calendars.get (the
    // recurring-event zone fallback) are not covered by calendar.events.
    expect(byType.get('calendar')!.auth.oauthScopes).toEqual(
      expect.arrayContaining([
        'https://www.googleapis.com/auth/calendar.events',
        'https://www.googleapis.com/auth/calendar.readonly',
      ])
    );
  });

  it('drive can write arbitrary files, as drive_update_file promises', () => {
    expect(byType.get('drive')!.auth.oauthScopes).toContain('https://www.googleapis.com/auth/drive');
  });

  it('every google service with write tools holds a non-readonly scope', () => {
    for (const def of serviceDefinitions) {
      if (def.category !== 'google' || def.permissions.write.length === 0) continue;
      const scopes = def.auth.oauthScopes ?? [];
      expect(
        scopes.some((s) => !s.endsWith('.readonly')),
        `"${def.type}" exposes write tools (${def.permissions.write.join(', ')}) but requests only readonly scopes`
      ).toBe(true);
    }
  });
});

describe('service registry — threads', () => {
  it('threads alwaysApprove tools default to require_approval and other writes to allow', () => {
    const p = getDefaultPermissions('threads');
    expect(p.thread_propose).toBe('require_approval');
    expect(p.thread_close).toBe('require_approval');
    expect(p.thread_add_watcher).toBe('require_approval');
    expect(p.thread_log_event).toBe('allow');
    expect(p.thread_get_brief).toBe('allow');
  });

  it('every alwaysApprove tool is a write tool of the service', () => {
    for (const def of serviceDefinitions) {
      for (const tool of def.permissions.alwaysApprove ?? []) {
        expect(def.permissions.write, `${def.type}.${tool}`).toContain(tool);
      }
    }
  });

  it('thread_ prefix does not collide with any other service prefix', () => {
    const others = serviceDefinitions.filter((d) => d.type !== 'threads');
    for (const d of others) {
      expect(d.toolPrefix.startsWith('thread_')).toBe(false);
      expect('thread_'.startsWith(d.toolPrefix)).toBe(false);
    }
    expect(getServiceTypeFromToolName('thread_propose')).toBe('threads');
  });
});
