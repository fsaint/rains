import { z } from 'zod';

// ============================================================================
// Agent Schemas
// ============================================================================

export const AgentStatusSchema = z.enum(['active', 'suspended', 'pending']);

export const CreateAgentSchema = z.object({
  name: z.string().min(1).max(100),
  description: z.string().max(500).optional(),
  policyId: z.string().optional(), // Optional - permissions managed via permission matrix
});

export const UpdateAgentSchema = z.object({
  name: z.string().min(1).max(100).optional(),
  description: z.string().max(500).optional(),
  policyId: z.string().uuid().optional(),
  status: AgentStatusSchema.optional(),
});

export const AgentSchema = z.object({
  id: z.string().uuid(),
  name: z.string(),
  description: z.string().optional(),
  policyId: z.string().uuid(),
  credentials: z.array(z.string().uuid()),
  status: AgentStatusSchema,
  createdAt: z.coerce.date(),
  updatedAt: z.coerce.date(),
});

// ============================================================================
// Policy Schemas
// ============================================================================

export const ToolConstraintsSchema = z.record(z.unknown());

export const ServicePolicySchema = z.object({
  tools: z.object({
    allow: z.array(z.string()).optional(),
    block: z.array(z.string()).optional(),
  }).optional(),
  constraints: z.record(ToolConstraintsSchema).optional(),
  approvalRequired: z.array(z.string()).optional(),
});

export const ParsedPolicySchema = z.object({
  version: z.string(),
  agent: z.string().optional(),
  services: z.record(ServicePolicySchema),
});

export const CreatePolicySchema = z.object({
  name: z.string().min(1).max(100),
  yaml: z.string().min(1),
});

export const UpdatePolicySchema = z.object({
  name: z.string().min(1).max(100).optional(),
  yaml: z.string().min(1).optional(),
});

export const PolicySchema = z.object({
  id: z.string().uuid(),
  version: z.string(),
  name: z.string(),
  yaml: z.string(),
  parsed: ParsedPolicySchema,
  createdAt: z.coerce.date(),
  updatedAt: z.coerce.date(),
});

// ============================================================================
// Credential Schemas
// ============================================================================

export const CredentialTypeSchema = z.enum(['oauth2', 'api_key', 'basic']);

export const OAuth2CredentialSchema = z.object({
  accessToken: z.string(),
  refreshToken: z.string().optional(),
  tokenType: z.string(),
  expiresAt: z.coerce.date().optional(),
  scope: z.string().optional(),
});

export const ApiKeyCredentialSchema = z.object({
  apiKey: z.string(),
});

export const BasicCredentialSchema = z.object({
  username: z.string(),
  password: z.string(),
});

export const CreateCredentialSchema = z.object({
  serviceId: z.string().min(1).max(100),
  type: CredentialTypeSchema,
  data: z.union([OAuth2CredentialSchema, ApiKeyCredentialSchema, BasicCredentialSchema]),
});

export const CredentialHealthSchema = z.object({
  credentialId: z.string().uuid(),
  serviceId: z.string(),
  valid: z.boolean(),
  expiresAt: z.coerce.date().optional(),
  lastChecked: z.coerce.date(),
  error: z.string().optional(),
});

// ============================================================================
// Approval Schemas
// ============================================================================

export const ApprovalStatusSchema = z.enum(['pending', 'approved', 'rejected', 'expired']);

export const ApprovalRequestSchema = z.object({
  id: z.string().uuid(),
  agentId: z.string().uuid(),
  tool: z.string(),
  arguments: z.record(z.unknown()),
  context: z.string().optional(),
  status: ApprovalStatusSchema,
  requestedAt: z.coerce.date(),
  expiresAt: z.coerce.date(),
  resolvedAt: z.coerce.date().optional(),
  resolvedBy: z.string().optional(),
  resolutionComment: z.string().optional(),
});

export const ApprovalDecisionSchema = z.object({
  approved: z.boolean(),
  comment: z.string().max(500).optional(),
});

// ============================================================================
// Audit Schemas
// ============================================================================

export const AuditEventTypeSchema = z.enum(['tool_call', 'approval', 'policy_change', 'auth', 'connection', 'agent_event']);
export const AuditResultSchema = z.enum(['success', 'blocked', 'error', 'pending']);

export const AuditFilterSchema = z.object({
  startDate: z.coerce.date().optional(),
  endDate: z.coerce.date().optional(),
  agentId: z.string().uuid().optional(),
  eventType: AuditEventTypeSchema.optional(),
  tool: z.string().optional(),
  result: AuditResultSchema.optional(),
  limit: z.number().int().min(1).max(1000).default(100),
  offset: z.number().int().min(0).default(0),
});

export const AuditEntrySchema = z.object({
  id: z.number().int(),
  timestamp: z.coerce.date(),
  eventType: AuditEventTypeSchema,
  agentId: z.string().optional(),
  tool: z.string().optional(),
  arguments: z.record(z.unknown()).optional(),
  result: AuditResultSchema.optional(),
  durationMs: z.number().int().optional(),
  metadata: z.record(z.unknown()).optional(),
});

// ============================================================================
// Spend Schemas
// ============================================================================

export const BudgetSchema = z.object({
  daily: z.number().positive().optional(),
  weekly: z.number().positive().optional(),
  monthly: z.number().positive().optional(),
  currency: z.string().length(3).default('USD'),
  alertThresholds: z.array(z.number().min(0).max(1)).default([0.5, 0.8, 0.95]),
});

export const SpendRecordSchema = z.object({
  agentId: z.string().uuid(),
  serviceId: z.string(),
  amount: z.number().positive(),
  currency: z.string().length(3).default('USD'),
});

// ============================================================================
// MCP Server Schemas
// ============================================================================

export const StdioConfigSchema = z.object({
  command: z.string(),
  args: z.array(z.string()).optional(),
  env: z.record(z.string()).optional(),
  cwd: z.string().optional(),
});

export const HttpConfigSchema = z.object({
  url: z.string().url(),
  headers: z.record(z.string()).optional(),
});

export const WebSocketConfigSchema = z.object({
  url: z.string().url(),
  headers: z.record(z.string()).optional(),
});

export const MCPServerConfigSchema = z.object({
  id: z.string().uuid(),
  name: z.string().min(1).max(100),
  transport: z.enum(['stdio', 'http', 'websocket']),
  config: z.union([StdioConfigSchema, HttpConfigSchema, WebSocketConfigSchema]),
});

export const CreateMCPServerSchema = z.object({
  name: z.string().min(1).max(100),
  transport: z.enum(['stdio', 'http', 'websocket']),
  config: z.union([StdioConfigSchema, HttpConfigSchema, WebSocketConfigSchema]),
});

// ============================================================================
// API Schemas
// ============================================================================

export const PaginationSchema = z.object({
  limit: z.number().int().min(1).max(100).default(20),
  offset: z.number().int().min(0).default(0),
});

export const ApiErrorSchema = z.object({
  code: z.string(),
  message: z.string(),
  details: z.record(z.unknown()).optional(),
});

// ============================================================================
// Type Inference Helpers
// ============================================================================

export type CreateAgentInput = z.infer<typeof CreateAgentSchema>;
export type UpdateAgentInput = z.infer<typeof UpdateAgentSchema>;
export type CreatePolicyInput = z.infer<typeof CreatePolicySchema>;
export type UpdatePolicyInput = z.infer<typeof UpdatePolicySchema>;
export type CreateCredentialInput = z.infer<typeof CreateCredentialSchema>;
export type ApprovalDecisionInput = z.infer<typeof ApprovalDecisionSchema>;
export type AuditFilterInput = z.infer<typeof AuditFilterSchema>;
export type CreateMCPServerInput = z.infer<typeof CreateMCPServerSchema>;
export type PaginationInput = z.infer<typeof PaginationSchema>;
