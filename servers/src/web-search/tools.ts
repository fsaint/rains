/**
 * Web Search MCP Server Tool Definitions (Brave Search API)
 */

import type { ToolDefinition } from '../common/base-server.js';
import {
  handleWebSearch,
  handleNewsSearch,
  handleImageSearch,
  handleSuggest,
} from './handlers.js';

/**
 * Web search
 */
export const webSearchTool: ToolDefinition = {
  name: 'web_search',
  description:
    'Search the web using Brave Search. Returns relevant web pages with titles, URLs, and descriptions.',
  inputSchema: {
    type: 'object',
    properties: {
      query: {
        type: 'string',
        description: 'Search query',
      },
      count: {
        type: 'number',
        description: 'Number of results (default: 10, max: 20)',
      },
      offset: {
        type: 'number',
        description: 'Offset for pagination',
      },
      country: {
        type: 'string',
        description: 'Country code for localized results (e.g., "US", "GB", "DE")',
      },
      searchLang: {
        type: 'string',
        description: 'Language code (e.g., "en", "es", "fr")',
      },
      safesearch: {
        type: 'string',
        enum: ['off', 'moderate', 'strict'],
        description: 'Safe search filter (default: moderate)',
      },
      freshness: {
        type: 'string',
        enum: ['pd', 'pw', 'pm', 'py'],
        description: 'Time filter: pd=past day, pw=past week, pm=past month, py=past year',
      },
    },
    required: ['query'],
  },
  handler: handleWebSearch,
};

/**
 * News search
 */
export const newsSearchTool: ToolDefinition = {
  name: 'web_search_news',
  description:
    'Search for news articles using Brave Search. Returns recent news with titles, sources, and publication dates.',
  inputSchema: {
    type: 'object',
    properties: {
      query: {
        type: 'string',
        description: 'News search query',
      },
      count: {
        type: 'number',
        description: 'Number of results (default: 10, max: 20)',
      },
      offset: {
        type: 'number',
        description: 'Offset for pagination',
      },
      country: {
        type: 'string',
        description: 'Country code for localized news',
      },
      freshness: {
        type: 'string',
        enum: ['pd', 'pw', 'pm'],
        description: 'Time filter: pd=past day, pw=past week, pm=past month',
      },
    },
    required: ['query'],
  },
  handler: handleNewsSearch,
};

/**
 * Image search
 */
export const imageSearchTool: ToolDefinition = {
  name: 'web_search_images',
  description:
    'Search for images using Brave Search. Returns image URLs, dimensions, and source pages.',
  inputSchema: {
    type: 'object',
    properties: {
      query: {
        type: 'string',
        description: 'Image search query',
      },
      count: {
        type: 'number',
        description: 'Number of results (default: 10, max: 20)',
      },
      safesearch: {
        type: 'string',
        enum: ['off', 'moderate', 'strict'],
        description: 'Safe search filter (default: strict)',
      },
      size: {
        type: 'string',
        enum: ['small', 'medium', 'large', 'wallpaper'],
        description: 'Filter by image size',
      },
      imageType: {
        type: 'string',
        enum: ['photo', 'clipart', 'line', 'gif', 'transparent', 'animatedgif'],
        description: 'Filter by image type',
      },
    },
    required: ['query'],
  },
  handler: handleImageSearch,
};

/**
 * Search suggestions
 */
export const suggestTool: ToolDefinition = {
  name: 'web_search_suggest',
  description: 'Get search suggestions/autocomplete for a query.',
  inputSchema: {
    type: 'object',
    properties: {
      query: {
        type: 'string',
        description: 'Partial query for suggestions',
      },
      count: {
        type: 'number',
        description: 'Number of suggestions (default: 5, max: 10)',
      },
      country: {
        type: 'string',
        description: 'Country code for localized suggestions',
      },
    },
    required: ['query'],
  },
  handler: handleSuggest,
};

/**
 * All Web Search tools
 */
export const webSearchTools: ToolDefinition[] = [
  webSearchTool,
  newsSearchTool,
  imageSearchTool,
  suggestTool,
];
