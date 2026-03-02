/**
 * Headless Browser MCP Server Tool Definitions (Playwright)
 */

import type { ToolDefinition } from '../common/base-server.js';
import {
  handleCreateSession,
  handleNavigate,
  handleScreenshot,
  handleGetContent,
  handleClick,
  handleType,
  handleEvaluate,
  handleCloseSession,
  handleListSessions,
  handleScroll,
  handleWaitForSelector,
} from './handlers.js';

/**
 * Create a new browser session
 */
export const createSessionTool: ToolDefinition = {
  name: 'browser_create_session',
  description:
    'Create a new headless browser session. Returns a session ID for subsequent operations.',
  inputSchema: {
    type: 'object',
    properties: {},
  },
  handler: handleCreateSession,
};

/**
 * Navigate to URL
 */
export const navigateTool: ToolDefinition = {
  name: 'browser_navigate',
  description: 'Navigate the browser to a URL.',
  inputSchema: {
    type: 'object',
    properties: {
      sessionId: {
        type: 'string',
        description: 'Browser session ID',
      },
      url: {
        type: 'string',
        description: 'URL to navigate to',
      },
      waitUntil: {
        type: 'string',
        enum: ['load', 'domcontentloaded', 'networkidle'],
        description: 'Wait condition (default: load)',
      },
      timeout: {
        type: 'number',
        description: 'Navigation timeout in milliseconds (default: 30000)',
      },
    },
    required: ['sessionId', 'url'],
  },
  handler: handleNavigate,
};

/**
 * Take screenshot
 */
export const screenshotTool: ToolDefinition = {
  name: 'browser_screenshot',
  description: 'Take a screenshot of the current page.',
  inputSchema: {
    type: 'object',
    properties: {
      sessionId: {
        type: 'string',
        description: 'Browser session ID',
      },
      fullPage: {
        type: 'boolean',
        description: 'Capture full scrollable page (default: false)',
      },
      selector: {
        type: 'string',
        description: 'CSS selector to screenshot specific element',
      },
      quality: {
        type: 'number',
        description: 'JPEG quality 0-100 (default: 80)',
      },
    },
    required: ['sessionId'],
  },
  handler: handleScreenshot,
};

/**
 * Get page content
 */
export const getContentTool: ToolDefinition = {
  name: 'browser_get_content',
  description:
    'Extract text content or HTML from the current page.',
  inputSchema: {
    type: 'object',
    properties: {
      sessionId: {
        type: 'string',
        description: 'Browser session ID',
      },
      selector: {
        type: 'string',
        description: 'CSS selector to extract specific element (default: body)',
      },
      format: {
        type: 'string',
        enum: ['text', 'html', 'markdown'],
        description: 'Output format (default: text)',
      },
      maxLength: {
        type: 'number',
        description: 'Maximum content length (default: 50000)',
      },
    },
    required: ['sessionId'],
  },
  handler: handleGetContent,
};

/**
 * Click element
 */
export const clickTool: ToolDefinition = {
  name: 'browser_click',
  description: 'Click on an element.',
  inputSchema: {
    type: 'object',
    properties: {
      sessionId: {
        type: 'string',
        description: 'Browser session ID',
      },
      selector: {
        type: 'string',
        description: 'CSS selector for element to click',
      },
      button: {
        type: 'string',
        enum: ['left', 'right', 'middle'],
        description: 'Mouse button (default: left)',
      },
      clickCount: {
        type: 'number',
        description: 'Number of clicks (default: 1)',
      },
      timeout: {
        type: 'number',
        description: 'Timeout in ms (default: 5000)',
      },
    },
    required: ['sessionId', 'selector'],
  },
  handler: handleClick,
};

/**
 * Type text
 */
export const typeTool: ToolDefinition = {
  name: 'browser_type',
  description: 'Type text into an input field.',
  inputSchema: {
    type: 'object',
    properties: {
      sessionId: {
        type: 'string',
        description: 'Browser session ID',
      },
      selector: {
        type: 'string',
        description: 'CSS selector for input element',
      },
      text: {
        type: 'string',
        description: 'Text to type',
      },
      clear: {
        type: 'boolean',
        description: 'Clear field before typing (default: true)',
      },
      delay: {
        type: 'number',
        description: 'Delay between keystrokes in ms (default: 0)',
      },
      pressEnter: {
        type: 'boolean',
        description: 'Press Enter after typing (default: false)',
      },
    },
    required: ['sessionId', 'selector', 'text'],
  },
  handler: handleType,
};

/**
 * Execute JavaScript
 */
export const evaluateTool: ToolDefinition = {
  name: 'browser_evaluate',
  description:
    'Execute JavaScript code in the browser context. Returns the result.',
  inputSchema: {
    type: 'object',
    properties: {
      sessionId: {
        type: 'string',
        description: 'Browser session ID',
      },
      script: {
        type: 'string',
        description: 'JavaScript code to execute',
      },
    },
    required: ['sessionId', 'script'],
  },
  handler: handleEvaluate,
};

/**
 * Scroll page
 */
export const scrollTool: ToolDefinition = {
  name: 'browser_scroll',
  description: 'Scroll the page or an element.',
  inputSchema: {
    type: 'object',
    properties: {
      sessionId: {
        type: 'string',
        description: 'Browser session ID',
      },
      direction: {
        type: 'string',
        enum: ['up', 'down', 'left', 'right'],
        description: 'Scroll direction',
      },
      amount: {
        type: 'number',
        description: 'Scroll amount in pixels (default: 500)',
      },
      selector: {
        type: 'string',
        description: 'CSS selector for element to scroll (default: window)',
      },
    },
    required: ['sessionId', 'direction'],
  },
  handler: handleScroll,
};

/**
 * Wait for selector
 */
export const waitForSelectorTool: ToolDefinition = {
  name: 'browser_wait_for_selector',
  description: 'Wait for an element to appear on the page.',
  inputSchema: {
    type: 'object',
    properties: {
      sessionId: {
        type: 'string',
        description: 'Browser session ID',
      },
      selector: {
        type: 'string',
        description: 'CSS selector to wait for',
      },
      state: {
        type: 'string',
        enum: ['attached', 'detached', 'visible', 'hidden'],
        description: 'Element state to wait for (default: visible)',
      },
      timeout: {
        type: 'number',
        description: 'Timeout in ms (default: 30000)',
      },
    },
    required: ['sessionId', 'selector'],
  },
  handler: handleWaitForSelector,
};

/**
 * Close browser session
 */
export const closeSessionTool: ToolDefinition = {
  name: 'browser_close_session',
  description: 'Close a browser session and release resources.',
  inputSchema: {
    type: 'object',
    properties: {
      sessionId: {
        type: 'string',
        description: 'Browser session ID to close',
      },
    },
    required: ['sessionId'],
  },
  handler: handleCloseSession,
};

/**
 * List active sessions
 */
export const listSessionsTool: ToolDefinition = {
  name: 'browser_list_sessions',
  description: 'List all active browser sessions.',
  inputSchema: {
    type: 'object',
    properties: {},
  },
  handler: handleListSessions,
};

/**
 * All Browser tools
 */
export const browserTools: ToolDefinition[] = [
  createSessionTool,
  navigateTool,
  screenshotTool,
  getContentTool,
  clickTool,
  typeTool,
  evaluateTool,
  scrollTool,
  waitForSelectorTool,
  closeSessionTool,
  listSessionsTool,
];
