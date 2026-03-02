import { useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { Plus, Trash2, Power, PowerOff, Key, Clock, X } from 'lucide-react';
import { agents, policies, type PendingRegistration } from '../api/client';

interface Agent {
  id: string;
  name: string;
  description?: string;
  policyId: string;
  status: string;
  credentials: string[];
  createdAt: string;
}

interface Policy {
  id: string;
  name: string;
}

export default function Agents() {
  const queryClient = useQueryClient();
  const [showCreateModal, setShowCreateModal] = useState(false);
  const [showClaimModal, setShowClaimModal] = useState(false);
  const [newAgent, setNewAgent] = useState({ name: '', description: '', policyId: '' });
  const [claimCode, setClaimCode] = useState('');
  const [claimError, setClaimError] = useState('');

  const { data: agentsList, isLoading } = useQuery<Agent[]>({
    queryKey: ['agents'],
    queryFn: agents.list as () => Promise<Agent[]>,
  });

  const { data: policiesList } = useQuery<Policy[]>({
    queryKey: ['policies'],
    queryFn: policies.list as () => Promise<Policy[]>,
  });

  const { data: pendingList } = useQuery<PendingRegistration[]>({
    queryKey: ['agents', 'pending'],
    queryFn: agents.listPending,
    refetchInterval: 5000, // Poll for new registrations
  });

  const createMutation = useMutation({
    mutationFn: agents.create,
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['agents'] });
      setShowCreateModal(false);
      setNewAgent({ name: '', description: '', policyId: '' });
    },
  });

  const deleteMutation = useMutation({
    mutationFn: agents.delete,
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['agents'] });
    },
  });

  const updateMutation = useMutation({
    mutationFn: ({ id, data }: { id: string; data: { status: string } }) => agents.update(id, data),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['agents'] });
    },
  });

  const claimMutation = useMutation({
    mutationFn: agents.claim,
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['agents'] });
      queryClient.invalidateQueries({ queryKey: ['agents', 'pending'] });
      setShowClaimModal(false);
      setClaimCode('');
      setClaimError('');
    },
    onError: () => {
      setClaimError('Invalid or expired claim code');
    },
  });

  const cancelPendingMutation = useMutation({
    mutationFn: agents.cancelPending,
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['agents', 'pending'] });
    },
  });

  const statusColors: Record<string, string> = {
    active: 'bg-safe-green/10 text-safe-green',
    suspended: 'bg-alert-red/10 text-alert-red',
    pending: 'bg-caution-amber/10 text-caution-amber',
  };

  const handleCreate = (e: React.FormEvent) => {
    e.preventDefault();
    createMutation.mutate(newAgent);
  };

  const handleClaim = (e: React.FormEvent) => {
    e.preventDefault();
    setClaimError('');
    claimMutation.mutate(claimCode.toUpperCase().trim());
  };

  const getTimeRemaining = (expiresAt: string) => {
    const remaining = new Date(expiresAt).getTime() - Date.now();
    if (remaining <= 0) return 'Expired';
    const minutes = Math.floor(remaining / 60000);
    const seconds = Math.floor((remaining % 60000) / 1000);
    return `${minutes}:${seconds.toString().padStart(2, '0')}`;
  };

  return (
    <div className="p-8">
      <div className="flex items-center justify-between mb-8">
        <div>
          <h1 className="text-2xl font-semibold text-reins-navy">Agents</h1>
          <p className="text-gray-500 mt-1">Manage registered AI agents</p>
        </div>
        <div className="flex gap-3">
          <button
            onClick={() => setShowClaimModal(true)}
            className="flex items-center gap-2 bg-safe-green text-white px-4 py-2 rounded-lg hover:bg-green-700 transition-colors"
          >
            <Key className="w-5 h-5" />
            Claim Agent
          </button>
          <button
            onClick={() => setShowCreateModal(true)}
            className="flex items-center gap-2 bg-trust-blue text-white px-4 py-2 rounded-lg hover:bg-blue-700 transition-colors"
          >
            <Plus className="w-5 h-5" />
            Add Agent
          </button>
        </div>
      </div>

      {/* Pending Registrations */}
      {pendingList && pendingList.length > 0 && (
        <div className="mb-6">
          <h2 className="text-lg font-medium text-reins-navy mb-3 flex items-center gap-2">
            <Clock className="w-5 h-5 text-caution-amber" />
            Pending Registrations
          </h2>
          <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
            {pendingList.map((pending) => (
              <div
                key={pending.id}
                className="bg-caution-amber/5 border border-caution-amber/20 rounded-lg p-4"
              >
                <div className="flex items-start justify-between">
                  <div>
                    <p className="font-medium text-reins-navy">{pending.name}</p>
                    {pending.description && (
                      <p className="text-sm text-gray-500 mt-1">{pending.description}</p>
                    )}
                  </div>
                  <button
                    onClick={() => cancelPendingMutation.mutate(pending.id)}
                    className="text-gray-400 hover:text-alert-red"
                    title="Cancel"
                  >
                    <X className="w-4 h-4" />
                  </button>
                </div>
                <div className="mt-3 flex items-center justify-between">
                  <div className="font-mono text-2xl font-bold text-caution-amber tracking-wider">
                    {pending.claimCode}
                  </div>
                  <div className="text-sm text-gray-500">
                    {getTimeRemaining(pending.expiresAt)}
                  </div>
                </div>
              </div>
            ))}
          </div>
        </div>
      )}

      {isLoading ? (
        <div className="flex items-center justify-center py-12">
          <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-trust-blue"></div>
        </div>
      ) : !agentsList?.length ? (
        <div className="bg-white rounded-xl p-12 shadow-sm border border-gray-100 text-center">
          <p className="text-gray-500">No agents registered yet</p>
          <p className="text-sm text-gray-400 mt-2">
            Agents can self-register and you can claim them with a code, or add them manually.
          </p>
          <div className="flex justify-center gap-4 mt-4">
            <button
              onClick={() => setShowClaimModal(true)}
              className="text-safe-green hover:underline"
            >
              Claim with code
            </button>
            <button
              onClick={() => setShowCreateModal(true)}
              className="text-trust-blue hover:underline"
            >
              Add manually
            </button>
          </div>
        </div>
      ) : (
        <div className="bg-white rounded-xl shadow-sm border border-gray-100 overflow-hidden">
          <table className="w-full">
            <thead className="bg-gray-50 border-b border-gray-100">
              <tr>
                <th className="text-left px-6 py-3 text-xs font-medium text-gray-500 uppercase tracking-wider">Name</th>
                <th className="text-left px-6 py-3 text-xs font-medium text-gray-500 uppercase tracking-wider">Status</th>
                <th className="text-left px-6 py-3 text-xs font-medium text-gray-500 uppercase tracking-wider">Policy</th>
                <th className="text-left px-6 py-3 text-xs font-medium text-gray-500 uppercase tracking-wider">Credentials</th>
                <th className="text-left px-6 py-3 text-xs font-medium text-gray-500 uppercase tracking-wider">Created</th>
                <th className="text-right px-6 py-3 text-xs font-medium text-gray-500 uppercase tracking-wider">Actions</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-gray-100">
              {agentsList.map((agent) => {
                const policy = policiesList?.find(p => p.id === agent.policyId);
                return (
                  <tr key={agent.id} className="hover:bg-gray-50">
                    <td className="px-6 py-4">
                      <div>
                        <p className="font-medium">{agent.name}</p>
                        {agent.description && (
                          <p className="text-sm text-gray-500">{agent.description}</p>
                        )}
                      </div>
                    </td>
                    <td className="px-6 py-4">
                      <span className={`inline-flex px-2 py-1 text-xs font-medium rounded-full ${statusColors[agent.status]}`}>
                        {agent.status}
                      </span>
                    </td>
                    <td className="px-6 py-4 text-sm">{policy?.name || '-'}</td>
                    <td className="px-6 py-4 text-sm">{agent.credentials.length}</td>
                    <td className="px-6 py-4 text-sm text-gray-500">
                      {new Date(agent.createdAt).toLocaleDateString()}
                    </td>
                    <td className="px-6 py-4 text-right">
                      <div className="flex items-center justify-end gap-2">
                        {agent.status === 'active' ? (
                          <button
                            onClick={() => updateMutation.mutate({ id: agent.id, data: { status: 'suspended' } })}
                            className="p-1 text-gray-400 hover:text-caution-amber"
                            title="Suspend"
                          >
                            <PowerOff className="w-4 h-4" />
                          </button>
                        ) : (
                          <button
                            onClick={() => updateMutation.mutate({ id: agent.id, data: { status: 'active' } })}
                            className="p-1 text-gray-400 hover:text-safe-green"
                            title="Activate"
                          >
                            <Power className="w-4 h-4" />
                          </button>
                        )}
                        <button
                          onClick={() => deleteMutation.mutate(agent.id)}
                          className="p-1 text-gray-400 hover:text-alert-red"
                          title="Delete"
                        >
                          <Trash2 className="w-4 h-4" />
                        </button>
                      </div>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}

      {/* Create Modal */}
      {showCreateModal && (
        <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50">
          <div className="bg-white rounded-xl p-6 w-full max-w-md shadow-xl">
            <h2 className="text-lg font-semibold mb-4">Register New Agent</h2>
            <form onSubmit={handleCreate}>
              <div className="space-y-4">
                <div>
                  <label className="block text-sm font-medium text-gray-700 mb-1">Name</label>
                  <input
                    type="text"
                    value={newAgent.name}
                    onChange={(e) => setNewAgent({ ...newAgent, name: e.target.value })}
                    className="w-full border border-gray-300 rounded-lg px-3 py-2 focus:ring-2 focus:ring-trust-blue focus:border-transparent"
                    required
                  />
                </div>
                <div>
                  <label className="block text-sm font-medium text-gray-700 mb-1">Description</label>
                  <textarea
                    value={newAgent.description}
                    onChange={(e) => setNewAgent({ ...newAgent, description: e.target.value })}
                    className="w-full border border-gray-300 rounded-lg px-3 py-2 focus:ring-2 focus:ring-trust-blue focus:border-transparent"
                    rows={3}
                  />
                </div>
                <div>
                  <label className="block text-sm font-medium text-gray-700 mb-1">Policy (optional)</label>
                  <select
                    value={newAgent.policyId}
                    onChange={(e) => setNewAgent({ ...newAgent, policyId: e.target.value })}
                    className="w-full border border-gray-300 rounded-lg px-3 py-2 focus:ring-2 focus:ring-trust-blue focus:border-transparent"
                  >
                    <option value="">No policy (use permission matrix)</option>
                    {policiesList?.map((policy) => (
                      <option key={policy.id} value={policy.id}>{policy.name}</option>
                    ))}
                  </select>
                </div>
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
                  {createMutation.isPending ? 'Creating...' : 'Create Agent'}
                </button>
              </div>
            </form>
          </div>
        </div>
      )}

      {/* Claim Modal */}
      {showClaimModal && (
        <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50">
          <div className="bg-white rounded-xl p-6 w-full max-w-md shadow-xl">
            <h2 className="text-lg font-semibold mb-2">Claim Agent</h2>
            <p className="text-sm text-gray-500 mb-4">
              Enter the 6-character code displayed by the agent to claim it.
            </p>
            <form onSubmit={handleClaim}>
              <div>
                <input
                  type="text"
                  value={claimCode}
                  onChange={(e) => {
                    setClaimCode(e.target.value.toUpperCase());
                    setClaimError('');
                  }}
                  placeholder="ABC123"
                  maxLength={6}
                  className="w-full text-center text-3xl font-mono font-bold tracking-[0.5em] border border-gray-300 rounded-lg px-3 py-4 focus:ring-2 focus:ring-safe-green focus:border-transparent uppercase"
                  autoFocus
                />
                {claimError && (
                  <p className="text-alert-red text-sm mt-2">{claimError}</p>
                )}
              </div>
              <div className="flex justify-end gap-3 mt-6">
                <button
                  type="button"
                  onClick={() => {
                    setShowClaimModal(false);
                    setClaimCode('');
                    setClaimError('');
                  }}
                  className="px-4 py-2 text-gray-700 hover:bg-gray-100 rounded-lg"
                >
                  Cancel
                </button>
                <button
                  type="submit"
                  disabled={claimMutation.isPending || claimCode.length !== 6}
                  className="px-4 py-2 bg-safe-green text-white rounded-lg hover:bg-green-700 disabled:opacity-50"
                >
                  {claimMutation.isPending ? 'Claiming...' : 'Claim Agent'}
                </button>
              </div>
            </form>
          </div>
        </div>
      )}
    </div>
  );
}
