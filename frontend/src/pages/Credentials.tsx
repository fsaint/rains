import { useState, useEffect } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { useSearchParams } from 'react-router-dom';
import { Plus, Trash2, Key, RefreshCw, CheckCircle, AlertCircle, Clock, X, Mail, HardDrive, Calendar, Github, SquareKanban } from 'lucide-react';
import { credentials, oauth, type Credential } from '../api/client';

interface CredentialHealth {
  valid: boolean;
  expiresAt?: string;
  error?: string;
}

const GoogleIcon = ({ className = 'w-5 h-5' }: { className?: string }) => (
  <svg className={className} viewBox="0 0 24 24">
    <path fill="#4285F4" d="M22.56 12.25c0-.78-.07-1.53-.2-2.25H12v4.26h5.92c-.26 1.37-1.04 2.53-2.21 3.31v2.77h3.57c2.08-1.92 3.28-4.74 3.28-8.09z" />
    <path fill="#34A853" d="M12 23c2.97 0 5.46-.98 7.28-2.66l-3.57-2.77c-.98.66-2.23 1.06-3.71 1.06-2.86 0-5.29-1.93-6.16-4.53H2.18v2.84C3.99 20.53 7.7 23 12 23z" />
    <path fill="#FBBC05" d="M5.84 14.09c-.22-.66-.35-1.36-.35-2.09s.13-1.43.35-2.09V7.07H2.18C1.43 8.55 1 10.22 1 12s.43 3.45 1.18 4.93l2.85-2.22.81-.62z" />
    <path fill="#EA4335" d="M12 5.38c1.62 0 3.06.56 4.21 1.64l3.15-3.15C17.45 2.09 14.97 1 12 1 7.7 1 3.99 3.47 2.18 7.07l3.66 2.84c.87-2.6 3.3-4.53 6.16-4.53z" />
  </svg>
);

const GOOGLE_SERVICES = [
  { type: 'gmail', name: 'Gmail', description: 'Read, search, and draft emails', icon: Mail },
  { type: 'drive', name: 'Google Drive', description: 'List, read, and search files', icon: HardDrive },
  { type: 'calendar', name: 'Google Calendar', description: 'View and manage calendar events', icon: Calendar },
];

export default function Credentials() {
  const queryClient = useQueryClient();
  const [searchParams, setSearchParams] = useSearchParams();
  const [showCreateModal, setShowCreateModal] = useState(false);
  const [createType, setCreateType] = useState<'pick' | 'google_scopes' | 'github_pat' | 'linear_key' | 'api_key'>('pick');
  const [notification, setNotification] = useState<{ type: 'success' | 'error'; message: string } | null>(null);
  const [newCredential, setNewCredential] = useState({
    serviceId: '',
    type: 'api_key' as const,
    data: { apiKey: '' },
  });
  const [healthStatus, setHealthStatus] = useState<Record<string, CredentialHealth>>({});
  const [selectedGoogleServices, setSelectedGoogleServices] = useState<Set<string>>(
    new Set(['gmail', 'drive', 'calendar'])
  );
  const [githubToken, setGithubToken] = useState('');
  const [githubError, setGithubError] = useState('');
  const [linearToken, setLinearToken] = useState('');
  const [linearWorkspace, setLinearWorkspace] = useState('');
  const [linearError, setLinearError] = useState('');
  const [updatingCredentialId, setUpdatingCredentialId] = useState<string | null>(null);

  // Handle OAuth callback
  useEffect(() => {
    const oauthSuccess = searchParams.get('oauth_success');
    const oauthError = searchParams.get('oauth_error');
    const email = searchParams.get('email');

    if (oauthSuccess === 'true') {
      const reconnected = searchParams.get('reconnected') === 'true';
      setNotification({
        type: 'success',
        message: reconnected
          ? `Google account ${email ? `(${email}) ` : ''}reconnected successfully!`
          : `Google account ${email ? `(${email}) ` : ''}connected successfully!`,
      });
      queryClient.invalidateQueries({ queryKey: ['credentials'] });
      setHealthStatus({});
      setSearchParams({});
    } else if (oauthError) {
      const errorMessages: Record<string, string> = {
        missing_params: 'OAuth flow was interrupted.',
        invalid_state: 'Security validation failed. Please try again.',
        token_exchange_failed: 'Failed to exchange authorization code.',
        userinfo_failed: 'Failed to retrieve account information.',
        config_error: 'Google OAuth is not configured.',
        internal_error: 'An internal error occurred.',
      };
      setNotification({
        type: 'error',
        message: errorMessages[oauthError] || `OAuth error: ${oauthError}`,
      });
      setSearchParams({});
    }

    if (oauthSuccess || oauthError) {
      const timer = setTimeout(() => setNotification(null), 5000);
      return () => clearTimeout(timer);
    }
    return undefined;
  }, [searchParams, setSearchParams, queryClient]);

  const { data: credentialsList, isLoading } = useQuery<Credential[]>({
    queryKey: ['credentials'],
    queryFn: credentials.list as () => Promise<Credential[]>,
  });

  // Auto-check health for all credentials on load
  useEffect(() => {
    if (!credentialsList?.length) return;
    for (const cred of credentialsList) {
      if (!healthStatus[cred.id]) {
        credentials.checkHealth(cred.id).then((health) => {
          setHealthStatus((prev) => ({ ...prev, [cred.id]: health as CredentialHealth }));
        }).catch(() => {});
      }
    }
  }, [credentialsList]); // eslint-disable-line react-hooks/exhaustive-deps

  const createMutation = useMutation({
    mutationFn: credentials.create,
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['credentials'] });
      setShowCreateModal(false);
      setNewCredential({ serviceId: '', type: 'api_key', data: { apiKey: '' } });
      setCreateType('pick');
    },
  });

  const deleteMutation = useMutation({
    mutationFn: credentials.delete,
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['credentials'] });
    },
  });

  const addGitHubMutation = useMutation({
    mutationFn: async (token: string) => {
      if (updatingCredentialId) {
        await credentials.delete(updatingCredentialId);
      }
      return credentials.addGitHub(token);
    },
    onSuccess: (data) => {
      queryClient.invalidateQueries({ queryKey: ['credentials'] });
      setShowCreateModal(false);
      setGithubToken('');
      setGithubError('');
      setCreateType('pick');
      const action = updatingCredentialId ? 'updated' : 'connected';
      setUpdatingCredentialId(null);
      setNotification({
        type: 'success',
        message: `GitHub account (${data.login}) ${action} with ${data.scopes.length} scope${data.scopes.length !== 1 ? 's' : ''}`,
      });
      setTimeout(() => setNotification(null), 5000);
    },
    onError: (error: any) => {
      setGithubError(error?.message || 'Invalid token');
    },
  });

  const addLinearMutation = useMutation({
    mutationFn: async ({ token, workspaceName }: { token: string; workspaceName: string }) => {
      if (updatingCredentialId) {
        await credentials.delete(updatingCredentialId);
      }
      return credentials.addLinear(token, workspaceName);
    },
    onSuccess: (data) => {
      queryClient.invalidateQueries({ queryKey: ['credentials'] });
      setShowCreateModal(false);
      setLinearToken('');
      setLinearWorkspace('');
      setLinearError('');
      setCreateType('pick');
      const action = updatingCredentialId ? 'updated' : 'connected';
      setUpdatingCredentialId(null);
      setNotification({
        type: 'success',
        message: `Linear workspace "${data.workspaceName}" ${action} successfully`,
      });
      setTimeout(() => setNotification(null), 5000);
    },
    onError: (error: any) => {
      setLinearError(error?.message || 'Invalid API key');
    },
  });

  const initiateGoogleOAuthMutation = useMutation({
    mutationFn: ({ services, reconnectId }: { services: string[]; reconnectId?: string }) =>
      oauth.initiateGoogle(services, reconnectId),
    onSuccess: (data) => {
      window.location.href = data.authUrl;
    },
    onError: (error) => {
      setNotification({
        type: 'error',
        message: error instanceof Error ? error.message : 'Failed to initiate OAuth flow',
      });
      setShowCreateModal(false);
    },
  });

  const checkHealth = async (id: string) => {
    const health = await credentials.checkHealth(id) as CredentialHealth;
    setHealthStatus((prev) => ({ ...prev, [id]: health }));
  };

  const handleCreate = (e: React.FormEvent) => {
    e.preventDefault();
    createMutation.mutate(newCredential);
  };

  const handleGoogleConnect = () => {
    const services = Array.from(selectedGoogleServices);
    if (services.length === 0) return;
    initiateGoogleOAuthMutation.mutate({ services });
  };

  const handleUpdateToken = (cred: Credential) => {
    setUpdatingCredentialId(cred.id);
    if (cred.serviceId === 'github') {
      setCreateType('github_pat');
      setGithubToken('');
      setGithubError('');
    } else if (cred.serviceId === 'linear') {
      setCreateType('linear_key');
      setLinearToken('');
      setLinearWorkspace('');
      setLinearError('');
    }
    setShowCreateModal(true);
  };

  const handleReconnect = (cred: Credential) => {
    const services = cred.grantedServices ?? ['gmail', 'drive', 'calendar'];
    initiateGoogleOAuthMutation.mutate({ services, reconnectId: cred.id });
  };

  const toggleGoogleService = (type: string) => {
    setSelectedGoogleServices((prev) => {
      const next = new Set(prev);
      if (next.has(type)) {
        next.delete(type);
      } else {
        next.add(type);
      }
      return next;
    });
  };

  const getHealthIcon = (id: string) => {
    const health = healthStatus[id];
    if (!health) return <Clock className="w-4 h-4 text-gray-400" />;
    if (health.valid) return <CheckCircle className="w-4 h-4 text-safe-green" />;
    return <AlertCircle className="w-4 h-4 text-alert-red" />;
  };

  const openCreateModal = () => {
    setCreateType('pick');
    setNewCredential({ serviceId: '', type: 'api_key', data: { apiKey: '' } });
    setSelectedGoogleServices(new Set(['gmail', 'drive', 'calendar']));
    setShowCreateModal(true);
  };

  const getServiceBadge = (type: string) => {
    if (type === 'github') return 'GitHub';
    if (type === 'linear') return 'Linear';
    const svc = GOOGLE_SERVICES.find((s) => s.type === type);
    if (!svc) return type;
    return svc.name;
  };

  return (
    <div className="p-8">
      {/* Notification Toast */}
      {notification && (
        <div
          className={`fixed top-4 right-4 z-50 px-4 py-3 rounded-lg shadow-lg flex items-center gap-2 ${
            notification.type === 'success'
              ? 'bg-safe-green text-white'
              : 'bg-alert-red text-white'
          }`}
        >
          {notification.type === 'success' ? (
            <CheckCircle className="w-5 h-5" />
          ) : (
            <AlertCircle className="w-5 h-5" />
          )}
          <span>{notification.message}</span>
        </div>
      )}

      <div className="flex items-center justify-between mb-8">
        <div>
          <h1 className="text-2xl font-semibold text-reins-navy">Credentials</h1>
          <p className="text-gray-500 mt-1">Manage encrypted service credentials</p>
        </div>
        <button
          onClick={openCreateModal}
          className="flex items-center gap-2 bg-trust-blue text-white px-4 py-2 rounded-lg hover:bg-blue-700 transition-colors"
        >
          <Plus className="w-5 h-5" />
          Add Credential
        </button>
      </div>

      {isLoading ? (
        <div className="flex items-center justify-center py-12">
          <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-trust-blue"></div>
        </div>
      ) : !credentialsList?.length ? (
        <div className="bg-white rounded-xl p-12 shadow-sm border border-gray-100 text-center">
          <Key className="w-12 h-12 text-gray-300 mx-auto mb-4" />
          <p className="text-gray-500">No credentials stored yet</p>
          <button
            onClick={openCreateModal}
            className="mt-4 text-trust-blue hover:underline"
          >
            Add your first credential
          </button>
        </div>
      ) : (
        <div className="bg-white rounded-xl shadow-sm border border-gray-100 overflow-hidden">
          <table className="w-full">
            <thead className="bg-gray-50 border-b border-gray-100">
              <tr>
                <th className="text-left px-6 py-3 text-xs font-medium text-gray-500 uppercase tracking-wider">Type</th>
                <th className="text-left px-6 py-3 text-xs font-medium text-gray-500 uppercase tracking-wider">Account</th>
                <th className="text-left px-6 py-3 text-xs font-medium text-gray-500 uppercase tracking-wider">Services</th>
                <th className="text-left px-6 py-3 text-xs font-medium text-gray-500 uppercase tracking-wider">Status</th>
                <th className="text-left px-6 py-3 text-xs font-medium text-gray-500 uppercase tracking-wider">Created</th>
                <th className="text-right px-6 py-3 text-xs font-medium text-gray-500 uppercase tracking-wider">Actions</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-gray-100">
              {credentialsList.map((cred) => (
                <tr key={cred.id} className="hover:bg-gray-50">
                  <td className="px-6 py-4">
                    <div className="flex items-center gap-2">
                      {cred.serviceId === 'google' ? (
                        <GoogleIcon className="w-4 h-4" />
                      ) : cred.serviceId === 'github' ? (
                        <Github className="w-4 h-4 text-gray-700" />
                      ) : cred.serviceId === 'linear' ? (
                        <SquareKanban className="w-4 h-4 text-indigo-600" />
                      ) : (
                        <Key className="w-4 h-4 text-gray-400" />
                      )}
                      <span className="font-medium capitalize">
                        {cred.serviceId === 'google' ? 'Google' : cred.serviceId === 'github' ? 'GitHub' : cred.serviceId === 'linear' ? 'Linear' : cred.serviceId}
                      </span>
                    </div>
                  </td>
                  <td className="px-6 py-4 text-sm">
                    {cred.accountEmail ? (
                      <div>
                        <div className="font-medium text-gray-900">{cred.accountEmail}</div>
                        {cred.accountName && (
                          <div className="text-xs text-gray-500">{cred.accountName}</div>
                        )}
                      </div>
                    ) : (
                      <span className="text-gray-400">-</span>
                    )}
                  </td>
                  <td className="px-6 py-4">
                    {cred.grantedServices?.length ? (
                      <div className="flex flex-wrap gap-1">
                        {cred.grantedServices.map((svc) => (
                          <span
                            key={svc}
                            className="inline-flex items-center px-2 py-0.5 rounded-full text-xs font-medium bg-blue-50 text-blue-700"
                          >
                            {getServiceBadge(svc)}
                          </span>
                        ))}
                      </div>
                    ) : (
                      <span className="text-gray-400 text-sm">-</span>
                    )}
                  </td>
                  <td className="px-6 py-4">
                    <div className="flex items-center gap-2">
                      {getHealthIcon(cred.id)}
                      <span className="text-sm">
                        {healthStatus[cred.id]
                          ? healthStatus[cred.id].valid
                            ? 'Valid'
                            : healthStatus[cred.id].error || 'Invalid'
                          : 'Unknown'}
                      </span>
                      {healthStatus[cred.id] && !healthStatus[cred.id].valid && cred.serviceId === 'google' && (
                        <button
                          onClick={() => handleReconnect(cred)}
                          disabled={initiateGoogleOAuthMutation.isPending}
                          className="ml-1 px-2 py-0.5 text-xs font-medium text-trust-blue bg-trust-blue/10 rounded hover:bg-trust-blue/20 transition-colors"
                        >
                          Reconnect
                        </button>
                      )}
                      {healthStatus[cred.id] && !healthStatus[cred.id].valid && (cred.serviceId === 'github' || cred.serviceId === 'linear') && (
                        <button
                          onClick={() => handleUpdateToken(cred)}
                          className="ml-1 px-2 py-0.5 text-xs font-medium text-trust-blue bg-trust-blue/10 rounded hover:bg-trust-blue/20 transition-colors"
                        >
                          Update token
                        </button>
                      )}
                    </div>
                  </td>
                  <td className="px-6 py-4 text-sm text-gray-500">
                    {new Date(cred.createdAt).toLocaleDateString()}
                  </td>
                  <td className="px-6 py-4 text-right">
                    <div className="flex items-center justify-end gap-2">
                      <button
                        onClick={() => checkHealth(cred.id)}
                        className="p-1 text-gray-400 hover:text-trust-blue"
                        title="Check health"
                      >
                        <RefreshCw className="w-4 h-4" />
                      </button>
                      <button
                        onClick={() => deleteMutation.mutate(cred.id)}
                        className="p-1 text-gray-400 hover:text-alert-red"
                        title="Delete"
                      >
                        <Trash2 className="w-4 h-4" />
                      </button>
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {/* Add Credential Modal */}
      {showCreateModal && (
        <div className="fixed inset-0 bg-reins-navy/60 backdrop-blur-sm flex items-center justify-center z-50">
          <div className="bg-white rounded-2xl p-6 w-full max-w-md shadow-2xl shadow-reins-navy/10 border border-gray-100">
            <div className="flex items-center justify-between mb-5">
              <h2 className="text-lg font-semibold text-reins-navy">
                {createType === 'pick' ? 'Add Credential' : createType === 'google_scopes' ? 'Google Services' : createType === 'linear_key' ? (updatingCredentialId ? 'Update Linear Token' : 'Linear Workspace') : createType === 'github_pat' ? (updatingCredentialId ? 'Update GitHub Token' : 'GitHub') : 'Add API Key'}
              </h2>
              <button
                onClick={() => { setShowCreateModal(false); setCreateType('pick'); setUpdatingCredentialId(null); }}
                className="text-gray-300 hover:text-gray-500 transition-colors"
              >
                <X className="w-5 h-5" />
              </button>
            </div>

            {createType === 'pick' ? (
              /* Type Picker */
              <div className="space-y-3">
                <p className="text-sm text-gray-500 mb-4">
                  Choose a credential type to add.
                </p>

                {/* Google */}
                <button
                  onClick={() => setCreateType('google_scopes')}
                  className="w-full flex items-center gap-4 p-4 rounded-xl border-2 border-gray-200 hover:border-trust-blue hover:bg-trust-blue/5 transition-all text-left"
                >
                  <div className="w-10 h-10 bg-gray-50 rounded-lg flex items-center justify-center shrink-0">
                    <GoogleIcon />
                  </div>
                  <div className="flex-1 min-w-0">
                    <div className="font-medium text-reins-navy">Google Account</div>
                    <div className="text-sm text-gray-500">
                      Gmail, Drive, Calendar access via OAuth
                    </div>
                  </div>
                </button>

                {/* GitHub */}
                <button
                  onClick={() => { setCreateType('github_pat'); setGithubToken(''); setGithubError(''); }}
                  className="w-full flex items-center gap-4 p-4 rounded-xl border-2 border-gray-200 hover:border-trust-blue hover:bg-trust-blue/5 transition-all text-left"
                >
                  <div className="w-10 h-10 bg-gray-50 rounded-lg flex items-center justify-center shrink-0">
                    <Github className="w-5 h-5 text-gray-700" />
                  </div>
                  <div className="flex-1 min-w-0">
                    <div className="font-medium text-reins-navy">GitHub</div>
                    <div className="text-sm text-gray-500">
                      Repos, issues, PRs via Personal Access Token
                    </div>
                  </div>
                </button>

                {/* Linear */}
                <button
                  onClick={() => { setCreateType('linear_key'); setLinearToken(''); setLinearWorkspace(''); setLinearError(''); }}
                  className="w-full flex items-center gap-4 p-4 rounded-xl border-2 border-gray-200 hover:border-trust-blue hover:bg-trust-blue/5 transition-all text-left"
                >
                  <div className="w-10 h-10 bg-gray-50 rounded-lg flex items-center justify-center shrink-0">
                    <SquareKanban className="w-5 h-5 text-indigo-600" />
                  </div>
                  <div className="flex-1 min-w-0">
                    <div className="font-medium text-reins-navy">Linear</div>
                    <div className="text-sm text-gray-500">
                      Issues, projects, and teams via API key (per workspace)
                    </div>
                  </div>
                </button>

                {/* API Key */}
                <button
                  onClick={() => setCreateType('api_key')}
                  className="w-full flex items-center gap-4 p-4 rounded-xl border-2 border-gray-200 hover:border-trust-blue hover:bg-trust-blue/5 transition-all text-left"
                >
                  <div className="w-10 h-10 bg-gray-50 rounded-lg flex items-center justify-center shrink-0">
                    <Key className="w-5 h-5 text-gray-500" />
                  </div>
                  <div className="flex-1 min-w-0">
                    <div className="font-medium text-reins-navy">API Key</div>
                    <div className="text-sm text-gray-500">
                      Web Search (Brave), or other API key services
                    </div>
                  </div>
                </button>
              </div>
            ) : createType === 'github_pat' ? (
              /* GitHub PAT Form */
              <div>
                <p className="text-sm text-gray-500 mb-4">
                  Enter your GitHub Personal Access Token. We'll validate it and detect its permissions.
                </p>
                <div className="space-y-4">
                  <div>
                    <label className="block text-xs font-medium text-gray-500 uppercase tracking-wider mb-1.5">
                      Personal Access Token
                    </label>
                    <input
                      type="password"
                      value={githubToken}
                      onChange={(e) => { setGithubToken(e.target.value); setGithubError(''); }}
                      placeholder="ghp_xxxxxxxxxxxxxxxxxxxx"
                      className="w-full border border-gray-200 rounded-lg px-3 py-2.5 text-sm font-mono focus:ring-2 focus:ring-trust-blue/20 focus:border-trust-blue transition-all outline-none"
                    />
                  </div>
                  {githubError && (
                    <div className="flex items-center gap-2 text-red-600 text-sm">
                      <AlertCircle className="w-4 h-4 shrink-0" />
                      {githubError}
                    </div>
                  )}
                  <p className="text-xs text-gray-400">
                    Create a token at{' '}
                    <a
                      href="https://github.com/settings/tokens"
                      target="_blank"
                      rel="noopener noreferrer"
                      className="text-trust-blue hover:underline"
                    >
                      GitHub Settings
                    </a>
                    . The token's scopes determine which tools are available.
                  </p>
                </div>
                <div className="flex justify-between items-center mt-6">
                  <button
                    onClick={() => setCreateType('pick')}
                    className="px-4 py-2 text-sm text-gray-500 hover:text-gray-700 transition-colors"
                  >
                    Back
                  </button>
                  <button
                    onClick={() => addGitHubMutation.mutate(githubToken)}
                    disabled={!githubToken || addGitHubMutation.isPending}
                    className="flex items-center gap-2 px-5 py-2.5 bg-trust-blue text-white rounded-lg text-sm font-medium hover:bg-blue-600 disabled:opacity-40 transition-all shadow-sm shadow-trust-blue/20"
                  >
                    {addGitHubMutation.isPending ? (
                      <div className="animate-spin rounded-full h-4 w-4 border-2 border-white/30 border-t-white" />
                    ) : (
                      <>
                        <Github className="w-4 h-4" />
                        Connect
                      </>
                    )}
                  </button>
                </div>
              </div>
            ) : createType === 'linear_key' ? (
              /* Linear API Key Form */
              <div>
                <p className="text-sm text-gray-500 mb-4">
                  Enter your Linear API key and workspace name. Each workspace needs its own key.
                </p>
                <div className="space-y-4">
                  <div>
                    <label className="block text-xs font-medium text-gray-500 uppercase tracking-wider mb-1.5">
                      Workspace Name
                    </label>
                    <input
                      type="text"
                      value={linearWorkspace}
                      onChange={(e) => { setLinearWorkspace(e.target.value); setLinearError(''); }}
                      placeholder="e.g. My Company"
                      className="w-full border border-gray-200 rounded-lg px-3 py-2.5 text-sm focus:ring-2 focus:ring-trust-blue/20 focus:border-trust-blue transition-all outline-none"
                    />
                  </div>
                  <div>
                    <label className="block text-xs font-medium text-gray-500 uppercase tracking-wider mb-1.5">
                      API Key
                    </label>
                    <input
                      type="password"
                      value={linearToken}
                      onChange={(e) => { setLinearToken(e.target.value); setLinearError(''); }}
                      placeholder="lin_api_xxxxxxxxxxxxxxxxxxxx"
                      className="w-full border border-gray-200 rounded-lg px-3 py-2.5 text-sm font-mono focus:ring-2 focus:ring-trust-blue/20 focus:border-trust-blue transition-all outline-none"
                    />
                  </div>
                  {linearError && (
                    <div className="flex items-center gap-2 text-red-600 text-sm">
                      <AlertCircle className="w-4 h-4 shrink-0" />
                      {linearError}
                    </div>
                  )}
                  <p className="text-xs text-gray-400">
                    Create an API key at{' '}
                    <a
                      href="https://linear.app/settings/api"
                      target="_blank"
                      rel="noopener noreferrer"
                      className="text-trust-blue hover:underline"
                    >
                      Linear Settings
                    </a>
                    . You can add multiple workspaces by repeating this step.
                  </p>
                </div>
                <div className="flex justify-between items-center mt-6">
                  <button
                    onClick={() => setCreateType('pick')}
                    className="px-4 py-2 text-sm text-gray-500 hover:text-gray-700 transition-colors"
                  >
                    Back
                  </button>
                  <button
                    onClick={() => addLinearMutation.mutate({ token: linearToken, workspaceName: linearWorkspace })}
                    disabled={!linearToken || !linearWorkspace || addLinearMutation.isPending}
                    className="flex items-center gap-2 px-5 py-2.5 bg-trust-blue text-white rounded-lg text-sm font-medium hover:bg-blue-600 disabled:opacity-40 transition-all shadow-sm shadow-trust-blue/20"
                  >
                    {addLinearMutation.isPending ? (
                      <div className="animate-spin rounded-full h-4 w-4 border-2 border-white/30 border-t-white" />
                    ) : (
                      <>
                        <SquareKanban className="w-4 h-4" />
                        Connect
                      </>
                    )}
                  </button>
                </div>
              </div>
            ) : createType === 'google_scopes' ? (
              /* Google Scope Picker */
              <div>
                <p className="text-sm text-gray-500 mb-4">
                  Select which Google services to authorize. You can always connect more later.
                </p>

                <div className="space-y-2 mb-6">
                  {GOOGLE_SERVICES.map((svc) => {
                    const Icon = svc.icon;
                    const isSelected = selectedGoogleServices.has(svc.type);
                    return (
                      <button
                        key={svc.type}
                        onClick={() => toggleGoogleService(svc.type)}
                        className={`w-full flex items-center gap-3 p-3 rounded-xl border-2 transition-all text-left ${
                          isSelected
                            ? 'border-trust-blue bg-trust-blue/5'
                            : 'border-gray-200 hover:border-gray-300'
                        }`}
                      >
                        <div className={`w-5 h-5 rounded border-2 flex items-center justify-center shrink-0 transition-colors ${
                          isSelected ? 'border-trust-blue bg-trust-blue' : 'border-gray-300'
                        }`}>
                          {isSelected && (
                            <svg className="w-3 h-3 text-white" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={3}>
                              <path strokeLinecap="round" strokeLinejoin="round" d="M5 13l4 4L19 7" />
                            </svg>
                          )}
                        </div>
                        <Icon className={`w-5 h-5 ${isSelected ? 'text-trust-blue' : 'text-gray-400'}`} />
                        <div className="flex-1 min-w-0">
                          <div className={`text-sm font-medium ${isSelected ? 'text-reins-navy' : 'text-gray-600'}`}>
                            {svc.name}
                          </div>
                          <div className="text-xs text-gray-400">{svc.description}</div>
                        </div>
                      </button>
                    );
                  })}
                </div>

                <div className="flex justify-between items-center">
                  <button
                    onClick={() => setCreateType('pick')}
                    className="px-4 py-2 text-sm text-gray-500 hover:text-gray-700 transition-colors"
                  >
                    Back
                  </button>
                  <button
                    onClick={handleGoogleConnect}
                    disabled={selectedGoogleServices.size === 0 || initiateGoogleOAuthMutation.isPending}
                    className="flex items-center gap-2 px-5 py-2.5 bg-trust-blue text-white rounded-lg text-sm font-medium hover:bg-blue-600 disabled:opacity-40 transition-all shadow-sm shadow-trust-blue/20"
                  >
                    {initiateGoogleOAuthMutation.isPending ? (
                      <div className="animate-spin rounded-full h-4 w-4 border-2 border-white/30 border-t-white" />
                    ) : (
                      <>
                        <GoogleIcon className="w-4 h-4" />
                        Connect {selectedGoogleServices.size} service{selectedGoogleServices.size !== 1 ? 's' : ''}
                      </>
                    )}
                  </button>
                </div>
              </div>
            ) : (
              /* API Key Form */
              <form onSubmit={handleCreate}>
                <div className="space-y-4">
                  <div>
                    <label className="block text-xs font-medium text-gray-500 uppercase tracking-wider mb-1.5">
                      Service
                    </label>
                    <select
                      value={newCredential.serviceId}
                      onChange={(e) => setNewCredential({ ...newCredential, serviceId: e.target.value })}
                      className="w-full border border-gray-200 rounded-lg px-3 py-2.5 text-sm focus:ring-2 focus:ring-trust-blue/20 focus:border-trust-blue transition-all outline-none bg-white"
                      required
                    >
                      <option value="">Select a service...</option>
                      <option value="web-search">Web Search (Brave)</option>
                      <option value="browser">Browser</option>
                    </select>
                  </div>
                  <div>
                    <label className="block text-xs font-medium text-gray-500 uppercase tracking-wider mb-1.5">
                      API Key
                    </label>
                    <input
                      type="password"
                      value={(newCredential.data as { apiKey: string }).apiKey}
                      onChange={(e) => setNewCredential({
                        ...newCredential,
                        data: { apiKey: e.target.value },
                      })}
                      className="w-full border border-gray-200 rounded-lg px-3 py-2.5 text-sm font-mono focus:ring-2 focus:ring-trust-blue/20 focus:border-trust-blue transition-all outline-none"
                      required
                    />
                  </div>
                </div>
                <div className="flex justify-end gap-2 mt-6">
                  <button
                    type="button"
                    onClick={() => setCreateType('pick')}
                    className="px-4 py-2 text-sm text-gray-500 hover:text-gray-700 transition-colors"
                  >
                    Back
                  </button>
                  <button
                    type="submit"
                    disabled={createMutation.isPending}
                    className="px-4 py-2 text-sm bg-trust-blue text-white rounded-lg hover:bg-blue-600 disabled:opacity-50 transition-all shadow-sm shadow-trust-blue/20"
                  >
                    {createMutation.isPending ? 'Adding...' : 'Add'}
                  </button>
                </div>
              </form>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
