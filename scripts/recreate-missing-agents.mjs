/**
 * Recreate Fly machines for deployed_agents that no longer have a live Fly app.
 * Run from repo root: node scripts/recreate-missing-agents.mjs
 */

import pg from 'pg';

const FLY_API_BASE = 'https://api.machines.dev/v1';
const FLY_TOKEN = process.env.FLY_API_TOKEN;
const MINIMAX_API_KEY = process.env.MINIMAX_API_KEY;
const REINS_URL = 'https://app.helm.mom';
const OPENCLAW_IMAGE = 'registry.fly.io/reins-openclaw:deployment-01KRN014HA6A8TY5ZZD4Q3AN6Q';
const FLY_ORG = 'personal';
const DB_URL = process.env.DATABASE_URL;

if (!FLY_TOKEN) { console.error('FLY_API_TOKEN required'); process.exit(1); }
if (!MINIMAX_API_KEY) { console.error('MINIMAX_API_KEY required'); process.exit(1); }
if (!DB_URL) { console.error('DATABASE_URL required'); process.exit(1); }

const db = new pg.Client({ connectionString: DB_URL });
await db.connect();

async function flyFetch(path, options = {}) {
  const res = await fetch(`${FLY_API_BASE}${path}`, {
    ...options,
    headers: {
      Authorization: `Bearer ${FLY_TOKEN}`,
      'Content-Type': 'application/json',
      ...(options.headers || {}),
    },
  });
  const body = await res.text();
  if (!res.ok) throw new Error(`Fly API ${res.status} ${path}: ${body}`);
  return body ? JSON.parse(body) : null;
}

async function flyGraphQL(query, variables) {
  const res = await fetch('https://api.fly.io/graphql', {
    method: 'POST',
    headers: { Authorization: `Bearer ${FLY_TOKEN}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ query, variables }),
  });
  return res.json();
}

async function allocateIps(appName) {
  for (const type of ['v6', 'shared_v4']) {
    try {
      await flyGraphQL(
        `mutation($input: AllocateIPAddressInput!) { allocateIpAddress(input: $input) { ipAddress { id } } }`,
        { input: { appId: appName, type } }
      );
      console.log(`  IP allocated: ${type}`);
    } catch (err) {
      console.warn(`  IP allocation ${type} failed (non-fatal):`, err.message);
    }
  }
}

async function createApp(appName) {
  await flyFetch('/apps', {
    method: 'POST',
    body: JSON.stringify({ app_name: appName, org_slug: FLY_ORG }),
  });
  console.log(`  App created: ${appName}`);
  await allocateIps(appName);
}

async function createVolume(appName, region) {
  const vol = await flyFetch(`/apps/${appName}/volumes`, {
    method: 'POST',
    body: JSON.stringify({ name: 'agent_state', region: region || 'iad', size_gb: 1, encrypted: false }),
  });
  console.log(`  Volume created: ${vol.id}`);
  return vol.id;
}

function buildMachineConfig(agent, volumeId) {
  const isSharedBot = agent.is_shared_bot === 1;
  const webhookUrl = isSharedBot
    ? `${REINS_URL}/api/webhooks/shared-bot`
    : `${REINS_URL}/api/webhooks/agent-bot/${agent.id}`;

  return {
    image: OPENCLAW_IMAGE,
    guest: { cpu_kind: 'shared', cpus: 2, memory_mb: 4096 },
    env: {
      TELEGRAM_BOT_TOKEN: agent.telegram_token,
      MCP_CONFIG: JSON.stringify(agent.mcp_config_json ? JSON.parse(agent.mcp_config_json) : []),
      USAGE_CALLBACK_URL: `${REINS_URL}/api/webhooks/usage`,
      INSTANCE_USER_ID: agent.id,
      REINS_API_URL: REINS_URL,
      ANTHROPIC_API_KEY: '',
      OPENCLAW_GATEWAY_TOKEN: agent.gateway_token,
      NODE_OPTIONS: '--max-old-space-size=3072 --dns-result-order=ipv4first',
      ...(agent.soul_md ? { SOUL_MD: agent.soul_md } : {}),
      ...(agent.telegram_user_id ? { TELEGRAM_TRUSTED_USER: agent.telegram_user_id } : {}),
      ...(agent.model_name ? { MODEL_NAME: agent.model_name } : {}),
      // MiniMax via OpenAI-compatible API
      MODEL_PROVIDER: 'openai',
      OPENAI_BASE_URL: 'https://api.minimax.io/v1',
      OPENAI_API_KEY: MINIMAX_API_KEY,
      THINKING_DEFAULT: 'medium',
      OPENCLAW_WEBHOOK_URL: webhookUrl,
      OPENCLAW_WEBHOOK_SECRET: agent.webhook_relay_secret,
      ...(agent.initial_prompt ? { INITIAL_PROMPT: agent.initial_prompt } : {}),
    },
    ...(volumeId ? { mounts: [{ volume: volumeId, path: '/home/node/.openclaw/agents' }] } : {}),
    services: [
      {
        ports: [{ port: 443, handlers: ['tls', 'http'] }],
        protocol: 'tcp',
        internal_port: 18789,
        autostart: true,
        autostop: 'off',
        checks: [{
          type: 'http', method: 'get', path: '/healthz', port: 18789,
          interval: '15s', timeout: '5s', grace_period: '120s',
        }],
      },
      {
        ports: [{ port: 8443, handlers: ['tls', 'http'] }],
        protocol: 'tcp',
        internal_port: 8787,
        autostart: true,
        autostop: 'off',
      },
    ],
  };
}

// Load missing agents from DB
const { rows: agents } = await db.query(`
  SELECT da.id, da.fly_app_name, da.fly_machine_id, da.runtime, da.telegram_token,
         da.telegram_user_id, da.mcp_config_json, da.model_provider, da.model_name,
         da.model_credentials, da.webhook_relay_secret, da.is_shared_bot,
         da.gateway_token, da.soul_md, da.initial_prompt, da.region,
         da.telegram_bot_username
  FROM deployed_agents da
  WHERE da.fly_app_name IN ('reins-6ucgytoq','reins-pvttpcgo','reins-j5pkejhq','reins-n8zbjcoc','reins-tnmsxotz')
    AND da.status = 'running'
  ORDER BY da.created_at
`);

console.log(`Recreating ${agents.length} agents...\n`);

for (const agent of agents) {
  const appName = agent.fly_app_name;
  const instanceSuffix = agent.id.replace(/[^a-z0-9]/gi, '').toLowerCase().slice(0, 8);
  console.log(`\n=== ${appName} (${agent.telegram_bot_username}) ===`);

  try {
    // 1. Create app
    await createApp(appName);

    // 2. Create volume
    const volumeId = await createVolume(appName, agent.region || 'iad');

    // 3. Create machine
    const machineConfig = buildMachineConfig(agent, volumeId);
    const machineName = `openclaw-${instanceSuffix.toUpperCase()}`;
    const machine = await flyFetch(`/apps/${appName}/machines`, {
      method: 'POST',
      body: JSON.stringify({
        name: machineName,
        region: agent.region || 'iad',
        config: machineConfig,
      }),
    });
    console.log(`  Machine created: ${machine.id}`);

    // 4. Update DB with new machine ID and volume ID
    await db.query(
      `UPDATE deployed_agents SET fly_machine_id = $1, fly_volume_id = $2, updated_at = NOW() WHERE id = $3`,
      [machine.id, volumeId, agent.id]
    );
    console.log(`  DB updated: machine=${machine.id} volume=${volumeId}`);

    // 5. Log to audit_log
    await db.query(
      `INSERT INTO audit_log (timestamp, event_type, result, metadata_json)
       VALUES (NOW(), 'fly_action', 'success', $1)`,
      [JSON.stringify({ action: 'recreate', app: appName, machine_id: machine.id, reason: 'app_missing_from_fly' })]
    );
    console.log(`  ✓ Done`);

  } catch (err) {
    console.error(`  ✗ FAILED: ${err.message}`);
  }
}

await db.end();
console.log('\nAll done.');
