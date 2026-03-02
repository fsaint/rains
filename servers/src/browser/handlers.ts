/**
 * Headless Browser MCP Server Tool Handlers (Playwright)
 */

import type { ServerContext, ToolResult } from '../common/types.js';
import { BrowserSessionManager } from './session-manager.js';

// Singleton session manager - initialized by the BrowserServer
let sessionManager: BrowserSessionManager | undefined;

/**
 * Set the session manager instance
 */
export function setSessionManager(manager: BrowserSessionManager): void {
  sessionManager = manager;
}

/**
 * Get the session manager
 */
function getSessionManager(): BrowserSessionManager {
  if (!sessionManager) {
    throw new Error('Browser session manager not initialized');
  }
  return sessionManager;
}

/**
 * Create session handler
 */
export async function handleCreateSession(
  _args: Record<string, unknown>,
  _context: ServerContext
): Promise<ToolResult> {
  const manager = getSessionManager();
  const session = await manager.createSession();

  return {
    success: true,
    data: {
      sessionId: session.id,
      message: 'Browser session created',
    },
  };
}

/**
 * Navigate handler
 */
export async function handleNavigate(
  args: Record<string, unknown>,
  _context: ServerContext
): Promise<ToolResult> {
  const manager = getSessionManager();

  const sessionId = args.sessionId as string;
  const url = args.url as string;
  const waitUntil = (args.waitUntil as 'load' | 'domcontentloaded' | 'networkidle') ?? 'load';
  const timeout = (args.timeout as number) ?? 30000;

  // Check if URL is allowed
  if (!manager.isUrlAllowed(url)) {
    return {
      success: false,
      error: `URL not allowed: ${url}`,
    };
  }

  const page = manager.getPage(sessionId);
  if (!page) {
    return {
      success: false,
      error: `Session not found: ${sessionId}`,
    };
  }

  await page.goto(url, { waitUntil, timeout });
  manager.updateSessionUrl(sessionId, url);

  const title = await page.title();

  return {
    success: true,
    data: {
      url,
      title,
      message: 'Navigation complete',
    },
  };
}

/**
 * Screenshot handler
 */
export async function handleScreenshot(
  args: Record<string, unknown>,
  _context: ServerContext
): Promise<ToolResult> {
  const manager = getSessionManager();

  const sessionId = args.sessionId as string;
  const fullPage = args.fullPage as boolean ?? false;
  const selector = args.selector as string | undefined;
  const quality = (args.quality as number) ?? 80;

  const page = manager.getPage(sessionId);
  if (!page) {
    return {
      success: false,
      error: `Session not found: ${sessionId}`,
    };
  }

  let screenshot: Buffer;

  if (selector) {
    const element = await page.$(selector);
    if (!element) {
      return {
        success: false,
        error: `Element not found: ${selector}`,
      };
    }
    screenshot = await element.screenshot({ type: 'jpeg', quality });
  } else {
    screenshot = await page.screenshot({
      type: 'jpeg',
      quality,
      fullPage,
    });
  }

  const base64 = screenshot.toString('base64');

  return {
    success: true,
    data: {
      format: 'jpeg',
      base64,
      size: screenshot.length,
      message: 'Screenshot captured',
    },
  };
}

/**
 * Get content handler
 */
export async function handleGetContent(
  args: Record<string, unknown>,
  _context: ServerContext
): Promise<ToolResult> {
  const manager = getSessionManager();

  const sessionId = args.sessionId as string;
  const selector = (args.selector as string) ?? 'body';
  const format = (args.format as 'text' | 'html' | 'markdown') ?? 'text';
  const maxLength = (args.maxLength as number) ?? 50000;

  const page = manager.getPage(sessionId);
  if (!page) {
    return {
      success: false,
      error: `Session not found: ${sessionId}`,
    };
  }

  const element = await page.$(selector);
  if (!element) {
    return {
      success: false,
      error: `Element not found: ${selector}`,
    };
  }

  let content: string;

  if (format === 'html') {
    content = await element.innerHTML();
  } else if (format === 'markdown') {
    // Simple markdown conversion: get text with some structure preserved
    content = await page.evaluate((sel) => {
      const el = document.querySelector(sel);
      if (!el) return '';

      // Helper to convert element to markdown-ish text
      const toMarkdown = (node: Element): string => {
        const lines: string[] = [];
        const tag = node.tagName.toLowerCase();

        if (tag === 'h1') lines.push(`# ${node.textContent?.trim() ?? ''}`);
        else if (tag === 'h2') lines.push(`## ${node.textContent?.trim() ?? ''}`);
        else if (tag === 'h3') lines.push(`### ${node.textContent?.trim() ?? ''}`);
        else if (tag === 'p') lines.push(node.textContent?.trim() ?? '');
        else if (tag === 'li') lines.push(`- ${node.textContent?.trim() ?? ''}`);
        else if (tag === 'a') {
          const href = node.getAttribute('href');
          lines.push(`[${node.textContent?.trim() ?? ''}](${href ?? ''})`);
        } else {
          Array.from(node.children).forEach((child) => {
            lines.push(toMarkdown(child));
          });
          if (lines.length === 0 && node.textContent?.trim()) {
            lines.push(node.textContent.trim());
          }
        }

        return lines.filter(Boolean).join('\n');
      };

      return toMarkdown(el);
    }, selector);
  } else {
    content = (await element.textContent()) ?? '';
  }

  // Truncate if too long
  const truncated = content.length > maxLength;
  const truncatedContent = truncated ? content.slice(0, maxLength) : content;

  return {
    success: true,
    data: {
      content: truncatedContent,
      format,
      truncated,
      originalLength: content.length,
    },
  };
}

/**
 * Click handler
 */
export async function handleClick(
  args: Record<string, unknown>,
  _context: ServerContext
): Promise<ToolResult> {
  const manager = getSessionManager();

  const sessionId = args.sessionId as string;
  const selector = args.selector as string;
  const button = (args.button as 'left' | 'right' | 'middle') ?? 'left';
  const clickCount = (args.clickCount as number) ?? 1;
  const timeout = (args.timeout as number) ?? 5000;

  const page = manager.getPage(sessionId);
  if (!page) {
    return {
      success: false,
      error: `Session not found: ${sessionId}`,
    };
  }

  await page.click(selector, { button, clickCount, timeout });

  return {
    success: true,
    data: {
      selector,
      message: 'Click performed',
    },
  };
}

/**
 * Type handler
 */
export async function handleType(
  args: Record<string, unknown>,
  _context: ServerContext
): Promise<ToolResult> {
  const manager = getSessionManager();

  const sessionId = args.sessionId as string;
  const selector = args.selector as string;
  const text = args.text as string;
  const clear = args.clear as boolean ?? true;
  const delay = (args.delay as number) ?? 0;
  const pressEnter = args.pressEnter as boolean ?? false;

  const page = manager.getPage(sessionId);
  if (!page) {
    return {
      success: false,
      error: `Session not found: ${sessionId}`,
    };
  }

  if (clear) {
    await page.fill(selector, '');
  }

  await page.type(selector, text, { delay });

  if (pressEnter) {
    await page.press(selector, 'Enter');
  }

  return {
    success: true,
    data: {
      selector,
      textLength: text.length,
      message: 'Text typed',
    },
  };
}

/**
 * Evaluate handler
 */
export async function handleEvaluate(
  args: Record<string, unknown>,
  _context: ServerContext
): Promise<ToolResult> {
  const manager = getSessionManager();

  const sessionId = args.sessionId as string;
  const script = args.script as string;

  const page = manager.getPage(sessionId);
  if (!page) {
    return {
      success: false,
      error: `Session not found: ${sessionId}`,
    };
  }

  // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment
  const result = await page.evaluate(script);

  return {
    success: true,
    data: {
      result,
      message: 'Script executed',
    },
  };
}

/**
 * Scroll handler
 */
export async function handleScroll(
  args: Record<string, unknown>,
  _context: ServerContext
): Promise<ToolResult> {
  const manager = getSessionManager();

  const sessionId = args.sessionId as string;
  const direction = args.direction as 'up' | 'down' | 'left' | 'right';
  const amount = (args.amount as number) ?? 500;
  const selector = args.selector as string | undefined;

  const page = manager.getPage(sessionId);
  if (!page) {
    return {
      success: false,
      error: `Session not found: ${sessionId}`,
    };
  }

  const scrollX = direction === 'right' ? amount : direction === 'left' ? -amount : 0;
  const scrollY = direction === 'down' ? amount : direction === 'up' ? -amount : 0;

  if (selector) {
    await page.evaluate(
      ({ sel, x, y }) => {
        const el = document.querySelector(sel);
        if (el) el.scrollBy(x, y);
      },
      { sel: selector, x: scrollX, y: scrollY }
    );
  } else {
    await page.evaluate(
      ({ x, y }) => window.scrollBy(x, y),
      { x: scrollX, y: scrollY }
    );
  }

  return {
    success: true,
    data: {
      direction,
      amount,
      message: 'Scroll performed',
    },
  };
}

/**
 * Wait for selector handler
 */
export async function handleWaitForSelector(
  args: Record<string, unknown>,
  _context: ServerContext
): Promise<ToolResult> {
  const manager = getSessionManager();

  const sessionId = args.sessionId as string;
  const selector = args.selector as string;
  const state = (args.state as 'attached' | 'detached' | 'visible' | 'hidden') ?? 'visible';
  const timeout = (args.timeout as number) ?? 30000;

  const page = manager.getPage(sessionId);
  if (!page) {
    return {
      success: false,
      error: `Session not found: ${sessionId}`,
    };
  }

  await page.waitForSelector(selector, { state, timeout });

  return {
    success: true,
    data: {
      selector,
      state,
      message: 'Element found',
    },
  };
}

/**
 * Close session handler
 */
export async function handleCloseSession(
  args: Record<string, unknown>,
  _context: ServerContext
): Promise<ToolResult> {
  const manager = getSessionManager();

  const sessionId = args.sessionId as string;

  await manager.closeSession(sessionId);

  return {
    success: true,
    data: {
      sessionId,
      message: 'Session closed',
    },
  };
}

/**
 * List sessions handler
 */
export async function handleListSessions(
  _args: Record<string, unknown>,
  _context: ServerContext
): Promise<ToolResult> {
  const manager = getSessionManager();

  const sessions = manager.listSessions();

  return {
    success: true,
    data: {
      sessions,
      count: sessions.length,
    },
  };
}
