/**
 * Dream scheduler — nightly memory consolidation for deployed agents.
 *
 * At 2am UTC, queries all running agents with a management URL and POSTs a
 * dream prompt to each agent's isolated /chat?session=dream endpoint. The agent
 * uses memory MCP tools (memory_dream, memory_set_parent, memory_update) to
 * reorganize and reflect on its memory vault.
 *
 * The push is runtime-agnostic, so both openclaw and hermes agents are
 * eligible. Agents with no deployed runtime (MCP-only) have no management_url
 * and cannot be reached this way at all — they rely on the per-turn memory
 * instructions in SOUL.md / knowledge.md instead.
 */

import { client } from '../db/index.js';

const DREAM_PROMPT = `You are entering a memory dream session. Work through your memory vault systematically:

0. Call memory_list_scopes. Your vault is divided into scopes — separate compartments that never mix. Work through ONE SCOPE AT A TIME, repeating steps 1-7 for each, and never treat entries from different scopes as related. Two entries with the same title in different scopes are different things.
1. Call memory_dream with that scope to get its manifest. Every row is labelled with its scope; if you ever see a scope you are not currently working on, skip that row.
2. Review the structure — identify entries that belong under a different parent, orphaned notes, and logical groupings.
3. Use memory_set_parent to reorganize entries into a clear hierarchy. It cannot move an entry into a different scope and will refuse the attempt — do not work around this. If an entry is filed in the wrong scope, note it in that scope's index and tell the user; only they can move it. STRUCTURAL ENTRIES ARE OFF LIMITS: never reparent, retitle, or merge "Helm Operating Map" or any entry parented to it (Memory Conventions, Area / Project Registry, Email Routing Table, Calendar Rules, Meeting Filing Rules). Skills read those pages by title, so moving one silently breaks them.
4. Search for duplicates or closely related entries with memory_search, passing the scope you are working on. Merge them by copying content into the fuller entry with memory_update, then registering the other entry's title as an alias on it (memory_add_attribute, type="label", name="alias"). Do NOT call memory_delete — it is a blocked tool and the call will be refused. Leave the emptied entry in place and note the merge in your final report.
5. Scan for probable aliases — entries of the same type whose titles are substrings, prefixes, or share ≥ 2 tokens with another entry (e.g. "Felipe" vs "Felipe Saint-Jean"). Duplicates only ever exist within one scope, so do not hunt for them across scopes; you could not merge them anyway. For each such pair:
   - If you are confident they refer to the same real-world entity → merge as described in step 4: content into the canonical entry, other title registered as an alias.
   - If unsure → keep both, but call memory_add_attribute on the longer/more complete entry with type="label", name="alias", value=<the shorter name>. Future creates that mention either name will then resolve to the canonical entry automatically.
6. For entries containing factual claims about a real-world entity (person, company, project), check whether they carry a source attribute (name="source"). If not, either (a) call memory_add_attribute with name="source", value="inferred" to mark the origin, or (b) call memory_add_attribute with name="unverified", value="true" if you suspect the fact may be wrong. This helps future reviews distinguish confirmed from speculative facts.
7. Update THAT SCOPE'S index entry with memory_update to reflect: the key people, projects, and notes in that scope, and a brief reflection on what you have learned recently. memory_get_root returns one index per scope — update each one from its own scope's contents only.

Be decisive. Work through every scope and all of its entries. When done, stop.`;

const DREAM_TIMEOUT_MS = 5 * 60 * 1000; // 5 minutes

/** Query eligible agents and POST the dream prompt to each. */
export async function runDreamProcess(): Promise<void> {
  const result = await client.execute({
    sql: `SELECT id, management_url, gateway_token
          FROM deployed_agents
          WHERE status = 'running'
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
