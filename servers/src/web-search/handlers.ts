/**
 * Web Search MCP Server Tool Handlers (Brave Search API)
 *
 * Brave Search API documentation: https://api.search.brave.com/app/documentation/web-search/get-started
 */

import type { ServerContext, ToolResult } from '../common/types.js';

const BRAVE_API_BASE = 'https://api.search.brave.com/res/v1';

interface BraveWebResult {
  title: string;
  url: string;
  description: string;
  age?: string;
  page_age?: string;
  language?: string;
  family_friendly?: boolean;
}

interface BraveNewsResult {
  title: string;
  url: string;
  description: string;
  age?: string;
  source?: {
    name: string;
    url: string;
    favicon?: string;
  };
  thumbnail?: {
    src: string;
  };
}

interface BraveImageResult {
  title: string;
  url: string;
  source: string;
  thumbnail: {
    src: string;
  };
  properties: {
    url: string;
    width?: number;
    height?: number;
    format?: string;
  };
}

interface BraveSearchResponse {
  query?: {
    original: string;
    show_strict_warning?: boolean;
  };
  web?: {
    type: string;
    results: BraveWebResult[];
  };
  news?: {
    type: string;
    results: BraveNewsResult[];
  };
  images?: {
    type: string;
    results: BraveImageResult[];
  };
  suggestions?: string[];
}

/**
 * Get API key from context
 */
function getApiKey(context: ServerContext): string {
  // The API key should be passed via context or environment
  const apiKey = context.accessToken ?? process.env.BRAVE_API_KEY;
  if (!apiKey) {
    throw new Error('Brave API key not configured');
  }
  return apiKey;
}

/**
 * Make request to Brave Search API
 */
async function braveRequest(
  endpoint: string,
  params: Record<string, string | number | undefined>,
  apiKey: string
): Promise<BraveSearchResponse> {
  const url = new URL(`${BRAVE_API_BASE}${endpoint}`);

  // Add params, filtering out undefined values
  for (const [key, value] of Object.entries(params)) {
    if (value !== undefined) {
      url.searchParams.set(key, String(value));
    }
  }

  const response = await fetch(url.toString(), {
    headers: {
      Accept: 'application/json',
      'Accept-Encoding': 'gzip',
      'X-Subscription-Token': apiKey,
    },
  });

  if (!response.ok) {
    const error = await response.text();
    throw new Error(`Brave API error (${response.status}): ${error}`);
  }

  return response.json() as Promise<BraveSearchResponse>;
}

/**
 * Web search handler
 */
export async function handleWebSearch(
  args: Record<string, unknown>,
  context: ServerContext
): Promise<ToolResult> {
  const apiKey = getApiKey(context);

  const query = args.query as string;
  const count = Math.min((args.count as number) ?? 10, 20);
  const offset = args.offset as number | undefined;
  const country = args.country as string | undefined;
  const searchLang = args.searchLang as string | undefined;
  const safesearch = (args.safesearch as string) ?? 'moderate';
  const freshness = args.freshness as string | undefined;

  const response = await braveRequest(
    '/web/search',
    {
      q: query,
      count,
      offset,
      country,
      search_lang: searchLang,
      safesearch,
      freshness,
    },
    apiKey
  );

  const results = (response.web?.results ?? []).map((r) => ({
    title: r.title,
    url: r.url,
    description: r.description,
    age: r.age ?? r.page_age,
    language: r.language,
  }));

  return {
    success: true,
    data: {
      query: response.query?.original ?? query,
      results,
      total: results.length,
    },
  };
}

/**
 * News search handler
 */
export async function handleNewsSearch(
  args: Record<string, unknown>,
  context: ServerContext
): Promise<ToolResult> {
  const apiKey = getApiKey(context);

  const query = args.query as string;
  const count = Math.min((args.count as number) ?? 10, 20);
  const offset = args.offset as number | undefined;
  const country = args.country as string | undefined;
  const freshness = args.freshness as string | undefined;

  const response = await braveRequest(
    '/news/search',
    {
      q: query,
      count,
      offset,
      country,
      freshness,
    },
    apiKey
  );

  const results = (response.news?.results ?? []).map((r) => ({
    title: r.title,
    url: r.url,
    description: r.description,
    age: r.age,
    source: r.source?.name,
    sourceUrl: r.source?.url,
    thumbnail: r.thumbnail?.src,
  }));

  return {
    success: true,
    data: {
      query: response.query?.original ?? query,
      results,
      total: results.length,
    },
  };
}

/**
 * Image search handler
 */
export async function handleImageSearch(
  args: Record<string, unknown>,
  context: ServerContext
): Promise<ToolResult> {
  const apiKey = getApiKey(context);

  const query = args.query as string;
  const count = Math.min((args.count as number) ?? 10, 20);
  const safesearch = (args.safesearch as string) ?? 'strict';
  const size = args.size as string | undefined;
  const imageType = args.imageType as string | undefined;

  const response = await braveRequest(
    '/images/search',
    {
      q: query,
      count,
      safesearch,
      size,
      type: imageType,
    },
    apiKey
  );

  const results = (response.images?.results ?? []).map((r) => ({
    title: r.title,
    sourceUrl: r.source,
    imageUrl: r.properties.url,
    thumbnailUrl: r.thumbnail.src,
    width: r.properties.width,
    height: r.properties.height,
    format: r.properties.format,
  }));

  return {
    success: true,
    data: {
      query: response.query?.original ?? query,
      results,
      total: results.length,
    },
  };
}

/**
 * Search suggestions handler
 */
export async function handleSuggest(
  args: Record<string, unknown>,
  context: ServerContext
): Promise<ToolResult> {
  const apiKey = getApiKey(context);

  const query = args.query as string;
  const count = Math.min((args.count as number) ?? 5, 10);
  const country = args.country as string | undefined;

  const response = await braveRequest(
    '/suggest/search',
    {
      q: query,
      count,
      country,
    },
    apiKey
  );

  return {
    success: true,
    data: {
      query,
      suggestions: response.suggestions ?? [],
    },
  };
}
