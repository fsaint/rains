import type { Context } from 'grammy';
import type { Applicant } from '../db.js';
import { config } from '../config.js';
import { HELM } from '../persona.js';
import { getDeploymentStatus } from '../api-client.js';

const POLL_INTERVAL_MS = 10_000;
const MACHINE_TIMEOUT_MS = 3 * 60 * 1_000;  // 3 min: wait for Fly machine to reach 'running'
const HEALTH_TIMEOUT_MS = 3 * 60 * 1_000;   // 3 min: wait for agent to become responsive
const HEALTH_POLL_MS = 8_000;

async function waitForHealthy(appName: string): Promise<boolean> {
  const deadline = Date.now() + HEALTH_TIMEOUT_MS;
  const url = `https://${appName}.fly.dev/healthz`;

  while (Date.now() < deadline) {
    try {
      const res = await fetch(url, { signal: AbortSignal.timeout(5_000) });
      if (res.ok) return true;
    } catch {
      // Not yet reachable — keep polling
    }
    await new Promise((r) => setTimeout(r, HEALTH_POLL_MS));
  }
  return false;
}

export async function handleValidating(
  ctx: Context,
  applicant: Applicant
): Promise<'done' | void> {
  await ctx.reply(HELM.validating);

  const deadline = Date.now() + MACHINE_TIMEOUT_MS;
  const deploymentId = applicant.deployment_id!;

  // Step 1: wait for Fly machine to reach 'running'
  const machineRunning = await new Promise<{ appName: string } | null>((resolve) => {
    const interval = setInterval(async () => {
      try {
        const status = await getDeploymentStatus(deploymentId);
        if (status.status === 'running') {
          clearInterval(interval);
          resolve({ appName: status.appName });
          return;
        }
      } catch (err: unknown) {
        console.error('[validating] status check failed:', err);
      }

      if (Date.now() > deadline) {
        clearInterval(interval);
        resolve(null);
      }
    }, POLL_INTERVAL_MS);
  });

  if (!machineRunning) {
    await ctx.reply(HELM.validatingTimeout);
    try {
      const { Bot } = await import('grammy');
      const tmpBot = new Bot(config.botToken);
      await tmpBot.api.sendMessage(
        config.adminTelegramId,
        `Deployment timeout for user ${applicant.telegram_user_id}, deployment ${deploymentId}`
      );
    } catch { /* non-fatal */ }
    return;
  }

  // Step 2: wait for the agent to actually respond to health checks
  const isHealthy = await waitForHealthy(machineRunning.appName);
  if (!isHealthy) {
    console.warn(`[validating] agent ${machineRunning.appName} did not pass healthz — proceeding anyway`);
  }

  // Step 3: send done message with bot link
  const botUsername = applicant.bot_username;
  const botLink = botUsername ? `\n\nStart chatting with your agent: t.me/${botUsername}` : '';
  await ctx.reply(`${HELM.done}${botLink}`);

  return 'done';
}
