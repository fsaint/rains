import { describe, it, expect } from 'vitest';
import {
  BUILTIN_TOOLS,
  MCP_SERVER_NAME,
  canonicalToolName,
  modelVisibleToolName,
  resolveSkillTokens,
  resolveToolTokens,
} from './mcp-naming.js';

describe('canonicalToolName', () => {
  it('maps the pre-rename get_result name to its canonical form', () => {
    expect(canonicalToolName('reins_get_result')).toBe(BUILTIN_TOOLS.getResult);
  });

  it('passes service tool names through untouched', () => {
    expect(canonicalToolName('gmail_search')).toBe('gmail_search');
  });

  it('no longer knows mark_onboarded', () => {
    expect(canonicalToolName('reins__mark_onboarded')).toBe('reins__mark_onboarded');
    expect('markOnboarded' in BUILTIN_TOOLS).toBe(false);
  });
});

describe('modelVisibleToolName', () => {
  it('renders the bare tool name — the client adds its own prefix', () => {
    expect(modelVisibleToolName('gmail_search')).toBe('gmail_search');
  });

  it('keeps the server name free of hyphens for clients that sanitize it', () => {
    expect(MCP_SERVER_NAME).not.toContain('-');
  });
});

describe('resolveToolTokens', () => {
  it('resolves every occurrence bare', () => {
    expect(resolveToolTokens('run {{tool:gmail_search}} then {{tool:drive_search}}'))
      .toBe('run gmail_search then drive_search');
  });

  it('resolves legacy tool names inside tokens to the canonical name', () => {
    expect(resolveToolTokens('{{tool:reins_get_result}}')).toBe(BUILTIN_TOOLS.getResult);
  });

  it('leaves malformed tokens verbatim so authoring mistakes stay visible', () => {
    expect(resolveToolTokens('{{tool:}} and {{ tool:x }}')).toBe('{{tool:}} and {{ tool:x }}');
  });

  it('leaves text without tokens untouched', () => {
    expect(resolveToolTokens('plain')).toBe('plain');
    expect(resolveToolTokens('')).toBe('');
  });
});

describe('resolveSkillTokens', () => {
  it('renders an actionable instruction naming the bare fetch tool', () => {
    expect(resolveSkillTokens('see {{skill:deep-research}}'))
      .toBe('see the `deep-research` skill (open it with skills_get)');
  });

  it('resolves every occurrence', () => {
    const out = resolveSkillTokens('{{skill:a}} {{skill:b}}');
    expect(out).toContain('`a` skill');
    expect(out).toContain('`b` skill');
  });

  it('leaves malformed tokens verbatim', () => {
    expect(resolveSkillTokens('{{skill:Not Kebab}}')).toBe('{{skill:Not Kebab}}');
  });

  it('leaves tool tokens alone', () => {
    expect(resolveSkillTokens('{{tool:gmail_search}}')).toBe('{{tool:gmail_search}}');
  });
});
