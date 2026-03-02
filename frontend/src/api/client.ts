const API_BASE = '/api';

export class ApiError extends Error {
  constructor(
    public code: string,
    message: string,
    public details?: Record<string, unknown>
  ) {
    super(message);
    this.name = 'ApiError';
  }
}

async function request<T>(
  path: string,
  options: RequestInit = {}
): Promise<T> {
  const response = await fetch(`${API_BASE}${path}`, {
    ...options,
    headers: {
      'Content-Type': 'application/json',
      ...options.headers,
    },
  });

  if (!response.ok) {
    const error = await response.json().catch(() => ({ error: { code: 'UNKNOWN', message: 'Unknown error' } }));
    throw new ApiError(
      error.error?.code || 'UNKNOWN',
      error.error?.message || 'Request failed',
      error.error?.details
    );
  }

  if (response.status === 204) {
    return undefined as T;
  }

  const data = await response.json();
  return data.data ?? data;
}

// Agent types
export interface PendingRegistration {
  id: string;
  name: string;
  description: string | null;
  claimCode: string;
  expiresAt: string;
  createdAt: string;
}

export interface ClaimedAgent {
  id: string;
  name: string;
  description: string | null;
  status: string;
  createdAt: string;
}

export interface RegistrationResponse {
  agentId: string;
  claimCode: string;
  claimUrl: string;
  expiresAt: string;
  expiresInSeconds: number;
  instructions: string;
}

// Agents
export const agents = {
  list: () => request<unknown[]>('/agents'),
  get: (id: string) => request<unknown>(`/agents/${id}`),
  create: (data: { name: string; description?: string; policyId?: string }) =>
    request<unknown>('/agents', { method: 'POST', body: JSON.stringify(data) }),
  update: (id: string, data: { name?: string; description?: string; policyId?: string; status?: string }) =>
    request<unknown>(`/agents/${id}`, { method: 'PATCH', body: JSON.stringify(data) }),
  delete: (id: string) => request<void>(`/agents/${id}`, { method: 'DELETE' }),

  // Self-registration
  claim: (code: string) =>
    request<ClaimedAgent>('/agents/claim', { method: 'POST', body: JSON.stringify({ code }) }),
  listPending: () => request<PendingRegistration[]>('/agents/pending'),
  cancelPending: (id: string) => request<void>(`/agents/pending/${id}`, { method: 'DELETE' }),
};

// Policies
export const policies = {
  list: () => request<unknown[]>('/policies'),
  get: (id: string) => request<unknown>(`/policies/${id}`),
  create: (data: { name: string; yaml: string }) =>
    request<unknown>('/policies', { method: 'POST', body: JSON.stringify(data) }),
  update: (id: string, data: { name?: string; yaml?: string }) =>
    request<unknown>(`/policies/${id}`, { method: 'PUT', body: JSON.stringify(data) }),
  delete: (id: string) => request<void>(`/policies/${id}`, { method: 'DELETE' }),
  validate: (id: string, yaml: string) =>
    request<{ valid: boolean; errors: unknown[]; parsed: unknown }>(
      `/policies/${id}/validate`,
      { method: 'POST', body: JSON.stringify({ yaml }) }
    ),
};

// Credentials
export const credentials = {
  list: () => request<unknown[]>('/credentials'),
  create: (data: { serviceId: string; type: string; data: unknown }) =>
    request<unknown>('/credentials', { method: 'POST', body: JSON.stringify(data) }),
  checkHealth: (id: string) => request<unknown>(`/credentials/${id}/health`),
  delete: (id: string) => request<void>(`/credentials/${id}`, { method: 'DELETE' }),
};

// Approvals
export const approvals = {
  list: (agentId?: string) =>
    request<unknown[]>(`/approvals${agentId ? `?agentId=${agentId}` : ''}`),
  get: (id: string) => request<unknown>(`/approvals/${id}`),
  approve: (id: string, comment?: string) =>
    request<unknown>(`/approvals/${id}/approve`, { method: 'POST', body: JSON.stringify({ comment }) }),
  reject: (id: string, reason: string) =>
    request<unknown>(`/approvals/${id}/reject`, { method: 'POST', body: JSON.stringify({ reason }) }),
};

// Audit
export const audit = {
  query: (filter: Record<string, unknown> = {}) => {
    const params = new URLSearchParams();
    Object.entries(filter).forEach(([key, value]) => {
      if (value !== undefined) params.append(key, String(value));
    });
    return request<{ data: unknown[]; pagination: unknown }>(`/audit?${params}`);
  },
};

// Connections
export const connections = {
  list: () => request<unknown[]>('/connections'),
};

// Health
export const health = {
  check: () => request<{ status: string; timestamp: string }>('/health'),
};

// Permission Matrix Types
export type ServiceType = 'gmail' | 'drive' | 'calendar' | 'web-search' | 'browser';
export type ToolPermission = 'allow' | 'block' | 'require_approval';

export interface PermissionMatrixCell {
  agentId: string;
  serviceType: ServiceType;
  enabled: boolean;
  credentialStatus: 'connected' | 'missing' | 'expired' | 'not_linked';
  toolCount: number;
  blockedCount: number;
  approvalRequiredCount: number;
}

export interface PermissionMatrix {
  agents: Array<{ id: string; name: string; status: string }>;
  services: Array<{ type: ServiceType; name: string }>;
  cells: PermissionMatrixCell[];
}

export interface ToolPermissionEntry {
  toolName: string;
  description: string;
  permission: ToolPermission;
  isDefault: boolean;
}

export interface AgentServiceConfig {
  agentId: string;
  agentName: string;
  serviceType: ServiceType;
  serviceName: string;
  enabled: boolean;
  credentialId: string | null;
  credentialStatus: 'connected' | 'missing' | 'expired' | 'not_linked';
  tools: ToolPermissionEntry[];
}

export interface ServiceCredential {
  id: string;
  type: string;
  status: string;
  expiresAt: string | null;
}

// Permissions
export const permissions = {
  getMatrix: () => request<PermissionMatrix>('/permissions/matrix'),

  getServiceConfig: (agentId: string, serviceType: ServiceType) =>
    request<AgentServiceConfig>(`/permissions/${agentId}/${serviceType}`),

  setServiceAccess: (agentId: string, serviceType: ServiceType, enabled: boolean) =>
    request<AgentServiceConfig>(`/permissions/${agentId}/${serviceType}/access`, {
      method: 'PUT',
      body: JSON.stringify({ enabled }),
    }),

  linkCredential: (agentId: string, serviceType: ServiceType, credentialId: string) =>
    request<AgentServiceConfig>(`/permissions/${agentId}/${serviceType}/credential`, {
      method: 'PUT',
      body: JSON.stringify({ credentialId }),
    }),

  unlinkCredential: (agentId: string, serviceType: ServiceType) =>
    request<void>(`/permissions/${agentId}/${serviceType}/credential`, { method: 'DELETE' }),

  setToolPermission: (
    agentId: string,
    serviceType: ServiceType,
    toolName: string,
    permission: ToolPermission
  ) =>
    request<AgentServiceConfig>(`/permissions/${agentId}/${serviceType}/tools/${toolName}`, {
      method: 'PUT',
      body: JSON.stringify({ permission }),
    }),

  resetToolPermission: (agentId: string, serviceType: ServiceType, toolName: string) =>
    request<AgentServiceConfig>(`/permissions/${agentId}/${serviceType}/tools/${toolName}`, {
      method: 'DELETE',
    }),

  setServiceToolPermissions: (
    agentId: string,
    serviceType: ServiceType,
    toolPermissions: Record<string, ToolPermission>
  ) =>
    request<AgentServiceConfig>(`/permissions/${agentId}/${serviceType}/tools`, {
      method: 'PUT',
      body: JSON.stringify({ permissions: toolPermissions }),
    }),

  getServiceCredentials: (serviceType: ServiceType) =>
    request<ServiceCredential[]>(`/permissions/credentials/${serviceType}`),
};
