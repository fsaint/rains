/**
 * Memory MCP Server Handlers
 *
 * Each handler calls the Reins backend API (/api/memory/*) using
 * the agent's gateway token for authentication.
 */

import type { ServerContext, ToolResult } from '../common/types.js';

function getApiBase(): string {
  return (process.env.REINS_API_URL ?? 'https://app.agenthelm.mom').replace(/\/$/, '');
}

function getGatewayToken(context: ServerContext): string {
  return (context as any).gatewayToken ?? process.env.REINS_GATEWAY_TOKEN ?? '';
}

async function memoryFetch(
  context: ServerContext,
  path: string,
  options: RequestInit = {}
): Promise<Response> {
  const token = getGatewayToken(context);
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    ...(options.headers as Record<string, string> ?? {}),
  };
  if (token) {
    headers['x-reins-agent-secret'] = token;
  }

  return fetch(`${getApiBase()}${path}`, {
    ...options,
    headers,
  });
}

async function apiGet<T = unknown>(context: ServerContext, path: string): Promise<T> {
  const res = await memoryFetch(context, path);
  if (!res.ok) throw new Error(`Memory API ${path} returned ${res.status}`);
  const json = await res.json() as { data: T };
  return json.data;
}

async function apiPost<T = unknown>(context: ServerContext, path: string, body: unknown): Promise<T> {
  const res = await memoryFetch(context, path, {
    method: 'POST',
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Memory API POST ${path} returned ${res.status}: ${text}`);
  }
  const json = await res.json() as { data: T };
  return json.data;
}

async function apiPut<T = unknown>(context: ServerContext, path: string, body: unknown): Promise<T> {
  const res = await memoryFetch(context, path, {
    method: 'PUT',
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Memory API PUT ${path} returned ${res.status}: ${text}`);
  }
  const json = await res.json() as { data: T };
  return json.data;
}

async function apiDelete(context: ServerContext, path: string): Promise<void> {
  const res = await memoryFetch(context, path, { method: 'DELETE' });
  if (!res.ok) throw new Error(`Memory API DELETE ${path} returned ${res.status}`);
}

// ── Handlers ──────────────────────────────────────────────────────────────────

export async function handleGetRoot(
  _args: Record<string, unknown>,
  context: ServerContext
): Promise<ToolResult> {
  try {
    const entry = await apiGet<{ id: string; title: string; content: string }>(context, '/api/memory/root');
    return {
      success: true,
      data: {
        id: entry.id,
        title: entry.title,
        content: entry.content,
      },
    };
  } catch (err) {
    return { success: false, error: err instanceof Error ? err.message : String(err) };
  }
}

export async function handleCreate(
  args: Record<string, unknown>,
  context: ServerContext
): Promise<ToolResult> {
  try {
    const entry = await apiPost(context, '/api/memory/entries', {
      title: args.title,
      type: args.type ?? 'note',
      content: args.content ?? null,
      parent_id: args.parent_id ?? null,
      attributes: args.attributes ?? [],
    });
    return { success: true, data: entry };
  } catch (err) {
    return { success: false, error: err instanceof Error ? err.message : String(err) };
  }
}

export async function handleUpdate(
  args: Record<string, unknown>,
  context: ServerContext
): Promise<ToolResult> {
  try {
    const { id, ...fields } = args;
    const entry = await apiPut(context, `/api/memory/entries/${id}`, fields);
    return { success: true, data: entry };
  } catch (err) {
    return { success: false, error: err instanceof Error ? err.message : String(err) };
  }
}

export async function handleSearch(
  args: Record<string, unknown>,
  context: ServerContext
): Promise<ToolResult> {
  try {
    const params = new URLSearchParams();
    params.set('q', String(args.query ?? ''));
    if (args.type) params.set('type', String(args.type));
    if (args.limit) params.set('limit', String(Math.min(Number(args.limit), 50)));

    const res = await memoryFetch(context, `/api/memory/entries?${params}`);
    if (!res.ok) throw new Error(`Search returned ${res.status}`);
    const json = await res.json() as { data: unknown[] };
    return { success: true, data: { entries: json.data, count: json.data.length } };
  } catch (err) {
    return { success: false, error: err instanceof Error ? err.message : String(err) };
  }
}

export async function handleList(
  args: Record<string, unknown>,
  context: ServerContext
): Promise<ToolResult> {
  try {
    const params = new URLSearchParams();
    if (args.type) params.set('type', String(args.type));
    if (args.parent_id) params.set('parent_id', String(args.parent_id));
    if (args.limit) params.set('limit', String(Math.min(Number(args.limit), 200)));

    const res = await memoryFetch(context, `/api/memory/entries?${params}`);
    if (!res.ok) throw new Error(`List returned ${res.status}`);
    const json = await res.json() as { data: unknown[] };
    return { success: true, data: { entries: json.data, count: json.data.length } };
  } catch (err) {
    return { success: false, error: err instanceof Error ? err.message : String(err) };
  }
}

export async function handleGet(
  args: Record<string, unknown>,
  context: ServerContext
): Promise<ToolResult> {
  try {
    let id = args.id as string | undefined;

    // If only title provided, look it up first
    if (!id && args.title) {
      const params = new URLSearchParams({ q: String(args.title), limit: '5' });
      const res = await memoryFetch(context, `/api/memory/entries?${params}`);
      if (!res.ok) throw new Error(`Search returned ${res.status}`);
      const json = await res.json() as { data: Array<{ id: string; title: string }> };
      const exact = json.data.find((e) => e.title.toLowerCase() === String(args.title).toLowerCase());
      if (!exact) return { success: false, error: `No entry found with title "${args.title}"` };
      id = exact.id;
    }

    if (!id) return { success: false, error: 'id or title is required' };

    const entry = await apiGet(context, `/api/memory/entries/${id}`);
    return { success: true, data: entry };
  } catch (err) {
    return { success: false, error: err instanceof Error ? err.message : String(err) };
  }
}

export async function handleRelate(
  args: Record<string, unknown>,
  context: ServerContext
): Promise<ToolResult> {
  try {
    const attr = await apiPost(context, `/api/memory/entries/${args.source_id}/attributes`, {
      type: 'relation',
      name: args.relation,
      value: args.target_id,
    });
    return { success: true, data: attr };
  } catch (err) {
    return { success: false, error: err instanceof Error ? err.message : String(err) };
  }
}

export async function handleDelete(
  args: Record<string, unknown>,
  context: ServerContext
): Promise<ToolResult> {
  try {
    await apiDelete(context, `/api/memory/entries/${args.id}`);
    return { success: true, data: { deleted: true, id: args.id } };
  } catch (err) {
    return { success: false, error: err instanceof Error ? err.message : String(err) };
  }
}
