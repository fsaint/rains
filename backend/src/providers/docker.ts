/**
 * Local Docker provider for development.
 * Runs OpenClaw or Hermes agents as local Docker containers.
 */

import { execFileSync } from 'child_process';

const OPENCLAW_IMAGE = process.env.OPENCLAW_IMAGE || 'reins-openclaw:latest';
const HERMES_IMAGE = process.env.HERMES_IMAGE || 'reins-hermes:latest';

function docker(...args: string[]): string {
  return execFileSync('docker', args, {
    encoding: 'utf8',
    timeout: 60_000,
  }).trim();
}

export async function createLocalContainer(opts: {
  instanceId: string;
  telegramToken: string;
  telegramUserId?: string;
  mcpConfigs: object[];
  gatewayToken: string;
  soulMd?: string;
  modelProvider?: string;
  modelName?: string;
  openaiApiKey?: string;
  telegramGroups?: Array<{ chatId: string; name?: string; requireMention?: boolean; allowFrom?: string[]; topicPrompts?: Array<{ threadId: number; prompt: string }> }>;
  modelCredentials?: string;
  thinkingDefault?: string;
  runtime?: string;
}): Promise<{ containerId: string; containerName: string; port: number }> {
  const isHermes = opts.runtime === 'hermes';
  const containerName = `reins-${opts.instanceId.slice(0, 12)}`;

  // Remove existing container with same name
  try {
    docker('rm', '-f', containerName);
  } catch {
    // ignore
  }

  const reinsUrl = process.env.REINS_PUBLIC_URL || process.env.REINS_DASHBOARD_URL || 'http://host.docker.internal:5001';

  let env: Record<string, string>;
  let internalPort: number;
  let image: string;

  if (isHermes) {
    internalPort = 8000;
    image = HERMES_IMAGE;
    env = {
      TELEGRAM_BOT_TOKEN: opts.telegramToken,
      MCP_CONFIG: JSON.stringify(opts.mcpConfigs),
      HERMES_GATEWAY_TOKEN: opts.gatewayToken,
      USAGE_CALLBACK_URL: `${reinsUrl}/api/webhooks/usage`,
      INSTANCE_USER_ID: opts.instanceId,
      REINS_API_URL: reinsUrl,
    };
    if (opts.telegramUserId) env.TELEGRAM_ALLOWED_USERS = opts.telegramUserId;
    if (opts.soulMd) env.HERMES_PERSONA = opts.soulMd;
    if (opts.modelProvider) env.MODEL_PROVIDER = opts.modelProvider;
    if (opts.modelName) env.MODEL_NAME = opts.modelName;
    if (opts.openaiApiKey && opts.modelProvider === 'minimax') env.MINIMAX_API_KEY = opts.openaiApiKey;
    else if (opts.openaiApiKey) env.OPENAI_API_KEY = opts.openaiApiKey;
    if (process.env.ANTHROPIC_API_KEY) env.ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY;
  } else {
    internalPort = 18789;
    image = OPENCLAW_IMAGE;
    env = {
      TELEGRAM_BOT_TOKEN: opts.telegramToken,
      MCP_CONFIG: JSON.stringify(opts.mcpConfigs),
      ANTHROPIC_API_KEY: process.env.ANTHROPIC_API_KEY || '',
      OPENCLAW_NO_RESPAWN: '1',
      NODE_OPTIONS: '--max-old-space-size=3072 --dns-result-order=ipv4first',
      OPENCLAW_GATEWAY_TOKEN: opts.gatewayToken,
      USAGE_CALLBACK_URL: `${reinsUrl}/api/webhooks/usage`,
      INSTANCE_USER_ID: opts.instanceId,
    };
    if (opts.soulMd) env.SOUL_MD = opts.soulMd;
    if (opts.telegramUserId) env.TELEGRAM_TRUSTED_USER = opts.telegramUserId;
    if (opts.modelName) env.MODEL_NAME = opts.modelName;
    if (opts.modelProvider === 'minimax') {
      // MiniMax via OpenAI-compatible API: translate to 'openai' provider so OpenClaw
      // uses OPENAI_API_KEY + OPENAI_BASE_URL instead of the native minimax extension
      // (the native extension's /anthropic endpoint doesn't support M2.7+ models).
      env.MODEL_PROVIDER = 'openai';
      env.OPENAI_BASE_URL = 'https://api.minimax.io/v1';
      if (opts.openaiApiKey) env.OPENAI_API_KEY = opts.openaiApiKey;
    } else {
      if (opts.modelProvider) env.MODEL_PROVIDER = opts.modelProvider;
      if (opts.openaiApiKey) env.OPENAI_API_KEY = opts.openaiApiKey;
    }
    if (opts.telegramGroups && opts.telegramGroups.length > 0) env.TELEGRAM_GROUPS_JSON = JSON.stringify(opts.telegramGroups);
    if (opts.modelCredentials) env.OPENAI_CODEX_TOKENS = opts.modelCredentials;
    env.THINKING_DEFAULT = opts.thinkingDefault ?? 'medium';
  }

  const envArgs = Object.entries(env).flatMap(([k, v]) => ['-e', `${k}=${v}`]);

  const containerId = docker(
    'run', '-d',
    '--name', containerName,
    ...envArgs,
    '-p', `0:${internalPort}`,
    image,
  );

  const portOutput = docker('port', containerName, String(internalPort));
  const port = parseInt(portOutput.split(':').pop() || '0');

  return { containerId: containerId.slice(0, 12), containerName, port };
}

export async function startLocalContainer(containerName: string) {
  docker('start', containerName);
}

export async function stopLocalContainer(containerName: string) {
  docker('stop', containerName);
}

export async function restartLocalContainer(containerName: string) {
  docker('restart', containerName);
}

export async function removeLocalContainer(containerName: string) {
  docker('rm', '-f', containerName);
}

export async function getLocalContainerStatus(containerName: string): Promise<string> {
  try {
    const status = docker('inspect', '-f', '{{.State.Status}}', containerName);
    return status === 'running' ? 'running' : 'stopped';
  } catch {
    return 'error';
  }
}

export async function getLocalContainerPort(containerName: string): Promise<number> {
  // Try Hermes port (8000) first, then OpenClaw port (18789)
  for (const internalPort of [8000, 18789]) {
    try {
      const portOutput = docker('port', containerName, String(internalPort));
      const port = parseInt(portOutput.split(':').pop() || '0');
      if (port > 0) return port;
    } catch {
      // try next
    }
  }
  return 0;
}

export async function updateLocalContainer(opts: {
  instanceId: string;
  containerName: string;
  telegramToken: string;
  telegramUserId?: string;
  mcpConfigs: object[];
  gatewayToken: string;
  soulMd?: string;
  modelProvider?: string;
  modelName?: string;
  openaiApiKey?: string;
  telegramGroups?: Array<{ chatId: string; name?: string; requireMention?: boolean; allowFrom?: string[]; topicPrompts?: Array<{ threadId: number; prompt: string }> }>;
  modelCredentials?: string;
  runtime?: string;
}): Promise<{ containerId: string; containerName: string; port: number }> {
  try {
    docker('rm', '-f', opts.containerName);
  } catch {
    // ignore
  }
  return createLocalContainer(opts);
}
