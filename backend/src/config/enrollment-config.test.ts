/**
 * Enrollment config (reins spec 2026-09-16 §2.2): the spec's defaults, and
 * the ENROLLMENT_SELF_ENROLL / ENROLLMENT_SELF_TRIAL_DAYS overrides.
 */

import { describe, it, expect, vi, afterEach } from 'vitest';

const ENV_KEYS = ['ENROLLMENT_SELF_ENROLL', 'ENROLLMENT_SELF_TRIAL_DAYS', 'NODE_ENV'] as const;
const saved = Object.fromEntries(ENV_KEYS.map((k) => [k, process.env[k]]));

async function load(env: Partial<Record<(typeof ENV_KEYS)[number], string>>) {
  vi.resetModules();
  for (const k of ENV_KEYS) delete process.env[k];
  process.env.NODE_ENV = 'test'; // no config/test.yaml: code defaults only
  Object.assign(process.env, env);
  process.env.REINS_ADMIN_PASSWORD ??= 'test-admin-pw';
  return (await import('./index.js')).config;
}

afterEach(() => {
  for (const k of ENV_KEYS) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
});

describe('config.enrollment', () => {
  it('defaults to self-enrollment on with a 15-day trial', async () => {
    const config = await load({});
    expect(config.enrollment).toEqual({ selfEnroll: true, selfTrialDays: 15 });
  });

  it('can be switched off by env', async () => {
    expect((await load({ ENROLLMENT_SELF_ENROLL: 'false' })).enrollment.selfEnroll).toBe(false);
    expect((await load({ ENROLLMENT_SELF_ENROLL: '0' })).enrollment.selfEnroll).toBe(false);
  });

  it('takes the trial length from env', async () => {
    expect((await load({ ENROLLMENT_SELF_TRIAL_DAYS: '30' })).enrollment.selfTrialDays).toBe(30);
  });
});

describe('parseBool', () => {
  it('reads true/false and 1/0, and leaves anything else unset', async () => {
    const { parseBool } = await import('./index.js');
    expect(parseBool('true')).toBe(true);
    expect(parseBool(' TRUE ')).toBe(true);
    expect(parseBool('1')).toBe(true);
    expect(parseBool('false')).toBe(false);
    expect(parseBool('0')).toBe(false);
    expect(parseBool('yes')).toBeUndefined();
    expect(parseBool(undefined)).toBeUndefined();
  });
});
