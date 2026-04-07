import { buildApp } from './app.js';
import { config } from './config/index.js';
import { initializeDatabase } from './db/index.js';
import { approvalQueue } from './approvals/queue.js';
import { initializeNativeServers, shutdownNativeServers } from './mcp/init-servers.js';
import { startTokenRefreshLoop, stopTokenRefreshLoop } from './credentials/vault.js';
import { startBackupLoop, stopBackupLoop } from './services/agent-backup.js';

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

// Graceful shutdown
const shutdown = async () => {
  app.log.info('Shutting down...');
  stopTokenRefreshLoop();
  stopBackupLoop();
  await shutdownNativeServers();
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
