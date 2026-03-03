import { useState, useEffect } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { useSearchParams } from 'react-router-dom';
import { Plus, Trash2, Key, RefreshCw, CheckCircle, AlertCircle, Clock, Mail, HardDrive, Calendar } from 'lucide-react';
import { credentials, oauth, type Credential } from '../api/client';

interface CredentialHealth {
  valid: boolean;
  expiresAt?: string;
  error?: string;
}

export default function Credentials() {
  const queryClient = useQueryClient();
  const [searchParams, setSearchParams] = useSearchParams();
  const [showCreateModal, setShowCreateModal] = useState(false);
  const [showGoogleModal, setShowGoogleModal] = useState(false);
  const [notification, setNotification] = useState<{ type: 'success' | 'error'; message: string } | null>(null);
  const [newCredential, setNewCredential] = useState({
    serviceId: '',
    type: 'api_key' as const,
    data: { apiKey: '' },
  });
  const [healthStatus, setHealthStatus] = useState<Record<string, CredentialHealth>>({});

  // Handle OAuth callback
  useEffect(() => {
    const oauthSuccess = searchParams.get('oauth_success');
    const oauthError = searchParams.get('oauth_error');
    const email = searchParams.get('email');

    if (oauthSuccess === 'true') {
      setNotification({
        type: 'success',
        message: `Google account ${email ? `(${email}) ` : ''}connected successfully!`,
      });
      queryClient.invalidateQueries({ queryKey: ['credentials'] });
      // Clear the search params
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

    // Clear notification after 5 seconds
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

  const createMutation = useMutation({
    mutationFn: credentials.create,
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['credentials'] });
      setShowCreateModal(false);
      setNewCredential({ serviceId: '', type: 'api_key', data: { apiKey: '' } });
    },
  });

  const deleteMutation = useMutation({
    mutationFn: credentials.delete,
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['credentials'] });
    },
  });

  const initiateGoogleOAuthMutation = useMutation({
    mutationFn: oauth.initiateGoogle,
    onSuccess: (data) => {
      // Redirect to Google OAuth
      window.location.href = data.authUrl;
    },
    onError: (error) => {
      setNotification({
        type: 'error',
        message: error instanceof Error ? error.message : 'Failed to initiate OAuth flow',
      });
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

  const getHealthIcon = (id: string) => {
    const health = healthStatus[id];
    if (!health) return <Clock className="w-4 h-4 text-gray-400" />;
    if (health.valid) return <CheckCircle className="w-4 h-4 text-safe-green" />;
    return <AlertCircle className="w-4 h-4 text-alert-red" />;
  };

  const typeLabels: Record<string, string> = {
    api_key: 'API Key',
    oauth2: 'OAuth 2.0',
    basic: 'Basic Auth',
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
        <div className="flex items-center gap-3">
          <button
            onClick={() => setShowGoogleModal(true)}
            className="flex items-center gap-2 bg-white text-gray-700 px-4 py-2 rounded-lg border border-gray-300 hover:bg-gray-50 transition-colors"
          >
            <svg className="w-5 h-5" viewBox="0 0 24 24">
              <path fill="#4285F4" d="M22.56 12.25c0-.78-.07-1.53-.2-2.25H12v4.26h5.92c-.26 1.37-1.04 2.53-2.21 3.31v2.77h3.57c2.08-1.92 3.28-4.74 3.28-8.09z" />
              <path fill="#34A853" d="M12 23c2.97 0 5.46-.98 7.28-2.66l-3.57-2.77c-.98.66-2.23 1.06-3.71 1.06-2.86 0-5.29-1.93-6.16-4.53H2.18v2.84C3.99 20.53 7.7 23 12 23z" />
              <path fill="#FBBC05" d="M5.84 14.09c-.22-.66-.35-1.36-.35-2.09s.13-1.43.35-2.09V7.07H2.18C1.43 8.55 1 10.22 1 12s.43 3.45 1.18 4.93l2.85-2.22.81-.62z" />
              <path fill="#EA4335" d="M12 5.38c1.62 0 3.06.56 4.21 1.64l3.15-3.15C17.45 2.09 14.97 1 12 1 7.7 1 3.99 3.47 2.18 7.07l3.66 2.84c.87-2.6 3.3-4.53 6.16-4.53z" />
            </svg>
            Connect Google Account
          </button>
          <button
            onClick={() => setShowCreateModal(true)}
            className="flex items-center gap-2 bg-trust-blue text-white px-4 py-2 rounded-lg hover:bg-blue-700 transition-colors"
          >
            <Plus className="w-5 h-5" />
            Add Credential
          </button>
        </div>
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
            onClick={() => setShowCreateModal(true)}
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
                <th className="text-left px-6 py-3 text-xs font-medium text-gray-500 uppercase tracking-wider">Service</th>
                <th className="text-left px-6 py-3 text-xs font-medium text-gray-500 uppercase tracking-wider">Account</th>
                <th className="text-left px-6 py-3 text-xs font-medium text-gray-500 uppercase tracking-wider">Type</th>
                <th className="text-left px-6 py-3 text-xs font-medium text-gray-500 uppercase tracking-wider">Status</th>
                <th className="text-left px-6 py-3 text-xs font-medium text-gray-500 uppercase tracking-wider">Expires</th>
                <th className="text-left px-6 py-3 text-xs font-medium text-gray-500 uppercase tracking-wider">Created</th>
                <th className="text-right px-6 py-3 text-xs font-medium text-gray-500 uppercase tracking-wider">Actions</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-gray-100">
              {credentialsList.map((cred) => (
                <tr key={cred.id} className="hover:bg-gray-50">
                  <td className="px-6 py-4">
                    <div className="flex items-center gap-2">
                      {cred.serviceId === 'gmail' && <Mail className="w-4 h-4 text-red-500" />}
                      {cred.serviceId === 'drive' && <HardDrive className="w-4 h-4 text-yellow-500" />}
                      {cred.serviceId === 'calendar' && <Calendar className="w-4 h-4 text-blue-500" />}
                      {!['gmail', 'drive', 'calendar'].includes(cred.serviceId) && (
                        <Key className="w-4 h-4 text-gray-400" />
                      )}
                      <span className="font-medium capitalize">{cred.serviceId}</span>
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
                  <td className="px-6 py-4 text-sm">{typeLabels[cred.type] || cred.type}</td>
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
                    </div>
                  </td>
                  <td className="px-6 py-4 text-sm text-gray-500">
                    {cred.expiresAt ? new Date(cred.expiresAt).toLocaleDateString() : 'Never'}
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

      {/* Create Modal */}
      {showCreateModal && (
        <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50">
          <div className="bg-white rounded-xl p-6 w-full max-w-md shadow-xl">
            <h2 className="text-lg font-semibold mb-4">Add Credential</h2>
            <form onSubmit={handleCreate}>
              <div className="space-y-4">
                <div>
                  <label className="block text-sm font-medium text-gray-700 mb-1">Service ID</label>
                  <input
                    type="text"
                    value={newCredential.serviceId}
                    onChange={(e) => setNewCredential({ ...newCredential, serviceId: e.target.value })}
                    className="w-full border border-gray-300 rounded-lg px-3 py-2 focus:ring-2 focus:ring-trust-blue focus:border-transparent"
                    placeholder="e.g., gmail, github"
                    required
                  />
                </div>
                <div>
                  <label className="block text-sm font-medium text-gray-700 mb-1">Type</label>
                  <select
                    value={newCredential.type}
                    onChange={(e) => setNewCredential({ ...newCredential, type: e.target.value as 'api_key' })}
                    className="w-full border border-gray-300 rounded-lg px-3 py-2 focus:ring-2 focus:ring-trust-blue focus:border-transparent"
                  >
                    <option value="api_key">API Key</option>
                    <option value="oauth2">OAuth 2.0</option>
                    <option value="basic">Basic Auth</option>
                  </select>
                </div>
                {newCredential.type === 'api_key' && (
                  <div>
                    <label className="block text-sm font-medium text-gray-700 mb-1">API Key</label>
                    <input
                      type="password"
                      value={(newCredential.data as { apiKey: string }).apiKey}
                      onChange={(e) => setNewCredential({
                        ...newCredential,
                        data: { apiKey: e.target.value },
                      })}
                      className="w-full border border-gray-300 rounded-lg px-3 py-2 font-mono focus:ring-2 focus:ring-trust-blue focus:border-transparent"
                      required
                    />
                  </div>
                )}
              </div>
              <div className="flex justify-end gap-3 mt-6">
                <button
                  type="button"
                  onClick={() => setShowCreateModal(false)}
                  className="px-4 py-2 text-gray-700 hover:bg-gray-100 rounded-lg"
                >
                  Cancel
                </button>
                <button
                  type="submit"
                  disabled={createMutation.isPending}
                  className="px-4 py-2 bg-trust-blue text-white rounded-lg hover:bg-blue-700 disabled:opacity-50"
                >
                  {createMutation.isPending ? 'Adding...' : 'Add Credential'}
                </button>
              </div>
            </form>
          </div>
        </div>
      )}

      {/* Google OAuth Modal */}
      {showGoogleModal && (
        <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50">
          <div className="bg-white rounded-xl p-6 w-full max-w-md shadow-xl">
            <h2 className="text-lg font-semibold mb-2">Connect Google Account</h2>
            <p className="text-sm text-gray-500 mb-6">
              Choose a Google service to connect. You'll be redirected to Google to authorize access.
            </p>
            <div className="space-y-3">
              <button
                onClick={() => initiateGoogleOAuthMutation.mutate('gmail')}
                disabled={initiateGoogleOAuthMutation.isPending}
                className="w-full flex items-center gap-3 p-4 rounded-lg border-2 border-gray-200 hover:border-trust-blue hover:bg-blue-50 transition-colors"
              >
                <div className="w-10 h-10 bg-red-100 rounded-lg flex items-center justify-center">
                  <Mail className="w-5 h-5 text-red-600" />
                </div>
                <div className="text-left flex-1">
                  <div className="font-medium text-gray-900">Gmail</div>
                  <div className="text-sm text-gray-500">Read emails and create drafts</div>
                </div>
              </button>
              <button
                onClick={() => initiateGoogleOAuthMutation.mutate('drive')}
                disabled={initiateGoogleOAuthMutation.isPending}
                className="w-full flex items-center gap-3 p-4 rounded-lg border-2 border-gray-200 hover:border-trust-blue hover:bg-blue-50 transition-colors"
              >
                <div className="w-10 h-10 bg-yellow-100 rounded-lg flex items-center justify-center">
                  <HardDrive className="w-5 h-5 text-yellow-600" />
                </div>
                <div className="text-left flex-1">
                  <div className="font-medium text-gray-900">Google Drive</div>
                  <div className="text-sm text-gray-500">Read and search files</div>
                </div>
              </button>
              <button
                onClick={() => initiateGoogleOAuthMutation.mutate('calendar')}
                disabled={initiateGoogleOAuthMutation.isPending}
                className="w-full flex items-center gap-3 p-4 rounded-lg border-2 border-gray-200 hover:border-trust-blue hover:bg-blue-50 transition-colors"
              >
                <div className="w-10 h-10 bg-blue-100 rounded-lg flex items-center justify-center">
                  <Calendar className="w-5 h-5 text-blue-600" />
                </div>
                <div className="text-left flex-1">
                  <div className="font-medium text-gray-900">Google Calendar</div>
                  <div className="text-sm text-gray-500">View calendar events</div>
                </div>
              </button>
            </div>
            <div className="flex justify-end mt-6">
              <button
                type="button"
                onClick={() => setShowGoogleModal(false)}
                className="px-4 py-2 text-gray-700 hover:bg-gray-100 rounded-lg"
              >
                Cancel
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
