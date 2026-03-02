import Fastify from 'fastify';
import cors from '@fastify/cors';
import websocket from '@fastify/websocket';
import { config } from './config/index.js';
import { initializeDatabase } from './db/index.js';
import { apiRoutes } from './api/routes.js';
import { approvalQueue } from './approvals/queue.js';

// Create Fastify server
const app = Fastify({
  logger: {
    level: config.logLevel,
    transport: config.nodeEnv === 'development' ? { target: 'pino-pretty' } : undefined,
  },
});

// Register plugins
await app.register(cors, {
  origin: config.nodeEnv === 'development' ? true : ['http://localhost:5173'],
  credentials: true,
});

await app.register(websocket);

// Initialize database
app.log.info('Initializing database...');
await initializeDatabase();
app.log.info('Database initialized');

// Register API routes
await app.register(apiRoutes);

// WebSocket endpoint for real-time updates
app.register(async (fastify) => {
  fastify.get('/ws', { websocket: true }, (connection) => {
    app.log.info('WebSocket client connected');
    const ws = connection.socket;

    // Send approval requests in real-time
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

// Graceful shutdown
const shutdown = async () => {
  app.log.info('Shutting down...');
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
