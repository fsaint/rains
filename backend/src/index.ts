import { buildApp } from './app.js';
import { config } from './config/index.js';
import { initializeDatabase } from './db/index.js';
import { approvalQueue } from './approvals/queue.js';
import { initializeNativeServers, shutdownNativeServers } from './mcp/init-servers.js';
import { startTokenRefreshLoop, stopTokenRefreshLoop } from './credentials/vault.js';
import { startBackupLoop, stopBackupLoop } from './services/agent-backup.js';
import { startTokenMonitor, stopTokenMonitor } from './services/token-monitor.js';
import { telegramNotifier } from './notifications/telegram.js';
import { initializeNotificationHandlers } from './notifications/handlers.js';
import { shutdownPostHog } from './analytics/posthog.js';

const app = await buildApp();

// Initialize database
app.log.info('Initializing database...');
await initializeDatabase();
app.log.info('Database initialized');

// Initialize native MCP servers
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

// Start background token refresh (every 45 minutes)
startTokenRefreshLoop();
app.log.info('Token refresh loop started');

// Start 24-hour agent backup loop
startBackupLoop();
app.log.info('Agent backup loop started (every 24 hours)');

// Start Codex token expiry monitor
startTokenMonitor();
app.log.info('Token monitor started');

// Wire approval queue events to notification services
initializeNotificationHandlers();

// Initialize Telegram bot (non-fatal if not configured or fails)
if (telegramNotifier.isConfigured()) {
  telegramNotifier.init()
    .then(() => telegramNotifier.setupWebhook())
    .catch((err) => app.log.error('Telegram initialization failed:', err));
  app.log.info('Telegram bot initialization started');
}

// Register shared bot webhook (non-fatal if not configured or fails)
if (config.sharedBotToken) {
  const reinsUrl = config.publicUrl || config.dashboardUrl;
  const webhookUrl = `${reinsUrl}/api/webhooks/shared-bot`;
  const params: Record<string, string> = { url: webhookUrl, allowed_updates: JSON.stringify(['message', 'edited_message', 'callback_query', 'my_chat_member']) };
  if (config.sharedBotWebhookSecret) params.secret_token = config.sharedBotWebhookSecret;
  fetch(`https://api.telegram.org/bot${config.sharedBotToken}/setWebhook`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(params),
  })
    .then((res) => res.json())
    .then((data) => app.log.info(`Shared bot webhook set: ${webhookUrl} — ${JSON.stringify(data)}`))
    .catch((err) => app.log.error('Shared bot setWebhook failed:', err));
}

// Graceful shutdown
const shutdown = async () => {
  app.log.info('Shutting down...');
  stopTokenRefreshLoop();
  stopBackupLoop();
  stopTokenMonitor();
  await shutdownNativeServers();
  await shutdownPostHog();
  await app.close();
  process.exit(0);
};

process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);

// Start server
try {
  await app.listen({ port: config.port, host: config.host });
  app.log.info(`Reins backend running at http://${config.host}:${config.port}`);
  app.log.info('Press Ctrl+C to stop');
} catch (err) {
  app.log.error(err);
  process.exit(1);
}
