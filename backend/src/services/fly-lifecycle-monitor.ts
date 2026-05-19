/**
 * Polls Fly.io Machines API for machine lifecycle events and drift detection.
 * There are no Fly webhooks — polling is the only mechanism.
 *
 * Two loops run independently:
 *  - appDiscovery: every FLY_LIFECYCLE_APP_DISCOVERY_MS (default 5 min) — lists all apps in the org
 *  - eventPoll: every FLY_LIFECYCLE_POLL_MS (default 60 s) — fetches machines+events per app
 */

import { auditLogger } from '../audit/logger.js';

const FLY_API_BASE = 'https://api.machines.dev/v1';
const MAX_SEEN_IDS = 100;

interface FlyMachineEvent {
  id: string;
  type: string;
  status: string;
  source: string;
  timestamp: number; // ms epoch
  request?: {
    exit_event?: {
      oom_killed: boolean;
      exit_code: number;
      signal: string | null;
      requested_stop: boolean;
    };
  };
}

interface FlyMachine {
  id: string;
  state: string;
  events?: FlyMachineEvent[];
}

function token(): string {
  const t = process.env.FLY_API_TOKEN;
  if (!t) throw new Error('FLY_API_TOKEN not set');
  return t;
}

async function flyFetch(path: string): Promise<Response> {
  return fetch(`${FLY_API_BASE}${path}`, {
    headers: { Authorization: `Bearer ${token()}` },
  });
}

async function listAppsForOrg(orgSlug: string): Promise<string[]> {
  const res = await fetch('https://api.fly.io/graphql', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${token()}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      query: `{ organization(slug: "${orgSlug}") { apps { nodes { name } } } }`,
    }),
  });
  const json = await res.json() as { data?: { organization?: { apps?: { nodes?: Array<{ name: string }> } } } };
  return json.data?.organization?.apps?.nodes?.map((n) => n.name) ?? [];
}

async function getMachinesWithEvents(appName: string): Promise<FlyMachine[]> {
  const res = await flyFetch(`/apps/${appName}/machines`);
  if (!res.ok) throw new Error(`Fly API ${res.status} for ${appName}`);
  return res.json() as Promise<FlyMachine[]>;
}

// Caps a Set at maxSize by removing oldest entries (insertion-order).
function capSet(s: Set<string>, maxSize: number): void {
  const overflow = s.size - maxSize;
  if (overflow <= 0) return;
  const iter = s.values();
  for (let i = 0; i < overflow; i++) { const v = iter.next().value; if (v !== undefined) s.delete(v); }
}

class FlyLifecycleMonitor {
  private discoveryTimer: ReturnType<typeof setInterval> | null = null;
  private pollTimer: ReturnType<typeof setInterval> | null = null;

  private apps: string[] = [];
  private seenEventIds = new Map<string, Set<string>>(); // machineId -> Set<eventId>
  private prevMachineSet = new Set<string>();            // "app:machineId"
  private firstTick = true;

  private orgSlug(): string {
    return process.env.FLY_LIFECYCLE_ORG_SLUG ?? 'personal';
  }

  private pollMs(): number {
    return parseInt(process.env.FLY_LIFECYCLE_POLL_MS ?? '60000', 10);
  }

  private discoveryMs(): number {
    return parseInt(process.env.FLY_LIFECYCLE_APP_DISCOVERY_MS ?? '300000', 10);
  }

  start(): void {
    if (this.discoveryTimer) return; // already running

    const discover = async () => {
      try {
        this.apps = await listAppsForOrg(this.orgSlug());
        console.log(`[fly-lifecycle] discovered ${this.apps.length} apps`);
      } catch (err) {
        console.warn('[fly-lifecycle] app discovery failed:', err instanceof Error ? err.message : err);
      }
    };

    const poll = async () => {
      if (this.apps.length === 0) return;

      const currentMachineSet = new Set<string>();
      let newEvents = 0;

      for (const app of this.apps) {
        try {
          const machines = await getMachinesWithEvents(app);

          for (const machine of machines) {
            const key = `${app}:${machine.id}`;
            currentMachineSet.add(key);

            if (!this.seenEventIds.has(machine.id)) {
              this.seenEventIds.set(machine.id, new Set());
            }
            const seen = this.seenEventIds.get(machine.id)!;

            for (const ev of machine.events ?? []) {
              const dedupeKey = ev.id || `${machine.id}:${ev.timestamp}:${ev.type}`;
              if (seen.has(dedupeKey)) continue;
              seen.add(dedupeKey);
              capSet(seen, MAX_SEEN_IDS);

              const exit = ev.request?.exit_event;
              await auditLogger.logFlyLifecycle({
                app,
                machineId: machine.id,
                flyEventType: ev.type,
                flyEventId: dedupeKey,
                source: ev.source,
                timestampMs: ev.timestamp,
                exit: exit
                  ? { oomKilled: exit.oom_killed, exitCode: exit.exit_code, signal: exit.signal }
                  : undefined,
              }).catch((e) => console.warn('[fly-lifecycle] log write failed:', e instanceof Error ? e.message : e));
              newEvents++;
            }
          }
        } catch (err) {
          console.warn(`[fly-lifecycle] poll failed for ${app}:`, err instanceof Error ? err.message : err);
        }
      }

      // Drift detection: skip on the very first tick to avoid a startup flood.
      if (!this.firstTick) {
        for (const key of this.prevMachineSet) {
          if (!currentMachineSet.has(key)) {
            const colonIdx = key.indexOf(':');
            const app = key.slice(0, colonIdx);
            const machineId = key.slice(colonIdx + 1);
            // Only log VANISHED if no destroy event was recently seen
            const seen = this.seenEventIds.get(machineId);
            const hasDestroyEvent = seen && [...seen].some((id) => id.includes(':destroy:') || id.endsWith(':destroy'));
            if (!hasDestroyEvent) {
              await auditLogger.logFlyLifecycle({
                app,
                machineId,
                flyEventType: 'vanished',
                flyEventId: `vanished:${machineId}:${Date.now()}`,
                source: 'monitor',
                timestampMs: Date.now(),
              }).catch(() => {});
              console.warn(`[fly-lifecycle] VANISHED: ${key}`);
            }
          }
        }
      }

      this.firstTick = false;
      this.prevMachineSet = currentMachineSet;

      if (newEvents > 0) {
        console.log(`[fly-lifecycle] tick: ${newEvents} new events recorded`);
      }
    };

    // Kick off discovery immediately, then on schedule
    discover().then(() => poll());
    this.discoveryTimer = setInterval(discover, this.discoveryMs());
    this.pollTimer = setInterval(poll, this.pollMs());
  }

  stop(): void {
    if (this.discoveryTimer) { clearInterval(this.discoveryTimer); this.discoveryTimer = null; }
    if (this.pollTimer) { clearInterval(this.pollTimer); this.pollTimer = null; }
  }
}

export const flyLifecycleMonitor = new FlyLifecycleMonitor();
