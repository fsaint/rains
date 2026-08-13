import { describe, it, expect } from 'vitest';
import {
  MCP_SERVER_NAME,
  LEGACY_MCP_SERVER_NAME,
  BUILTIN_TOOLS,
  canonicalToolName,
  modelVisibleToolName,
  resolveToolTokens,
  resolveSkillTokens,
} from './mcp-naming.js';

describe('canonicalToolName', () => {
  it('maps pre-rename built-in names to their canonical form', () => {
    expect(canonicalToolName('reins_get_result')).toBe(BUILTIN_TOOLS.getResult);
    expect(canonicalToolName('reins__mark_onboarded')).toBe(BUILTIN_TOOLS.markOnboarded);
  });

  it('passes service tool names through untouched', () => {
    expect(canonicalToolName('gmail_search')).toBe('gmail_search');
    expect(canonicalToolName('unknown_tool')).toBe('unknown_tool');
  });
});

describe('modelVisibleToolName', () => {
  it('namespaces with the server name for OpenClaw', () => {
    expect(modelVisibleToolName('gmail_search', 'openclaw')).toBe('helm__gmail_search');
  });

  it('adds the mcp__ prefix for Hermes', () => {
    // hermes-agent tools/mcp_tool.py -> mcp_prefixed_tool_name
    expect(modelVisibleToolName('gmail_search', 'hermes')).toBe('mcp__helm__gmail_search');
  });

  it('defaults to the OpenClaw form', () => {
    expect(modelVisibleToolName('get_result')).toBe('helm__get_result');
  });

  it('honours the name an agent was actually deployed with', () => {
    // An agent deployed before the rename still namespaces with the old server
    // name, because its MCP_CONFIG is baked into the machine. Rendering the
    // current constant into text it reads would name a tool it does not have.
    expect(modelVisibleToolName('get_result', 'openclaw', LEGACY_MCP_SERVER_NAME))
      .toBe('reins__get_result');
    expect(modelVisibleToolName('get_result', 'hermes', LEGACY_MCP_SERVER_NAME))
      .toBe('mcp__reins__get_result');
  });

  it('keeps the server component identical across runtimes', () => {
    // Hermes sanitizes [^A-Za-z0-9_] to _, so a hyphenated server name would
    // diverge between runtimes. This guards that choice.
    expect(MCP_SERVER_NAME).toMatch(/^[A-Za-z0-9_]+$/);
  });
});

describe('resolveSkillTokens', () => {
  it('renders an actionable instruction naming the fetch tool per runtime', () => {
    expect(resolveSkillTokens('See {{skill:deep-research}} first.', 'openclaw'))
      .toBe('See the `deep-research` skill (open it with helm__skills_get) first.');
    expect(resolveSkillTokens('See {{skill:deep-research}} first.', 'hermes'))
      .toBe('See the `deep-research` skill (open it with mcp__helm__skills_get) first.');
  });

  it('honours the server name the agent was deployed with', () => {
    expect(resolveSkillTokens('{{skill:a-b}}', 'openclaw', LEGACY_MCP_SERVER_NAME))
      .toContain('reins__skills_get');
  });

  it('resolves every occurrence', () => {
    const out = resolveSkillTokens('{{skill:a}} and {{skill:b}}', 'openclaw');
    expect(out).toContain('`a`');
    expect(out).toContain('`b`');
  });

  it('leaves malformed tokens verbatim so authoring mistakes stay visible', () => {
    // Slugs are kebab-case (slugify in routes.ts), so underscores and capitals
    // are authoring errors, not alternate spellings.
    expect(resolveSkillTokens('{{skill:}}', 'openclaw')).toBe('{{skill:}}');
    expect(resolveSkillTokens('{{ skill:x }}', 'openclaw')).toBe('{{ skill:x }}');
    expect(resolveSkillTokens('{{skill:Has_Underscore}}', 'openclaw')).toBe('{{skill:Has_Underscore}}');
  });

  it('leaves tool tokens alone', () => {
    expect(resolveSkillTokens('{{tool:gmail_search}}', 'openclaw')).toBe('{{tool:gmail_search}}');
  });

  it('leaves text without tokens untouched', () => {
    expect(resolveSkillTokens('No tokens here.', 'hermes')).toBe('No tokens here.');
    expect(resolveSkillTokens('', 'hermes')).toBe('');
  });
});


describe('resolveToolTokens', () => {
  it('resolves a token per runtime', () => {
    expect(resolveToolTokens('Call {{tool:gmail_search}} now.', 'openclaw'))
      .toBe('Call helm__gmail_search now.');
    expect(resolveToolTokens('Call {{tool:gmail_search}} now.', 'hermes'))
      .toBe('Call mcp__helm__gmail_search now.');
  });

  it('resolves every occurrence', () => {
    expect(resolveToolTokens('{{tool:a}} then {{tool:b}} then {{tool:a}}', 'openclaw'))
      .toBe('helm__a then helm__b then helm__a');
  });

  it('resolves legacy tool names inside tokens to the canonical name', () => {
    expect(resolveToolTokens('{{tool:reins_get_result}}', 'openclaw')).toBe('helm__get_result');
  });

  it('leaves malformed tokens verbatim so authoring mistakes stay visible', () => {
    expect(resolveToolTokens('{{tool:}}', 'openclaw')).toBe('{{tool:}}');
    expect(resolveToolTokens('{{ tool:x }}', 'openclaw')).toBe('{{ tool:x }}');
    expect(resolveToolTokens('{{tool:has-hyphen}}', 'openclaw')).toBe('{{tool:has-hyphen}}');
  });

  it('renders tokens with the deployment\'s own server name', () => {
    expect(resolveToolTokens('Call {{tool:get_result}}.', 'openclaw', LEGACY_MCP_SERVER_NAME))
      .toBe('Call reins__get_result.');
  });

  it('leaves text without tokens untouched', () => {
    expect(resolveToolTokens('No tokens here.', 'hermes')).toBe('No tokens here.');
    expect(resolveToolTokens('', 'hermes')).toBe('');
  });
});
