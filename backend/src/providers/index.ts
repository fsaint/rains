/**
 * Provider abstraction layer.
 * Routes provisioning calls to either Fly.io (production) or local Docker (development).
 * Selected via REINS_PROVIDER env var: "fly" | "local" (default: "fly")
 */

import * as fly from './fly.js';
import * as docker from './docker.js';

const isLocal = process.env.REINS_PROVIDER === 'local';

export interface ProvisionResult {
  machineId: string;
  appName: string;
  managementUrl: string;
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
}

export async function provision(opts: ProvisionOpts): Promise<ProvisionResult> {
  if (isLocal) {
    const result = await docker.createLocalContainer(opts);
    return {
      machineId: result.containerId,
      appName: result.containerName,
      managementUrl: `http://localhost:${result.port}/?token=${opts.gatewayToken}`,
    };
  }

  const appName = await fly.createApp(opts.instanceId);
  const { flyMachineId } = await fly.createMachine({ appName, ...opts });
  return {
    machineId: flyMachineId,
    appName,
    managementUrl: `https://${appName}.fly.dev/?token=${opts.gatewayToken}`,
  };
}

export async function start(appName: string, machineId: string) {
  if (isLocal) {
    await docker.startLocalContainer(appName);
  } else {
    await fly.startMachine(appName, machineId);
  }
}

export async function stop(appName: string, machineId: string) {
  if (isLocal) {
    await docker.stopLocalContainer(appName);
  } else {
    await fly.stopMachine(appName, machineId);
  }
}

export async function getStatus(appName: string, machineId: string): Promise<string> {
  if (isLocal) {
    return docker.getLocalContainerStatus(appName);
  }
  const machine = await fly.getMachineStatus(appName, machineId);
  const state = machine.state as string;
  return state === 'started' ? 'running' : state === 'stopped' ? 'stopped' : state;
}

export async function redeploy(
  appName: string,
  machineId: string,
  opts: ProvisionOpts
): Promise<string> {
  if (isLocal) {
    const result = await docker.updateLocalContainer({
      ...opts,
      containerName: appName,
    });
    return `http://localhost:${result.port}/?token=${opts.gatewayToken}`;
  }

  await fly.updateMachine(appName, machineId, opts);
  return `https://${appName}.fly.dev/?token=${opts.gatewayToken}`;
}

export async function destroy(appName: string, machineId: string) {
  if (isLocal) {
    await docker.removeLocalContainer(appName);
  } else {
    try { await fly.destroyMachine(appName, machineId); } catch { /* ignore */ }
    try { await fly.destroyApp(appName); } catch { /* ignore */ }
  }
}

export async function getManagementUrl(appName: string, gatewayToken: string): Promise<string> {
  if (isLocal) {
    const port = await docker.getLocalContainerPort(appName);
    return `http://localhost:${port}/?token=${gatewayToken}`;
  }
  return `https://${appName}.fly.dev/?token=${gatewayToken}`;
}
