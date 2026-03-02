import { useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { Plus, Trash2, Key, RefreshCw, CheckCircle, AlertCircle, Clock } from 'lucide-react';
import { credentials } from '../api/client';

interface Credential {
  id: string;
  serviceId: string;
  type: string;
  expiresAt?: string;
  createdAt: string;
}

interface CredentialHealth {
  valid: boolean;
  expiresAt?: string;
  error?: string;
}

export default function Credentials() {
  const queryClient = useQueryClient();
  const [showCreateModal, setShowCreateModal] = useState(false);
  const [newCredential, setNewCredential] = useState({
    serviceId: '',
    type: 'api_key' as const,
    data: { apiKey: '' },
  });
  const [healthStatus, setHealthStatus] = useState<Record<string, CredentialHealth>>({});

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
      <div className="flex items-center justify-between mb-8">
        <div>
          <h1 className="text-2xl font-semibold text-reins-navy">Credentials</h1>
          <p className="text-gray-500 mt-1">Manage encrypted service credentials</p>
        </div>
        <button
          onClick={() => setShowCreateModal(true)}
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
                      <Key className="w-4 h-4 text-gray-400" />
                      <span className="font-medium">{cred.serviceId}</span>
                    </div>
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
    </div>
  );
}
