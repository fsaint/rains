/**
 * Provider Abstraction Layer Tests
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

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

import * as fly from './fly.js';
import * as provider from './index.js';

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
