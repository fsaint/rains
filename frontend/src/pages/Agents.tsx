import { useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { Plus, Trash2, Power, PowerOff } from 'lucide-react';
import { agents, policies } from '../api/client';

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
  const [newAgent, setNewAgent] = useState({ name: '', description: '', policyId: '' });

  const { data: agentsList, isLoading } = useQuery<Agent[]>({
    queryKey: ['agents'],
    queryFn: agents.list as () => Promise<Agent[]>,
  });

  const { data: policiesList } = useQuery<Policy[]>({
    queryKey: ['policies'],
    queryFn: policies.list as () => Promise<Policy[]>,
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

  const statusColors: Record<string, string> = {
    active: 'bg-safe-green/10 text-safe-green',
    suspended: 'bg-alert-red/10 text-alert-red',
    pending: 'bg-caution-amber/10 text-caution-amber',
  };

  const handleCreate = (e: React.FormEvent) => {
    e.preventDefault();
    createMutation.mutate(newAgent);
  };

  return (
    <div className="p-8">
      <div className="flex items-center justify-between mb-8">
        <div>
          <h1 className="text-2xl font-semibold text-reins-navy">Agents</h1>
          <p className="text-gray-500 mt-1">Manage registered AI agents</p>
        </div>
        <button
          onClick={() => setShowCreateModal(true)}
          className="flex items-center gap-2 bg-trust-blue text-white px-4 py-2 rounded-lg hover:bg-blue-700 transition-colors"
        >
          <Plus className="w-5 h-5" />
          Add Agent
        </button>
      </div>

      {isLoading ? (
        <div className="flex items-center justify-center py-12">
          <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-trust-blue"></div>
        </div>
      ) : !agentsList?.length ? (
        <div className="bg-white rounded-xl p-12 shadow-sm border border-gray-100 text-center">
          <p className="text-gray-500">No agents registered yet</p>
          <button
            onClick={() => setShowCreateModal(true)}
            className="mt-4 text-trust-blue hover:underline"
          >
            Register your first agent
          </button>
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
                  <label className="block text-sm font-medium text-gray-700 mb-1">Policy</label>
                  <select
                    value={newAgent.policyId}
                    onChange={(e) => setNewAgent({ ...newAgent, policyId: e.target.value })}
                    className="w-full border border-gray-300 rounded-lg px-3 py-2 focus:ring-2 focus:ring-trust-blue focus:border-transparent"
                    required
                  >
                    <option value="">Select a policy...</option>
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
    </div>
  );
}
