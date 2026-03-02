import { useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { Plus, Trash2, Edit, FileText } from 'lucide-react';
import { policies } from '../api/client';

interface Policy {
  id: string;
  name: string;
  version: string;
  yaml: string;
  createdAt: string;
  updatedAt: string;
}

const DEFAULT_POLICY = `version: "1.0"
services:
  example-service:
    tools:
      allow:
        - read_data
        - list_items
      block:
        - delete_data
    approval_required:
      - write_data
`;

export default function Policies() {
  const queryClient = useQueryClient();
  const [showCreateModal, setShowCreateModal] = useState(false);
  const [editingPolicy, setEditingPolicy] = useState<Policy | null>(null);
  const [newPolicy, setNewPolicy] = useState({ name: '', yaml: DEFAULT_POLICY });

  const { data: policiesList, isLoading } = useQuery<Policy[]>({
    queryKey: ['policies'],
    queryFn: policies.list as () => Promise<Policy[]>,
  });

  const createMutation = useMutation({
    mutationFn: policies.create,
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['policies'] });
      setShowCreateModal(false);
      setNewPolicy({ name: '', yaml: DEFAULT_POLICY });
    },
  });

  const updateMutation = useMutation({
    mutationFn: ({ id, data }: { id: string; data: { name?: string; yaml?: string } }) =>
      policies.update(id, data),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['policies'] });
      setEditingPolicy(null);
    },
  });

  const deleteMutation = useMutation({
    mutationFn: policies.delete,
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['policies'] });
    },
  });

  const handleCreate = (e: React.FormEvent) => {
    e.preventDefault();
    createMutation.mutate(newPolicy);
  };

  const handleUpdate = (e: React.FormEvent) => {
    e.preventDefault();
    if (editingPolicy) {
      updateMutation.mutate({
        id: editingPolicy.id,
        data: { name: editingPolicy.name, yaml: editingPolicy.yaml },
      });
    }
  };

  return (
    <div className="p-8">
      <div className="flex items-center justify-between mb-8">
        <div>
          <h1 className="text-2xl font-semibold text-reins-navy">Policies</h1>
          <p className="text-gray-500 mt-1">Manage tool access policies</p>
        </div>
        <button
          onClick={() => setShowCreateModal(true)}
          className="flex items-center gap-2 bg-trust-blue text-white px-4 py-2 rounded-lg hover:bg-blue-700 transition-colors"
        >
          <Plus className="w-5 h-5" />
          Create Policy
        </button>
      </div>

      {isLoading ? (
        <div className="flex items-center justify-center py-12">
          <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-trust-blue"></div>
        </div>
      ) : !policiesList?.length ? (
        <div className="bg-white rounded-xl p-12 shadow-sm border border-gray-100 text-center">
          <FileText className="w-12 h-12 text-gray-300 mx-auto mb-4" />
          <p className="text-gray-500">No policies created yet</p>
          <button
            onClick={() => setShowCreateModal(true)}
            className="mt-4 text-trust-blue hover:underline"
          >
            Create your first policy
          </button>
        </div>
      ) : (
        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-6">
          {policiesList.map((policy) => (
            <div
              key={policy.id}
              className="bg-white rounded-xl p-6 shadow-sm border border-gray-100 hover:shadow-md transition-shadow"
            >
              <div className="flex items-start justify-between mb-4">
                <div>
                  <h3 className="font-semibold text-lg">{policy.name}</h3>
                  <p className="text-sm text-gray-500">v{policy.version}</p>
                </div>
                <div className="flex gap-1">
                  <button
                    onClick={() => setEditingPolicy(policy)}
                    className="p-1.5 text-gray-400 hover:text-trust-blue hover:bg-gray-100 rounded"
                  >
                    <Edit className="w-4 h-4" />
                  </button>
                  <button
                    onClick={() => deleteMutation.mutate(policy.id)}
                    className="p-1.5 text-gray-400 hover:text-alert-red hover:bg-gray-100 rounded"
                  >
                    <Trash2 className="w-4 h-4" />
                  </button>
                </div>
              </div>
              <pre className="text-xs bg-gray-50 p-3 rounded-lg overflow-auto max-h-40 font-mono">
                {policy.yaml}
              </pre>
              <div className="mt-4 text-xs text-gray-400">
                Updated {new Date(policy.updatedAt).toLocaleDateString()}
              </div>
            </div>
          ))}
        </div>
      )}

      {/* Create Modal */}
      {showCreateModal && (
        <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50">
          <div className="bg-white rounded-xl p-6 w-full max-w-2xl shadow-xl max-h-[90vh] overflow-auto">
            <h2 className="text-lg font-semibold mb-4">Create New Policy</h2>
            <form onSubmit={handleCreate}>
              <div className="space-y-4">
                <div>
                  <label className="block text-sm font-medium text-gray-700 mb-1">Name</label>
                  <input
                    type="text"
                    value={newPolicy.name}
                    onChange={(e) => setNewPolicy({ ...newPolicy, name: e.target.value })}
                    className="w-full border border-gray-300 rounded-lg px-3 py-2 focus:ring-2 focus:ring-trust-blue focus:border-transparent"
                    placeholder="e.g., Gmail Read-Only"
                    required
                  />
                </div>
                <div>
                  <label className="block text-sm font-medium text-gray-700 mb-1">Policy YAML</label>
                  <textarea
                    value={newPolicy.yaml}
                    onChange={(e) => setNewPolicy({ ...newPolicy, yaml: e.target.value })}
                    className="w-full border border-gray-300 rounded-lg px-3 py-2 font-mono text-sm focus:ring-2 focus:ring-trust-blue focus:border-transparent"
                    rows={15}
                    required
                  />
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
                  {createMutation.isPending ? 'Creating...' : 'Create Policy'}
                </button>
              </div>
            </form>
          </div>
        </div>
      )}

      {/* Edit Modal */}
      {editingPolicy && (
        <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50">
          <div className="bg-white rounded-xl p-6 w-full max-w-2xl shadow-xl max-h-[90vh] overflow-auto">
            <h2 className="text-lg font-semibold mb-4">Edit Policy</h2>
            <form onSubmit={handleUpdate}>
              <div className="space-y-4">
                <div>
                  <label className="block text-sm font-medium text-gray-700 mb-1">Name</label>
                  <input
                    type="text"
                    value={editingPolicy.name}
                    onChange={(e) => setEditingPolicy({ ...editingPolicy, name: e.target.value })}
                    className="w-full border border-gray-300 rounded-lg px-3 py-2 focus:ring-2 focus:ring-trust-blue focus:border-transparent"
                    required
                  />
                </div>
                <div>
                  <label className="block text-sm font-medium text-gray-700 mb-1">Policy YAML</label>
                  <textarea
                    value={editingPolicy.yaml}
                    onChange={(e) => setEditingPolicy({ ...editingPolicy, yaml: e.target.value })}
                    className="w-full border border-gray-300 rounded-lg px-3 py-2 font-mono text-sm focus:ring-2 focus:ring-trust-blue focus:border-transparent"
                    rows={15}
                    required
                  />
                </div>
              </div>
              <div className="flex justify-end gap-3 mt-6">
                <button
                  type="button"
                  onClick={() => setEditingPolicy(null)}
                  className="px-4 py-2 text-gray-700 hover:bg-gray-100 rounded-lg"
                >
                  Cancel
                </button>
                <button
                  type="submit"
                  disabled={updateMutation.isPending}
                  className="px-4 py-2 bg-trust-blue text-white rounded-lg hover:bg-blue-700 disabled:opacity-50"
                >
                  {updateMutation.isPending ? 'Saving...' : 'Save Changes'}
                </button>
              </div>
            </form>
          </div>
        </div>
      )}
    </div>
  );
}
