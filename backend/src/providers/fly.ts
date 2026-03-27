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

function getOpenClawImage(): string {
  const image = process.env.OPENCLAW_IMAGE;
  if (!image) throw new Error('OPENCLAW_IMAGE environment variable is required');
  return image;
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
}

export async function createMachine(opts: CreateMachineOpts) {
  const res = await flyFetch(`/apps/${opts.appName}/machines`, {
    method: 'POST',
    body: JSON.stringify({
      name: `openclaw-${opts.instanceId.slice(0, 8)}`,
      region: opts.region || 'iad',
      config: buildMachineConfig(opts),
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
      config: buildMachineConfig({ ...opts, appName }),
    }),
  });
  return res.json();
}

function buildMachineConfig(opts: CreateMachineOpts) {
  const reinsUrl = process.env.REINS_PUBLIC_URL || process.env.REINS_DASHBOARD_URL || '';

  return {
    image: getOpenClawImage(),
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
      ...(opts.modelName ? { MODEL_NAME: opts.modelName } : {}),
      ...(opts.openaiApiKey ? { OPENAI_API_KEY: opts.openaiApiKey } : {}),
      ...(opts.modelCredentials ? { OPENAI_CODEX_TOKENS: opts.modelCredentials } : {}),
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
