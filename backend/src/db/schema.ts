import { sqliteTable, text, integer, real, blob } from 'drizzle-orm/sqlite-core';
import { sql } from 'drizzle-orm';

// Agents table
export const agents = sqliteTable('agents', {
  id: text('id').primaryKey(),
  name: text('name').notNull(),
  description: text('description'),
  policyId: text('policy_id'),
  status: text('status').default('pending').notNull(),
  createdAt: text('created_at').default(sql`CURRENT_TIMESTAMP`).notNull(),
  updatedAt: text('updated_at').default(sql`CURRENT_TIMESTAMP`).notNull(),
});

// Agent credentials junction table
export const agentCredentials = sqliteTable('agent_credentials', {
  agentId: text('agent_id').notNull(),
  credentialId: text('credential_id').notNull(),
});

// Policies table
export const policies = sqliteTable('policies', {
  id: text('id').primaryKey(),
  version: text('version').notNull(),
  name: text('name').notNull(),
  yaml: text('yaml').notNull(),
  createdAt: text('created_at').default(sql`CURRENT_TIMESTAMP`).notNull(),
  updatedAt: text('updated_at').default(sql`CURRENT_TIMESTAMP`).notNull(),
});

// Credentials table (encrypted)
export const credentials = sqliteTable('credentials', {
  id: text('id').primaryKey(),
  serviceId: text('service_id').notNull(),
  type: text('type').notNull(), // 'oauth2' | 'api_key' | 'basic'
  encryptedData: blob('encrypted_data', { mode: 'buffer' }).notNull(),
  iv: blob('iv', { mode: 'buffer' }).notNull(),
  authTag: blob('auth_tag', { mode: 'buffer' }).notNull(),
  expiresAt: text('expires_at'),
  accountEmail: text('account_email'), // e.g., "user@gmail.com"
  accountName: text('account_name'), // e.g., "John Doe"
  createdAt: text('created_at').default(sql`CURRENT_TIMESTAMP`).notNull(),
  updatedAt: text('updated_at').default(sql`CURRENT_TIMESTAMP`).notNull(),
});

// Audit log table (append-only)
export const auditLog = sqliteTable('audit_log', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  timestamp: text('timestamp').default(sql`CURRENT_TIMESTAMP`).notNull(),
  eventType: text('event_type').notNull(),
  agentId: text('agent_id'),
  tool: text('tool'),
  argumentsJson: text('arguments_json'),
  result: text('result'),
  durationMs: integer('duration_ms'),
  metadataJson: text('metadata_json'),
});

// Approval queue table
export const approvals = sqliteTable('approvals', {
  id: text('id').primaryKey(),
  agentId: text('agent_id').notNull(),
  tool: text('tool').notNull(),
  argumentsJson: text('arguments_json'),
  context: text('context'),
  status: text('status').default('pending').notNull(),
  requestedAt: text('requested_at').default(sql`CURRENT_TIMESTAMP`).notNull(),
  expiresAt: text('expires_at').notNull(),
  resolvedAt: text('resolved_at'),
  resolvedBy: text('resolved_by'),
  resolutionComment: text('resolution_comment'),
});

// Spend records table
export const spendRecords = sqliteTable('spend_records', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  agentId: text('agent_id').notNull(),
  serviceId: text('service_id').notNull(),
  amount: real('amount').notNull(),
  currency: text('currency').default('USD').notNull(),
  recordedAt: text('recorded_at').default(sql`CURRENT_TIMESTAMP`).notNull(),
});

// MCP Servers table
export const mcpServers = sqliteTable('mcp_servers', {
  id: text('id').primaryKey(),
  name: text('name').notNull(),
  transport: text('transport').notNull(), // 'stdio' | 'http' | 'websocket'
  configJson: text('config_json').notNull(),
  healthStatus: text('health_status').default('unknown').notNull(),
  lastHealthCheck: text('last_health_check'),
  createdAt: text('created_at').default(sql`CURRENT_TIMESTAMP`).notNull(),
  updatedAt: text('updated_at').default(sql`CURRENT_TIMESTAMP`).notNull(),
});

// Device tokens table for push notifications
export const deviceTokens = sqliteTable('device_tokens', {
  id: text('id').primaryKey(),
  deviceId: text('device_id').notNull().unique(),
  token: text('token').notNull(),
  platform: text('platform').notNull(), // 'ios' | 'android'
  userId: text('user_id'),
  createdAt: text('created_at').default(sql`CURRENT_TIMESTAMP`).notNull(),
  updatedAt: text('updated_at').default(sql`CURRENT_TIMESTAMP`).notNull(),
});

// Agent service access - controls which services each agent can access
export const agentServiceAccess = sqliteTable('agent_service_access', {
  id: text('id').primaryKey(),
  agentId: text('agent_id').notNull(),
  serviceType: text('service_type').notNull(), // 'gmail' | 'drive' | 'calendar' | 'web-search' | 'browser'
  enabled: integer('enabled', { mode: 'boolean' }).default(false).notNull(),
  credentialId: text('credential_id'), // Optional linked credential
  createdAt: text('created_at').default(sql`CURRENT_TIMESTAMP`).notNull(),
  updatedAt: text('updated_at').default(sql`CURRENT_TIMESTAMP`).notNull(),
});

// Agent tool permissions - per-tool permission overrides
export const agentToolPermissions = sqliteTable('agent_tool_permissions', {
  id: text('id').primaryKey(),
  agentId: text('agent_id').notNull(),
  serviceType: text('service_type').notNull(),
  toolName: text('tool_name').notNull(),
  permission: text('permission').notNull(), // 'allow' | 'block' | 'require_approval'
  createdAt: text('created_at').default(sql`CURRENT_TIMESTAMP`).notNull(),
  updatedAt: text('updated_at').default(sql`CURRENT_TIMESTAMP`).notNull(),
});

// Pending agent registrations - agents waiting to be claimed
export const pendingAgentRegistrations = sqliteTable('pending_agent_registrations', {
  id: text('id').primaryKey(),
  name: text('name').notNull(),
  description: text('description'),
  claimCode: text('claim_code').notNull().unique(),
  expiresAt: text('expires_at').notNull(),
  createdAt: text('created_at').default(sql`CURRENT_TIMESTAMP`).notNull(),
});
