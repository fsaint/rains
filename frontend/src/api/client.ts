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

// Agents
export const agents = {
  list: () => request<unknown[]>('/agents'),
  get: (id: string) => request<unknown>(`/agents/${id}`),
  create: (data: { name: string; description?: string; policyId: string }) =>
    request<unknown>('/agents', { method: 'POST', body: JSON.stringify(data) }),
  update: (id: string, data: { name?: string; description?: string; policyId?: string; status?: string }) =>
    request<unknown>(`/agents/${id}`, { method: 'PATCH', body: JSON.stringify(data) }),
  delete: (id: string) => request<void>(`/agents/${id}`, { method: 'DELETE' }),
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
