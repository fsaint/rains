import { describe, it, expect } from 'vitest';
import { AuditFilterSchema } from './index.js';

describe('AuditFilterSchema.agentId', () => {
  // Agent ids are nanoids, not UUIDs. A uuid() check here turned every
  // GET /api/audit?agentId=<real id> into a 500.
  it('accepts a nanoid agent id', () => {
    const parsed = AuditFilterSchema.parse({ agentId: 'V1StGXR8_Z5jdHi6B-myT' });
    expect(parsed.agentId).toBe('V1StGXR8_Z5jdHi6B-myT');
  });

  it('accepts a uuid too, since older rows may carry one', () => {
    const id = '11111111-1111-4111-8111-111111111111';
    expect(AuditFilterSchema.parse({ agentId: id }).agentId).toBe(id);
  });

  it('rejects an empty agent id', () => {
    expect(AuditFilterSchema.safeParse({ agentId: '' }).success).toBe(false);
  });

  it('stays optional', () => {
    expect(AuditFilterSchema.parse({}).agentId).toBeUndefined();
  });
});
