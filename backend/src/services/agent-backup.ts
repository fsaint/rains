/**
 * Agent Backup Service
 *
 * Backs up all agent configuration and state every 24 hours.
 * Backed-up data includes:
 *   - agents (core metadata)
 *   - deployed_agents (deployment config, soul, MCP config)
 *   - agent_service_instances (service access slots)
 *   - agent_tool_permissions (per-tool permission overrides)
 *   - agent_service_credentials (credential linkages)
 *   - credentials (encrypted blobs — safe to back up as-is)
 *   - policies (YAML policy definitions)
 *
 * Backups are written as JSON files to the configured backup directory.
 * Old backups beyond the retention window are pruned automatically.
 */

import { mkdir, readdir, writeFile, readFile, unlink, stat } from 'fs/promises';
import { join } from 'path';
import { client, sql } from '../db/index.js';
import { execOnMachine } from '../providers/fly.js';

const BACKUP_VERSION = '2';
const INTERVAL_MS = 24 * 60 * 60 * 1000; // 24 hours

/**
 * Base directory for agent-side file snapshots (the .openclaw config dir).
 * The Fly volume is mounted at $OPENCLAW_STATE_DIR/agents/ only — everything
 * else in this directory (including cron/) is ephemeral and must be backed up.
 */
const OPENCLAW_DIR = '/home/node/.openclaw';

/**
 * Paths relative to OPENCLAW_DIR to include in the cron file snapshot.
 * jobs.json is the live cron store; jobs.json.bak is its last-good backup.
 * Discovered by reading /app/dist/store-0nH_zmSJ.js on a live agent machine:
 *   resolveDefaultCronStorePath() → path.join(resolveConfigDir(), 'cron', 'jobs.json')
 */
const CRON_PATHS = [
  'cron/jobs.json',
  'cron/jobs.json.bak',
] as const;

let backupInterval: ReturnType<typeof setInterval> | null = null;

export interface BackupMetadata {
  id: string;
  filename: string;
  createdAt: string;
  sizeBytes: number;
  agentCount: number;
}

export interface AgentBackup {
  version: string;
  createdAt: string;
  agents: unknown[];
  deployedAgents: unknown[];
  agentServiceInstances: unknown[];
  agentToolPermissions: unknown[];
  agentServiceCredentials: unknown[];
  credentials: unknown[];
  policies: unknown[];
  /**
   * Agent-side file snapshots keyed by deployment ID.
   * Value is a base64-encoded tar.gz of CRON_PATHS from the agent's state dir.
   * Only present in backups with version >= '2'.
   */
  agentFiles?: Record<string, string>;
}

function getBackupDir(): string {
  return process.env.REINS_BACKUP_DIR ?? join(process.cwd(), 'data', 'backups');
}

function getRetentionDays(): number {
  const val = parseInt(process.env.REINS_BACKUP_RETENTION_DAYS ?? '7', 10);
  return isNaN(val) || val < 1 ? 7 : val;
}

/**
 * Perform a full agent backup. Returns the backup metadata.
 */
export async function performBackup(): Promise<BackupMetadata> {
  const backupDir = getBackupDir();
  await mkdir(backupDir, { recursive: true });

  const [
    agentsResult,
    deployedAgentsResult,
    instancesResult,
    toolPermsResult,
    serviceCredsResult,
    credentialsResult,
    policiesResult,
  ] = await Promise.all([
    client.execute('SELECT * FROM agents'),
    client.execute('SELECT * FROM deployed_agents'),
    client.execute('SELECT * FROM agent_service_instances'),
    client.execute('SELECT * FROM agent_tool_permissions'),
    client.execute('SELECT * FROM agent_service_credentials'),
    client.execute('SELECT * FROM credentials'),
    client.execute('SELECT * FROM policies'),
  ]);

  const createdAt = new Date().toISOString();
  const id = createdAt.replace(/[:.]/g, '-').replace('T', '_').slice(0, 19);

  // Snapshot cron files from each running agent machine
  const agentFiles: Record<string, string> = {};
  for (const row of deployedAgentsResult.rows) {
    const da = row as Record<string, unknown>;
    const deploymentId = da['id'] as string | undefined;
    const appName = da['fly_app_name'] as string | undefined;
    const machineId = da['fly_machine_id'] as string | undefined;
    if (!deploymentId || !appName || !machineId) continue;

    try {
      const { stdout, exitCode } = await execOnMachine(
        appName,
        machineId,
        [
          'sh', '-c',
          `tar czf - --ignore-failed-read -C ${OPENCLAW_DIR} ${CRON_PATHS.join(' ')} 2>/dev/null | base64`,
        ],
        { timeout: 30 }
      );
      if (exitCode !== 0 || !stdout.trim()) {
        console.warn(`[backup] No cron files found for deployment ${deploymentId} (exit ${exitCode})`);
        continue;
      }
      agentFiles[deploymentId] = stdout.trim();
    } catch (err) {
      console.warn(`[backup] Skipping cron snapshot for deployment ${deploymentId}: ${(err as Error).message}`);
    }
  }

  const backup: AgentBackup = {
    version: BACKUP_VERSION,
    createdAt,
    agents: agentsResult.rows,
    deployedAgents: deployedAgentsResult.rows,
    agentServiceInstances: instancesResult.rows,
    agentToolPermissions: toolPermsResult.rows,
    agentServiceCredentials: serviceCredsResult.rows,
    credentials: credentialsResult.rows,
    policies: policiesResult.rows,
    ...(Object.keys(agentFiles).length > 0 ? { agentFiles } : {}),
  };

  const filename = `backup-${id}.json`;
  const filepath = join(backupDir, filename);
  await writeFile(filepath, JSON.stringify(backup, null, 2), 'utf8');

  const fileStat = await stat(filepath);

  // Prune old backups
  await pruneOldBackups(backupDir);

  const metadata: BackupMetadata = {
    id,
    filename,
    createdAt,
    sizeBytes: fileStat.size,
    agentCount: agentsResult.rows.length,
  };

  console.log(`[backup] Wrote ${filename} (${backup.agents.length} agents, ${fileStat.size} bytes)`);
  return metadata;
}

/**
 * List all backups, most recent first.
 */
export async function listBackups(): Promise<BackupMetadata[]> {
  const backupDir = getBackupDir();
  await mkdir(backupDir, { recursive: true });

  const files = await readdir(backupDir);
  const backupFiles = files.filter((f) => f.startsWith('backup-') && f.endsWith('.json'));

  const metadatas: BackupMetadata[] = [];
  for (const filename of backupFiles) {
    const filepath = join(backupDir, filename);
    try {
      const fileStat = await stat(filepath);
      const raw = await readFile(filepath, 'utf8');
      const parsed = JSON.parse(raw) as AgentBackup;
      const id = filename.replace(/^backup-/, '').replace(/\.json$/, '');
      metadatas.push({
        id,
        filename,
        createdAt: parsed.createdAt,
        sizeBytes: fileStat.size,
        agentCount: parsed.agents?.length ?? 0,
      });
    } catch {
      // Skip corrupt/unreadable files
    }
  }

  return metadatas.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
}

/**
 * Load a specific backup by ID.
 */
export async function getBackup(id: string): Promise<AgentBackup | null> {
  const backupDir = getBackupDir();
  const filename = `backup-${id}.json`;
  const filepath = join(backupDir, filename);
  try {
    const raw = await readFile(filepath, 'utf8');
    return JSON.parse(raw) as AgentBackup;
  } catch {
    return null;
  }
}

/**
 * Delete backups older than the retention window.
 */
async function pruneOldBackups(backupDir: string): Promise<void> {
  const retentionDays = getRetentionDays();
  const cutoff = Date.now() - retentionDays * 24 * 60 * 60 * 1000;

  const files = await readdir(backupDir);
  const backupFiles = files.filter((f) => f.startsWith('backup-') && f.endsWith('.json'));

  for (const filename of backupFiles) {
    const filepath = join(backupDir, filename);
    try {
      const fileStat = await stat(filepath);
      if (fileStat.mtimeMs < cutoff) {
        await unlink(filepath);
        console.log(`[backup] Pruned old backup: ${filename}`);
      }
    } catch {
      // Ignore
    }
  }
}

export interface RestoreResult {
  safetyBackupId: string;
  restored: {
    credentials: number;
    policies: number;
    agents: number;
    deployedAgents: number;
    agentServiceInstances: number;
    agentToolPermissions: number;
    agentServiceCredentials: number;
  };
}

/**
 * Restore all agent data from a backup snapshot.
 *
 * Takes an automatic safety backup first, then replaces the contents of all
 * backed-up tables with the data from the specified backup inside a single
 * PostgreSQL transaction. On error the transaction is rolled back and the
 * database is left untouched.
 */
export async function restoreBackup(id: string): Promise<RestoreResult> {
  const backup = await getBackup(id);
  if (!backup) throw new Error(`Backup not found: ${id}`);

  // Take a pre-restore safety snapshot so the current state is recoverable
  const safety = await performBackup();

  // Helper: INSERT all rows for one table inside the transaction
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  async function insertRows(tx: any, table: string, rows: unknown[]): Promise<void> {
    for (const row of rows) {
      const r = row as Record<string, unknown>;
      const cols = Object.keys(r);
      if (cols.length === 0) continue;
      const placeholders = cols.map((_, i) => `$${i + 1}`).join(', ');
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      await tx.unsafe(
        `INSERT INTO ${table} (${cols.join(', ')}) VALUES (${placeholders})`,
        Object.values(r) as any[]
      );
    }
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  await sql.begin(async (tx: any) => {
    // Clear in reverse FK order
    await tx.unsafe('DELETE FROM agent_tool_permissions');
    await tx.unsafe('DELETE FROM agent_service_credentials');
    await tx.unsafe('DELETE FROM agent_service_instances');
    await tx.unsafe('DELETE FROM deployed_agents');
    await tx.unsafe('DELETE FROM agents');
    await tx.unsafe('DELETE FROM credentials');
    await tx.unsafe('DELETE FROM policies');

    // Re-insert in FK order
    await insertRows(tx, 'credentials',               backup.credentials);
    await insertRows(tx, 'policies',                  backup.policies);
    await insertRows(tx, 'agents',                    backup.agents);
    await insertRows(tx, 'deployed_agents',           backup.deployedAgents);
    await insertRows(tx, 'agent_service_instances',   backup.agentServiceInstances);
    await insertRows(tx, 'agent_tool_permissions',    backup.agentToolPermissions);
    await insertRows(tx, 'agent_service_credentials', backup.agentServiceCredentials);
  });

  // Restore cron files to agent machines (version 2+ backups only)
  if (backup.agentFiles && Object.keys(backup.agentFiles).length > 0) {
    for (const [deploymentId, bundle] of Object.entries(backup.agentFiles)) {
      const da = (backup.deployedAgents as Array<Record<string, unknown>>)
        .find((r) => r['id'] === deploymentId);
      const appName = da?.['fly_app_name'] as string | undefined;
      const machineId = da?.['fly_machine_id'] as string | undefined;
      if (!appName || !machineId) {
        console.warn(`[backup] No machine info for deployment ${deploymentId} — skipping cron restore`);
        continue;
      }

      // Wait up to 60s for the machine to be started before pushing files
      let ready = false;
      for (let attempt = 0; attempt < 12; attempt++) {
        try {
          const { exitCode } = await execOnMachine(appName, machineId, ['true'], { timeout: 5 });
          if (exitCode === 0) { ready = true; break; }
        } catch { /* not ready yet */ }
        await new Promise((r) => setTimeout(r, 5000));
      }
      if (!ready) {
        console.warn(`[backup] Machine ${machineId} not ready after 60s — skipping cron restore for ${deploymentId}`);
        continue;
      }

      try {
        const { exitCode, stderr } = await execOnMachine(
          appName,
          machineId,
          ['sh', '-c', `base64 -d | tar xzf - -C ${OPENCLAW_DIR}`],
          { timeout: 30, stdin: bundle }
        );
        if (exitCode !== 0) {
          console.warn(`[backup] Cron restore failed for ${deploymentId} (exit ${exitCode}): ${stderr}`);
        } else {
          console.log(`[backup] Restored cron files for deployment ${deploymentId}`);
        }
      } catch (err) {
        console.warn(`[backup] Cron restore error for ${deploymentId}: ${(err as Error).message}`);
      }
    }
  }

  console.log(`[backup] Restored from ${id} (safety backup: ${safety.id})`);

  return {
    safetyBackupId: safety.id,
    restored: {
      credentials:            backup.credentials.length,
      policies:               backup.policies.length,
      agents:                 backup.agents.length,
      deployedAgents:         backup.deployedAgents.length,
      agentServiceInstances:  backup.agentServiceInstances.length,
      agentToolPermissions:   backup.agentToolPermissions.length,
      agentServiceCredentials: backup.agentServiceCredentials.length,
    },
  };
}

/**
 * Start the 24-hour backup loop. Runs once immediately, then every 24 hours.
 */
export function startBackupLoop(): void {
  performBackup().catch((err) => {
    console.error('[backup] Initial backup failed:', err);
  });

  backupInterval = setInterval(async () => {
    try {
      await performBackup();
    } catch (err) {
      console.error('[backup] Scheduled backup failed:', err);
    }
  }, INTERVAL_MS);
}

/**
 * Stop the backup loop.
 */
export function stopBackupLoop(): void {
  if (backupInterval) {
    clearInterval(backupInterval);
    backupInterval = null;
  }
}
