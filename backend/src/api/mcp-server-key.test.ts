import { describe, it, expect } from 'vitest';
import { mcpServerKey } from './routes.js';

describe('mcpServerKey', () => {
  it('kebab-cases the agent name under a reins- prefix', () => {
    expect(mcpServerKey('Home Agent')).toBe('reins-home-agent');
  });

  it('never starts or ends the slug with a hyphen', () => {
    expect(mcpServerKey(' My Agent! ')).toBe('reins-my-agent');
    expect(mcpServerKey('---x---')).toBe('reins-x');
  });

  it('falls back when the name has no usable characters', () => {
    expect(mcpServerKey('!!!')).toBe('reins-agent');
    expect(mcpServerKey('')).toBe('reins-agent');
  });
});
