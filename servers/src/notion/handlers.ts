/**
 * Notion MCP Server Tool Handlers
 *
 * Uses the Notion REST API with an internal integration token.
 */

import type { ServerContext, ToolResult } from '../common/types.js';

const NOTION_API = 'https://api.notion.com/v1';
const NOTION_VERSION = '2022-06-28';

/**
 * Make an authenticated Notion API request
 */
async function notionRequest(
  context: ServerContext,
  path: string,
  options: RequestInit = {}
): Promise<Response> {
  const token = context.accessToken;
  if (!token) {
    throw new Error('No Notion access token available');
  }

  const headers: Record<string, string> = {
    Authorization: `Bearer ${token}`,
    'Notion-Version': NOTION_VERSION,
    'Content-Type': 'application/json',
    ...(options.headers as Record<string, string> ?? {}),
  };

  return fetch(`${NOTION_API}${path}`, { ...options, headers });
}

async function handleError(response: Response): Promise<ToolResult> {
  const body = await response.json().catch(() => ({ message: response.statusText }));
  return { success: false, error: `Notion API error (${response.status}): ${body.message || response.statusText}` };
}

// ============================================================================
// Search
// ============================================================================

export async function handleSearch(
  args: Record<string, unknown>,
  context: ServerContext
): Promise<ToolResult> {
  const query = args.query as string | undefined;
  const filter = args.filter as 'database' | 'page' | undefined;
  const pageSize = Math.min((args.pageSize as number) || 20, 100);
  const startCursor = args.startCursor as string | undefined;

  const body: any = { page_size: pageSize };
  if (query) body.query = query;
  if (filter) body.filter = { value: filter, property: 'object' };
  if (startCursor) body.start_cursor = startCursor;

  const response = await notionRequest(context, '/search', {
    method: 'POST',
    body: JSON.stringify(body),
  });
  if (!response.ok) return handleError(response);

  const data = await response.json();
  return {
    success: true,
    data: {
      results: data.results?.map((r: any) => ({
        id: r.id,
        object: r.object,
        title: r.object === 'database'
          ? r.title?.map((t: any) => t.plain_text).join('')
          : r.properties?.title?.title?.map((t: any) => t.plain_text).join('') || r.properties?.Name?.title?.map((t: any) => t.plain_text).join('') || r.id,
        url: r.url,
        lastEditedTime: r.last_edited_time,
      })),
      hasMore: data.has_more,
      nextCursor: data.next_cursor,
    },
  };
}

// ============================================================================
// Database tools
// ============================================================================

export async function handleGetDatabase(
  args: Record<string, unknown>,
  context: ServerContext
): Promise<ToolResult> {
  const databaseId = args.databaseId as string;

  const response = await notionRequest(context, `/databases/${databaseId}`);
  if (!response.ok) return handleError(response);

  const db = await response.json();
  return {
    success: true,
    data: {
      id: db.id,
      title: db.title?.map((t: any) => t.plain_text).join(''),
      description: db.description?.map((t: any) => t.plain_text).join(''),
      url: db.url,
      properties: Object.fromEntries(
        Object.entries(db.properties || {}).map(([name, prop]: [string, any]) => [
          name,
          { id: prop.id, type: prop.type },
        ])
      ),
    },
  };
}

export async function handleQueryDatabase(
  args: Record<string, unknown>,
  context: ServerContext
): Promise<ToolResult> {
  const databaseId = args.databaseId as string;
  const pageSize = Math.min((args.pageSize as number) || 20, 100);
  const startCursor = args.startCursor as string | undefined;
  const filter = args.filter as object | undefined;
  const sorts = args.sorts as Array<{ property: string; direction: string }> | undefined;

  const body: any = { page_size: pageSize };
  if (startCursor) body.start_cursor = startCursor;
  if (filter) body.filter = filter;
  if (sorts) body.sorts = sorts;

  const response = await notionRequest(context, `/databases/${databaseId}/query`, {
    method: 'POST',
    body: JSON.stringify(body),
  });
  if (!response.ok) return handleError(response);

  const data = await response.json();
  return {
    success: true,
    data: {
      results: data.results?.map(formatPage),
      hasMore: data.has_more,
      nextCursor: data.next_cursor,
    },
  };
}

// ============================================================================
// Page tools
// ============================================================================

export async function handleGetPage(
  args: Record<string, unknown>,
  context: ServerContext
): Promise<ToolResult> {
  const pageId = args.pageId as string;

  const response = await notionRequest(context, `/pages/${pageId}`);
  if (!response.ok) return handleError(response);

  const page = await response.json();
  return { success: true, data: formatPage(page) };
}

export async function handleGetPageContent(
  args: Record<string, unknown>,
  context: ServerContext
): Promise<ToolResult> {
  const pageId = args.pageId as string;
  const pageSize = Math.min((args.pageSize as number) || 50, 100);
  const startCursor = args.startCursor as string | undefined;

  const params = new URLSearchParams({ page_size: String(pageSize) });
  if (startCursor) params.set('start_cursor', startCursor);

  const response = await notionRequest(context, `/blocks/${pageId}/children?${params}`);
  if (!response.ok) return handleError(response);

  const data = await response.json();
  return {
    success: true,
    data: {
      blocks: data.results?.map(formatBlock),
      hasMore: data.has_more,
      nextCursor: data.next_cursor,
    },
  };
}

export async function handleCreatePage(
  args: Record<string, unknown>,
  context: ServerContext
): Promise<ToolResult> {
  const databaseId = args.databaseId as string;
  const properties = args.properties as Record<string, unknown>;
  const children = args.children as Array<unknown> | undefined;

  const body: any = {
    parent: { database_id: databaseId },
    properties,
  };
  if (children) body.children = children;

  const response = await notionRequest(context, '/pages', {
    method: 'POST',
    body: JSON.stringify(body),
  });
  if (!response.ok) return handleError(response);

  const page = await response.json();
  return { success: true, data: { id: page.id, url: page.url } };
}

export async function handleUpdatePage(
  args: Record<string, unknown>,
  context: ServerContext
): Promise<ToolResult> {
  const pageId = args.pageId as string;
  const properties = args.properties as Record<string, unknown>;

  const response = await notionRequest(context, `/pages/${pageId}`, {
    method: 'PATCH',
    body: JSON.stringify({ properties }),
  });
  if (!response.ok) return handleError(response);

  const page = await response.json();
  return { success: true, data: { id: page.id, url: page.url } };
}

export async function handleArchivePage(
  args: Record<string, unknown>,
  context: ServerContext
): Promise<ToolResult> {
  const pageId = args.pageId as string;

  const response = await notionRequest(context, `/pages/${pageId}`, {
    method: 'PATCH',
    body: JSON.stringify({ archived: true }),
  });
  if (!response.ok) return handleError(response);

  return { success: true, data: { archived: true, pageId } };
}

// ============================================================================
// Helpers
// ============================================================================

function formatPage(page: any) {
  const title = extractTitle(page.properties);
  return {
    id: page.id,
    title,
    url: page.url,
    createdTime: page.created_time,
    lastEditedTime: page.last_edited_time,
    archived: page.archived,
    properties: formatProperties(page.properties),
  };
}

function extractTitle(properties: any): string {
  if (!properties) return '';
  for (const prop of Object.values(properties) as any[]) {
    if (prop.type === 'title' && prop.title) {
      return prop.title.map((t: any) => t.plain_text).join('');
    }
  }
  return '';
}

function formatProperties(properties: any): Record<string, unknown> {
  if (!properties) return {};
  const result: Record<string, unknown> = {};

  for (const [name, prop] of Object.entries(properties) as [string, any][]) {
    switch (prop.type) {
      case 'title':
        result[name] = prop.title?.map((t: any) => t.plain_text).join('');
        break;
      case 'rich_text':
        result[name] = prop.rich_text?.map((t: any) => t.plain_text).join('');
        break;
      case 'number':
        result[name] = prop.number;
        break;
      case 'select':
        result[name] = prop.select?.name;
        break;
      case 'multi_select':
        result[name] = prop.multi_select?.map((s: any) => s.name);
        break;
      case 'date':
        result[name] = prop.date;
        break;
      case 'checkbox':
        result[name] = prop.checkbox;
        break;
      case 'url':
        result[name] = prop.url;
        break;
      case 'email':
        result[name] = prop.email;
        break;
      case 'phone_number':
        result[name] = prop.phone_number;
        break;
      case 'status':
        result[name] = prop.status?.name;
        break;
      case 'people':
        result[name] = prop.people?.map((p: any) => p.name || p.id);
        break;
      case 'relation':
        result[name] = prop.relation?.map((r: any) => r.id);
        break;
      case 'formula':
        result[name] = prop.formula?.[prop.formula?.type];
        break;
      case 'rollup':
        result[name] = prop.rollup?.[prop.rollup?.type];
        break;
      default:
        result[name] = `[${prop.type}]`;
    }
  }
  return result;
}

function formatBlock(block: any) {
  const base = {
    id: block.id,
    type: block.type,
    hasChildren: block.has_children,
  };

  const content = block[block.type];
  if (!content) return base;

  // Extract text from rich_text arrays
  if (content.rich_text) {
    return { ...base, text: content.rich_text.map((t: any) => t.plain_text).join('') };
  }

  // Special block types
  switch (block.type) {
    case 'to_do':
      return { ...base, text: content.rich_text?.map((t: any) => t.plain_text).join(''), checked: content.checked };
    case 'code':
      return { ...base, text: content.rich_text?.map((t: any) => t.plain_text).join(''), language: content.language };
    case 'image':
      return { ...base, url: content.file?.url || content.external?.url, caption: content.caption?.map((t: any) => t.plain_text).join('') };
    case 'child_database':
      return { ...base, title: content.title };
    default:
      return base;
  }
}

/**
 * Validate a Notion integration token
 */
export async function validateToken(token: string): Promise<{
  valid: boolean;
  botName?: string;
  workspaceName?: string;
  error?: string;
}> {
  try {
    const response = await fetch(`${NOTION_API}/users/me`, {
      headers: {
        Authorization: `Bearer ${token}`,
        'Notion-Version': NOTION_VERSION,
      },
    });

    if (!response.ok) {
      return { valid: false, error: `Authentication failed (${response.status})` };
    }

    const data = await response.json();
    return {
      valid: true,
      botName: data.name,
      workspaceName: data.bot?.workspace_name,
    };
  } catch (error) {
    return { valid: false, error: String(error) };
  }
}
