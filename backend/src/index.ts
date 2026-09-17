import { buildApp } from './app.js';
import { config } from './config/index.js';
import { initializeDatabase } from './db/index.js';
import { approvalQueue } from './approvals/queue.js';
import { initializeNativeServers, shutdownNativeServers } from './mcp/init-servers.js';
import { startTokenRefreshLoop, stopTokenRefreshLoop } from './credentials/vault.js';
import { startTokenMonitor, stopTokenMonitor } from './services/token-monitor.js';
import { startUploadGcCron } from './services/agent-uploads.js';
import { telegramNotifier } from './notifications/telegram.js';
import { initializeNotificationHandlers } from './notifications/handlers.js';
import { shutdownPostHog } from './analytics/posthog.js';

const app = await buildApp();

app.log.info('Initializing database...');
await initializeDatabase();
app.log.info('Database initialized');

app.log.info('Initializing native MCP servers...');
await initializeNativeServers();
app.log.info('Native MCP servers initialized');

// WebSocket endpoint for real-time updates
app.register(async (fastify) => {
  fastify.get('/ws', { websocket: true }, (connection) => {
    app.log.info('WebSocket client connected');
    const ws = connection.socket;

    const onApprovalRequest = (approval: unknown) => {
      ws.send(JSON.stringify({ type: 'approval_request', data: approval }));
    };
    const onApprovalResolved = (approval: unknown) => {
      ws.send(JSON.stringify({ type: 'approval_resolved', data: approval }));
    };

    approvalQueue.on('request', onApprovalRequest);
    approvalQueue.on('resolved', onApprovalResolved);

    ws.on('close', () => {
      app.log.info('WebSocket client disconnected');
      approvalQueue.off('request', onApprovalRequest);
      approvalQueue.off('resolved', onApprovalResolved);
    });
  });
});

// Background OAuth token refresh (every 45 minutes)
startTokenRefreshLoop();
app.log.info('Token refresh loop started');

// OAuth credential expiry monitor
startTokenMonitor();
app.log.info('Token monitor started');

// Agent-upload GC (purges expired attachment blobs hourly)
startUploadGcCron();
app.log.info('Agent upload GC started');

// Wire approval queue events to notification services
initializeNotificationHandlers();

// Approvals bot (non-fatal if not configured or fails)
if (telegramNotifier.isConfigured()) {
  telegramNotifier.init()
    .then(() => telegramNotifier.setupWebhook())
    .catch((err) => app.log.error('Telegram initialization failed:', err));
  app.log.info('Telegram bot initialization started');
}

const shutdown = async () => {
  app.log.info('Shutting down...');
  stopTokenRefreshLoop();
  stopTokenMonitor();
  await shutdownNativeServers();
  await shutdownPostHog();
  await app.close();
  process.exit(0);
};

process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);

try {
  await app.listen({ port: config.port, host: config.host });
  app.log.info(`Helm backend running at http://${config.host}:${config.port}`);
  app.log.info('Press Ctrl+C to stop');
} catch (err) {
  app.log.error(err);
  process.exit(1);
}
