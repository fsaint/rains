/**
 * Headless Browser Handler Tests
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { ServerContext } from '../common/types.js';
import type { Page, ElementHandle } from 'playwright';

// Create mock page
const mockPage = {
  goto: vi.fn(),
  title: vi.fn(),
  screenshot: vi.fn(),
  $: vi.fn(),
  click: vi.fn(),
  fill: vi.fn(),
  type: vi.fn(),
  press: vi.fn(),
  evaluate: vi.fn(),
  waitForSelector: vi.fn(),
  innerHTML: vi.fn(),
  textContent: vi.fn(),
} as unknown as Page;

// Mock session manager
const mockSessionManager = {
  createSession: vi.fn(),
  getPage: vi.fn(),
  isUrlAllowed: vi.fn(),
  updateSessionUrl: vi.fn(),
  closeSession: vi.fn(),
  listSessions: vi.fn(),
};

// Mock the session-manager module
vi.mock('./session-manager.js', () => ({
  BrowserSessionManager: vi.fn().mockImplementation(() => mockSessionManager),
}));

// Import handlers and setSessionManager
import {
  setSessionManager,
  handleCreateSession,
  handleNavigate,
  handleScreenshot,
  handleGetContent,
  handleClick,
  handleType,
  handleEvaluate,
  handleScroll,
  handleWaitForSelector,
  handleCloseSession,
  handleListSessions,
} from './handlers.js';
import { BrowserSessionManager } from './session-manager.js';

describe('Browser Handlers', () => {
  const mockContext: ServerContext = {
    requestId: 'test-request-id',
  };

  beforeEach(() => {
    vi.clearAllMocks();
    // Initialize session manager
    const manager = new BrowserSessionManager();
    setSessionManager(manager);
  });

  describe('handleCreateSession', () => {
    it('should create a new browser session', async () => {
      mockSessionManager.createSession.mockResolvedValueOnce({
        id: 'session-123',
        createdAt: Date.now(),
      });

      const result = await handleCreateSession({}, mockContext);

      expect(result.success).toBe(true);
      expect(result.data.sessionId).toBe('session-123');
      expect(result.data.message).toBe('Browser session created');
    });
  });

  describe('handleNavigate', () => {
    it('should navigate to URL', async () => {
      mockSessionManager.isUrlAllowed.mockReturnValueOnce(true);
      mockSessionManager.getPage.mockReturnValueOnce(mockPage);
      vi.mocked(mockPage.goto).mockResolvedValueOnce(null);
      vi.mocked(mockPage.title).mockResolvedValueOnce('Example Page');

      const result = await handleNavigate(
        { sessionId: 'session-123', url: 'https://example.com' },
        mockContext
      );

      expect(result.success).toBe(true);
      expect(result.data.url).toBe('https://example.com');
      expect(result.data.title).toBe('Example Page');
    });

    it('should reject blocked URLs', async () => {
      mockSessionManager.isUrlAllowed.mockReturnValueOnce(false);

      const result = await handleNavigate(
        { sessionId: 'session-123', url: 'https://blocked.com' },
        mockContext
      );

      expect(result.success).toBe(false);
      expect(result.error).toContain('URL not allowed');
    });

    it('should return error for non-existent session', async () => {
      mockSessionManager.isUrlAllowed.mockReturnValueOnce(true);
      mockSessionManager.getPage.mockReturnValueOnce(null);

      const result = await handleNavigate(
        { sessionId: 'non-existent', url: 'https://example.com' },
        mockContext
      );

      expect(result.success).toBe(false);
      expect(result.error).toContain('Session not found');
    });

    it('should use custom waitUntil option', async () => {
      mockSessionManager.isUrlAllowed.mockReturnValueOnce(true);
      mockSessionManager.getPage.mockReturnValueOnce(mockPage);
      vi.mocked(mockPage.goto).mockResolvedValueOnce(null);
      vi.mocked(mockPage.title).mockResolvedValueOnce('Page');

      await handleNavigate(
        { sessionId: 'session-123', url: 'https://example.com', waitUntil: 'networkidle' },
        mockContext
      );

      expect(mockPage.goto).toHaveBeenCalledWith('https://example.com', {
        waitUntil: 'networkidle',
        timeout: 30000,
      });
    });
  });

  describe('handleScreenshot', () => {
    it('should capture full page screenshot', async () => {
      mockSessionManager.getPage.mockReturnValueOnce(mockPage);
      vi.mocked(mockPage.screenshot).mockResolvedValueOnce(Buffer.from('fake-image-data'));

      const result = await handleScreenshot(
        { sessionId: 'session-123', fullPage: true },
        mockContext
      );

      expect(result.success).toBe(true);
      expect(result.data.format).toBe('jpeg');
      expect(result.data.base64).toBeTruthy();
    });

    it('should capture element screenshot', async () => {
      const mockElement = {
        screenshot: vi.fn().mockResolvedValueOnce(Buffer.from('element-image')),
      } as unknown as ElementHandle;

      mockSessionManager.getPage.mockReturnValueOnce(mockPage);
      vi.mocked(mockPage.$).mockResolvedValueOnce(mockElement);

      const result = await handleScreenshot(
        { sessionId: 'session-123', selector: '#header' },
        mockContext
      );

      expect(result.success).toBe(true);
      expect(mockElement.screenshot).toHaveBeenCalled();
    });

    it('should return error if element not found', async () => {
      mockSessionManager.getPage.mockReturnValueOnce(mockPage);
      vi.mocked(mockPage.$).mockResolvedValueOnce(null);

      const result = await handleScreenshot(
        { sessionId: 'session-123', selector: '#non-existent' },
        mockContext
      );

      expect(result.success).toBe(false);
      expect(result.error).toContain('Element not found');
    });
  });

  describe('handleGetContent', () => {
    it('should get text content', async () => {
      const mockElement = {
        textContent: vi.fn().mockResolvedValueOnce('Page text content'),
        innerHTML: vi.fn(),
      } as unknown as ElementHandle;

      mockSessionManager.getPage.mockReturnValueOnce(mockPage);
      vi.mocked(mockPage.$).mockResolvedValueOnce(mockElement);

      const result = await handleGetContent(
        { sessionId: 'session-123', selector: 'body' },
        mockContext
      );

      expect(result.success).toBe(true);
      expect(result.data.content).toBe('Page text content');
      expect(result.data.format).toBe('text');
    });

    it('should get HTML content', async () => {
      const mockElement = {
        innerHTML: vi.fn().mockResolvedValueOnce('<p>HTML content</p>'),
      } as unknown as ElementHandle;

      mockSessionManager.getPage.mockReturnValueOnce(mockPage);
      vi.mocked(mockPage.$).mockResolvedValueOnce(mockElement);

      const result = await handleGetContent(
        { sessionId: 'session-123', selector: 'body', format: 'html' },
        mockContext
      );

      expect(result.success).toBe(true);
      expect(result.data.content).toBe('<p>HTML content</p>');
      expect(result.data.format).toBe('html');
    });

    it('should truncate long content', async () => {
      const longContent = 'x'.repeat(60000);
      const mockElement = {
        textContent: vi.fn().mockResolvedValueOnce(longContent),
      } as unknown as ElementHandle;

      mockSessionManager.getPage.mockReturnValueOnce(mockPage);
      vi.mocked(mockPage.$).mockResolvedValueOnce(mockElement);

      const result = await handleGetContent(
        { sessionId: 'session-123', maxLength: 50000 },
        mockContext
      );

      expect(result.success).toBe(true);
      expect(result.data.truncated).toBe(true);
      expect(result.data.content.length).toBe(50000);
      expect(result.data.originalLength).toBe(60000);
    });

    it('should return error if element not found', async () => {
      mockSessionManager.getPage.mockReturnValueOnce(mockPage);
      vi.mocked(mockPage.$).mockResolvedValueOnce(null);

      const result = await handleGetContent(
        { sessionId: 'session-123', selector: '#missing' },
        mockContext
      );

      expect(result.success).toBe(false);
      expect(result.error).toContain('Element not found');
    });
  });

  describe('handleClick', () => {
    it('should click element', async () => {
      mockSessionManager.getPage.mockReturnValueOnce(mockPage);
      vi.mocked(mockPage.click).mockResolvedValueOnce();

      const result = await handleClick(
        { sessionId: 'session-123', selector: 'button.submit' },
        mockContext
      );

      expect(result.success).toBe(true);
      expect(result.data.selector).toBe('button.submit');
      expect(mockPage.click).toHaveBeenCalledWith('button.submit', {
        button: 'left',
        clickCount: 1,
        timeout: 5000,
      });
    });

    it('should support right click', async () => {
      mockSessionManager.getPage.mockReturnValueOnce(mockPage);
      vi.mocked(mockPage.click).mockResolvedValueOnce();

      await handleClick(
        { sessionId: 'session-123', selector: '#menu', button: 'right' },
        mockContext
      );

      expect(mockPage.click).toHaveBeenCalledWith('#menu', {
        button: 'right',
        clickCount: 1,
        timeout: 5000,
      });
    });

    it('should return error for non-existent session', async () => {
      mockSessionManager.getPage.mockReturnValueOnce(null);

      const result = await handleClick(
        { sessionId: 'missing', selector: 'button' },
        mockContext
      );

      expect(result.success).toBe(false);
      expect(result.error).toContain('Session not found');
    });
  });

  describe('handleType', () => {
    it('should type text into element', async () => {
      mockSessionManager.getPage.mockReturnValueOnce(mockPage);
      vi.mocked(mockPage.fill).mockResolvedValueOnce();
      vi.mocked(mockPage.type).mockResolvedValueOnce();

      const result = await handleType(
        { sessionId: 'session-123', selector: 'input#search', text: 'hello world' },
        mockContext
      );

      expect(result.success).toBe(true);
      expect(result.data.textLength).toBe(11);
      expect(mockPage.fill).toHaveBeenCalledWith('input#search', '');
      expect(mockPage.type).toHaveBeenCalledWith('input#search', 'hello world', { delay: 0 });
    });

    it('should not clear when clear=false', async () => {
      mockSessionManager.getPage.mockReturnValueOnce(mockPage);
      vi.mocked(mockPage.type).mockResolvedValueOnce();

      await handleType(
        { sessionId: 'session-123', selector: 'input', text: 'append', clear: false },
        mockContext
      );

      expect(mockPage.fill).not.toHaveBeenCalled();
    });

    it('should press Enter when pressEnter=true', async () => {
      mockSessionManager.getPage.mockReturnValueOnce(mockPage);
      vi.mocked(mockPage.fill).mockResolvedValueOnce();
      vi.mocked(mockPage.type).mockResolvedValueOnce();
      vi.mocked(mockPage.press).mockResolvedValueOnce();

      await handleType(
        { sessionId: 'session-123', selector: 'input', text: 'search', pressEnter: true },
        mockContext
      );

      expect(mockPage.press).toHaveBeenCalledWith('input', 'Enter');
    });
  });

  describe('handleEvaluate', () => {
    it('should execute script and return result', async () => {
      mockSessionManager.getPage.mockReturnValueOnce(mockPage);
      vi.mocked(mockPage.evaluate).mockResolvedValueOnce({ width: 1920, height: 1080 });

      const result = await handleEvaluate(
        {
          sessionId: 'session-123',
          script: '(() => ({ width: window.innerWidth, height: window.innerHeight }))()',
        },
        mockContext
      );

      expect(result.success).toBe(true);
      expect(result.data.result).toEqual({ width: 1920, height: 1080 });
    });

    it('should return error for non-existent session', async () => {
      mockSessionManager.getPage.mockReturnValueOnce(null);

      const result = await handleEvaluate(
        { sessionId: 'missing', script: 'document.title' },
        mockContext
      );

      expect(result.success).toBe(false);
    });
  });

  describe('handleScroll', () => {
    it('should scroll down', async () => {
      mockSessionManager.getPage.mockReturnValueOnce(mockPage);
      vi.mocked(mockPage.evaluate).mockResolvedValueOnce();

      const result = await handleScroll(
        { sessionId: 'session-123', direction: 'down', amount: 500 },
        mockContext
      );

      expect(result.success).toBe(true);
      expect(result.data.direction).toBe('down');
      expect(result.data.amount).toBe(500);
    });

    it('should scroll element', async () => {
      mockSessionManager.getPage.mockReturnValueOnce(mockPage);
      vi.mocked(mockPage.evaluate).mockResolvedValueOnce();

      await handleScroll(
        { sessionId: 'session-123', direction: 'right', selector: '#scrollable' },
        mockContext
      );

      expect(mockPage.evaluate).toHaveBeenCalled();
    });
  });

  describe('handleWaitForSelector', () => {
    it('should wait for element to appear', async () => {
      mockSessionManager.getPage.mockReturnValueOnce(mockPage);
      vi.mocked(mockPage.waitForSelector).mockResolvedValueOnce(null);

      const result = await handleWaitForSelector(
        { sessionId: 'session-123', selector: '.loaded' },
        mockContext
      );

      expect(result.success).toBe(true);
      expect(result.data.selector).toBe('.loaded');
      expect(result.data.state).toBe('visible');
    });

    it('should use custom state and timeout', async () => {
      mockSessionManager.getPage.mockReturnValueOnce(mockPage);
      vi.mocked(mockPage.waitForSelector).mockResolvedValueOnce(null);

      await handleWaitForSelector(
        { sessionId: 'session-123', selector: '.modal', state: 'hidden', timeout: 5000 },
        mockContext
      );

      expect(mockPage.waitForSelector).toHaveBeenCalledWith('.modal', {
        state: 'hidden',
        timeout: 5000,
      });
    });
  });

  describe('handleCloseSession', () => {
    it('should close session', async () => {
      mockSessionManager.closeSession.mockResolvedValueOnce();

      const result = await handleCloseSession(
        { sessionId: 'session-123' },
        mockContext
      );

      expect(result.success).toBe(true);
      expect(result.data.sessionId).toBe('session-123');
      expect(result.data.message).toBe('Session closed');
      expect(mockSessionManager.closeSession).toHaveBeenCalledWith('session-123');
    });
  });

  describe('handleListSessions', () => {
    it('should list all sessions', async () => {
      mockSessionManager.listSessions.mockReturnValueOnce([
        { id: 'session-1', url: 'https://example.com', createdAt: Date.now() },
        { id: 'session-2', url: 'https://test.com', createdAt: Date.now() },
      ]);

      const result = await handleListSessions({}, mockContext);

      expect(result.success).toBe(true);
      expect(result.data.sessions).toHaveLength(2);
      expect(result.data.count).toBe(2);
    });
  });
});
