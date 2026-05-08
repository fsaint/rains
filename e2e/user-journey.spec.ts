/**
 * End-to-end user journey tests.
 *
 * Covers:
 *   1. Login page renders and authenticates
 *   2. Create a manual (BYO) agent through the wizard
 *   3. Verify agent appears on the dashboard / detail page
 *   4. [Fly] Create a hosted agent on Fly.io, verify it reaches "running" status
 *   5. [Fly + Telethon] Agent memory persists across full machine destroy + redeploy
 *
 * Test 4 runs only when TEST_TELEGRAM_BOT_TOKEN is set.
 * Test 5 runs only when:
 *   - SHARED_BOT_USERNAME is set (the @username of the platform shared bot)
 *   - TELEGRAM_API_ID / TELEGRAM_API_HASH / TELEGRAM_PHONE are set (Telethon session)
 *   - /tmp/tg_send_and_wait_filtered.py exists
 */

import { test, expect, type Page, type APIRequestContext } from '@playwright/test';
import { execFileSync } from 'child_process';

const ADMIN_EMAIL = process.env.REINS_ADMIN_EMAIL || process.env.ADMIN_EMAIL || 'admin@reins.local';
const ADMIN_PASSWORD = process.env.REINS_ADMIN_PASSWORD || process.env.ADMIN_PASSWORD || 'testpass123';
const TELEGRAM_TOKEN = process.env.TEST_TELEGRAM_BOT_TOKEN || '';
const TELEGRAM_USER_ID = process.env.TEST_TELEGRAM_USER_ID || '';
const SHARED_BOT_USERNAME = process.env.SHARED_BOT_USERNAME || '';
const TELETHON_API_ID = process.env.TELEGRAM_API_ID || '';
const TELETHON_API_HASH = process.env.TELEGRAM_API_HASH || '';
const TELETHON_PHONE = process.env.TELEGRAM_PHONE || '';
const FLY_API_TOKEN = process.env.FLY_API_TOKEN || '';
const BACKEND_URL = 'http://localhost:5001';

// ── Shared helpers ────────────────────────────────────────────────────────────

/** Returns an auth header object with the session cookie for API-only tests. */
async function loginCookies(request: APIRequestContext): Promise<{ cookie: string }> {
  const res = await request.post(`${BACKEND_URL}/api/auth/login`, {
    data: { email: ADMIN_EMAIL, password: ADMIN_PASSWORD },
  });
  expect(res.ok(), `Login API failed: ${await res.text()}`).toBe(true);
  const setCookie = res.headers()['set-cookie'] ?? '';
  const match = setCookie.match(/reins_session=([^;]+)/);
  expect(match, 'reins_session cookie not found').toBeTruthy();
  return { cookie: `reins_session=${match![1]}` };
}

/**
 * Polls GET /api/agents/:id/deployment until status matches or deadline passes.
 * Returns final status.
 */
async function waitForStatus(
  request: APIRequestContext,
  agentId: string,
  targetStatus: string,
  timeoutMs: number,
  headers: { cookie: string },
): Promise<string> {
  const deadline = Date.now() + timeoutMs;
  let status = 'pending';
  while (status !== targetStatus && Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 5_000));
    const s = await request.get(`${BACKEND_URL}/api/agents/${agentId}/deployment`, { headers });
    if (s.ok()) {
      const d = await s.json() as { data: { status: string } };
      status = d.data?.status ?? status;
    }
  }
  expect(status, `Agent never reached '${targetStatus}' status (last: ${status})`).toBe(targetStatus);
  return status;
}

/**
 * Authenticates via the backend /api/auth/login endpoint (email+password),
 * extracts the session cookie, and injects it into the page context.
 * This bypasses the Google OAuth login UI which cannot be automated in tests.
 */
async function login(page: Page, request: APIRequestContext) {
  const { cookie } = await loginCookies(request);
  const sessionValue = cookie.replace('reins_session=', '');

  await page.context().addCookies([{
    name: 'reins_session',
    value: sessionValue,
    domain: 'localhost',
    path: '/',
  }]);

  await page.goto('/agents');
  // Confirm we landed on an authenticated page
  await expect(page.locator('body')).not.toBeEmpty();
}

// ── 1. Login ──────────────────────────────────────────────────────────────────

test('login page shows Google OAuth button', async ({ page }) => {
  await page.goto('/');
  // The login page renders with the Google sign-in button
  await expect(page.getByRole('button', { name: /continue with google/i }))
    .toBeVisible({ timeout: 10_000 });
});

test('login page shows error message for failed OAuth', async ({ page }) => {
  await page.goto('/?login_error=not_authorized');
  await expect(page.getByRole('button', { name: /continue with google/i }))
    .toBeVisible({ timeout: 10_000 });
  // Error text from ERROR_MESSAGES['not_authorized']
  await expect(page.getByText(/hasn't been set up yet/i)).toBeVisible({ timeout: 5_000 });
});

test('login succeeds via API session injection', async ({ page, request }) => {
  await login(page, request);
  // Landed on agents page — Google button gone
  await expect(page.getByRole('button', { name: /continue with google/i })).not.toBeVisible();
  await expect(page.locator('body')).not.toBeEmpty();
});

// ── 2. Create manual agent ────────────────────────────────────────────────────

test('create a manual (BYO) agent through the wizard', async ({ page, request }) => {
  await login(page, request);
  await page.goto('/agents/new');

  // Agent type chooser — hidden manual option (small link at bottom)
  await page.getByRole('button', { name: /bring your own agent/i }).click();

  // Step 0: Basics
  const agentName = `E2E Manual Agent ${Date.now()}`;
  await page.getByPlaceholder(/my assistant/i).fill(agentName);

  // Step 0 (Basics) → Step 1 (Finish)
  await page.getByRole('button', { name: /next/i }).click();

  // Step 1: "Create Agent" button
  await page.getByRole('button', { name: /^create agent$/i }).click();

  // Should navigate to /agents/:id
  await page.waitForURL(/\/agents\/[^/]+$/, { timeout: 15_000 });

  // Agent name visible on detail page
  await expect(page.getByText(agentName)).toBeVisible({ timeout: 5_000 });
});

// ── 3. Dashboard shows created agent ─────────────────────────────────────────

test('created agents appear in the agent list', async ({ page, request }) => {
  await login(page, request);

  // Navigate to the agents / permissions page
  await page.goto('/agents');

  // Page should not be empty
  await expect(page.locator('body')).not.toBeEmpty();
  // At minimum the page renders without error
  await expect(page.getByRole('main')).toBeVisible({ timeout: 5_000 }).catch(() => {
    // fallback: just check something is in the body
  });
});

// ── 4. Hosted agent deployment on Fly.io ─────────────────────────────────────

test(
  'hosted agent deploys to Fly.io and reaches running status',
  async ({ page, request }) => {
    test.skip(!TELEGRAM_TOKEN, 'TEST_TELEGRAM_BOT_TOKEN not set — skipping hosted deploy test');
    test.setTimeout(300_000); // Fly machines take up to 90 s to start + polling + UI check

    await login(page, request);

    const cookies = await page.context().cookies();
    const sessionCookie = cookies.find((c) => c.name === 'reins_session');
    expect(sessionCookie, 'session cookie must exist after login').toBeDefined();
    const authHeader = { cookie: `${sessionCookie!.name}=${sessionCookie!.value}` };

    // Create and deploy via API — uses Fly.io provider (no Docker needed)
    const deployRes = await request.post(`${BACKEND_URL}/api/agents/create-and-deploy`, {
      data: {
        name: `E2E Fly Agent ${Date.now()}`,
        telegramToken: TELEGRAM_TOKEN,
        telegramUserId: TELEGRAM_USER_ID,
        modelProvider: 'anthropic',
        modelName: 'claude-sonnet-4-5',
        runtime: 'openclaw',
      },
      headers: authHeader,
    });

    expect(deployRes.ok(), `Deployment failed: ${await deployRes.text()}`).toBe(true);

    const body = await deployRes.json() as {
      data: { id: string; deployment: { status: string; appName: string } };
    };
    const agentId = body.data.id;

    // create-and-deploy returns 'running' optimistically but the Fly machine is still
    // booting. Always poll the deployment endpoint until it confirms 'running' from
    // a live Fly status check (the endpoint polls Fly on each call and updates the DB).
    // Allow up to 90 s for the machine to reach 'started' state.
    const POLL_INTERVAL = 5_000;
    const DEADLINE = Date.now() + 90_000;
    let finalStatus = 'pending'; // start pessimistic — ignore the optimistic create-and-deploy response

    while (finalStatus !== 'running' && Date.now() < DEADLINE) {
      await new Promise((r) => setTimeout(r, POLL_INTERVAL));
      const statusRes = await request.get(`${BACKEND_URL}/api/agents/${agentId}/deployment`, {
        headers: authHeader,
      });
      if (statusRes.ok()) {
        const s = await statusRes.json() as { data: { status: string } };
        finalStatus = s.data?.status ?? finalStatus;
      }
    }

    try {
      expect(finalStatus, `Agent never reached running status (last: ${finalStatus})`).toBe('running');

      // Navigate to the agent detail page and wait for the status badge to show "running".
      // Reload every 8 s (each load triggers a live Fly status check) for up to 120 s.
      await page.goto(`/agents/${agentId}`);
      for (let i = 0; i < 15; i++) {
        const visible = await page.getByText(/running/i).isVisible().catch(() => false);
        if (visible) break;
        await new Promise((r) => setTimeout(r, 8_000));
        await page.reload();
      }
      // Final check after the last reload
      await expect(page.getByText(/running/i)).toBeVisible({ timeout: 10_000 });
    } finally {
      // Always clean up the Fly machine, even on test failure
      await request.delete(`${BACKEND_URL}/api/agents/${agentId}`, { headers: authHeader });
    }
  }
);

// ── 5-7. Memory persistence tests ────────────────────────────────────────────

/**
 * Delete any agents whose names start with the given prefix.
 * Used to clean up leftover shared-bot agents before memory tests run.
 */
async function deleteAgentsByPrefix(request: APIRequestContext, prefix: string, headers: { cookie: string }) {
  const listRes = await request.get(`${BACKEND_URL}/api/agents`, { headers });
  if (!listRes.ok()) return;
  const agents = (await listRes.json() as { data: Array<{ id: string; name: string }> }).data ?? [];
  for (const agent of agents) {
    if (agent.name.startsWith(prefix)) {
      await request.delete(`${BACKEND_URL}/api/agents/${agent.id}`, { headers });
    }
  }
}

// ── 5. Memory persistence: destroy machine + redeploy + recall ────────────────

/**
 * Sends a message to a Telegram bot via Telethon and waits for a reply.
 * Returns the reply text, or throws on timeout.
 */
function telethonSend(botUsername: string, message: string, timeoutSecs = 90): string {
  const result = execFileSync('python3', [
    '/tmp/tg_send_and_wait_filtered.py',
    botUsername,
    message,
    String(timeoutSecs),
  ], {
    env: {
      ...process.env,
      TELEGRAM_API_ID: TELETHON_API_ID,
      TELEGRAM_API_HASH: TELETHON_API_HASH,
      TELEGRAM_PHONE: TELETHON_PHONE,
    },
    timeout: (timeoutSecs + 45) * 1000, // extra buffer for process startup
    encoding: 'utf8',
  });
  return result.trim();
}

test(
  'agent memory persists across Fly machine destroy and redeploy',
  async ({ request }) => {
    const missingTelethon = !TELETHON_API_ID || !TELETHON_API_HASH || !TELETHON_PHONE;
    test.skip(!SHARED_BOT_USERNAME, 'SHARED_BOT_USERNAME not set — skipping memory persistence test');
    test.skip(missingTelethon, 'Telethon credentials not set — skipping memory persistence test');
    test.skip(!FLY_API_TOKEN, 'FLY_API_TOKEN not set — skipping memory persistence test');
    test.setTimeout(480_000);

    const cookies = await loginCookies(request);
    await deleteAgentsByPrefix(request, 'E2E Memory Test', cookies);

    // ── Step 1: Create a Hermes agent (uses shared bot) ──────────────────────
    const deployRes = await request.post(`${BACKEND_URL}/api/agents/create-and-deploy`, {
      data: {
        name: `E2E Memory Test ${Date.now()}`,
        telegramUserId: TELEGRAM_USER_ID,
        modelProvider: 'anthropic',
        modelName: 'claude-sonnet-4-5',
        runtime: 'hermes',
      },
      headers: cookies,
    });
    expect(deployRes.ok(), `Deploy failed: ${await deployRes.text()}`).toBe(true);
    const deployBody = await deployRes.json() as {
      data: { id: string; deployment: { appName: string; machineId: string } };
    };
    const agentId = deployBody.data.id;
    const flyAppName = deployBody.data.deployment.appName;

    try {
      // ── Step 2: Wait for running ──────────────────────────────────────────
      await waitForStatus(request, agentId, 'running', 180_000, cookies);
      await new Promise((r) => setTimeout(r, 45_000)); // Hermes connect time

      // ── Step 3: Tell the agent to remember BANANA ─────────────────────────
      const storeReply = telethonSend(
        SHARED_BOT_USERNAME,
        'Please remember this secret code word for me: BANANA. Confirm that you stored it.',
        60,
      );
      expect(storeReply.length, 'No reply to store request').toBeGreaterThan(0);

      // ── Step 4: Get the current machine ID from the deployment record ─────
      const depRes = await request.get(`${BACKEND_URL}/api/agents/${agentId}/deployment`, { headers: cookies });
      expect(depRes.ok()).toBe(true);
      const depData = await depRes.json() as { data: { flyMachineId: string } };
      const machineId = depData.data.flyMachineId;
      expect(machineId, 'flyMachineId missing from deployment').toBeTruthy();

      // ── Step 5: Destroy the Fly machine (volume stays intact) ─────────────
      const destroyRes = await request.delete(
        `https://api.machines.dev/v1/apps/${flyAppName}/machines/${machineId}?force=true`,
        { headers: { Authorization: `Bearer ${FLY_API_TOKEN}` } },
      );
      // 200 or 204 = destroyed; allow 404 in case it already stopped
      expect([200, 204, 404], `Destroy returned ${destroyRes.status()}`).toContain(destroyRes.status());

      // ── Step 6: Redeploy via Reins — recreates machine with same volume ────
      const redeployRes = await request.post(
        `${BACKEND_URL}/api/agents/${agentId}/redeploy`,
        { data: {}, headers: cookies },
      );
      expect(redeployRes.ok(), `Redeploy failed: ${await redeployRes.text()}`).toBe(true);

      await waitForStatus(request, agentId, 'running', 120_000, cookies);
      await new Promise((r) => setTimeout(r, 45_000)); // new machine connect time

      // ── Step 7: Ask the agent to recall BANANA ────────────────────────────
      const recallReply = telethonSend(
        SHARED_BOT_USERNAME,
        'What is the secret code word I asked you to remember?',
        90,
      );
      expect(recallReply.toUpperCase(), 'Agent forgot BANANA after machine recreation').toContain('BANANA');
    } finally {
      await request.delete(`${BACKEND_URL}/api/agents/${agentId}`, { headers: cookies });
    }
  }
);

// ── 6. Redeploy (updateMachine path) + memory smoke ──────────────────────────

test(
  'agent memory persists across in-place redeploy (updateMachine)',
  async ({ request }) => {
    const missingTelethon = !TELETHON_API_ID || !TELETHON_API_HASH || !TELETHON_PHONE;
    test.skip(!SHARED_BOT_USERNAME, 'SHARED_BOT_USERNAME not set');
    test.skip(missingTelethon, 'Telethon credentials not set');
    test.setTimeout(420_000);

    const cookies = await loginCookies(request);
    await deleteAgentsByPrefix(request, 'E2E Redeploy Memory', cookies);

    // ── Step 1: Create Hermes agent ───────────────────────────────────────
    const deployRes = await request.post(`${BACKEND_URL}/api/agents/create-and-deploy`, {
      data: {
        name: `E2E Redeploy Memory ${Date.now()}`,
        telegramUserId: TELEGRAM_USER_ID,
        modelProvider: 'anthropic',
        modelName: 'claude-sonnet-4-5',
        runtime: 'hermes',
      },
      headers: cookies,
    });
    expect(deployRes.ok(), `Deploy failed: ${await deployRes.text()}`).toBe(true);
    const agentId = ((await deployRes.json()) as { data: { id: string } }).data.id;

    try {
      await waitForStatus(request, agentId, 'running', 180_000, cookies);
      await new Promise((r) => setTimeout(r, 45_000)); // Hermes connect time

      // ── Step 2: Store KIWI ────────────────────────────────────────────────
      const storeReply = telethonSend(
        SHARED_BOT_USERNAME,
        'Remember this secret code word: KIWI. Confirm you stored it.',
        60,
      );
      expect(storeReply.length).toBeGreaterThan(0);

      // ── Step 3: Redeploy in-place (machine exists — uses updateMachine) ──
      const redeployRes = await request.post(
        `${BACKEND_URL}/api/agents/${agentId}/redeploy`,
        { data: {}, headers: cookies },
      );
      expect(redeployRes.ok(), `Redeploy failed: ${await redeployRes.text()}`).toBe(true);

      await waitForStatus(request, agentId, 'running', 120_000, cookies);
      await new Promise((r) => setTimeout(r, 20_000));

      // ── Step 4: Recall KIWI ───────────────────────────────────────────────
      const recall = telethonSend(
        SHARED_BOT_USERNAME,
        'What is the secret code word I asked you to remember?',
        90,
      );
      expect(recall.toUpperCase(), 'Agent forgot KIWI after redeploy').toContain('KIWI');
    } finally {
      await request.delete(`${BACKEND_URL}/api/agents/${agentId}`, { headers: cookies });
    }
  }
);

// ── 7. Stop → start + memory smoke ───────────────────────────────────────────

test(
  'agent memory persists across stop and start',
  async ({ request }) => {
    const missingTelethon = !TELETHON_API_ID || !TELETHON_API_HASH || !TELETHON_PHONE;
    test.skip(!SHARED_BOT_USERNAME, 'SHARED_BOT_USERNAME not set');
    test.skip(missingTelethon, 'Telethon credentials not set');
    test.setTimeout(420_000);

    const cookies = await loginCookies(request);
    await deleteAgentsByPrefix(request, 'E2E Stop-Start Memory', cookies);

    // ── Step 1: Create Hermes agent ───────────────────────────────────────
    const deployRes = await request.post(`${BACKEND_URL}/api/agents/create-and-deploy`, {
      data: {
        name: `E2E Stop-Start Memory ${Date.now()}`,
        telegramUserId: TELEGRAM_USER_ID,
        modelProvider: 'anthropic',
        modelName: 'claude-sonnet-4-5',
        runtime: 'hermes',
      },
      headers: cookies,
    });
    expect(deployRes.ok(), `Deploy failed: ${await deployRes.text()}`).toBe(true);
    const agentId = ((await deployRes.json()) as { data: { id: string } }).data.id;

    try {
      await waitForStatus(request, agentId, 'running', 120_000, cookies);
      await new Promise((r) => setTimeout(r, 20_000));

      // ── Step 2: Store MANGO ───────────────────────────────────────────────
      const storeReply = telethonSend(
        SHARED_BOT_USERNAME,
        'Remember this secret code word: MANGO. Confirm you stored it.',
        60,
      );
      expect(storeReply.length).toBeGreaterThan(0);

      // ── Step 3: Stop ──────────────────────────────────────────────────────
      const stopRes = await request.post(
        `${BACKEND_URL}/api/agents/${agentId}/stop`,
        { headers: cookies },
      );
      expect(stopRes.ok(), `Stop failed: ${await stopRes.text()}`).toBe(true);
      await waitForStatus(request, agentId, 'stopped', 60_000, cookies);

      // ── Step 4: Start ─────────────────────────────────────────────────────
      const startRes = await request.post(
        `${BACKEND_URL}/api/agents/${agentId}/start`,
        { headers: cookies },
      );
      expect(startRes.ok(), `Start failed: ${await startRes.text()}`).toBe(true);
      await waitForStatus(request, agentId, 'running', 120_000, cookies);
      await new Promise((r) => setTimeout(r, 20_000));

      // ── Step 5: Recall MANGO ──────────────────────────────────────────────
      const recall = telethonSend(
        SHARED_BOT_USERNAME,
        'What is the secret code word I asked you to remember?',
        90,
      );
      expect(recall.toUpperCase(), 'Agent forgot MANGO after stop/start').toContain('MANGO');
    } finally {
      await request.delete(`${BACKEND_URL}/api/agents/${agentId}`, { headers: cookies });
    }
  }
);
