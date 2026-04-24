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

// Telegram group type (matches backend TelegramGroup)
export interface TopicPrompt {
  threadId: number;
  prompt: string;
}

export interface TelegramGroup {
  chatId: string;
  name?: string;
  requireMention?: boolean;
  allowFrom?: string[];
  topicPrompts?: TopicPrompt[];
}

// Deployment types
export interface DeployConfig {
  telegramToken: string;
  telegramUserId?: string;
  soulMd?: string;
  modelProvider?: string;
  modelName?: string;
  region?: string;
  modelCredentials?: string;
  openaiApiKey?: string;
  runtime?: 'openclaw' | 'hermes';
}

export interface DeploymentInfo {
  id?: string;
  deploymentId?: string;
  agentId: string;
  flyAppName?: string;
  flyMachineId?: string;
  status: string;
  managementUrl?: string;
  modelProvider?: string;
  modelName?: string;
  region?: string;
  appName?: string;
  machineId?: string;
  isManual?: boolean;
  openaiApiKey?: string | null;
  telegramGroups?: TelegramGroup[];
  createdAt?: string;
  updatedAt?: string;
  runtime?: string;
}

// Create & Deploy types
export interface CreateAndDeployData {
  name: string;
  description?: string;
  telegramToken: string;
  telegramUserId?: string;
  modelProvider?: 'anthropic' | 'openai-codex' | 'openai' | 'minimax';
  modelName?: string;
  soulMd?: string;
  region?: string;
  openaiApiKey?: string;
  modelCredentials?: string;
  mcpServers?: string;
  runtime?: 'openclaw' | 'hermes';
}

export interface AgentDetail {
  id: string;
  name: string;
  description: string | null;
  status: string;
  createdAt: string;
  deployment: {
    id: string;
    status: string;
    flyAppName: string | null;
    flyMachineId: string | null;
    managementUrl: string | null;
    gatewayToken: string;
    telegramToken: string | null;
    telegramUserId: string | null;
    openaiApiKey: string | null;
    telegramGroups: TelegramGroup[];
    soulMd: string | null;
    modelProvider: string | null;
    modelName: string | null;
    region: string | null;
    mcpConfigJson: string | null;
    runtime?: string | null;
    createdAt: string;
  } | null;
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
    request<{
      prompt: string;
      mcpUrl: string;
      agentName: string;
      enabledServices: string[];
      claudeCodeConfig: Record<string, unknown>;
      openaiClawConfig: Record<string, unknown>;
    }>(`/agents/${id}/connect-prompt`),

  // Self-registration
  claim: (code: string) =>
    request<ClaimedAgent>('/agents/claim', { method: 'POST', body: JSON.stringify({ code }) }),
  listPending: () => request<PendingRegistration[]>('/agents/pending'),
  cancelPending: (id: string) => request<void>(`/agents/pending/${id}`, { method: 'DELETE' }),

  // Deployment lifecycle
  deploy: (id: string, data: DeployConfig) =>
    request<DeploymentInfo>(`/agents/${id}/deploy`, { method: 'POST', body: JSON.stringify(data) }),
  getDeployment: (id: string) =>
    request<DeploymentInfo>(`/agents/${id}/deployment`),
  startDeployment: (id: string) =>
    request<{ status: string }>(`/agents/${id}/start`, { method: 'POST' }),
  stopDeployment: (id: string) =>
    request<{ status: string }>(`/agents/${id}/stop`, { method: 'POST' }),
  restartDeployment: (id: string) =>
    request<{ status: string }>(`/agents/${id}/restart`, { method: 'POST' }),
  redeployAgent: (id: string, data?: Partial<DeployConfig>) =>
    request<{ status: string; managementUrl: string }>(`/agents/${id}/redeploy`, { method: 'POST', body: JSON.stringify(data ?? {}) }),
  destroyDeployment: (id: string) =>
    request<void>(`/agents/${id}/deploy`, { method: 'DELETE' }),
  createAndDeploy: (data: CreateAndDeployData) =>
    request<{ id: string; name: string; status: string; deployment: object }>('/agents/create-and-deploy', {
      method: 'POST',
      body: JSON.stringify(data),
    }),
  createManual: (data: { name: string; description?: string; soulMd?: string }) =>
    request<{ id: string; name: string; status: string; deployment: object }>('/agents/create-manual', {
      method: 'POST',
      body: JSON.stringify(data),
    }),
  getDetail: (id: string) =>
    request<AgentDetail>(`/agents/${id}/detail`),
  getLogs: (id: string, nextToken?: string) =>
    request<{ logs: Array<{ timestamp: string; message: string; level: string; instance: string; region: string }>; nextToken?: string }>(
      `/agents/${id}/logs${nextToken ? `?next_token=${nextToken}` : ''}`
    ),
  updateSoul: (id: string, soulMd: string) =>
    request<{ soulMd: string; redeployed: boolean }>(`/agents/${id}/soul`, {
      method: 'PUT',
      body: JSON.stringify({ soulMd }),
    }),
  getManagementUrl: (id: string) =>
    request<{ url: string }>(`/agents/${id}/management-url`),
  logsStreamUrl: (id: string) => `${API_BASE}/agents/${id}/logs/stream`,
  updateSettings: (id: string, data: { telegramGroups?: TelegramGroup[]; openaiApiKey?: string | null }) =>
    request<{ changed: boolean; restarted: boolean }>(`/agents/${id}/settings`, {
      method: 'PUT',
      body: JSON.stringify(data),
    }),
};

// OpenAI Auth
export const openaiAuth = {
  startDeviceFlow: () =>
    request<{ deviceAuthId: string; userCode: string; verificationUrl: string; interval: number }>('/auth/openai-device', {
      method: 'POST',
      body: JSON.stringify({ action: 'start' }),
    }),
  pollDeviceFlow: (deviceAuthId: string, userCode: string) =>
    request<{ status: string; tokens?: string; error?: string }>('/auth/openai-device', {
      method: 'POST',
      body: JSON.stringify({ action: 'poll', deviceAuthId, userCode }),
    }),
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
  addLinear: (token: string, workspaceName: string) =>
    request<{ id: string; serviceId: string; workspaceName: string; workspaceId: string }>(
      '/credentials/linear',
      { method: 'POST', body: JSON.stringify({ token, workspaceName }) }
    ),
  addNotion: (token: string) =>
    request<{ id: string; serviceId: string; botName: string; workspaceName: string }>(
      '/credentials/notion',
      { method: 'POST', body: JSON.stringify({ token }) }
    ),
  addHermeneutix: (token: string) =>
    request<{ id: string; serviceId: string }>(
      '/credentials/hermeneutix',
      { method: 'POST', body: JSON.stringify({ token }) }
    ),
  addZendesk: (token: string, email: string, subdomain: string) =>
    request<{ id: string; serviceId: string }>(
      '/credentials/zendesk',
      { method: 'POST', body: JSON.stringify({ token, email, subdomain }) }
    ),
  addApiKey: (serviceId: string, apiKey: string) =>
    request<{ id: string; serviceId: string }>(
      '/credentials',
      { method: 'POST', body: JSON.stringify({ serviceId, type: 'api_key', data: { apiKey } }) }
    ),
  checkHealth: (id: string) => request<unknown>(`/credentials/${id}/health`),
  delete: (id: string) => request<void>(`/credentials/${id}`, { method: 'DELETE' }),
};

// OAuth
export const oauth = {
  initiateGoogle: (services?: string[], reconnectCredentialId?: string, approvalId?: string) => {
    const params = new URLSearchParams();
    if (services?.length) params.set('services', services.join(','));
    if (reconnectCredentialId) params.set('reconnect', reconnectCredentialId);
    if (approvalId) params.set('approvalId', approvalId);
    const qs = params.toString();
    return request<{ authUrl: string; state: string }>(
      `/oauth/google${qs ? `?${qs}` : ''}`
    );
  },
  initiateMicrosoft: (services?: string[], reconnectCredentialId?: string, approvalId?: string) => {
    const params = new URLSearchParams();
    if (services?.length) params.set('services', services.join(','));
    if (reconnectCredentialId) params.set('reconnect', reconnectCredentialId);
    if (approvalId) params.set('approvalId', approvalId);
    const qs = params.toString();
    return request<{ authUrl: string; state: string }>(
      `/oauth/microsoft${qs ? `?${qs}` : ''}`
    );
  },
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
  query: async (filter: Record<string, unknown> = {}) => {
    const params = new URLSearchParams();
    Object.entries(filter).forEach(([key, value]) => {
      if (value !== undefined) params.append(key, String(value));
    });
    const headers: Record<string, string> = {};
    const response = await fetch(`${API_BASE}/audit?${params}`, { headers });
    if (!response.ok) {
      const error = await response.json().catch(() => ({}));
      throw new ApiError(error.error?.code || 'UNKNOWN', error.error?.message || 'Request failed');
    }
    return response.json() as Promise<{ data: unknown[]; pagination: { total: number; limit: number; offset: number; hasMore: boolean } }>;
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
  telegramLinked?: boolean;
}

export interface AuthResponse {
  authenticated: boolean;
  user?: User;
}

// Backups
export interface BackupMetadata {
  id: string;
  filename: string;
  createdAt: string;
  sizeBytes: number;
  agentCount: number;
}

export interface RestoreResult {
  ok: boolean;
  safetyBackupId: string;
  restored: {
    credentials: number;
    policies: number;
    agents: number;
    deployedAgents: number;
    agentServiceInstances: number;
    agentToolPermissions: number;
    agentServiceCredentials: number;
  };
}

export const backups = {
  list: () => request<{ backups: BackupMetadata[] }>('/backups'),
  create: () => request<{ backup: BackupMetadata }>('/backups', { method: 'POST' }),
  restore: (id: string) => request<RestoreResult>(`/backups/${id}/restore`, { method: 'POST' }),
  downloadUrl: (id: string) => `/api/backups/${id}`,
};

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

// Telegram notification linking
export const telegram = {
  createLink: () =>
    request<{ code: string; url: string; expiresAt: string }>('/telegram/link', { method: 'POST' }),
  unlink: () =>
    request<{ ok: boolean }>('/telegram/link', { method: 'DELETE' }),
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


// Service Instance Types
export interface ServiceInstance {
  id: string;
  agentId: string;
  serviceType: string;
  serviceName: string;
  label: string | null;
  credentialId: string | null;
  credentialEmail: string | null;
  credentialName: string | null;
  credentialStatus: 'connected' | 'missing' | 'expired' | 'not_linked';
  enabled: boolean;
  isDefault: boolean;
  permissionLevel: PermissionLevel;
  toolCount: number;
  blockedCount: number;
  approvalRequiredCount: number;
}

export interface InstanceConfig extends ServiceInstance {
  tools: ToolPermissionEntry[];
}

export interface AgentPermissionsResponse {
  agents: Array<{
    id: string;
    name: string;
    status: string;
    instances: ServiceInstance[];
  }>;
  availableServices: Array<{ type: string; name: string; icon: string }>;
}

export interface DrivePathRule {
  folderId: string;
  label?: string;
  permission: 'read' | 'write' | 'blocked';
}

export interface DrivePathConfig {
  defaultLevel: 'read' | 'write' | 'blocked';
  rules: DrivePathRule[];
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

  // Instance-based API
  getAgentPermissions: () =>
    request<AgentPermissionsResponse>('/permissions/agents'),

  getAvailableServices: () =>
    request<Array<{ type: string; name: string; icon: string }>>('/permissions/available-services'),

  createInstance: (agentId: string, serviceType: string, label?: string, credentialId?: string) =>
    request<ServiceInstance>(`/permissions/${agentId}/instances`, {
      method: 'POST',
      body: JSON.stringify({ serviceType, label, credentialId }),
    }),

  getInstanceConfig: (instanceId: string) =>
    request<InstanceConfig>(`/permissions/instances/${instanceId}`),

  updateInstance: (instanceId: string, data: { label?: string; credentialId?: string; enabled?: boolean }) =>
    request<ServiceInstance>(`/permissions/instances/${instanceId}`, {
      method: 'PUT',
      body: JSON.stringify(data),
    }),

  deleteInstance: (instanceId: string) =>
    request<void>(`/permissions/instances/${instanceId}`, { method: 'DELETE' }),

  setInstanceLevel: (instanceId: string, level: PermissionLevel) =>
    request<InstanceConfig>(`/permissions/instances/${instanceId}/level`, {
      method: 'PUT',
      body: JSON.stringify({ level }),
    }),

  setInstanceToolPermission: (instanceId: string, toolName: string, permission: ToolPermission) =>
    request<InstanceConfig>(`/permissions/instances/${instanceId}/tools/${toolName}`, {
      method: 'PUT',
      body: JSON.stringify({ permission }),
    }),

  resetInstanceToolPermission: (instanceId: string, toolName: string) =>
    request<InstanceConfig>(`/permissions/instances/${instanceId}/tools/${toolName}`, {
      method: 'DELETE',
    }),

  // Drive path-based permissions
  getDrivePathConfig: (agentId: string) =>
    request<DrivePathConfig>(`/permissions/${agentId}/drive/path-config`),

  setDrivePathConfig: (agentId: string, config: DrivePathConfig) =>
    request<DrivePathConfig>(`/permissions/${agentId}/drive/path-config`, {
      method: 'PUT',
      body: JSON.stringify(config),
    }),
};
