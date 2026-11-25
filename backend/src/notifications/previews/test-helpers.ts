/** Shared scaffolding for the preview builder tests. */
import { vi } from 'vitest';
import type { ApprovalRequest } from '@reins/shared';

export function makeApproval(overrides: Partial<ApprovalRequest>): ApprovalRequest {
  return {
    id: 'appr-1',
    agentId: 'agent-abc',
    tool: 'gmail_archive',
    arguments: {},
    status: 'pending',
    requestedAt: new Date(),
    expiresAt: new Date(Date.now() + 30 * 60 * 1000),
    revision: 0,
    ...overrides,
  };
}

export interface FakeCall {
  method: string;
  url: string;
  headers: Record<string, string>;
  body: unknown;
}

/**
 * Route fetch by URL substring. The first matching route answers; anything
 * unrouted is a 404, which is how a builder sees a lookup that failed.
 */
export function routeFetch(routes: Array<[match: string, body: unknown, status?: number]>): FakeCall[] {
  const calls: FakeCall[] = [];
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: string | URL, init: RequestInit = {}) => {
      const url = String(input);
      calls.push({
        method: (init.method ?? 'GET').toUpperCase(),
        url,
        headers: (init.headers ?? {}) as Record<string, string>,
        body: typeof init.body === 'string' ? JSON.parse(init.body) : undefined,
      });
      const route = routes.find(([match]) => url.includes(match));
      if (!route) return new Response('{}', { status: 404 });
      return new Response(JSON.stringify(route[1]), { status: route[2] ?? 200 });
    })
  );
  return calls;
}
