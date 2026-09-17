import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useMutation } from '@tanstack/react-query';
import { ArrowLeft, Loader2 } from 'lucide-react';
import { agents } from '../api/client';

export default function AgentNew() {
  const navigate = useNavigate();
  const [name, setName] = useState('');
  const [description, setDescription] = useState('');
  const [error, setError] = useState('');

  const createMutation = useMutation({
    mutationFn: () => agents.create({ name: name.trim(), description: description.trim() || undefined }),
    onSuccess: (created) => navigate(`/agents/${created.id}`),
    onError: (err: unknown) => setError(err instanceof Error ? err.message : 'Failed to create agent'),
  });

  const canCreate = name.trim() !== '' && !createMutation.isPending;

  return (
    <div className="p-4 sm:p-8 max-w-2xl">
      <div className="flex items-center gap-4 mb-8">
        <button
          onClick={() => navigate('/agents')}
          className="p-2 text-gray-400 hover:text-reins-navy hover:bg-gray-100 rounded-lg transition-all"
          aria-label="Back to agents"
        >
          <ArrowLeft className="w-5 h-5" />
        </button>
        <div>
          <h1 className="text-2xl font-semibold text-reins-navy tracking-tight">Create Agent</h1>
          <p className="text-gray-400 text-sm mt-0.5">
            An MCP endpoint for Claude, Claude Code, Cowork, or any MCP client
          </p>
        </div>
      </div>

      <section className="bg-white rounded-xl border border-gray-100 p-6 space-y-4">
        <h2 className="text-sm font-semibold text-gray-500 uppercase tracking-wider">Basics</h2>
        <div>
          <label className="block text-xs font-medium text-gray-500 uppercase tracking-wider mb-1.5">
            Agent Name *
          </label>
          <input
            type="text"
            value={name}
            onChange={(e) => setName(e.target.value)}
            className="w-full border border-gray-200 rounded-lg px-3 py-2.5 text-sm focus:ring-2 focus:ring-trust-blue/20 focus:border-trust-blue transition-all outline-none"
            placeholder="e.g. My Assistant"
            autoFocus
          />
        </div>
        <div>
          <label className="block text-xs font-medium text-gray-500 uppercase tracking-wider mb-1.5">
            Description
          </label>
          <input
            type="text"
            value={description}
            onChange={(e) => setDescription(e.target.value)}
            className="w-full border border-gray-200 rounded-lg px-3 py-2.5 text-sm focus:ring-2 focus:ring-trust-blue/20 focus:border-trust-blue transition-all outline-none"
            placeholder="What does this agent do?"
          />
        </div>
        <ul className="text-sm text-gray-500 space-y-1 list-disc list-inside pt-2">
          <li>You get an MCP endpoint URL to paste into your client</li>
          <li>Helm enforces policies and manages OAuth credentials</li>
          <li>Add accounts, permissions, memory scopes, and skills after creation</li>
        </ul>
      </section>

      {error && (
        <div className="mt-4 p-3 bg-red-50 border border-red-100 rounded-lg text-sm text-red-700">{error}</div>
      )}

      <div className="flex items-center justify-between mt-8">
        <button
          type="button"
          onClick={() => navigate('/agents')}
          className="px-5 py-2.5 text-sm text-gray-500 hover:text-gray-700 transition-colors"
        >
          Cancel
        </button>
        <button
          type="button"
          onClick={() => { setError(''); createMutation.mutate(); }}
          disabled={!canCreate}
          className="flex items-center gap-2 px-6 py-2.5 bg-trust-blue text-white rounded-xl hover:bg-blue-600 transition-colors disabled:opacity-50 text-sm font-medium shadow-sm shadow-trust-blue/20"
        >
          {createMutation.isPending && <Loader2 className="w-4 h-4 animate-spin" />}
          Create Agent
        </button>
      </div>
    </div>
  );
}
