import { defineConfig, devices } from '@playwright/test';

/**
 * Playwright E2E configuration.
 *
 * Local dev:  ADMIN_EMAIL / ADMIN_PASSWORD must match whatever is in the
 *             local DB (seeded by initializeDatabase()).
 *
 * CI:         GitHub Actions sets DATABASE_URL, ADMIN_EMAIL, ADMIN_PASSWORD,
 *             REINS_ENCRYPTION_KEY, and (optionally) TEST_TELEGRAM_BOT_TOKEN
 *             as environment variables / repository secrets.
 */
export default defineConfig({
  testDir: './e2e',
  timeout: 45_000,
  retries: process.env.CI ? 2 : 0,
  workers: 1, // serial — tests share a live backend DB

  use: {
    baseURL: process.env.E2E_BASE_URL || 'http://localhost:6173',
    trace: 'on-first-retry',
    screenshot: 'only-on-failure',
    video: 'retain-on-failure',
  },

  projects: [
    { name: 'chromium', use: { ...devices['Desktop Chrome'] } },
  ],

  /**
   * webServer spins up both servers when running locally.
   * In CI, the servers are started separately before Playwright runs.
   */
  webServer: process.env.CI
    ? undefined
    : [
        {
          command: 'npm run dev:backend',
          url: 'http://localhost:3000/health',
          reuseExistingServer: true,
          timeout: 30_000,
          env: {
            ADMIN_EMAIL: process.env.ADMIN_EMAIL || 'admin@reins.local',
            ADMIN_PASSWORD: process.env.ADMIN_PASSWORD || 'changeme',
            REINS_PROVIDER: process.env.REINS_PROVIDER || 'local',
            OPENCLAW_IMAGE: process.env.OPENCLAW_IMAGE || 'reins-stub-openclaw:latest',
          },
        },
        {
          command: 'npm run dev:frontend',
          url: 'http://localhost:6173',
          reuseExistingServer: true,
          timeout: 30_000,
        },
      ],
});
