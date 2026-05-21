/**
 * Agent Backup Service tests
 *
 * Focuses on the cron file snapshot / restore behaviour added in v2.
 * DB tables and filesystem writes are fully mocked so these tests run offline.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

// vi.mock factories are hoisted before variable declarations, so use vi.hoisted()
// to define mocks that can be referenced inside the factory.
const {
  mockWriteFile,
  mockReadFile,
  mockReaddir,
  mockStat,
  mockMkdir,
  mockUnlink,
  mockClientExecute,
  mockSqlBegin,
  mockExecOnMachine,
} = vi.hoisted(() => ({
  mockWriteFile: vi.fn().mockResolvedValue(undefined),
  mockReadFile: vi.fn(),
  mockReaddir: vi.fn().mockResolvedValue([]),
  mockStat: vi.fn().mockResolvedValue({ size: 1234, mtimeMs: Date.now() }),
  mockMkdir: vi.fn().mockResolvedValue(undefined),
  mockUnlink: vi.fn().mockResolvedValue(undefined),
  mockClientExecute: vi.fn(),
  mockSqlBegin: vi.fn(),
  mockExecOnMachine: vi.fn(),
}));

vi.mock('fs/promises', () => ({
  mkdir: mockMkdir,
  writeFile: mockWriteFile,
  readFile: mockReadFile,
  readdir: mockReaddir,
  stat: mockStat,
  unlink: mockUnlink,
}));

vi.mock('../db/index.js', () => ({
  client: { execute: mockClientExecute },
  sql: { begin: mockSqlBegin },
}));

vi.mock('../providers/fly.js', () => ({
  execOnMachine: mockExecOnMachine,
}));

import { performBackup, restoreBackup, type AgentBackup } from './agent-backup.js';

// --- Helpers -----------------------------------------------------------------

const EMPTY_RESULT = { rows: [], columns: [], rowsAffected: 0, lastInsertRowid: 0n };

function makeDeployedAgentRow(overrides: Record<string, unknown> = {}) {
  return {
    id: 'dep-1',
    fly_app_name: 'my-agent-app',
    fly_machine_id: 'machine-abc',
    fly_volume_id: 'vol-xyz',
    ...overrides,
  };
}

function buildV2Backup(agentFiles?: Record<string, string>): AgentBackup {
  return {
    version: '2',
    createdAt: '2026-05-21T00:00:00.000Z',
    agents: [{ id: 'agent-1' }],
    deployedAgents: [makeDeployedAgentRow()],
    agentServiceInstances: [],
    agentToolPermissions: [],
    agentServiceCredentials: [],
    credentials: [],
    policies: [],
    ...(agentFiles ? { agentFiles } : {}),
  };
}

// Set up the seven-table query mocks in order
function setupDbForBackup(daRows: unknown[] = []) {
  mockClientExecute
    .mockResolvedValueOnce({ rows: [{ id: 'agent-1' }] })   // agents
    .mockResolvedValueOnce({ rows: daRows })                  // deployed_agents
    .mockResolvedValueOnce(EMPTY_RESULT)                      // instances
    .mockResolvedValueOnce(EMPTY_RESULT)                      // tool_permissions
    .mockResolvedValueOnce(EMPTY_RESULT)                      // service_credentials
    .mockResolvedValueOnce(EMPTY_RESULT)                      // credentials
    .mockResolvedValueOnce(EMPTY_RESULT);                     // policies
}

// -----------------------------------------------------------------------------

describe('performBackup — cron file snapshotting', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockMkdir.mockResolvedValue(undefined);
    mockWriteFile.mockResolvedValue(undefined);
    mockStat.mockResolvedValue({ size: 9999, mtimeMs: Date.now() });
    mockReaddir.mockResolvedValue([]);
  });

  it('calls execOnMachine with the tar command for each deployed agent', async () => {
    setupDbForBackup([makeDeployedAgentRow()]);
    mockExecOnMachine.mockResolvedValue({ stdout: 'H4sIbase64bundle==', stderr: '', exitCode: 0 });

    await performBackup();

    expect(mockExecOnMachine).toHaveBeenCalledTimes(1);
    const [appName, machineId, command] = mockExecOnMachine.mock.calls[0] as [string, string, string[]];
    expect(appName).toBe('my-agent-app');
    expect(machineId).toBe('machine-abc');
    expect(command[0]).toBe('sh');
    expect(command[2]).toContain('tar czf');
    expect(command[2]).toContain('/home/node/.openclaw');
    expect(command[2]).toContain('cron/jobs.json');
    expect(command[2]).toContain('base64');
  });

  it('includes agentFiles in the written backup JSON', async () => {
    setupDbForBackup([makeDeployedAgentRow()]);
    mockExecOnMachine.mockResolvedValue({ stdout: 'BUNDLE==', stderr: '', exitCode: 0 });

    await performBackup();

    const written = mockWriteFile.mock.calls[0][1] as string;
    const parsed = JSON.parse(written) as AgentBackup;
    expect(parsed.version).toBe('2');
    expect(parsed.agentFiles).toBeDefined();
    expect(parsed.agentFiles!['dep-1']).toBe('BUNDLE==');
  });

  it('skips an agent when exec fails and does not fail the whole backup', async () => {
    setupDbForBackup([makeDeployedAgentRow()]);
    mockExecOnMachine.mockRejectedValue(new Error('machine stopped'));

    await expect(performBackup()).resolves.not.toThrow();

    const written = mockWriteFile.mock.calls[0][1] as string;
    const parsed = JSON.parse(written) as AgentBackup;
    expect(parsed.agentFiles).toBeUndefined();
  });

  it('skips agents missing fly_machine_id without calling exec', async () => {
    setupDbForBackup([makeDeployedAgentRow({ fly_machine_id: null })]);

    await performBackup();

    expect(mockExecOnMachine).not.toHaveBeenCalled();
  });

  it('skips agents missing fly_app_name without calling exec', async () => {
    setupDbForBackup([makeDeployedAgentRow({ fly_app_name: null })]);

    await performBackup();

    expect(mockExecOnMachine).not.toHaveBeenCalled();
  });
});

// -----------------------------------------------------------------------------

describe('restoreBackup — cron file restoration', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockMkdir.mockResolvedValue(undefined);
    mockWriteFile.mockResolvedValue(undefined);
    mockStat.mockResolvedValue({ size: 1, mtimeMs: Date.now() });
    mockReaddir.mockResolvedValue([]);
    mockClientExecute.mockResolvedValue(EMPTY_RESULT);
    mockSqlBegin.mockImplementation(async (fn: (tx: unknown) => Promise<void>) => {
      await fn({ unsafe: vi.fn().mockResolvedValue(undefined) });
    });
  });

  it('pushes cron bundle to the machine after the DB restore', async () => {
    const backupWithFiles = buildV2Backup({ 'dep-1': 'BUNDLE==' });
    mockReadFile.mockResolvedValue(JSON.stringify(backupWithFiles));

    // First exec: readiness probe; second: tar extract
    mockExecOnMachine
      .mockResolvedValueOnce({ stdout: '', stderr: '', exitCode: 0 })
      .mockResolvedValueOnce({ stdout: '', stderr: '', exitCode: 0 });

    await restoreBackup('2026-05-21_00-00-00');

    expect(mockExecOnMachine).toHaveBeenCalledTimes(2);
    const [appName, machineId, command, opts] = mockExecOnMachine.mock.calls[1] as [
      string,
      string,
      string[],
      { stdin?: string }
    ];
    expect(appName).toBe('my-agent-app');
    expect(machineId).toBe('machine-abc');
    expect(command[2]).toContain('base64 -d');
    expect(command[2]).toContain('tar xzf');
    expect(command[2]).toContain('/home/node/.openclaw');
    expect(opts.stdin).toBe('BUNDLE==');
  });

  it('does not call execOnMachine for a v1 backup without agentFiles', async () => {
    const v1Backup: AgentBackup = { ...buildV2Backup(), version: '1', agentFiles: undefined };
    mockReadFile.mockResolvedValue(JSON.stringify(v1Backup));

    await restoreBackup('2026-05-21_00-00-00');

    expect(mockExecOnMachine).not.toHaveBeenCalled();
  });

  it('skips cron restore gracefully when exec throws', async () => {
    vi.useFakeTimers();
    const backupWithFiles = buildV2Backup({ 'dep-1': 'BUNDLE==' });
    mockReadFile.mockResolvedValue(JSON.stringify(backupWithFiles));
    mockExecOnMachine.mockRejectedValue(new Error('connection refused'));

    const restorePromise = restoreBackup('2026-05-21_00-00-00');
    // Fast-forward through the 12 × 5s readiness poll attempts
    await vi.runAllTimersAsync();
    await expect(restorePromise).resolves.not.toThrow();

    vi.useRealTimers();
  });

  it('skips cron restore when deployment has no machine info in the backup', async () => {
    const backup = buildV2Backup({ 'unknown-dep': 'BUNDLE==' });
    mockReadFile.mockResolvedValue(JSON.stringify(backup));

    await restoreBackup('2026-05-21_00-00-00');

    expect(mockExecOnMachine).not.toHaveBeenCalled();
  });
});
