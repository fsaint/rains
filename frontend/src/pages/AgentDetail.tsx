import { useState } from 'react';
import { useParams, useNavigate, Link } from 'react-router-dom';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import {
  ArrowLeft,
  ExternalLink,
  Play,
  Square,
  RefreshCw,
  Trash2,
  Copy,
  Check,
  Loader2,
  Save,
  Server,
} from 'lucide-react';
import { agents, type AgentDetail as AgentDetailType } from '../api/client';

const STATUS_COLORS: Record<string, { bg: string; text: string; dot: string }> = {
  running: { bg: 'bg-emerald-50', text: 'text-emerald-700', dot: 'bg-emerald-500' },
  stopped: { bg: 'bg-gray-100', text: 'text-gray-600', dot: 'bg-gray-400' },
  pending: { bg: 'bg-amber-50', text: 'text-amber-700', dot: 'bg-amber-500' },
  starting: { bg: 'bg-blue-50', text: 'text-blue-700', dot: 'bg-blue-500' },
  error: { bg: 'bg-red-50', text: 'text-red-700', dot: 'bg-red-500' },
  destroyed: { bg: 'bg-gray-100', text: 'text-gray-500', dot: 'bg-gray-300' },
};

export default function AgentDetail() {
  const { id } = useParams<{ id: string }>();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const [tokenCopied, setTokenCopied] = useState(false);
  const [soulMd, setSoulMd] = useState<string | null>(null);
  const [soulDirty, setSoulDirty] = useState(false);

  const { data: agent, isLoading } = useQuery<AgentDetailType>({
    queryKey: ['agent-detail', id],
    queryFn: () => agents.getDetail(id!),
    enabled: !!id,
    refetchInterval: (query) => {
      const data = query.state.data;
      if (data?.deployment && ['running', 'starting', 'pending'].includes(data.deployment.status)) {
        return 10000;
      }
      return false;
    },
  });

  // Initialize soul editor when data loads
  if (agent?.deployment?.soulMd !== undefined && soulMd === null) {
    setSoulMd(agent.deployment.soulMd || '');
  }

  const startMutation = useMutation({
    mutationFn: () => agents.startDeployment(id!),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['agent-detail', id] }),
  });

  const stopMutation = useMutation({
    mutationFn: () => agents.stopDeployment(id!),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['agent-detail', id] }),
  });

  const redeployMutation = useMutation({
    mutationFn: () => agents.redeployAgent(id!),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['agent-detail', id] }),
  });

  const destroyMutation = useMutation({
    mutationFn: () => agents.destroyDeployment(id!),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['agent-detail', id] }),
  });

  const soulMutation = useMutation({
    mutationFn: (newSoul: string) => agents.updateSoul(id!, newSoul),
    onSuccess: () => {
      setSoulDirty(false);
      queryClient.invalidateQueries({ queryKey: ['agent-detail', id] });
    },
  });

  const isActionLoading = startMutation.isPending || stopMutation.isPending || redeployMutation.isPending || destroyMutation.isPending;

  const handleCopyToken = async (token: string) => {
    await navigator.clipboard.writeText(token);
    setTokenCopied(true);
    setTimeout(() => setTokenCopied(false), 2000);
  };

  if (isLoading) {
    return (
      <div className="p-8 flex items-center justify-center min-h-[50vh]">
        <div className="flex items-center gap-3 text-gray-400">
          <div className="animate-spin rounded-full h-5 w-5 border-2 border-gray-300 border-t-trust-blue" />
          <span className="text-sm">Loading agent...</span>
        </div>
      </div>
    );
  }

  if (!agent) {
    return (
      <div className="p-8">
        <p className="text-gray-500">Agent not found.</p>
        <Link to="/agents" className="text-trust-blue hover:underline text-sm mt-2 inline-block">
          Back to agents
        </Link>
      </div>
    );
  }

  const dep = agent.deployment;
  const statusStyle = STATUS_COLORS[dep?.status || 'pending'] || STATUS_COLORS.pending;

  // Parse MCP servers from config
  let mcpServers: { name: string; url?: string }[] = [];
  if (dep?.mcpConfigJson) {
    try {
      mcpServers = JSON.parse(dep.mcpConfigJson);
    } catch { /* ignore */ }
  }

  return (
    <div className="p-8 max-w-4xl">
      {/* Header */}
      <div className="flex items-start justify-between mb-8">
        <div className="flex items-center gap-4">
          <button
            onClick={() => navigate('/agents')}
            className="p-2 text-gray-400 hover:text-reins-navy hover:bg-gray-100 rounded-lg transition-all"
          >
            <ArrowLeft className="w-5 h-5" />
          </button>
          <div>
            <div className="flex items-center gap-3">
              <h1 className="text-2xl font-semibold text-reins-navy tracking-tight">{agent.name}</h1>
              {dep && (
                <div className={`flex items-center gap-1.5 px-2.5 py-1 rounded-full ${statusStyle.bg}`}>
                  <div className={`w-2 h-2 rounded-full ${statusStyle.dot} ${dep.status === 'running' ? 'animate-pulse' : ''}`} />
                  <span className={`text-xs font-medium ${statusStyle.text}`}>{dep.status}</span>
                </div>
              )}
            </div>
            {agent.description && (
              <p className="text-gray-400 text-sm mt-0.5">{agent.description}</p>
            )}
            <div className="flex items-center gap-4 text-xs text-gray-400 mt-1">
              {dep?.region && <span>Region: {dep.region}</span>}
              {dep?.telegramToken && <span>Telegram: {dep.telegramToken}</span>}
              {dep?.modelProvider && <span>Model: {dep.modelProvider}/{dep.modelName}</span>}
            </div>
          </div>
        </div>
      </div>

      <div className="space-y-6">
        {/* Controls */}
        {dep && dep.status !== 'destroyed' && dep.status !== 'error' && (
          <div className="bg-white rounded-xl border border-gray-100 p-5">
            <div className="flex items-center gap-2 flex-wrap">
              {dep.status === 'stopped' && (
                <button
                  onClick={() => startMutation.mutate()}
                  disabled={isActionLoading}
                  className="flex items-center gap-1.5 px-4 py-2 text-sm font-medium text-white bg-emerald-500 hover:bg-emerald-600 rounded-lg transition-colors disabled:opacity-50"
                >
                  {startMutation.isPending ? <Loader2 className="w-4 h-4 animate-spin" /> : <Play className="w-4 h-4" />}
                  Start
                </button>
              )}
              {dep.status === 'running' && (
                <button
                  onClick={() => stopMutation.mutate()}
                  disabled={isActionLoading}
                  className="flex items-center gap-1.5 px-4 py-2 text-sm font-medium text-white bg-gray-500 hover:bg-gray-600 rounded-lg transition-colors disabled:opacity-50"
                >
                  {stopMutation.isPending ? <Loader2 className="w-4 h-4 animate-spin" /> : <Square className="w-4 h-4" />}
                  Stop
                </button>
              )}
              <button
                onClick={() => redeployMutation.mutate()}
                disabled={isActionLoading}
                className="flex items-center gap-1.5 px-4 py-2 text-sm font-medium text-trust-blue bg-trust-blue/5 hover:bg-trust-blue/10 border border-trust-blue/10 rounded-lg transition-colors disabled:opacity-50"
              >
                {redeployMutation.isPending ? <Loader2 className="w-4 h-4 animate-spin" /> : <RefreshCw className="w-4 h-4" />}
                Redeploy
              </button>
              <div className="flex-1" />
              <button
                onClick={() => {
                  if (confirm('Destroy this deployment? This cannot be undone.')) {
                    destroyMutation.mutate();
                  }
                }}
                disabled={isActionLoading}
                className="flex items-center gap-1.5 px-4 py-2 text-sm font-medium text-red-600 hover:bg-red-50 rounded-lg transition-colors disabled:opacity-50"
              >
                {destroyMutation.isPending ? <Loader2 className="w-4 h-4 animate-spin" /> : <Trash2 className="w-4 h-4" />}
                Destroy
              </button>
            </div>
          </div>
        )}

        {/* Management */}
        {dep && (
          <div className="bg-white rounded-xl border border-gray-100 p-5 space-y-4">
            <h2 className="text-sm font-semibold text-gray-500 uppercase tracking-wider">Management</h2>
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
              {dep.managementUrl && (
                <div>
                  <span className="text-xs text-gray-400 uppercase tracking-wider">Console</span>
                  <a
                    href={dep.managementUrl}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="flex items-center gap-1.5 text-sm text-trust-blue hover:underline mt-0.5"
                  >
                    <ExternalLink className="w-3.5 h-3.5" />
                    Open Console
                  </a>
                </div>
              )}
              {dep.flyAppName && (
                <div>
                  <span className="text-xs text-gray-400 uppercase tracking-wider">App Name</span>
                  <p className="text-sm font-mono text-gray-700 mt-0.5">{dep.flyAppName}</p>
                </div>
              )}
              <div>
                <span className="text-xs text-gray-400 uppercase tracking-wider">Gateway Token</span>
                <div className="flex items-center gap-2 mt-0.5">
                  <code className="text-xs font-mono text-gray-600 bg-gray-50 px-2 py-1 rounded">
                    {dep.gatewayToken.slice(0, 8)}...{dep.gatewayToken.slice(-4)}
                  </code>
                  <button
                    onClick={() => handleCopyToken(dep.gatewayToken)}
                    className={`flex items-center gap-1 text-xs px-2 py-0.5 rounded transition-all ${
                      tokenCopied
                        ? 'text-emerald-600 bg-emerald-50'
                        : 'text-gray-400 hover:text-gray-600'
                    }`}
                  >
                    {tokenCopied ? <Check className="w-3 h-3" /> : <Copy className="w-3 h-3" />}
                    {tokenCopied ? 'Copied' : 'Copy'}
                  </button>
                </div>
              </div>
            </div>
          </div>
        )}

        {/* Soul MD Editor */}
        {dep && (
          <div className="bg-white rounded-xl border border-gray-100 p-5 space-y-4">
            <div className="flex items-center justify-between">
              <h2 className="text-sm font-semibold text-gray-500 uppercase tracking-wider">Soul MD</h2>
              {soulDirty && (
                <button
                  onClick={() => soulMutation.mutate(soulMd || '')}
                  disabled={soulMutation.isPending}
                  className="flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium text-white bg-trust-blue hover:bg-blue-600 rounded-lg transition-colors disabled:opacity-50"
                >
                  {soulMutation.isPending ? <Loader2 className="w-3 h-3 animate-spin" /> : <Save className="w-3 h-3" />}
                  Save & Redeploy
                </button>
              )}
            </div>
            <textarea
              value={soulMd ?? ''}
              onChange={(e) => {
                setSoulMd(e.target.value);
                setSoulDirty(true);
              }}
              className="w-full border border-gray-200 rounded-lg px-3 py-2.5 text-sm font-mono focus:ring-2 focus:ring-trust-blue/20 focus:border-trust-blue transition-all outline-none resize-none"
              rows={8}
              placeholder="Agent personality and instructions..."
            />
            {soulMutation.isError && (
              <p className="text-xs text-red-600">
                {soulMutation.error instanceof Error ? soulMutation.error.message : 'Failed to update'}
              </p>
            )}
          </div>
        )}

        {/* MCP Servers */}
        {mcpServers.length > 0 && (
          <div className="bg-white rounded-xl border border-gray-100 p-5 space-y-4">
            <h2 className="text-sm font-semibold text-gray-500 uppercase tracking-wider">MCP Servers</h2>
            <div className="space-y-2">
              {mcpServers.map((s, i) => (
                <div key={i} className="flex items-center gap-3 p-3 bg-gray-50 rounded-lg">
                  <Server className="w-4 h-4 text-gray-400 shrink-0" />
                  <div className="min-w-0">
                    <p className="text-sm font-medium text-reins-navy">{s.name}</p>
                    {s.url && <p className="text-xs text-gray-400 font-mono truncate">{s.url}</p>}
                  </div>
                </div>
              ))}
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
