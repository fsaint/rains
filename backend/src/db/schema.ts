import { pgTable, text, integer, serial, real, boolean } from 'drizzle-orm/pg-core';
import { sql } from 'drizzle-orm';

// Users table
export const users = pgTable('users', {
  id: text('id').primaryKey(),
  email: text('email').notNull().unique(),
  name: text('name').notNull(),
  passwordHash: text('password_hash').notNull(),
  role: text('role').default('user').notNull(), // 'admin' | 'user'
  status: text('status').default('active').notNull(), // 'active' | 'suspended' | 'deleted'
  telegramChatId: text('telegram_chat_id'), // Telegram chat ID for approval notifications
  createdAt: text('created_at').default(sql`now()`).notNull(),
  updatedAt: text('updated_at').default(sql`now()`).notNull(),
});

// Agents table
export const agents = pgTable('agents', {
  id: text('id').primaryKey(),
  userId: text('user_id'),
  name: text('name').notNull(),
  description: text('description'),
  policyId: text('policy_id'),
  status: text('status').default('pending').notNull(),
  createdAt: text('created_at').default(sql`now()`).notNull(),
  updatedAt: text('updated_at').default(sql`now()`).notNull(),
});

// Agent credentials junction table
export const agentCredentials = pgTable('agent_credentials', {
  agentId: text('agent_id').notNull(),
  credentialId: text('credential_id').notNull(),
});

// Policies table
export const policies = pgTable('policies', {
  id: text('id').primaryKey(),
  version: text('version').notNull(),
  name: text('name').notNull(),
  yaml: text('yaml').notNull(),
  createdAt: text('created_at').default(sql`now()`).notNull(),
  updatedAt: text('updated_at').default(sql`now()`).notNull(),
});

// Credentials table (encrypted)
export const credentials = pgTable('credentials', {
  id: text('id').primaryKey(),
  userId: text('user_id'),
  serviceId: text('service_id').notNull(),
  type: text('type').notNull(), // 'oauth2' | 'api_key' | 'basic'
  encryptedData: text('encrypted_data').notNull(), // base64 encoded
  iv: text('iv').notNull(), // base64 encoded
  authTag: text('auth_tag').notNull(), // base64 encoded
  expiresAt: text('expires_at'),
  accountEmail: text('account_email'), // e.g., "user@gmail.com"
  accountName: text('account_name'), // e.g., "John Doe"
  grantedServices: text('granted_services'), // JSON array of service types
  createdAt: text('created_at').default(sql`now()`).notNull(),
  updatedAt: text('updated_at').default(sql`now()`).notNull(),
});

// Audit log table (append-only)
export const auditLog = pgTable('audit_log', {
  id: serial('id').primaryKey(),
  timestamp: text('timestamp').default(sql`now()`).notNull(),
  eventType: text('event_type').notNull(),
  userId: text('user_id'),
  agentId: text('agent_id'),
  tool: text('tool'),
  argumentsJson: text('arguments_json'),
  result: text('result'),
  durationMs: integer('duration_ms'),
  metadataJson: text('metadata_json'),
});

// Approval queue table
export const approvals = pgTable('approvals', {
  id: text('id').primaryKey(),
  agentId: text('agent_id').notNull(),
  tool: text('tool').notNull(),
  argumentsJson: text('arguments_json'),
  context: text('context'),
  status: text('status').default('pending').notNull(),
  requestedAt: text('requested_at').default(sql`now()`).notNull(),
  expiresAt: text('expires_at').notNull(),
  resolvedAt: text('resolved_at'),
  resolvedBy: text('resolved_by'),
  resolutionComment: text('resolution_comment'),
  telegramChatId: text('telegram_chat_id'), // Telegram chat ID where notification was sent
  telegramMessageId: text('telegram_message_id'), // Telegram message ID for edit-in-place
});

// Telegram link codes — one-time codes for linking a Telegram chat to a Reins user
export const telegramLinkCodes = pgTable('telegram_link_codes', {
  code: text('code').primaryKey(),
  userId: text('user_id').notNull(),
  expiresAt: text('expires_at').notNull(),
  createdAt: text('created_at').notNull(),
});

// Spend records table
export const spendRecords = pgTable('spend_records', {
  id: serial('id').primaryKey(),
  agentId: text('agent_id').notNull(),
  serviceId: text('service_id').notNull(),
  amount: real('amount').notNull(),
  currency: text('currency').default('USD').notNull(),
  recordedAt: text('recorded_at').default(sql`now()`).notNull(),
});

// MCP Servers table
export const mcpServers = pgTable('mcp_servers', {
  id: text('id').primaryKey(),
  name: text('name').notNull(),
  transport: text('transport').notNull(), // 'stdio' | 'http' | 'websocket'
  configJson: text('config_json').notNull(),
  healthStatus: text('health_status').default('unknown').notNull(),
  lastHealthCheck: text('last_health_check'),
  createdAt: text('created_at').default(sql`now()`).notNull(),
  updatedAt: text('updated_at').default(sql`now()`).notNull(),
});

// Device tokens table for push notifications
export const deviceTokens = pgTable('device_tokens', {
  id: text('id').primaryKey(),
  deviceId: text('device_id').notNull().unique(),
  token: text('token').notNull(),
  platform: text('platform').notNull(), // 'ios' | 'android'
  userId: text('user_id'),
  createdAt: text('created_at').default(sql`now()`).notNull(),
  updatedAt: text('updated_at').default(sql`now()`).notNull(),
});

// Agent service access - controls which services each agent can access
export const agentServiceAccess = pgTable('agent_service_access', {
  id: text('id').primaryKey(),
  agentId: text('agent_id').notNull(),
  serviceType: text('service_type').notNull(),
  enabled: boolean('enabled').default(false).notNull(),
  credentialId: text('credential_id'),
  pathRules: text('path_rules'), // JSON: DrivePathRule[] for path-based permission overrides
  createdAt: text('created_at').default(sql`now()`).notNull(),
  updatedAt: text('updated_at').default(sql`now()`).notNull(),
});

// Agent service credentials junction table - multiple credentials per agent+service
export const agentServiceCredentials = pgTable('agent_service_credentials', {
  id: text('id').primaryKey(),
  agentId: text('agent_id').notNull(),
  serviceType: text('service_type').notNull(),
  credentialId: text('credential_id').notNull(),
  isDefault: boolean('is_default').default(false).notNull(),
  createdAt: text('created_at').default(sql`now()`).notNull(),
});

// Agent tool permissions - per-tool permission overrides
export const agentToolPermissions = pgTable('agent_tool_permissions', {
  id: text('id').primaryKey(),
  agentId: text('agent_id').notNull(),
  serviceType: text('service_type').notNull(),
  toolName: text('tool_name').notNull(),
  permission: text('permission').notNull(), // 'allow' | 'block' | 'require_approval'
  instanceId: text('instance_id'), // links to agent_service_instances
  createdAt: text('created_at').default(sql`now()`).notNull(),
  updatedAt: text('updated_at').default(sql`now()`).notNull(),
});

// Agent service instances - per-account permission slots
export const agentServiceInstances = pgTable('agent_service_instances', {
  id: text('id').primaryKey(),
  agentId: text('agent_id').notNull(),
  serviceType: text('service_type').notNull(),
  label: text('label'),
  credentialId: text('credential_id'),
  enabled: boolean('enabled').default(true).notNull(),
  isDefault: boolean('is_default').default(false).notNull(),
  createdAt: text('created_at').default(sql`now()`).notNull(),
  updatedAt: text('updated_at').default(sql`now()`).notNull(),
});

// Pending agent registrations - agents waiting to be claimed
export const pendingAgentRegistrations = pgTable('pending_agent_registrations', {
  id: text('id').primaryKey(),
  userId: text('user_id'),
  name: text('name').notNull(),
  description: text('description'),
  claimCode: text('claim_code').notNull().unique(),
  expiresAt: text('expires_at').notNull(),
  createdAt: text('created_at').default(sql`now()`).notNull(),
});

// ============================================================================
// Deployed Agents - tracks agent deployments on Fly.io or local Docker
// ============================================================================

export const deployedAgents = pgTable('deployed_agents', {
  id: text('id').primaryKey(),
  agentId: text('agent_id').notNull(),
  flyAppName: text('fly_app_name'),
  flyMachineId: text('fly_machine_id'),
  status: text('status').default('pending').notNull(), // pending | starting | running | stopped | error | destroyed
  managementUrl: text('management_url'),
  telegramToken: text('telegram_token'),
  telegramUserId: text('telegram_user_id'),
  soulMd: text('soul_md'),
  modelProvider: text('model_provider').default('anthropic'),
  modelName: text('model_name').default('claude-sonnet-4-5'),
  region: text('region').default('iad'),
  gatewayToken: text('gateway_token').notNull(),
  openaiApiKey: text('openai_api_key'),
  telegramGroupsJson: text('telegram_groups_json'),
  openclawWebhookUrl: text('openclaw_webhook_url'),
  webhookRelaySecret: text('webhook_relay_secret'),
  modelCredentials: text('model_credentials'),
  mcpConfigJson: text('mcp_config_json'),
  isManual: integer('is_manual').default(0),
  createdAt: text('created_at').default(sql`now()`).notNull(),
  updatedAt: text('updated_at').default(sql`now()`).notNull(),
});
