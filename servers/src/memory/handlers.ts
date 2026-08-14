/**
 * Memory MCP Server Handlers
 *
 * Each handler calls the Reins backend API (/api/memory/*) using
 * the agent's gateway token for authentication.
 */

import type { ServerContext, ToolResult } from '../common/types.js';

function getApiBase(): string {
  return (process.env.REINS_API_URL ?? 'https://app.helm.mom').replace(/\/$/, '');
}

function getGatewayToken(context: ServerContext): string {
  return context.gatewayToken ?? process.env.REINS_GATEWAY_TOKEN ?? '';
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

/**
 * Turn a non-2xx into a message the model can act on.
 *
 * Reading the body matters more than it looks: a refused scope comes back as
 * `{error, code: 'SCOPE_NOT_GRANTED', available_scopes: [...]}`, and that list
 * is the whole point — a model that receives it can correct itself on the next
 * call instead of failing the task. Reporting only the status code throws away
 * the one piece of information that makes the error recoverable.
 */
async function readError(res: Response, fallback: string): Promise<string> {
  const body = await res.json().catch(() => null) as
    | { error?: unknown; message?: unknown }
    | null;
  if (!body) return `${fallback} (HTTP ${res.status})`;

  const nested = (body.error as { message?: string } | undefined)?.message;
  const detail =
    nested ??
    (typeof body.message === 'string' ? body.message : undefined) ??
    (typeof body.error === 'string' ? body.error : undefined);
  return detail ?? `${fallback} (HTTP ${res.status})`;
}

async function apiGet<T = unknown>(context: ServerContext, path: string): Promise<T> {
  const res = await memoryFetch(context, path);
  if (!res.ok) throw new Error(await readError(res, `Memory API ${path} failed`));
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
  if (!res.ok) throw new Error(await readError(res, `Memory API DELETE ${path} failed`));
}

// ── Handlers ──────────────────────────────────────────────────────────────────

/**
 * The root index.
 *
 * The shape is a backward-compatible superset: the top-level fields are still
 * the default scope's root, exactly as before, with scope information alongside.
 * Deliberately not polymorphic on scope count — a response that restructures the
 * day a user adds a second scope is a prompt bug that only surfaces in production.
 */
export async function handleGetRoot(
  args: Record<string, unknown>,
  context: ServerContext
): Promise<ToolResult> {
  try {
    const params = new URLSearchParams();
    if (args.scope) params.set('scope', String(args.scope));
    const query = params.toString();

    const entry = await apiGet<{
      id: string;
      title: string;
      content: string;
      scope?: string;
      default_scope?: string | null;
      scopes?: Array<Record<string, unknown>>;
    }>(context, `/api/memory/root${query ? `?${query}` : ''}`);

    return {
      success: true,
      data: {
        id: entry.id,
        title: entry.title,
        content: entry.content,
        ...(entry.scope ? { scope: entry.scope } : {}),
        ...(entry.default_scope ? { default_scope: entry.default_scope } : {}),
        ...(entry.scopes ? { scopes: entry.scopes } : {}),
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
    const res = await memoryFetch(context, '/api/memory/entries', {
      method: 'POST',
      body: JSON.stringify({
        title: args.title,
        type: args.type ?? 'note',
        content: args.content ?? null,
        parent_id: args.parent_id ?? null,
        scope: args.scope ?? null,
        attributes: args.attributes ?? [],
      }),
    });
    if (!res.ok) {
      throw new Error(await readError(res, 'Could not create the entry'));
    }
    const json = await res.json() as { data: Record<string, unknown> };
    const created = res.status === 201;
    return { success: true, data: { ...json.data, created } };
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
    if (args.scope) params.set('scope', String(args.scope));

    const res = await memoryFetch(context, `/api/memory/entries?${params}`);
    if (!res.ok) throw new Error(await readError(res, 'Search failed'));
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
    if (args.tag) params.set('tag', String(args.tag));
    if (args.since) params.set('since', String(args.since));
    if (args.order) params.set('order', String(args.order));
    if (args.scope) params.set('scope', String(args.scope));

    const res = await memoryFetch(context, `/api/memory/entries?${params}`);
    if (!res.ok) throw new Error(await readError(res, 'List failed'));
    const json = await res.json() as { data: unknown[] };
    return { success: true, data: { entries: json.data, count: json.data.length } };
  } catch (err) {
    return { success: false, error: err instanceof Error ? err.message : String(err) };
  }
}

export async function handleListTags(
  args: Record<string, unknown>,
  context: ServerContext
): Promise<ToolResult> {
  try {
    const params = new URLSearchParams();
    if (args.scope) params.set('scope', String(args.scope));
    const query = params.toString();
    const tags = await apiGet<Array<{ tag: string; count: number }>>(
      context,
      `/api/memory/tags${query ? `?${query}` : ''}`
    );
    return { success: true, data: { tags } };
  } catch (err) {
    return { success: false, error: err instanceof Error ? err.message : String(err) };
  }
}

export async function handleListScopes(
  _args: Record<string, unknown>,
  context: ServerContext
): Promise<ToolResult> {
  try {
    const scopes = await apiGet<Array<Record<string, unknown>>>(context, '/api/memory/scopes');
    return {
      success: true,
      data: {
        scopes: scopes.map((s) => ({
          slug: s.slug,
          name: s.name,
          description: s.description,
          is_default: s.is_default,
          entry_count: s.entry_count,
        })),
      },
    };
  } catch (err) {
    return { success: false, error: err instanceof Error ? err.message : String(err) };
  }
}

export async function handleCreateScope(
  args: Record<string, unknown>,
  context: ServerContext
): Promise<ToolResult> {
  const name = typeof args.name === 'string' && args.name.trim() !== '' ? args.name.trim() : null;
  if (!name) return { success: false, error: 'name is required' };

  try {
    const res = await memoryFetch(context, '/api/memory/scopes', {
      method: 'POST',
      body: JSON.stringify({
        name,
        ...(typeof args.slug === 'string' ? { slug: args.slug } : {}),
        ...(typeof args.description === 'string' ? { description: args.description } : {}),
      }),
    });
    // The backend refuses near-duplicate slugs and caps the count; both come
    // back as messages worth handing to the model verbatim.
    if (!res.ok) throw new Error(await readError(res, 'Could not create the scope'));

    const json = await res.json() as { data: Record<string, unknown> };
    return {
      success: true,
      data: {
        ...json.data,
        next_step:
          'Pass this slug as `scope` when creating entries that belong here. Nothing moves ' +
          'between scopes afterwards, so file new entries deliberately.',
      },
    };
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

    // If only title provided, look it up first. `scope` narrows that lookup;
    // it is meaningless once an id is known, since an id determines its scope.
    if (!id && args.title) {
      const params = new URLSearchParams({ q: String(args.title), limit: '5' });
      if (args.scope) params.set('scope', String(args.scope));
      const res = await memoryFetch(context, `/api/memory/entries?${params}`);
      if (!res.ok) throw new Error(await readError(res, 'Search failed'));
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

export async function handleDream(
  args: Record<string, unknown>,
  context: ServerContext
): Promise<ToolResult> {
  try {
    const params = new URLSearchParams();
    if (args.scope) params.set('scope', String(args.scope));
    const query = params.toString();
    const res = await memoryFetch(context, `/api/memory/dream${query ? `?${query}` : ''}`);
    if (!res.ok) throw new Error(await readError(res, 'Dream manifest failed'));
    const json = await res.json() as { data: unknown[] };
    return { success: true, data: { entries: json.data, count: json.data.length } };
  } catch (err) {
    return { success: false, error: err instanceof Error ? err.message : String(err) };
  }
}

export async function handleSetParent(
  args: Record<string, unknown>,
  context: ServerContext
): Promise<ToolResult> {
  try {
    const result = await apiPut(context, `/api/memory/entries/${args.entry_id}/parent`, {
      parent_id: args.parent_id ?? null,
    });
    return { success: true, data: result };
  } catch (err) {
    return { success: false, error: err instanceof Error ? err.message : String(err) };
  }
}

export async function handleAddAttribute(
  args: Record<string, unknown>,
  context: ServerContext
): Promise<ToolResult> {
  try {
    const attr = await apiPost(context, `/api/memory/entries/${args.entry_id}/attributes`, {
      type: args.type,
      name: args.name,
      value: args.value,
    });
    return { success: true, data: attr };
  } catch (err) {
    return { success: false, error: err instanceof Error ? err.message : String(err) };
  }
}

export async function handleRemoveAttribute(
  args: Record<string, unknown>,
  context: ServerContext
): Promise<ToolResult> {
  try {
    await apiDelete(context, `/api/memory/attributes/${args.attribute_id}`);
    return { success: true, data: { deleted: true, id: args.attribute_id } };
  } catch (err) {
    return { success: false, error: err instanceof Error ? err.message : String(err) };
  }
}
