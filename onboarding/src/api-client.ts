import { config } from './config.js';

const DEFAULT_SOUL_MD = `You are a personal AI assistant. You are helpful, concise, and get things done.`;

interface OAuthLinkResponse {
  url: string;
  expiresAt: string;
}

interface DeploymentStatusResponse {
  deploymentId: string;
  status: 'pending' | 'starting' | 'running' | 'stopped' | 'error';
  agentId: string;
  appName: string;
  updatedAt: string;
}

interface CreateAndDeployResponse {
  data: {
    id: string;
    name: string;
    status: string;
    deployment: {
      deploymentId: string;
      status: string;
      appName: string;
      runtime: string;
    };
  };
}

interface SetupLinkResponse {
  url: string;
  expiresAt: string;
}

interface ApiErrorBody {
  error?: {
    message?: string;
    code?: string;
  };
}

async function apiRequest<T>(
  method: string,
  path: string,
  body?: unknown
): Promise<T> {
  const url = `${config.agenthelmApiUrl}${path}`;
  const res = await fetch(url, {
    method,
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${config.agenthelmApiKey}`,
    },
    body: body ? JSON.stringify(body) : undefined,
  });

  if (!res.ok) {
    const err = await res.json().catch((): ApiErrorBody => ({ error: { message: res.statusText } })) as ApiErrorBody;
    const message = err.error?.message ?? res.statusText;
    const code = err.error?.code;
    const error = Object.assign(new Error(message), { status: res.status, code });
    throw error;
  }

  return res.json() as Promise<T>;
}

export async function generateOAuthLink(telegramUserId: number): Promise<OAuthLinkResponse> {
  return apiRequest<OAuthLinkResponse>('POST', '/api/onboarding/oauth/google/link', { telegramUserId });
}

export async function createAndDeploy(params: {
  name: string;
  telegramToken: string;
  telegramUserId: string;
  minimaxKey: string;
  onboardingTelegramUserId: number;
}): Promise<CreateAndDeployResponse> {
  return apiRequest<CreateAndDeployResponse>('POST', '/api/agents/create-and-deploy', {
    name: params.name,
    telegramToken: params.telegramToken,
    telegramUserId: params.telegramUserId,
    modelProvider: 'minimax',
    modelName: 'MiniMax-M2.7',
    openaiApiKey: params.minimaxKey,
    runtime: 'hermes',
    soulMd: DEFAULT_SOUL_MD,
    onboardingTelegramUserId: params.onboardingTelegramUserId,
  });
}

export async function getDeploymentStatus(deploymentId: string): Promise<DeploymentStatusResponse> {
  return apiRequest<DeploymentStatusResponse>('GET', `/api/onboarding/deployments/${deploymentId}/status`);
}

export async function generateSetupLink(telegramUserId: number): Promise<SetupLinkResponse> {
  return apiRequest<SetupLinkResponse>('POST', '/api/onboarding/auth/setup-link', { telegramUserId });
}
