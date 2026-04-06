/**
 * Fly.io Machines API client for provisioning OpenClaw agents.
 * Ported from AgentX, adapted for Reins configuration patterns.
 */

const FLY_API_BASE = 'https://api.machines.dev/v1';

function getFlyToken(): string {
  const token = process.env.FLY_API_TOKEN;
  if (!token) throw new Error('FLY_API_TOKEN environment variable is required');
  return token;
}

function getFlyOrg(): string {
  const org = process.env.FLY_ORG;
  if (!org) throw new Error('FLY_ORG environment variable is required');
  return org;
}

const OPENCLAW_APP = process.env.OPENCLAW_APP || 'agentx-openclaw';

let _cachedImage: string | null = null;
let _cacheTime = 0;
const IMAGE_CACHE_TTL = 5 * 60 * 1000; // 5 minutes

async function getOpenClawImage(): Promise<string> {
  // Explicit image takes precedence
  const explicit = process.env.OPENCLAW_IMAGE;
  if (explicit) return explicit;

  // Return cached image if fresh
  const now = Date.now();
  if (_cachedImage && now - _cacheTime < IMAGE_CACHE_TTL) return _cachedImage;

  // Try to resolve from running machines first
  try {
    const res = await fetch(`https://api.machines.dev/v1/apps/${OPENCLAW_APP}/machines`, {
      headers: { Authorization: `Bearer ${getFlyToken()}` },
    });
    if (res.ok) {
      const machines = await res.json() as Array<{ config?: { image?: string } }>;
      const image = machines[0]?.config?.image;
      if (image) {
        _cachedImage = image;
        _cacheTime = now;
        return image;
      }
    }
  } catch (err) {
    console.warn('Failed to resolve image from machines, falling back to registry:', err);
  }

  // Fallback: resolve from the app's latest release via GraphQL
  try {
    const gqlRes = await fetch('https://api.fly.io/graphql', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${getFlyToken()}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        query: `{ app(name: "${OPENCLAW_APP}") { currentRelease { imageRef } } }`,
      }),
    });
    const gql = await gqlRes.json() as { data?: { app?: { currentRelease?: { imageRef?: string } } } };
    const imageRef = gql.data?.app?.currentRelease?.imageRef;
    if (imageRef) {
      console.log(`Resolved image from ${OPENCLAW_APP} latest release: ${imageRef}`);
      _cachedImage = imageRef;
      _cacheTime = now;
      return imageRef;
    }
  } catch (err) {
    console.warn('Failed to resolve image from releases:', err);
  }

  throw new Error(`Cannot resolve OpenClaw image: no machines or releases found for app ${OPENCLAW_APP}. Set OPENCLAW_IMAGE explicitly.`);
}

async function flyFetch(path: string, options: RequestInit = {}) {
  const res = await fetch(`${FLY_API_BASE}${path}`, {
    ...options,
    headers: {
      Authorization: `Bearer ${getFlyToken()}`,
      'Content-Type': 'application/json',
      ...options.headers,
    },
  });

  if (!res.ok) {
    const body = await res.text();
    throw new Error(`Fly API error ${res.status}: ${body}`);
  }

  return res;
}

async function flyGraphQL(query: string, variables: Record<string, unknown>) {
  const res = await fetch('https://api.fly.io/graphql', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${getFlyToken()}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ query, variables }),
  });
  return res.json();
}

async function allocateIps(appName: string) {
  await flyGraphQL(
    `mutation($input: AllocateIPAddressInput!) { allocateIpAddress(input: $input) { ipAddress { id address type } } }`,
    { input: { appId: appName, type: 'v6' } }
  );
  await flyGraphQL(
    `mutation($input: AllocateIPAddressInput!) { allocateIpAddress(input: $input) { ipAddress { id address type } } }`,
    { input: { appId: appName, type: 'shared_v4' } }
  );
}

export async function createApp(instanceId: string): Promise<string> {
  const appName = `reins-${instanceId.slice(0, 8).toLowerCase().replace(/[^a-z0-9-]/g, '')}`;
  await flyFetch('/apps', {
    method: 'POST',
    body: JSON.stringify({ app_name: appName, org_slug: getFlyOrg() }),
  });

  try {
    await allocateIps(appName);
  } catch (err) {
    console.error('IP allocation failed (non-fatal):', err);
  }

  return appName;
}

export interface CreateMachineOpts {
  appName: string;
  instanceId: string;
  telegramToken: string;
  telegramUserId?: string;
  mcpConfigs: object[];
  gatewayToken: string;
  soulMd?: string;
  modelProvider?: string;
  modelName?: string;
  region?: string;
  openaiApiKey?: string;
  modelCredentials?: string;
  thinkingDefault?: string;
}

export async function createMachine(opts: CreateMachineOpts) {
  const res = await flyFetch(`/apps/${opts.appName}/machines`, {
    method: 'POST',
    body: JSON.stringify({
      name: `openclaw-${opts.instanceId.slice(0, 8)}`,
      region: opts.region || 'iad',
      config: await buildMachineConfig(opts),
    }),
  });

  const machine = (await res.json()) as { id: string };
  return { flyMachineId: machine.id, flyAppName: opts.appName };
}

export async function updateMachine(
  appName: string,
  machineId: string,
  opts: Omit<CreateMachineOpts, 'appName'>
) {
  const res = await flyFetch(`/apps/${appName}/machines/${machineId}`, {
    method: 'POST',
    body: JSON.stringify({
      config: await buildMachineConfig({ ...opts, appName }),
    }),
  });
  return res.json();
}

async function buildMachineConfig(opts: CreateMachineOpts) {
  const reinsUrl = process.env.REINS_PUBLIC_URL || process.env.REINS_DASHBOARD_URL || '';

  return {
    image: await getOpenClawImage(),
    guest: {
      cpu_kind: 'shared',
      cpus: 2,
      memory_mb: 4096,
    },
    env: {
      TELEGRAM_BOT_TOKEN: opts.telegramToken,
      MCP_CONFIG: JSON.stringify(opts.mcpConfigs),
      USAGE_CALLBACK_URL: `${reinsUrl}/api/webhooks/usage`,
      INSTANCE_USER_ID: opts.instanceId,
      ANTHROPIC_API_KEY: process.env.ANTHROPIC_API_KEY || '',
      OPENCLAW_GATEWAY_TOKEN: opts.gatewayToken,
      OPENCLAW_NO_RESPAWN: '1',
      NODE_OPTIONS: '--max-old-space-size=3072 --dns-result-order=ipv4first',
      ...(opts.soulMd ? { SOUL_MD: opts.soulMd } : {}),
      ...(opts.telegramUserId ? { TELEGRAM_TRUSTED_USER: opts.telegramUserId } : {}),
      ...(opts.modelProvider ? { MODEL_PROVIDER: opts.modelProvider } : {}),
      // openai-codex discovers available models at runtime — don't constrain with a model name
      ...(opts.modelName && opts.modelProvider !== 'openai-codex' ? { MODEL_NAME: opts.modelName } : {}),
      ...(opts.openaiApiKey ? { OPENAI_API_KEY: opts.openaiApiKey } : {}),
      ...(opts.modelCredentials ? { OPENAI_CODEX_TOKENS: opts.modelCredentials } : {}),
      THINKING_DEFAULT: opts.thinkingDefault ?? 'medium',
    },
    services: [
      {
        ports: [{ port: 443, handlers: ['tls', 'http'] }],
        protocol: 'tcp',
        internal_port: 18789,
        autostart: true,
        autostop: 'off',
      },
    ],
  };
}

export async function startMachine(appName: string, machineId: string) {
  await flyFetch(`/apps/${appName}/machines/${machineId}/start`, { method: 'POST' });
}

export async function stopMachine(appName: string, machineId: string) {
  await flyFetch(`/apps/${appName}/machines/${machineId}/stop`, { method: 'POST' });
}

export async function restartMachine(appName: string, machineId: string) {
  await flyFetch(`/apps/${appName}/machines/${machineId}/restart`, { method: 'POST' });
}

export async function getMachineStatus(appName: string, machineId: string): Promise<{ state: string }> {
  const res = await flyFetch(`/apps/${appName}/machines/${machineId}`);
  return res.json() as Promise<{ state: string }>;
}

export async function destroyMachine(appName: string, machineId: string) {
  await flyFetch(`/apps/${appName}/machines/${machineId}?force=true`, { method: 'DELETE' });
}

export async function destroyApp(appName: string) {
  await flyFetch(`/apps/${appName}`, { method: 'DELETE' });
}

export interface FlyLogEntry {
  timestamp: string;
  message: string;
  level: string;
  instance: string;
  region: string;
}

export async function getAppLogs(appName: string, nextToken?: string): Promise<{ logs: FlyLogEntry[]; nextToken?: string }> {
  const params = new URLSearchParams();
  if (nextToken) params.set('next_token', nextToken);

  const res = await fetch(`https://api.fly.io/api/v1/apps/${appName}/logs?${params}`, {
    headers: { Authorization: getFlyToken() },
  });

  if (!res.ok) {
    const body = await res.text();
    throw new Error(`Fly Logs API error ${res.status}: ${body}`);
  }

  const data = await res.json() as {
    data: Array<{ attributes: { timestamp: string; message: string; level: string; instance: string; region: string } }>;
    meta: { next_token?: string };
  };

  return {
    logs: (data.data || []).map(entry => ({
      timestamp: entry.attributes.timestamp,
      message: entry.attributes.message,
      level: entry.attributes.level,
      instance: entry.attributes.instance,
      region: entry.attributes.region,
    })),
    nextToken: data.meta?.next_token || undefined,
  };
}
