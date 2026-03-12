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
  const headers: Record<string, string> = { ...options.headers as Record<string, string> };
  if (options.body) {
    headers['Content-Type'] = 'application/json';
  }
  const response = await fetch(`${API_BASE}${path}`, {
    ...options,
    headers,
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
  create: (data: { name: string; description?: string }) =>
    request<unknown>('/agents', { method: 'POST', body: JSON.stringify(data) }),
  update: (id: string, data: { name?: string; description?: string; status?: string }) =>
    request<unknown>(`/agents/${id}`, { method: 'PATCH', body: JSON.stringify(data) }),
  delete: (id: string) => request<void>(`/agents/${id}`, { method: 'DELETE' }),

  // Connection prompt
  getConnectPrompt: (id: string) =>
    request<{ prompt: string; mcpUrl: string; agentName: string; enabledServices: string[] }>(`/agents/${id}/connect-prompt`),

  // Self-registration
  claim: (code: string) =>
    request<ClaimedAgent>('/agents/claim', { method: 'POST', body: JSON.stringify({ code }) }),
  listPending: () => request<PendingRegistration[]>('/agents/pending'),
  cancelPending: (id: string) => request<void>(`/agents/pending/${id}`, { method: 'DELETE' }),
};

// Credential types
export interface Credential {
  id: string;
  serviceId: string;
  type: string;
  accountEmail?: string;
  accountName?: string;
  grantedServices?: string[];
  expiresAt?: string;
  createdAt: string;
}

// Credentials
export const credentials = {
  list: () => request<Credential[]>('/credentials'),
  create: (data: { serviceId: string; type: string; data: unknown }) =>
    request<unknown>('/credentials', { method: 'POST', body: JSON.stringify(data) }),
  addGitHub: (token: string) =>
    request<{ id: string; serviceId: string; login: string; scopes: string[]; grantedServices: string[] }>(
      '/credentials/github',
      { method: 'POST', body: JSON.stringify({ token }) }
    ),
  checkHealth: (id: string) => request<unknown>(`/credentials/${id}/health`),
  delete: (id: string) => request<void>(`/credentials/${id}`, { method: 'DELETE' }),
};

// OAuth
export const oauth = {
  initiateGoogle: (services?: string[]) =>
    request<{ authUrl: string; state: string }>(
      `/oauth/google${services?.length ? `?services=${services.join(',')}` : ''}`
    ),
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

// User types
export interface User {
  id: string;
  email: string;
  name: string;
  role: 'admin' | 'user';
}

export interface AuthResponse {
  authenticated: boolean;
  user?: User;
}

// Auth
export const auth = {
  login: (email: string, password: string) =>
    request<AuthResponse>('/auth/login', {
      method: 'POST',
      body: JSON.stringify({ email, password }),
    }),
  logout: () =>
    request<{ authenticated: boolean }>('/auth/logout', { method: 'POST' }),
  session: () =>
    request<AuthResponse>('/auth/session'),
  updateProfile: (data: { name: string }) =>
    request<{ name: string }>('/auth/profile', { method: 'PATCH', body: JSON.stringify(data) }),
  changePassword: (currentPassword: string, newPassword: string) =>
    request<{ success: boolean }>('/auth/change-password', {
      method: 'POST',
      body: JSON.stringify({ currentPassword, newPassword }),
    }),
};

// Admin types
export interface AdminUser {
  id: string;
  email: string;
  name: string;
  role: string;
  status: string;
  created_at: string;
  updated_at: string;
}

// Admin
export const admin = {
  listUsers: () => request<AdminUser[]>('/admin/users'),
  createUser: (data: { email: string; name: string; password: string; role?: string }) =>
    request<AdminUser>('/admin/users', { method: 'POST', body: JSON.stringify(data) }),
  updateUser: (id: string, data: { name?: string; role?: string; status?: string }) =>
    request<AdminUser>(`/admin/users/${id}`, { method: 'PATCH', body: JSON.stringify(data) }),
  deleteUser: (id: string) =>
    request<void>(`/admin/users/${id}`, { method: 'DELETE' }),
  resetPassword: (id: string, password: string) =>
    request<{ success: boolean }>(`/admin/users/${id}/reset-password`, {
      method: 'POST',
      body: JSON.stringify({ password }),
    }),
};

// Health
export const health = {
  check: () => request<{ status: string; timestamp: string }>('/health'),
};

// Permission Matrix Types
export type ServiceType = string;
export type ToolPermission = 'allow' | 'block' | 'require_approval';
export type PermissionLevel = 'none' | 'read' | 'full' | 'custom';

export interface PermissionMatrixCell {
  agentId: string;
  serviceType: ServiceType;
  enabled: boolean;
  credentialStatus: 'connected' | 'missing' | 'expired' | 'not_linked';
  toolCount: number;
  blockedCount: number;
  approvalRequiredCount: number;
  permissionLevel: PermissionLevel;
  linkedCredentialCount: number;
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

export interface LinkedCredential {
  credentialId: string;
  accountEmail: string | null;
  accountName: string | null;
  isDefault: boolean;
  status: 'connected' | 'missing' | 'expired';
}

export interface AgentServiceConfig {
  agentId: string;
  agentName: string;
  serviceType: ServiceType;
  serviceName: string;
  enabled: boolean;
  credentialId: string | null;
  credentialStatus: 'connected' | 'missing' | 'expired' | 'not_linked';
  linkedCredentials: LinkedCredential[];
  tools: ToolPermissionEntry[];
  permissionLevel?: PermissionLevel;
}

export interface ServiceCredential {
  id: string;
  type: string;
  status: string;
  expiresAt: string | null;
  accountEmail: string | null;
  accountName: string | null;
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

  getPermissionLevel: (agentId: string, serviceType: ServiceType) =>
    request<{ level: PermissionLevel }>(`/permissions/${agentId}/${serviceType}/level`),

  setPermissionLevel: (agentId: string, serviceType: ServiceType, level: PermissionLevel) =>
    request<AgentServiceConfig & { permissionLevel: PermissionLevel }>(
      `/permissions/${agentId}/${serviceType}/level`,
      {
        method: 'PUT',
        body: JSON.stringify({ level }),
      }
    ),

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

  // Multi-account credential management
  addServiceCredential: (agentId: string, serviceType: ServiceType, credentialId: string, isDefault?: boolean) =>
    request<LinkedCredential[]>(`/permissions/${agentId}/${serviceType}/credentials`, {
      method: 'POST',
      body: JSON.stringify({ credentialId, isDefault }),
    }),

  removeServiceCredential: (agentId: string, serviceType: ServiceType, credentialId: string) =>
    request<void>(`/permissions/${agentId}/${serviceType}/credentials/${credentialId}`, { method: 'DELETE' }),

  setDefaultCredential: (agentId: string, serviceType: ServiceType, credentialId: string) =>
    request<LinkedCredential[]>(`/permissions/${agentId}/${serviceType}/credentials/${credentialId}/default`, {
      method: 'PUT',
    }),

  getLinkedCredentials: (agentId: string, serviceType: ServiceType) =>
    request<LinkedCredential[]>(`/permissions/${agentId}/${serviceType}/credentials`),
};
