/**
 * The wrapper between the server manager and a service's tool handlers copies
 * the tool context field by field — a whitelist. A field missing from it is
 * dropped silently, and the handler behaves as if it were never set.
 */

import { describe, it, expect, vi } from 'vitest';

vi.mock('../config/index.js', () => ({ config: {} }));
vi.mock('./server-manager.js', () => ({
  serverManager: { registerServer: vi.fn(), getStatus: vi.fn().mockResolvedValue([]) },
}));

import { createServerWrapper } from './init-servers.js';

describe('createServerWrapper', () => {
  function wrapperWith(handler: ReturnType<typeof vi.fn>) {
    return createServerWrapper('hermeneutix', 'Hermeneutix', [
      {
        name: 'hermeneutix_list_meetings',
        description: 'List meetings',
        inputSchema: { type: 'object', properties: {} },
        handler,
      },
    ] as never);
  }

  it('forwards instanceConfig to the tool handler', async () => {
    const handler = vi.fn().mockResolvedValue({ success: true, data: [] });
    const wrapper = wrapperWith(handler);
    const instanceConfig = { projectId: '11111111-1111-4111-8111-111111111111', projectName: 'Roadmap' };

    await wrapper.callTool('hermeneutix_list_meetings', { limit: 5 }, {
      requestId: 'req-1',
      agentId: 'agent-1',
      accessToken: 'tok',
      instanceConfig,
    });

    expect(handler).toHaveBeenCalledWith(
      { limit: 5 },
      expect.objectContaining({ requestId: 'req-1', agentId: 'agent-1', accessToken: 'tok', instanceConfig })
    );
  });

  it('passes no instanceConfig when the context carries none', async () => {
    const handler = vi.fn().mockResolvedValue({ success: true });
    const wrapper = wrapperWith(handler);

    await wrapper.callTool('hermeneutix_list_meetings', {}, { requestId: 'req-1', agentId: 'agent-1' });

    expect(handler.mock.calls[0][1].instanceConfig).toBeUndefined();
  });

  it('rejects an unknown tool without calling any handler', async () => {
    const handler = vi.fn();
    const wrapper = wrapperWith(handler);

    const result = await wrapper.callTool('hermeneutix_nope', {}, { requestId: 'req-1', agentId: 'agent-1' });

    expect(result.success).toBe(false);
    expect(handler).not.toHaveBeenCalled();
  });
});
