/**
 * Local Docker provider for development.
 * Runs OpenClaw agents as local Docker containers.
 */

import { execFileSync } from 'child_process';

const OPENCLAW_IMAGE = process.env.OPENCLAW_IMAGE || 'reins-openclaw:latest';

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
}): Promise<{ containerId: string; containerName: string; port: number }> {
  const containerName = `reins-${opts.instanceId.slice(0, 12)}`;

  // Remove existing container with same name
  try {
    docker('rm', '-f', containerName);
  } catch {
    // ignore
  }

  const reinsUrl = process.env.REINS_PUBLIC_URL || process.env.REINS_DASHBOARD_URL || 'http://host.docker.internal:5001';

  const env: Record<string, string> = {
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
  if (opts.modelProvider) env.MODEL_PROVIDER = opts.modelProvider;
  if (opts.modelName) env.MODEL_NAME = opts.modelName;
  if (opts.openaiApiKey) env.OPENAI_API_KEY = opts.openaiApiKey;
  if (opts.telegramGroups && opts.telegramGroups.length > 0) env.TELEGRAM_GROUPS_JSON = JSON.stringify(opts.telegramGroups);
  if (opts.modelCredentials) env.OPENAI_CODEX_TOKENS = opts.modelCredentials;
  env.THINKING_DEFAULT = opts.thinkingDefault ?? 'medium';

  const envArgs = Object.entries(env).flatMap(([k, v]) => ['-e', `${k}=${v}`]);

  const containerId = docker(
    'run', '-d',
    '--name', containerName,
    ...envArgs,
    '-p', '0:18789',
    OPENCLAW_IMAGE,
  );

  const portOutput = docker('port', containerName, '18789');
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
  try {
    const portOutput = docker('port', containerName, '18789');
    return parseInt(portOutput.split(':').pop() || '0');
  } catch {
    return 0;
  }
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
}): Promise<{ containerId: string; containerName: string; port: number }> {
  try {
    docker('rm', '-f', opts.containerName);
  } catch {
    // ignore
  }
  return createLocalContainer(opts);
}
