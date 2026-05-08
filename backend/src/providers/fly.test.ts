/**
 * Fly.io Provider Tests
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// Save original env
const originalEnv = { ...process.env };

describe('Fly Provider', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    process.env.FLY_API_TOKEN = 'test-fly-token';
    process.env.FLY_ORG = 'test-org';
    process.env.OPENCLAW_IMAGE = 'test-image:latest';
    process.env.ANTHROPIC_API_KEY = 'sk-test-key';
    process.env.REINS_PUBLIC_URL = 'https://reins.test.com';
  });

  afterEach(() => {
    process.env = { ...originalEnv };
    vi.restoreAllMocks();
  });

  describe('createApp', () => {
    it('should create a Fly app with reins- prefix', async () => {
      const fetchMock = vi.fn()
        .mockResolvedValueOnce({ ok: true, json: () => ({}) }) // createApp
        .mockResolvedValueOnce({ ok: true, json: () => ({}) }) // IPv6
        .mockResolvedValueOnce({ ok: true, json: () => ({}) }); // IPv4
      vi.stubGlobal('fetch', fetchMock);

      const { createApp } = await import('./fly.js');
      const appName = await createApp('test-instance-1234');

      expect(appName).toBe('reins-testinst');
      expect(fetchMock).toHaveBeenCalledTimes(3);

      // Verify app creation call
      const createCall = fetchMock.mock.calls[0];
      expect(createCall[0]).toContain('/apps');
      const body = JSON.parse(createCall[1].body);
      expect(body.app_name).toBe('reins-testinst');
      expect(body.org_slug).toBe('test-org');
    });

    it('should continue if IP allocation fails', async () => {
      const fetchMock = vi.fn()
        .mockResolvedValueOnce({ ok: true, json: () => ({}) }) // createApp
        .mockRejectedValueOnce(new Error('IP allocation failed')) // IPv6
        .mockRejectedValueOnce(new Error('IP allocation failed')); // IPv4
      vi.stubGlobal('fetch', fetchMock);

      const { createApp } = await import('./fly.js');
      const appName = await createApp('test-instance-1234');
      expect(appName).toBe('reins-testinst');
    });
  });

  describe('createMachine', () => {
    it('should create a machine with correct config', async () => {
      const fetchMock = vi.fn().mockResolvedValueOnce({
        ok: true,
        json: () => ({ id: 'machine-123' }),
      });
      vi.stubGlobal('fetch', fetchMock);

      const { createMachine } = await import('./fly.js');
      const result = await createMachine({
        appName: 'reins-test',
        instanceId: 'inst-12345678',
        telegramToken: 'tg-token-123',
        telegramUserId: 'user-456',
        mcpConfigs: [{ name: 'reins', url: 'https://reins.test.com/mcp/agent-1' }],
        gatewayToken: 'gw-token',
        soulMd: '# My Agent',
        modelProvider: 'anthropic',
        modelName: 'claude-sonnet-4-5',
      });

      expect(result.flyMachineId).toBe('machine-123');
      expect(result.flyAppName).toBe('reins-test');

      const call = fetchMock.mock.calls[0];
      expect(call[0]).toContain('/apps/reins-test/machines');
      const body = JSON.parse(call[1].body);
      expect(body.region).toBe('iad');
      expect(body.config.image).toBe('test-image:latest');
      expect(body.config.guest.memory_mb).toBe(4096);
      expect(body.config.env.TELEGRAM_BOT_TOKEN).toBe('tg-token-123');
      expect(body.config.env.TELEGRAM_TRUSTED_USER).toBe('user-456');
      expect(body.config.env.SOUL_MD).toBe('# My Agent');
      expect(body.config.env.MODEL_PROVIDER).toBe('anthropic');
      expect(JSON.parse(body.config.env.MCP_CONFIG)).toEqual([
        { name: 'reins', url: 'https://reins.test.com/mcp/agent-1' },
      ]);
    });

    it('should omit optional env vars when not provided', async () => {
      const fetchMock = vi.fn().mockResolvedValueOnce({
        ok: true,
        json: () => ({ id: 'machine-456' }),
      });
      vi.stubGlobal('fetch', fetchMock);

      const { createMachine } = await import('./fly.js');
      await createMachine({
        appName: 'reins-test',
        instanceId: 'inst-1',
        telegramToken: 'token',
        mcpConfigs: [],
        gatewayToken: 'gw',
      });

      const body = JSON.parse(fetchMock.mock.calls[0][1].body);
      expect(body.config.env).not.toHaveProperty('SOUL_MD');
      expect(body.config.env).not.toHaveProperty('TELEGRAM_TRUSTED_USER');
      expect(body.config.env).not.toHaveProperty('MODEL_PROVIDER');
      expect(body.config.env).not.toHaveProperty('MODEL_NAME');
    });

    it('should use custom region', async () => {
      const fetchMock = vi.fn().mockResolvedValueOnce({
        ok: true,
        json: () => ({ id: 'm1' }),
      });
      vi.stubGlobal('fetch', fetchMock);

      const { createMachine } = await import('./fly.js');
      await createMachine({
        appName: 'app',
        instanceId: 'i',
        telegramToken: 't',
        mcpConfigs: [],
        gatewayToken: 'g',
        region: 'lhr',
      });

      const body = JSON.parse(fetchMock.mock.calls[0][1].body);
      expect(body.region).toBe('lhr');
    });
  });

  describe('lifecycle operations', () => {
    it('startMachine should POST to start endpoint', async () => {
      const fetchMock = vi.fn().mockResolvedValueOnce({ ok: true });
      vi.stubGlobal('fetch', fetchMock);

      const { startMachine } = await import('./fly.js');
      await startMachine('app-1', 'machine-1');

      expect(fetchMock.mock.calls[0][0]).toContain('/apps/app-1/machines/machine-1/start');
      expect(fetchMock.mock.calls[0][1].method).toBe('POST');
    });

    it('stopMachine should POST to stop endpoint', async () => {
      const fetchMock = vi.fn().mockResolvedValueOnce({ ok: true });
      vi.stubGlobal('fetch', fetchMock);

      const { stopMachine } = await import('./fly.js');
      await stopMachine('app-1', 'machine-1');

      expect(fetchMock.mock.calls[0][0]).toContain('/apps/app-1/machines/machine-1/stop');
    });

    it('getMachineStatus should return machine state', async () => {
      const fetchMock = vi.fn().mockResolvedValueOnce({
        ok: true,
        json: () => ({ state: 'started', id: 'machine-1' }),
      });
      vi.stubGlobal('fetch', fetchMock);

      const { getMachineStatus } = await import('./fly.js');
      const status = await getMachineStatus('app-1', 'machine-1');

      expect(status.state).toBe('started');
    });

    it('destroyMachine should DELETE with force=true', async () => {
      const fetchMock = vi.fn().mockResolvedValueOnce({ ok: true });
      vi.stubGlobal('fetch', fetchMock);

      const { destroyMachine } = await import('./fly.js');
      await destroyMachine('app-1', 'machine-1');

      expect(fetchMock.mock.calls[0][0]).toContain('force=true');
      expect(fetchMock.mock.calls[0][1].method).toBe('DELETE');
    });

    it('destroyApp should DELETE the app', async () => {
      const fetchMock = vi.fn().mockResolvedValueOnce({ ok: true });
      vi.stubGlobal('fetch', fetchMock);

      const { destroyApp } = await import('./fly.js');
      await destroyApp('app-1');

      expect(fetchMock.mock.calls[0][0]).toContain('/apps/app-1');
      expect(fetchMock.mock.calls[0][1].method).toBe('DELETE');
    });
  });

  describe('error handling', () => {
    it('should throw on non-ok API response', async () => {
      const fetchMock = vi.fn().mockResolvedValueOnce({
        ok: false,
        status: 422,
        text: () => Promise.resolve('App name taken'),
      });
      vi.stubGlobal('fetch', fetchMock);

      const { createApp } = await import('./fly.js');
      await expect(createApp('test')).rejects.toThrow('Fly API error 422: App name taken');
    });

    it('should throw if FLY_API_TOKEN is missing', async () => {
      // getFlyToken() reads process.env at call time — no re-import needed
      delete process.env.FLY_API_TOKEN;
      const { createApp } = await import('./fly.js');
      await expect(createApp('test')).rejects.toThrow('FLY_API_TOKEN');
    });
  });

  describe('auth headers', () => {
    it('should include Bearer token in all requests', async () => {
      const fetchMock = vi.fn().mockResolvedValueOnce({ ok: true, json: () => ({}) });
      vi.stubGlobal('fetch', fetchMock);

      const { startMachine } = await import('./fly.js');
      await startMachine('app', 'machine');

      expect(fetchMock.mock.calls[0][1].headers.Authorization).toBe('Bearer test-fly-token');
    });
  });
});
