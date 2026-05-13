/**
 * Dream scheduler — nightly memory consolidation for OpenClaw agents.
 *
 * At 2am UTC, queries all running OpenClaw agents and POSTs a dream prompt
 * to each agent's isolated /chat?session=dream endpoint. The agent uses
 * memory MCP tools (memory_dream, memory_set_parent, memory_update) to
 * reorganize and reflect on its memory vault.
 */

import { client } from '../db/index.js';

const DREAM_PROMPT = `You are entering a memory dream session. Work through your memory vault systematically:

1. Call memory_dream to get the full manifest of your entries.
2. Review the structure — identify entries that belong under a different parent, orphaned notes, and logical groupings.
3. Use memory_set_parent to reorganize entries into a clear hierarchy.
4. Search for duplicates or closely related entries with memory_search. Merge them by updating one with memory_update and deleting the other.
5. Update the root index (Memory Index) with memory_update to reflect: key people, projects, and notes you know about, and a brief reflection on what you have learned recently.

Be decisive. Work through all entries. When done, stop.`;

const DREAM_TIMEOUT_MS = 5 * 60 * 1000; // 5 minutes

/** Query eligible agents and POST the dream prompt to each. */
export async function runDreamProcess(): Promise<void> {
  const result = await client.execute({
    sql: `SELECT id, management_url, gateway_token
          FROM deployed_agents
          WHERE runtime = 'openclaw'
            AND status = 'running'
            AND management_url IS NOT NULL`,
    args: [],
  });

  const agents = result.rows;
  if (agents.length === 0) {
    console.log('[dream] No eligible OpenClaw agents — skipping');
    return;
  }

  console.log(`[dream] Starting dream process for ${agents.length} agent(s)`);

  for (const agent of agents) {
    const url = `${agent.management_url as string}/chat?session=dream`;
    try {
      await fetch(url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-reins-gateway-token': agent.gateway_token as string,
        },
        body: JSON.stringify({ message: DREAM_PROMPT }),
        signal: AbortSignal.timeout(DREAM_TIMEOUT_MS),
      });
      console.log(`[dream] Triggered agent ${agent.id as string}`);
    } catch (err) {
      console.error(`[dream] Failed to trigger agent ${agent.id as string}:`, err);
    }
  }

  console.log('[dream] Dream process complete');
}

/** Schedule dream to run nightly at 2am UTC using chained setTimeout. */
export function startDreamScheduler(): void {
  function scheduleNext() {
    const now = new Date();
    const next = new Date();
    next.setUTCHours(2, 0, 0, 0);
    if (next <= now) next.setUTCDate(next.getUTCDate() + 1);
    const delayMs = next.getTime() - now.getTime();
    const hoursUntil = Math.round(delayMs / 1000 / 60 / 60 * 10) / 10;
    console.log(`[dream] Next dream session in ${hoursUntil}h (${next.toUTCString()})`);
    setTimeout(async () => {
      await runDreamProcess();
      scheduleNext();
    }, delayMs);
  }
  scheduleNext();
}
