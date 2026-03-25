// Core domain types for Reins

// ============================================================================
// Agent Types
// ============================================================================

export type AgentStatus = 'active' | 'suspended' | 'pending';

export interface Agent {
  id: string;
  name: string;
  description?: string;
  policyId: string;
  credentials: string[];
  status: AgentStatus;
  createdAt: Date;
  updatedAt: Date;
}

export interface AgentConnection {
  agentId: string;
  connectedAt: Date;
  lastActivity: Date;
  status: 'connected' | 'disconnected';
  transport: 'stdio' | 'http' | 'websocket';
}

// ============================================================================
// Policy Types
// ============================================================================

export interface Policy {
  id: string;
  version: string;
  name: string;
  yaml: string;
  parsed: ParsedPolicy;
  createdAt: Date;
  updatedAt: Date;
}

export interface ParsedPolicy {
  version: string;
  agent?: string;
  services: Record<string, ServicePolicy>;
}

export interface ServicePolicy {
  tools?: {
    allow?: string[];
    block?: string[];
  };
  constraints?: Record<string, ToolConstraints>;
  approvalRequired?: string[];
}

export interface ToolConstraints {
  [key: string]: unknown;
}

export type ToolDecision =
  | { action: 'allow' }
  | { action: 'block'; reason: string }
  | { action: 'require_approval'; approvers?: string[] };

// ============================================================================
// Credential Types
// ============================================================================

export type CredentialType = 'oauth2' | 'api_key' | 'basic';

export interface Credential {
  id: string;
  serviceId: string;
  type: CredentialType;
  expiresAt?: Date;
  createdAt: Date;
  updatedAt: Date;
}

export interface StoredCredential extends Credential {
  encryptedData: Buffer;
  iv: Buffer;
  authTag: Buffer;
}

export interface OAuth2Credential {
  accessToken: string;
  refreshToken?: string;
  tokenType: string;
  expiresAt?: Date;
  scope?: string;
}

export interface ApiKeyCredential {
  apiKey: string;
}

export interface BasicCredential {
  username: string;
  password: string;
}

export type CredentialData = OAuth2Credential | ApiKeyCredential | BasicCredential;

export interface CredentialHealth {
  credentialId: string;
  serviceId: string;
  valid: boolean;
  expiresAt?: Date;
  lastChecked: Date;
  error?: string;
}

// ============================================================================
// Approval Types
// ============================================================================

export type ApprovalStatus = 'pending' | 'approved' | 'rejected' | 'expired';

export interface ApprovalRequest {
  id: string;
  agentId: string;
  tool: string;
  arguments: Record<string, unknown>;
  context?: string;
  status: ApprovalStatus;
  requestedAt: Date;
  expiresAt: Date;
  resolvedAt?: Date;
  resolvedBy?: string;
  resolutionComment?: string;
}

export interface ApprovalDecision {
  approved: boolean;
  approver: string;
  comment?: string;
}

// ============================================================================
// Audit Types
// ============================================================================

export type AuditEventType = 'tool_call' | 'approval' | 'policy_change' | 'auth' | 'connection' | 'agent_event';
export type AuditResult = 'success' | 'blocked' | 'error' | 'pending';

export interface AuditEntry {
  id: number;
  timestamp: Date;
  eventType: AuditEventType;
  agentId?: string;
  tool?: string;
  arguments?: Record<string, unknown>;
  result?: AuditResult;
  durationMs?: number;
  metadata?: Record<string, unknown>;
}

export interface AuditFilter {
  startDate?: Date;
  endDate?: Date;
  agentId?: string;
  eventType?: AuditEventType;
  tool?: string;
  result?: AuditResult;
  limit?: number;
  offset?: number;
}

// ============================================================================
// Spend Types
// ============================================================================

export interface Budget {
  daily?: number;
  weekly?: number;
  monthly?: number;
  currency: string;
  alertThresholds: number[];
}

export interface SpendRecord {
  id: number;
  agentId: string;
  serviceId: string;
  amount: number;
  currency: string;
  recordedAt: Date;
}

export interface SpendSummary {
  agentId: string;
  period: 'daily' | 'weekly' | 'monthly';
  total: number;
  budget?: number;
  currency: string;
  percentUsed: number;
}

export type SpendDecision =
  | { allowed: true }
  | { allowed: false; reason: string; budgetRemaining: number };

// ============================================================================
// MCP Types
// ============================================================================

export interface MCPServerConfig {
  id: string;
  name: string;
  transport: 'stdio' | 'http' | 'websocket';
  config: StdioConfig | HttpConfig | WebSocketConfig;
}

export interface StdioConfig {
  command: string;
  args?: string[];
  env?: Record<string, string>;
  cwd?: string;
}

export interface HttpConfig {
  url: string;
  headers?: Record<string, string>;
}

export interface WebSocketConfig {
  url: string;
  headers?: Record<string, string>;
}

export type MCPServerHealth = 'healthy' | 'degraded' | 'down' | 'unknown';

export interface MCPServer extends MCPServerConfig {
  healthStatus: MCPServerHealth;
  lastHealthCheck?: Date;
  toolCount?: number;
  resourceCount?: number;
}

// ============================================================================
// API Response Types
// ============================================================================

export interface ApiResponse<T> {
  success: boolean;
  data?: T;
  error?: ApiError;
}

export interface ApiError {
  code: string;
  message: string;
  details?: Record<string, unknown>;
}

export interface PaginatedResponse<T> {
  items: T[];
  total: number;
  limit: number;
  offset: number;
  hasMore: boolean;
}

// ============================================================================
// WebSocket Event Types
// ============================================================================

export type WebSocketEventType =
  | 'approval_request'
  | 'approval_resolved'
  | 'agent_status'
  | 'credential_health'
  | 'spend_alert'
  | 'connection_status';

export interface WebSocketEvent<T = unknown> {
  type: WebSocketEventType;
  data: T;
  timestamp: Date;
}
