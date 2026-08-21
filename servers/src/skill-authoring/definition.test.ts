/**
 * Definition invariants for skill-authoring.
 *
 * These assert against the real definition rather than a mirror of it, because
 * the properties below are the privilege boundary itself: getDefaultPermsFromDef
 * in the backend derives every agent's permissions from this object at read
 * time, so a tool in the wrong bucket here silently changes what an architect
 * can do without approval.
 */

import { describe, it, expect } from 'vitest';
import { definition } from './definition.js';
import { skillAuthoringTools } from './tools.js';

describe('skill-authoring definition', () => {
  it('classifies every tool exactly once', () => {
    const { read, write, blocked } = definition.permissions;
    const classified = [...read, ...write, ...blocked];

    expect(new Set(classified).size).toBe(classified.length);
    expect(new Set(classified)).toEqual(new Set(skillAuthoringTools.map((t) => t.name)));
  });

  it('leaves defaultWritePermission unset, so every write stays behind an approval', () => {
    // A skill body is an instruction another agent follows. Setting this to
    // 'allow' (as memory does) would remove that gate for all five writes at
    // once, and nothing else in the system would notice.
    expect(definition.permissions.defaultWritePermission).toBeUndefined();
  });

  it('treats delete as a write, not a read', () => {
    expect(definition.permissions.write).toContain('skill_authoring_delete');
    expect(definition.permissions.read).not.toContain('skill_authoring_delete');
  });

  it('exposes scope on exactly the tools that can write a platform skill', () => {
    const withScope = skillAuthoringTools
      .filter((t) => 'scope' in ((t.inputSchema as { properties?: Record<string, unknown> }).properties ?? {}))
      .map((t) => t.name)
      .sort();

    // Assign and unassign are deliberately absent: attaching a skill to your own
    // agent changes nothing outside the owner's account, so a scope argument
    // there would imply a privilege that does not exist.
    expect(withScope).toEqual([
      'skill_authoring_create',
      'skill_authoring_delete',
      'skill_authoring_update',
    ]);
  });

  it('never advertises a tool prefix that collides with the read-only skills server', () => {
    // getServiceTypeFromToolName resolves by first match over the definitions
    // array, so a prefix that is a prefix of another routes calls to the wrong
    // service.
    expect('skills_'.startsWith(definition.toolPrefix)).toBe(false);
    expect(definition.toolPrefix.startsWith('skills_')).toBe(false);
  });
});
