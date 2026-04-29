/**
 * Fly Machines API lifecycle management for ephemeral image-test VMs.
 * Mirrors patterns from backend/src/providers/fly.ts but scoped to the
 * reins-test org and image-test workflow.
 */

const FLY_API_BASE = 'https://api.machines.dev/v1';

function getFlyToken(): string {
  const token = process.env.FLY_API_TOKEN;
  if (!token) throw new Error('FLY_API_TOKEN is required');
  return token;
}

function getTestOrg(): string {
  return process.env.FLY_TEST_ORG || 'reins-test';
}

function randomSuffix(): string {
  return Math.random().toString(36).slice(2, 8);
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
    throw new Error(`Fly API ${res.status} on ${path}: ${body}`);
  }

  return res;
}

/**
 * Create an ephemeral Fly app in the test org.
 * Returns the app name.
 */
export async function createTestApp(variantName: string): Promise<string> {
  const slug = variantName.toLowerCase().replace(/[^a-z0-9]/g, '-').slice(0, 20);
  const appName = `reins-imgtest-${slug}-${randomSuffix()}`;

  await flyFetch('/apps', {
    method: 'POST',
    body: JSON.stringify({
      app_name: appName,
      org_slug: getTestOrg(),
    }),
  });

  console.log(`Created test app: ${appName}`);
  return appName;
}

export interface TestMachineEnv {
  TELEGRAM_BOT_TOKEN: string;
  ANTHROPIC_API_KEY: string;
  OPENCLAW_MODEL?: string;
  XVFB_RESOLUTION?: string;
  [key: string]: string | undefined;
}

/**
 * Create a single machine in the test app with the given image and env.
 * Returns the machine ID.
 */
export async function createTestMachine(
  appName: string,
  image: string,
  env: TestMachineEnv,
): Promise<string> {
  // Strip undefined values
  const cleanEnv: Record<string, string> = {};
  for (const [k, v] of Object.entries(env)) {
    if (v !== undefined) cleanEnv[k] = v;
  }

  const res = await flyFetch(`/apps/${appName}/machines`, {
    method: 'POST',
    body: JSON.stringify({
      name: `imgtest-${randomSuffix()}`,
      region: 'iad',
      config: {
        image,
        guest: {
          cpu_kind: 'shared',
          cpus: 2,
          memory_mb: 4096,
        },
        env: {
          ...cleanEnv,
          OPENCLAW_NO_RESPAWN: '1',
          NODE_OPTIONS: '--max-old-space-size=3072 --dns-result-order=ipv4first',
        },
        services: [
          {
            ports: [{ port: 443, handlers: ['tls', 'http'] }],
            protocol: 'tcp',
            internal_port: 18789,
            autostart: true,
            autostop: 'off',
            checks: [
              {
                type: 'http',
                method: 'get',
                path: '/healthz',
                port: 18789,
                interval: '15s',
                timeout: '5s',
                grace_period: '120s',
              },
            ],
          },
        ],
      },
    }),
  });

  const machine = (await res.json()) as { id: string };
  console.log(`Created test machine: ${machine.id} in app ${appName}`);
  return machine.id;
}

/**
 * Poll the machine's /healthz endpoint until it responds 200 or timeout.
 * Falls back to polling machine state if no hostname is available yet.
 */
export async function waitForHealthy(
  appName: string,
  machineId: string,
  timeoutMs = 120_000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  console.log(`Waiting for ${appName}/${machineId} to become healthy (timeout: ${timeoutMs / 1000}s)...`);

  while (Date.now() < deadline) {
    await sleep(5_000);
    try {
      const res = await flyFetch(`/apps/${appName}/machines/${machineId}`);
      const machine = (await res.json()) as {
        state: string;
        checks?: Array<{ name: string; status: string }>;
      };

      if (machine.state === 'started') {
        // Check if health check is passing
        const healthCheck = machine.checks?.find((c) => c.name === 'app' || c.status === 'passing');
        if (healthCheck?.status === 'passing') {
          console.log(`Machine ${machineId} is healthy`);
          return;
        }
        // Machine started but checks not yet passing — keep waiting
        console.log(`Machine started, waiting for health check...`);
      } else {
        console.log(`Machine state: ${machine.state}`);
      }
    } catch (err) {
      // Transient error — keep polling
      console.log(`Poll error (will retry): ${err}`);
    }
  }

  throw new Error(`Machine ${machineId} in app ${appName} did not become healthy within ${timeoutMs / 1000}s`);
}

/**
 * Destroy a machine (force) then delete the app.
 * Best-effort: logs errors but does not throw.
 */
export async function destroyTest(appName: string, machineId: string): Promise<void> {
  console.log(`Tearing down ${appName}/${machineId}...`);

  try {
    await flyFetch(`/apps/${appName}/machines/${machineId}?force=true`, {
      method: 'DELETE',
    });
    console.log(`Machine ${machineId} destroyed`);
  } catch (err) {
    console.error(`Failed to destroy machine ${machineId}:`, err);
  }

  // Wait a moment for machine to fully terminate before deleting app
  await sleep(5_000);

  try {
    await flyFetch(`/apps/${appName}`, { method: 'DELETE' });
    console.log(`App ${appName} deleted`);
  } catch (err) {
    console.error(`Failed to delete app ${appName}:`, err);
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}
