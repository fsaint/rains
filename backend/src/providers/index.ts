/**
 * Provider abstraction layer — Fly.io only.
 * Uses FLY_ORG to target the correct org (dev vs production).
 */

import * as fly from './fly.js';

export interface ProvisionResult {
  machineId: string;
  appName: string;
  managementUrl: string;
}

export interface TopicPrompt {
  threadId: number;
  prompt: string;
}

export interface TelegramGroup {
  chatId: string;
  name?: string;
  requireMention?: boolean;
  allowFrom?: string[];
  topicPrompts?: TopicPrompt[];
}

export interface ProvisionOpts {
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
  telegramGroups?: TelegramGroup[];
  modelCredentials?: string;
  thinkingDefault?: string;
  webhookRelaySecret?: string;
  runtime?: 'openclaw' | 'hermes';
}

export async function provision(opts: ProvisionOpts): Promise<ProvisionResult> {
  const appName = await fly.createApp(opts.instanceId);
  const { flyMachineId } = await fly.createMachine({ appName, ...opts });
  return {
    machineId: flyMachineId,
    appName,
    managementUrl: `https://${appName}.fly.dev/?token=${opts.gatewayToken}`,
  };
}

export async function start(appName: string, machineId: string) {
  await fly.startMachine(appName, machineId);
}

export async function stop(appName: string, machineId: string) {
  await fly.stopMachine(appName, machineId);
}

export async function restart(appName: string, machineId: string) {
  await fly.restartMachine(appName, machineId);
}

export async function getStatus(appName: string, machineId: string): Promise<string> {
  const machine = await fly.getMachineStatus(appName, machineId);
  const state = machine.state as string;
  return state === 'started' ? 'running' : state === 'stopped' ? 'stopped' : state;
}

export async function redeploy(
  appName: string,
  machineId: string,
  opts: ProvisionOpts
): Promise<string> {
  await fly.updateMachine(appName, machineId, opts);
  return `https://${appName}.fly.dev/?token=${opts.gatewayToken}`;
}

export async function updateEnv(
  appName: string,
  machineId: string,
  envUpdates: Record<string, string | undefined>
): Promise<void> {
  return fly.updateMachineEnv(appName, machineId, envUpdates);
}

export async function destroy(appName: string, machineId: string) {
  try { await fly.destroyMachine(appName, machineId); } catch { /* ignore */ }
  try { await fly.destroyApp(appName); } catch { /* ignore */ }
}

export interface LogEntry {
  timestamp: string;
  message: string;
  level: string;
  instance: string;
  region: string;
}

export async function getLogs(appName: string, nextToken?: string): Promise<{ logs: LogEntry[]; nextToken?: string }> {
  return fly.getAppLogs(appName, nextToken);
}

export async function getManagementUrl(appName: string, gatewayToken: string): Promise<string> {
  return `https://${appName}.fly.dev/?token=${gatewayToken}`;
}
