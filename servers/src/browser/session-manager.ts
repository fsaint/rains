/**
 * Browser Session Manager
 *
 * Manages Playwright browser instances with pooling and automatic cleanup.
 */

import { chromium, type Browser, type BrowserContext, type Page } from 'playwright';
import pino from 'pino';
import type { BrowserConfig, BrowserSession } from '../common/types.js';

const logger = pino({ name: 'browser-session-manager' });

const DEFAULT_CONFIG: Required<BrowserConfig> = {
  maxInstances: 5,
  idleTimeout: 5 * 60 * 1000, // 5 minutes
  allowedDomains: ['*'],
  blockedDomains: [],
};

interface SessionState {
  id: string;
  browser: Browser;
  context: BrowserContext;
  page: Page;
  createdAt: number;
  lastActivity: number;
  currentUrl?: string;
}

/**
 * Manages browser sessions with pooling and automatic cleanup
 */
export class BrowserSessionManager {
  private config: Required<BrowserConfig>;
  private sessions: Map<string, SessionState> = new Map();
  private cleanupInterval?: NodeJS.Timeout;

  constructor(config: BrowserConfig = {}) {
    this.config = { ...DEFAULT_CONFIG, ...config };
  }

  /**
   * Start the session manager
   */
  start(): void {
    // Start cleanup interval
    this.cleanupInterval = setInterval(
      () => this.cleanupIdleSessions(),
      60 * 1000 // Check every minute
    );
    logger.info('Browser session manager started');
  }

  /**
   * Stop the session manager and close all sessions
   */
  async stop(): Promise<void> {
    if (this.cleanupInterval) {
      clearInterval(this.cleanupInterval);
    }

    // Close all sessions
    const closePromises = Array.from(this.sessions.keys()).map((id) =>
      this.closeSession(id)
    );
    await Promise.all(closePromises);

    logger.info('Browser session manager stopped');
  }

  /**
   * Create a new browser session
   */
  async createSession(): Promise<BrowserSession> {
    // Check if we've hit the limit
    if (this.sessions.size >= this.config.maxInstances) {
      // Try to close the oldest idle session
      const oldestIdle = this.findOldestIdleSession();
      if (oldestIdle) {
        await this.closeSession(oldestIdle);
      } else {
        throw new Error(
          `Maximum browser sessions (${this.config.maxInstances}) reached`
        );
      }
    }

    const id = crypto.randomUUID();
    const now = Date.now();

    // Launch browser
    const browser = await chromium.launch({
      headless: true,
      args: [
        '--no-sandbox',
        '--disable-setuid-sandbox',
        '--disable-dev-shm-usage',
        '--disable-gpu',
      ],
    });

    // Create context with reasonable defaults
    const context = await browser.newContext({
      viewport: { width: 1280, height: 720 },
      userAgent:
        'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
      locale: 'en-US',
      timezoneId: 'America/Los_Angeles',
    });

    // Create page
    const page = await context.newPage();

    const session: SessionState = {
      id,
      browser,
      context,
      page,
      createdAt: now,
      lastActivity: now,
    };

    this.sessions.set(id, session);
    logger.info({ sessionId: id }, 'Browser session created');

    return {
      id,
      createdAt: now,
      lastActivity: now,
    };
  }

  /**
   * Get a session by ID
   */
  getSession(sessionId: string): SessionState | undefined {
    const session = this.sessions.get(sessionId);
    if (session) {
      session.lastActivity = Date.now();
    }
    return session;
  }

  /**
   * Get page from session
   */
  getPage(sessionId: string): Page | undefined {
    return this.getSession(sessionId)?.page;
  }

  /**
   * Update session state after navigation
   */
  updateSessionUrl(sessionId: string, url: string): void {
    const session = this.sessions.get(sessionId);
    if (session) {
      session.currentUrl = url;
      session.lastActivity = Date.now();
    }
  }

  /**
   * Close a session
   */
  async closeSession(sessionId: string): Promise<void> {
    const session = this.sessions.get(sessionId);
    if (!session) return;

    try {
      await session.context.close();
      await session.browser.close();
    } catch (error) {
      logger.warn({ sessionId, error }, 'Error closing session');
    }

    this.sessions.delete(sessionId);
    logger.info({ sessionId }, 'Browser session closed');
  }

  /**
   * List all active sessions
   */
  listSessions(): BrowserSession[] {
    return Array.from(this.sessions.values()).map((s) => ({
      id: s.id,
      createdAt: s.createdAt,
      lastActivity: s.lastActivity,
      currentUrl: s.currentUrl,
    }));
  }

  /**
   * Check if a URL is allowed
   */
  isUrlAllowed(url: string): boolean {
    try {
      const parsed = new URL(url);
      const hostname = parsed.hostname;

      // Check blocked domains first
      for (const pattern of this.config.blockedDomains) {
        if (this.matchDomainPattern(hostname, pattern)) {
          return false;
        }
      }

      // Check allowed domains
      if (
        this.config.allowedDomains.length === 1 &&
        this.config.allowedDomains[0] === '*'
      ) {
        return true;
      }

      for (const pattern of this.config.allowedDomains) {
        if (this.matchDomainPattern(hostname, pattern)) {
          return true;
        }
      }

      return false;
    } catch {
      return false;
    }
  }

  /**
   * Match domain against glob pattern
   */
  private matchDomainPattern(hostname: string, pattern: string): boolean {
    // Convert glob pattern to regex
    const regex = new RegExp(
      '^' +
        pattern
          .replace(/\./g, '\\.')
          .replace(/\*/g, '.*')
          .replace(/\?/g, '.') +
        '$'
    );
    return regex.test(hostname);
  }

  /**
   * Find the oldest idle session
   */
  private findOldestIdleSession(): string | undefined {
    let oldest: { id: string; lastActivity: number } | undefined;

    for (const [id, session] of this.sessions) {
      if (!oldest || session.lastActivity < oldest.lastActivity) {
        oldest = { id, lastActivity: session.lastActivity };
      }
    }

    return oldest?.id;
  }

  /**
   * Clean up idle sessions
   */
  private async cleanupIdleSessions(): Promise<void> {
    const now = Date.now();

    for (const [id, session] of this.sessions) {
      if (now - session.lastActivity > this.config.idleTimeout) {
        logger.info({ sessionId: id }, 'Closing idle session');
        await this.closeSession(id);
      }
    }
  }

  /**
   * Get session count
   */
  get sessionCount(): number {
    return this.sessions.size;
  }
}
