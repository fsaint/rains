import { useState } from 'react';
import { X, Check, KeyRound, ExternalLink } from 'lucide-react';
import { useQueryClient } from '@tanstack/react-query';
import { ClaudeSetupTokenFlow } from './ClaudeSetupTokenFlow';
import { CodexDeviceFlow } from './CodexDeviceFlow';
import { approvals, agents, credentials, oauth } from '../api/client';

const PROVIDER_LABELS: Record<string, string> = {
  anthropic: 'Anthropic Claude',
  'openai-codex': 'OpenAI',
  fly: 'Fly.io',
  docker: 'Docker',
  gmail: 'Gmail',
  drive: 'Google Drive',
  calendar: 'Google Calendar',
  github: 'GitHub',
  linear: 'Linear',
  notion: 'Notion',
  'outlook-mail': 'Outlook Mail',
  'outlook-calendar': 'Outlook Calendar',
  microsoft: 'Microsoft',
  hermeneutix: 'Hermeneutix',
};

// Services that use Google OAuth
const GOOGLE_OAUTH_SERVICES = ['gmail', 'drive', 'calendar'];
// Services that use Microsoft OAuth
const MICROSOFT_OAUTH_SERVICES = ['outlook-mail', 'outlook-calendar', 'microsoft'];
// Services that use a simple API key input
const API_KEY_SERVICES = ['linear', 'notion', 'github', 'hermeneutix'];

export interface ReauthApproval {
  id: string;
  agentId: string;
  tool: string;
  arguments: Record<string, unknown>;
  context?: string;
  status: string;
  requestedAt: string;
  expiresAt: string;
}

interface Props {
  approval: ReauthApproval;
  onComplete: () => void;
  onDismiss: () => void;
}

export function ReauthModal({ approval, onComplete, onDismiss }: Props) {
  const queryClient = useQueryClient();
  const provider = (approval.arguments.provider as string) ?? 'unknown';
  const credentialId = approval.arguments.credentialId as string | undefined;
  const providerLabel = PROVIDER_LABELS[provider] ?? provider;

  const [status, setStatus] = useState<'idle' | 'working' | 'done' | 'error'>('idle');
  const [errorMsg, setErrorMsg] = useState('');
  const [apiKey, setApiKey] = useState('');

  async function closeApproval() {
    await approvals.approve(approval.id, 'Re-authenticated successfully');
    queryClient.invalidateQueries({ queryKey: ['approvals'] });
    onComplete();
  }

  async function handleLLMComplete(token: string) {
    setStatus('working');
    try {
      await agents.redeployAgent(approval.agentId, { modelCredentials: token });
      await closeApproval();
      setStatus('done');
    } catch (err) {
      setStatus('error');
      setErrorMsg(err instanceof Error ? err.message : 'Redeploy failed');
    }
  }

  async function handleOAuthReconnect(provider: 'google' | 'microsoft') {
    setStatus('working');
    try {
      let result: { authUrl: string };
      if (provider === 'google') {
        result = await oauth.initiateGoogle(undefined, credentialId);
      } else {
        result = await oauth.initiateMicrosoft(undefined, credentialId);
      }
      // Open in new tab — the OAuth callback will update the credential
      window.open(result.authUrl, '_blank', 'noopener,noreferrer');
      // Approve optimistically — the credential will be refreshed by OAuth flow
      await closeApproval();
      setStatus('done');
    } catch (err) {
      setStatus('error');
      setErrorMsg(err instanceof Error ? err.message : 'OAuth initiation failed');
    }
  }

  async function handleApiKeySubmit() {
    if (!apiKey.trim()) return;
    setStatus('working');
    try {
      if (provider === 'github') {
        await credentials.addGitHub(apiKey.trim());
      } else if (provider === 'linear') {
        await credentials.addLinear(apiKey.trim(), 'My Workspace');
      } else if (provider === 'notion') {
        await credentials.addNotion(apiKey.trim());
      } else {
        await credentials.addApiKey(provider, apiKey.trim());
      }
      await closeApproval();
      setStatus('done');
    } catch (err) {
      setStatus('error');
      setErrorMsg(err instanceof Error ? err.message : 'Failed to save credentials');
    }
  }

  function renderProviderContent() {
    if (status === 'done') {
      return (
        <div className="flex items-center gap-3 p-4 bg-emerald-50 border border-emerald-100 rounded-xl">
          <Check className="w-5 h-5 text-emerald-600 shrink-0" />
          <div>
            <p className="font-medium text-emerald-800 text-sm">Re-authentication successful</p>
            <p className="text-xs text-emerald-600 mt-0.5">Your agent will resume shortly.</p>
          </div>
        </div>
      );
    }

    if (provider === 'anthropic') {
      return (
        <ClaudeSetupTokenFlow
          onComplete={handleLLMComplete}
        />
      );
    }

    if (provider === 'openai-codex') {
      return (
        <CodexDeviceFlow
          onComplete={handleLLMComplete}
        />
      );
    }

    if (GOOGLE_OAUTH_SERVICES.includes(provider)) {
      return (
        <div className="space-y-3">
          <p className="text-sm text-gray-600">
            Your {providerLabel} connection has expired. Click below to re-authorize access.
          </p>
          <button
            onClick={() => handleOAuthReconnect('google')}
            disabled={status === 'working'}
            className="w-full flex items-center justify-center gap-2 px-4 py-3 bg-reins-navy text-white rounded-xl hover:bg-reins-navy/90 transition-colors text-sm font-medium disabled:opacity-60"
          >
            <ExternalLink className="w-4 h-4" />
            {status === 'working' ? 'Opening…' : `Reconnect ${providerLabel}`}
          </button>
        </div>
      );
    }

    if (MICROSOFT_OAUTH_SERVICES.includes(provider)) {
      return (
        <div className="space-y-3">
          <p className="text-sm text-gray-600">
            Your {providerLabel} connection has expired. Click below to re-authorize access.
          </p>
          <button
            onClick={() => handleOAuthReconnect('microsoft')}
            disabled={status === 'working'}
            className="w-full flex items-center justify-center gap-2 px-4 py-3 bg-reins-navy text-white rounded-xl hover:bg-reins-navy/90 transition-colors text-sm font-medium disabled:opacity-60"
          >
            <ExternalLink className="w-4 h-4" />
            {status === 'working' ? 'Opening…' : `Reconnect ${providerLabel}`}
          </button>
        </div>
      );
    }

    if (API_KEY_SERVICES.includes(provider)) {
      const placeholder =
        provider === 'github' ? 'ghp_…' :
        provider === 'linear' ? 'lin_api_…' :
        provider === 'notion' ? 'secret_…' :
        'Paste your API key';

      return (
        <div className="space-y-3">
          <p className="text-sm text-gray-600">
            Enter a new API key for {providerLabel}.
          </p>
          <input
            type="password"
            value={apiKey}
            onChange={(e) => setApiKey(e.target.value)}
            onKeyDown={(e) => e.key === 'Enter' && handleApiKeySubmit()}
            placeholder={placeholder}
            autoFocus
            className="w-full border border-gray-200 rounded-lg px-3 py-2.5 text-sm font-mono focus:ring-2 focus:ring-trust-blue/20 focus:border-trust-blue outline-none bg-white"
          />
          <button
            onClick={handleApiKeySubmit}
            disabled={!apiKey.trim() || status === 'working'}
            className="w-full px-4 py-2.5 bg-trust-blue text-white rounded-lg hover:bg-blue-600 transition-colors text-sm font-medium disabled:opacity-60"
          >
            {status === 'working' ? 'Saving…' : 'Save & Re-authenticate'}
          </button>
        </div>
      );
    }

    // Fallback — fly, docker, or unknown
    return (
      <div className="space-y-3">
        <p className="text-sm text-gray-600">
          {approval.context ?? `Authentication is required for ${providerLabel}. Please check your configuration and try again.`}
        </p>
        <button
          onClick={onDismiss}
          className="w-full px-4 py-2.5 border border-gray-200 text-gray-600 rounded-lg hover:bg-gray-50 transition-colors text-sm font-medium"
        >
          Dismiss
        </button>
      </div>
    );
  }

  return (
    <div
      className="fixed inset-0 bg-black/40 flex items-center justify-center z-50 p-4"
      onClick={(e) => e.target === e.currentTarget && onDismiss()}
    >
      <div className="bg-white rounded-2xl p-6 w-full max-w-md shadow-xl">
        {/* Header */}
        <div className="flex items-center justify-between mb-5">
          <div className="flex items-center gap-3">
            <div className="w-9 h-9 rounded-xl bg-trust-blue/10 flex items-center justify-center">
              <KeyRound className="w-4 h-4 text-trust-blue" />
            </div>
            <div>
              <h2 className="font-semibold text-gray-900 text-base">Re-authenticate {providerLabel}</h2>
              <p className="text-xs text-gray-500 mt-0.5">Agent: {approval.agentId}</p>
            </div>
          </div>
          <button
            onClick={onDismiss}
            className="w-8 h-8 flex items-center justify-center rounded-lg text-gray-400 hover:text-gray-600 hover:bg-gray-100 transition-colors"
          >
            <X className="w-4 h-4" />
          </button>
        </div>

        {/* Provider-specific content */}
        {renderProviderContent()}

        {/* Error state */}
        {status === 'error' && (
          <div className="mt-3 p-3 bg-red-50 border border-red-100 rounded-lg">
            <p className="text-xs text-red-700">{errorMsg}</p>
          </div>
        )}
      </div>
    </div>
  );
}
