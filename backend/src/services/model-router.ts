import { createCipheriv, createDecipheriv, randomBytes } from 'crypto';
import { nanoid } from 'nanoid';
import { client } from '../db/index.js';

export type Provider = 'anthropic' | 'openai' | 'minimax' | 'google';
export type ModelRole = 'strong' | 'weak';

export interface ModelConfig {
  id: string;
  agentId: string;
  provider: Provider;
  modelName: string;
  role: ModelRole;
  apiKeyMasked: string;
  createdAt: string;
}

const PROVIDER_PREFIX: Record<Provider, string> = {
  anthropic: 'anthropic',
  openai: 'openai',
  minimax: 'openai',
  google: 'gemini',
};

const PROVIDER_BASE_URL: Partial<Record<Provider, string>> = {
  minimax: 'https://api.minimax.io/v1',
};

export function encryptKey(plaintext: string): string {
  const key = Buffer.from(process.env.REINS_ENCRYPTION_KEY!, 'hex');
  const iv = randomBytes(16);
  const cipher = createCipheriv('aes-256-gcm', key, iv);
  const encrypted = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return `${iv.toString('hex')}:${encrypted.toString('hex')}:${tag.toString('hex')}`;
}

export function decryptKey(ciphertext: string): string {
  const [ivHex, encHex, tagHex] = ciphertext.split(':');
  const key = Buffer.from(process.env.REINS_ENCRYPTION_KEY!, 'hex');
  const decipher = createDecipheriv('aes-256-gcm', key, Buffer.from(ivHex, 'hex'));
  decipher.setAuthTag(Buffer.from(tagHex, 'hex'));
  return decipher.update(Buffer.from(encHex, 'hex')).toString() + decipher.final('utf8');
}

function maskKey(key: string): string {
  if (key.length <= 8) return '***';
  return `${key.slice(0, 4)}...${key.slice(-3)}`;
}

export async function listModelConfigs(agentId: string): Promise<ModelConfig[]> {
  const rows = await client.execute({
    sql: 'SELECT * FROM agent_model_configs WHERE agent_id = ? ORDER BY role',
    args: [agentId],
  });
  return rows.rows.map((r) => ({
    id: r.id as string,
    agentId: r.agent_id as string,
    provider: r.provider as Provider,
    modelName: r.model_name as string,
    role: r.role as ModelRole,
    apiKeyMasked: maskKey(decryptKey(r.api_key_encrypted as string)),
    createdAt: r.created_at as string,
  }));
}

export async function upsertModelConfig(data: {
  agentId: string;
  provider: Provider;
  modelName: string;
  role: ModelRole;
  apiKey: string;
}): Promise<void> {
  const existing = await client.execute({
    sql: 'SELECT id FROM agent_model_configs WHERE agent_id = ? AND role = ?',
    args: [data.agentId, data.role],
  });
  if (existing.rows.length > 0) {
    await client.execute({
      sql: `UPDATE agent_model_configs
            SET provider = ?, model_name = ?, api_key_encrypted = ?, updated_at = datetime('now')
            WHERE agent_id = ? AND role = ?`,
      args: [data.provider, data.modelName, encryptKey(data.apiKey), data.agentId, data.role],
    });
  } else {
    await client.execute({
      sql: `INSERT INTO agent_model_configs (id, agent_id, provider, model_name, role, api_key_encrypted)
            VALUES (?, ?, ?, ?, ?, ?)`,
      args: [nanoid(), data.agentId, data.provider, data.modelName, data.role, encryptKey(data.apiKey)],
    });
  }
}

export async function deleteModelConfig(id: string, agentId: string): Promise<void> {
  await client.execute({
    sql: 'DELETE FROM agent_model_configs WHERE id = ? AND agent_id = ?',
    args: [id, agentId],
  });
}

interface RawConfigRow {
  provider: Provider;
  model_name: string;
  role: ModelRole;
  api_key_encrypted: string;
}

export async function getLiteLLMConfigB64(agentId: string): Promise<string | null> {
  if (!agentId) return null;
  const rows = await client.execute({
    sql: 'SELECT * FROM agent_model_configs WHERE agent_id = ?',
    args: [agentId],
  });
  if (rows.rows.length === 0) return null;

  const configs = rows.rows as unknown as RawConfigRow[];
  const modelList = configs.map((c) => ({
    model_name: c.role,
    litellm_params: {
      model: `${PROVIDER_PREFIX[c.provider]}/${c.model_name}`,
      api_key: decryptKey(c.api_key_encrypted),
      ...(PROVIDER_BASE_URL[c.provider] ? { api_base: PROVIDER_BASE_URL[c.provider] } : {}),
    },
  }));

  if (configs.length === 1) {
    const other = configs[0].role === 'strong' ? 'weak' : 'strong';
    modelList.push({ ...modelList[0], model_name: other });
  }

  return Buffer.from(JSON.stringify({ model_list: modelList })).toString('base64');
}
