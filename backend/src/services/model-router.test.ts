import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

vi.mock('../db/index.js', () => ({
  client: { execute: vi.fn() },
}));
vi.mock('nanoid', () => ({ nanoid: () => 'test-id' }));

process.env.REINS_ENCRYPTION_KEY = 'a'.repeat(64); // fixed 32-byte hex for tests

import { client } from '../db/index.js';
import {
  listModelConfigs,
  upsertModelConfig,
  deleteModelConfig,
  getLiteLLMConfigB64,
  encryptKey,
  decryptKey,
} from './model-router.js';

const EMPTY_RESULT = { rows: [], rowsAffected: 0, lastInsertRowid: 0n, columns: [] };
const ONE_ROW_RESULT = { rows: [{ id: 'x' }], rowsAffected: 1, lastInsertRowid: 0n, columns: [] };

afterEach(() => { vi.clearAllMocks(); });

describe('encryptKey / decryptKey round-trip', () => {
  it('encrypts and decrypts back to original plaintext', () => {
    const encrypted = encryptKey('sk-super-secret-key');
    expect(encrypted).not.toBe('sk-super-secret-key');
    expect(decryptKey(encrypted)).toBe('sk-super-secret-key');
  });

  it('produces different ciphertext each call (random IV)', () => {
    const a = encryptKey('same');
    const b = encryptKey('same');
    expect(a).not.toBe(b);
    expect(decryptKey(a)).toBe('same');
    expect(decryptKey(b)).toBe('same');
  });
});

describe('listModelConfigs', () => {
  beforeEach(() => { vi.clearAllMocks(); });

  it('returns empty array when no configs exist', async () => {
    vi.mocked(client.execute).mockResolvedValueOnce(EMPTY_RESULT);
    expect(await listModelConfigs('agent-1')).toEqual([]);
  });

  it('masks api key in returned config', async () => {
    const encVal = encryptKey('sk-ant-abcdefghijklmn');
    vi.mocked(client.execute).mockResolvedValueOnce({
      rows: [{
        id: 'cfg-1', agent_id: 'a1', provider: 'anthropic',
        model_name: 'claude-opus-4-7', role: 'strong',
        api_key_encrypted: encVal, created_at: '2026-01-01',
      }],
      rowsAffected: 0, lastInsertRowid: 0n, columns: [],
    });
    const result = await listModelConfigs('a1');
    expect(result[0].apiKeyMasked).toMatch(/^sk-a\.\.\.lmn$/);
    expect(result[0].provider).toBe('anthropic');
    expect(result[0].role).toBe('strong');
    expect(result[0].modelName).toBe('claude-opus-4-7');
  });
});

describe('upsertModelConfig', () => {
  beforeEach(() => { vi.clearAllMocks(); });

  it('INSERTs when no config exists for that role', async () => {
    vi.mocked(client.execute)
      .mockResolvedValueOnce(EMPTY_RESULT)  // SELECT check
      .mockResolvedValueOnce(ONE_ROW_RESULT); // INSERT
    await upsertModelConfig({ agentId: 'a1', provider: 'openai', modelName: 'gpt-4o', role: 'strong', apiKey: 'sk-oai' });
    const insertCall = vi.mocked(client.execute).mock.calls[1][0] as { sql: string; args: unknown[] };
    expect(insertCall.sql).toContain('INSERT INTO agent_model_configs');
    expect(insertCall.args[2]).toBe('openai');
    expect(insertCall.args[3]).toBe('gpt-4o');
    expect(insertCall.args[4]).toBe('strong');
    expect(decryptKey(insertCall.args[5] as string)).toBe('sk-oai');
  });

  it('UPDATEs when a config for that role already exists', async () => {
    vi.mocked(client.execute)
      .mockResolvedValueOnce(ONE_ROW_RESULT) // SELECT finds existing
      .mockResolvedValueOnce(ONE_ROW_RESULT); // UPDATE
    await upsertModelConfig({ agentId: 'a1', provider: 'anthropic', modelName: 'claude-sonnet-4-6', role: 'strong', apiKey: 'sk-new' });
    const updateCall = vi.mocked(client.execute).mock.calls[1][0] as { sql: string };
    expect(updateCall.sql).toContain('UPDATE agent_model_configs');
  });
});

describe('deleteModelConfig', () => {
  it('deletes by id and agentId', async () => {
    vi.mocked(client.execute).mockResolvedValueOnce(ONE_ROW_RESULT);
    await deleteModelConfig('cfg-1', 'a1');
    const call = vi.mocked(client.execute).mock.calls[0][0] as { sql: string; args: unknown[] };
    expect(call.sql).toContain('DELETE FROM agent_model_configs');
    expect(call.args).toEqual(['cfg-1', 'a1']);
  });
});

describe('getLiteLLMConfigB64', () => {
  beforeEach(() => { vi.clearAllMocks(); });

  it('returns null when agent has no configs', async () => {
    vi.mocked(client.execute).mockResolvedValueOnce(EMPTY_RESULT);
    expect(await getLiteLLMConfigB64('a1')).toBeNull();
  });

  it('returns null for empty agentId', async () => {
    expect(await getLiteLLMConfigB64('')).toBeNull();
  });

  it('generates model_list with strong and weak entries for two models', async () => {
    vi.mocked(client.execute).mockResolvedValueOnce({
      rows: [
        { provider: 'anthropic', model_name: 'claude-opus-4-7', role: 'strong', api_key_encrypted: encryptKey('sk-ant') },
        { provider: 'openai',    model_name: 'gpt-4o',          role: 'weak',   api_key_encrypted: encryptKey('sk-oai') },
      ],
      rowsAffected: 0, lastInsertRowid: 0n, columns: [],
    });
    const b64 = await getLiteLLMConfigB64('a1');
    expect(b64).not.toBeNull();
    const config = JSON.parse(Buffer.from(b64!, 'base64').toString());
    expect(config.model_list).toHaveLength(2);
    const strong = config.model_list.find((m: { model_name: string }) => m.model_name === 'strong');
    const weak   = config.model_list.find((m: { model_name: string }) => m.model_name === 'weak');
    expect(strong.litellm_params.model).toBe('anthropic/claude-opus-4-7');
    expect(strong.litellm_params.api_key).toBe('sk-ant');
    expect(weak.litellm_params.model).toBe('openai/gpt-4o');
    expect(weak.litellm_params.api_key).toBe('sk-oai');
  });

  it('aliases single model as both strong and weak', async () => {
    vi.mocked(client.execute).mockResolvedValueOnce({
      rows: [{ provider: 'anthropic', model_name: 'claude-sonnet-4-6', role: 'strong', api_key_encrypted: encryptKey('sk-ant') }],
      rowsAffected: 0, lastInsertRowid: 0n, columns: [],
    });
    const b64 = await getLiteLLMConfigB64('a1');
    const config = JSON.parse(Buffer.from(b64!, 'base64').toString());
    expect(config.model_list).toHaveLength(2);
    const names = config.model_list.map((m: { model_name: string }) => m.model_name);
    expect(names).toContain('strong');
    expect(names).toContain('weak');
  });

  it('adds api_base for minimax provider', async () => {
    vi.mocked(client.execute).mockResolvedValueOnce({
      rows: [{ provider: 'minimax', model_name: 'MiniMax-M2.7', role: 'strong', api_key_encrypted: encryptKey('mm-key') }],
      rowsAffected: 0, lastInsertRowid: 0n, columns: [],
    });
    const b64 = await getLiteLLMConfigB64('a1');
    const config = JSON.parse(Buffer.from(b64!, 'base64').toString());
    const strong = config.model_list.find((m: { model_name: string }) => m.model_name === 'strong');
    expect(strong.litellm_params.api_base).toBe('https://api.minimax.io/v1');
    expect(strong.litellm_params.model).toBe('openai/MiniMax-M2.7');
  });

  it('uses gemini/ prefix for google provider', async () => {
    vi.mocked(client.execute).mockResolvedValueOnce({
      rows: [{ provider: 'google', model_name: 'gemini-2.5-flash', role: 'weak', api_key_encrypted: encryptKey('gai-key') }],
      rowsAffected: 0, lastInsertRowid: 0n, columns: [],
    });
    const b64 = await getLiteLLMConfigB64('a1');
    const config = JSON.parse(Buffer.from(b64!, 'base64').toString());
    const weak = config.model_list.find((m: { model_name: string }) => m.model_name === 'weak');
    expect(weak.litellm_params.model).toBe('gemini/gemini-2.5-flash');
  });
});
