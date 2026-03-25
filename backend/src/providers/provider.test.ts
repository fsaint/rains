/**
 * Provider Abstraction Layer Tests
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// Mock both providers
vi.mock('./fly.js', () => ({
  createApp: vi.fn().mockResolvedValue('reins-test-app'),
  createMachine: vi.fn().mockResolvedValue({ flyMachineId: 'machine-1', flyAppName: 'reins-test-app' }),
  updateMachine: vi.fn().mockResolvedValue({}),
  startMachine: vi.fn().mockResolvedValue(undefined),
  stopMachine: vi.fn().mockResolvedValue(undefined),
  getMachineStatus: vi.fn().mockResolvedValue({ state: 'started' }),
  destroyMachine: vi.fn().mockResolvedValue(undefined),
  destroyApp: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('./docker.js', () => ({
  createLocalContainer: vi.fn().mockResolvedValue({ containerId: 'c1', containerName: 'reins-test', port: 9876 }),
  startLocalContainer: vi.fn().mockResolvedValue(undefined),
  stopLocalContainer: vi.fn().mockResolvedValue(undefined),
  removeLocalContainer: vi.fn().mockResolvedValue(undefined),
  getLocalContainerStatus: vi.fn().mockResolvedValue('running'),
  getLocalContainerPort: vi.fn().mockResolvedValue(9876),
  updateLocalContainer: vi.fn().mockResolvedValue({ containerId: 'c2', containerName: 'reins-test', port: 9877 }),
}));

import * as fly from './fly.js';
import * as docker from './docker.js';

const defaultOpts = {
  instanceId: 'inst-1',
  telegramToken: 'token',
  mcpConfigs: [{ name: 'reins', url: 'https://reins.test/mcp/agent-1' }],
  gatewayToken: 'gw-token-123',
};

describe('Provider Abstraction', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe('Fly.io provider (default)', () => {
    let provider: typeof import('./index.js');

    beforeEach(async () => {
      delete process.env.REINS_PROVIDER;
      vi.resetModules();
      provider = await import('./index.js');
    });

    describe('provision', () => {
      it('should create app and machine on Fly.io', async () => {
        const result = await provider.provision(defaultOpts);

        expect(fly.createApp).toHaveBeenCalledWith('inst-1');
        expect(fly.createMachine).toHaveBeenCalledWith(
          expect.objectContaining({ appName: 'reins-test-app', telegramToken: 'token' })
        );
        expect(result.machineId).toBe('machine-1');
        expect(result.appName).toBe('reins-test-app');
        expect(result.managementUrl).toBe('https://reins-test-app.fly.dev/?token=gw-token-123');
      });
    });

    describe('start', () => {
      it('should call fly.startMachine', async () => {
        await provider.start('app', 'machine');
        expect(fly.startMachine).toHaveBeenCalledWith('app', 'machine');
      });
    });

    describe('stop', () => {
      it('should call fly.stopMachine', async () => {
        await provider.stop('app', 'machine');
        expect(fly.stopMachine).toHaveBeenCalledWith('app', 'machine');
      });
    });

    describe('getStatus', () => {
      it('should map "started" to "running"', async () => {
        vi.mocked(fly.getMachineStatus).mockResolvedValueOnce({ state: 'started' });
        const status = await provider.getStatus('app', 'machine');
        expect(status).toBe('running');
      });

      it('should map "stopped" to "stopped"', async () => {
        vi.mocked(fly.getMachineStatus).mockResolvedValueOnce({ state: 'stopped' });
        const status = await provider.getStatus('app', 'machine');
        expect(status).toBe('stopped');
      });

      it('should pass through other states', async () => {
        vi.mocked(fly.getMachineStatus).mockResolvedValueOnce({ state: 'destroyed' });
        const status = await provider.getStatus('app', 'machine');
        expect(status).toBe('destroyed');
      });
    });

    describe('redeploy', () => {
      it('should call fly.updateMachine and return management URL', async () => {
        const url = await provider.redeploy('app', 'machine', defaultOpts);
        expect(fly.updateMachine).toHaveBeenCalledWith('app', 'machine', expect.any(Object));
        expect(url).toBe('https://app.fly.dev/?token=gw-token-123');
      });
    });

    describe('destroy', () => {
      it('should destroy machine then app', async () => {
        await provider.destroy('app', 'machine');
        expect(fly.destroyMachine).toHaveBeenCalledWith('app', 'machine');
        expect(fly.destroyApp).toHaveBeenCalledWith('app');
      });

      it('should ignore errors during destroy', async () => {
        vi.mocked(fly.destroyMachine).mockRejectedValueOnce(new Error('gone'));
        vi.mocked(fly.destroyApp).mockRejectedValueOnce(new Error('gone'));
        await expect(provider.destroy('app', 'machine')).resolves.toBeUndefined();
      });
    });

    describe('getManagementUrl', () => {
      it('should return Fly.io URL', async () => {
        const url = await provider.getManagementUrl('my-app', 'my-token');
        expect(url).toBe('https://my-app.fly.dev/?token=my-token');
      });
    });
  });

  describe('Local Docker provider', () => {
    let provider: typeof import('./index.js');

    beforeEach(async () => {
      process.env.REINS_PROVIDER = 'local';
      vi.resetModules();
      provider = await import('./index.js');
    });

    afterEach(() => {
      delete process.env.REINS_PROVIDER;
    });

    describe('provision', () => {
      it('should create a local Docker container', async () => {
        const result = await provider.provision(defaultOpts);

        expect(docker.createLocalContainer).toHaveBeenCalledWith(expect.objectContaining({
          instanceId: 'inst-1',
          telegramToken: 'token',
        }));
        expect(result.machineId).toBe('c1');
        expect(result.appName).toBe('reins-test');
        expect(result.managementUrl).toBe('http://localhost:9876/?token=gw-token-123');
      });
    });

    describe('start', () => {
      it('should call docker.startLocalContainer with appName', async () => {
        await provider.start('container-name', 'ignored');
        expect(docker.startLocalContainer).toHaveBeenCalledWith('container-name');
      });
    });

    describe('stop', () => {
      it('should call docker.stopLocalContainer', async () => {
        await provider.stop('container-name', 'ignored');
        expect(docker.stopLocalContainer).toHaveBeenCalledWith('container-name');
      });
    });

    describe('getStatus', () => {
      it('should return Docker container status', async () => {
        vi.mocked(docker.getLocalContainerStatus).mockResolvedValueOnce('running');
        const status = await provider.getStatus('container-name', 'ignored');
        expect(status).toBe('running');
      });
    });

    describe('redeploy', () => {
      it('should recreate container with new config', async () => {
        const url = await provider.redeploy('container-name', 'ignored', defaultOpts);
        expect(docker.updateLocalContainer).toHaveBeenCalledWith(
          expect.objectContaining({ containerName: 'container-name' })
        );
        expect(url).toBe('http://localhost:9877/?token=gw-token-123');
      });
    });

    describe('destroy', () => {
      it('should remove Docker container', async () => {
        await provider.destroy('container-name', 'ignored');
        expect(docker.removeLocalContainer).toHaveBeenCalledWith('container-name');
      });
    });

    describe('getManagementUrl', () => {
      it('should return localhost URL with port', async () => {
        const url = await provider.getManagementUrl('container', 'tok');
        expect(url).toBe('http://localhost:9876/?token=tok');
      });
    });
  });
});
