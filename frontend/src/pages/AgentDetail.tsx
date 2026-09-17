import { useState } from 'react';
import { useParams, useNavigate, Link } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { ArrowLeft, Copy, Check } from 'lucide-react';
import { agents, type AgentDetail as AgentDetailType } from '../api/client';
import McpAccessSection from '../components/McpAccessSection';

export default function AgentDetail() {
  const { id } = useParams<{ id: string }>();
  const navigate = useNavigate();
  const [copiedKey, setCopiedKey] = useState<string | null>(null);

  const { data: agent, isLoading } = useQuery<AgentDetailType>({
    queryKey: ['agent-detail', id],
    queryFn: () => agents.getDetail(id!),
    enabled: !!id,
  });

  const connectPrompt = useQuery({
    queryKey: ['connect-prompt', id],
    queryFn: () => agents.getConnectPrompt(id!),
    enabled: !!id,
    retry: false,
  });

  const copy = async (text: string, key: string) => {
    await navigator.clipboard.writeText(text);
    setCopiedKey(key);
    setTimeout(() => setCopiedKey(null), 2000);
  };

  if (isLoading) {
    return (
      <div className="p-4 sm:p-8 flex items-center justify-center min-h-[50vh]">
        <div className="flex items-center gap-3 text-gray-400">
          <div className="animate-spin rounded-full h-5 w-5 border-2 border-gray-300 border-t-trust-blue" />
          <span className="text-sm">Loading agent...</span>
        </div>
      </div>
    );
  }

  if (!agent) {
    return (
      <div className="p-4 sm:p-8">
        <p className="text-gray-500">Agent not found.</p>
        <Link to="/agents" className="text-trust-blue hover:underline text-sm mt-2 inline-block">
          Back to agents
        </Link>
      </div>
    );
  }

  const CopyButton = ({ text, k, dark = false }: { text: string; k: string; dark?: boolean }) => (
    <button
      onClick={() => copy(text, k)}
      className={dark ? 'absolute top-2 right-2 text-gray-400 hover:text-gray-200 transition-colors' : 'shrink-0 text-gray-400 hover:text-gray-600 transition-colors'}
      aria-label="Copy"
    >
      {copiedKey === k ? <Check className={`w-4 h-4 ${dark ? 'text-emerald-400' : 'text-emerald-500'}`} /> : <Copy className="w-4 h-4" />}
    </button>
  );

  return (
    <div className="p-4 sm:p-8 max-w-4xl">
      <div className="flex items-center gap-4 mb-8">
        <button
          onClick={() => navigate('/agents')}
          className="p-2 text-gray-400 hover:text-reins-navy hover:bg-gray-100 rounded-lg transition-all"
          aria-label="Back to agents"
        >
          <ArrowLeft className="w-5 h-5" />
        </button>
        <div>
          <h1 className="text-2xl font-semibold text-reins-navy tracking-tight">{agent.name}</h1>
          {agent.description && <p className="text-gray-400 text-sm mt-0.5">{agent.description}</p>}
        </div>
      </div>

      <div className="space-y-6">
        <div className="bg-white rounded-xl border border-gray-100 p-5 space-y-4">
          <h2 className="text-sm font-semibold text-gray-500 uppercase tracking-wider">Connect</h2>
          <div>
            <label className="block text-xs font-medium text-gray-400 uppercase tracking-wider mb-1.5">MCP Endpoint URL</label>
            <div className="flex items-center gap-2 p-3 bg-gray-50 rounded-lg font-mono text-xs text-gray-700 border border-gray-200">
              <span className="flex-1 break-all">{agent.mcpUrl}</span>
              <CopyButton text={agent.mcpUrl} k="url" />
            </div>
          </div>

          <McpAccessSection agentId={agent.id} />

          {connectPrompt.data && (
            <div>
              <label className="block text-xs font-medium text-gray-400 uppercase tracking-wider mb-1.5">Claude Code / Claude Desktop</label>
              <div className="relative">
                <pre className="p-3 bg-gray-900 text-gray-100 rounded-lg text-xs overflow-x-auto leading-relaxed">
                  {JSON.stringify(connectPrompt.data.claudeCodeConfig, null, 2)}
                </pre>
                <CopyButton text={JSON.stringify(connectPrompt.data.claudeCodeConfig, null, 2)} k="claude" dark />
              </div>
            </div>
          )}
        </div>

        <div className="bg-white rounded-xl border border-gray-100 p-5">
          <p className="text-sm text-gray-500">
            Accounts, permissions, memory scopes, and skills for this agent are managed on the{' '}
            <Link to="/agents" className="text-trust-blue hover:underline">Agents</Link> page.
          </p>
        </div>
      </div>
    </div>
  );
}
