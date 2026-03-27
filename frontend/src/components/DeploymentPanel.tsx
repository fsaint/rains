import { useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import {
  Rocket,
  Square,
  Play,
  RefreshCw,
  Trash2,
  ExternalLink,
  Loader2,
  AlertCircle,
  X,
  ScrollText,
} from 'lucide-react';
import { agents, type DeployConfig } from '../api/client';
import { LogsPanel } from './LogsPanel';

interface DeploymentPanelProps {
  agentId: string;
  agentName: string;
  onClose: () => void;
}

const STATUS_COLORS: Record<string, { bg: string; text: string; dot: string }> = {
  running: { bg: 'bg-emerald-50', text: 'text-emerald-700', dot: 'bg-emerald-500' },
  stopped: { bg: 'bg-gray-100', text: 'text-gray-600', dot: 'bg-gray-400' },
  pending: { bg: 'bg-amber-50', text: 'text-amber-700', dot: 'bg-amber-500' },
  starting: { bg: 'bg-blue-50', text: 'text-blue-700', dot: 'bg-blue-500' },
  error: { bg: 'bg-red-50', text: 'text-red-700', dot: 'bg-red-500' },
  destroyed: { bg: 'bg-gray-100', text: 'text-gray-500', dot: 'bg-gray-300' },
};

export function DeploymentPanel({ agentId, agentName, onClose }: DeploymentPanelProps) {
  const queryClient = useQueryClient();
  const [showDeployForm, setShowDeployForm] = useState(false);
  const [showLogs, setShowLogs] = useState(false);
  const [config, setConfig] = useState<DeployConfig>({
    telegramToken: '',
    telegramUserId: '',
    soulMd: '',
    modelProvider: 'anthropic',
    modelName: 'claude-sonnet-4-5',
    region: 'iad',
  });

  const deploymentQuery = useQuery({
    queryKey: ['deployment', agentId],
    queryFn: () => agents.getDeployment(agentId),
    retry: false,
    refetchInterval: (query) => {
      const data = query.state.data;
      if (data && ['running', 'starting', 'pending'].includes(data.status)) {
        return 10000;
      }
      return false;
    },
  });

  const deployment = deploymentQuery.data;
  const hasDeployment = deployment && !['destroyed', 'error'].includes(deployment.status);

  const deployMutation = useMutation({
    mutationFn: (data: DeployConfig) => agents.deploy(agentId, data),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['deployment', agentId] });
      queryClient.invalidateQueries({ queryKey: ['agents'] });
      setShowDeployForm(false);
    },
  });

  const startMutation = useMutation({
    mutationFn: () => agents.startDeployment(agentId),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['deployment', agentId] }),
  });

  const stopMutation = useMutation({
    mutationFn: () => agents.stopDeployment(agentId),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['deployment', agentId] }),
  });

  const redeployMutation = useMutation({
    mutationFn: () => agents.redeployAgent(agentId),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['deployment', agentId] }),
  });

  const destroyMutation = useMutation({
    mutationFn: () => agents.destroyDeployment(agentId),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['deployment', agentId] });
      queryClient.invalidateQueries({ queryKey: ['agents'] });
    },
  });

  const isLoading =
    deployMutation.isPending ||
    startMutation.isPending ||
    stopMutation.isPending ||
    redeployMutation.isPending ||
    destroyMutation.isPending;

  const error =
    deployMutation.error ||
    startMutation.error ||
    stopMutation.error ||
    redeployMutation.error ||
    destroyMutation.error;

  const handleDeploy = (e: React.FormEvent) => {
    e.preventDefault();
    if (!config.telegramToken.trim()) return;
    deployMutation.mutate({
      ...config,
      telegramUserId: config.telegramUserId || undefined,
      soulMd: config.soulMd || undefined,
    });
  };

  const statusStyle = STATUS_COLORS[deployment?.status || 'pending'] || STATUS_COLORS.pending;

  return (
    <div className="fixed inset-0 bg-reins-navy/60 backdrop-blur-sm flex items-center justify-center z-50">
      <div className="bg-white rounded-2xl p-6 w-full max-w-xl shadow-2xl border border-gray-100 max-h-[90vh] overflow-y-auto">
        <div className="flex items-center justify-between mb-5">
          <div>
            <h2 className="text-lg font-semibold text-reins-navy">Deploy Agent</h2>
            <p className="text-sm text-gray-500">{agentName}</p>
          </div>
          <button onClick={onClose} className="text-gray-300 hover:text-gray-500 transition-colors">
            <X className="w-5 h-5" />
          </button>
        </div>

        {error && (
          <div className="mb-4 p-3 bg-red-50 border border-red-100 rounded-lg flex items-start gap-2">
            <AlertCircle className="w-4 h-4 text-red-500 mt-0.5 shrink-0" />
            <p className="text-sm text-red-700">{(error as Error).message}</p>
          </div>
        )}

        {hasDeployment ? (
          <div className="space-y-4">
            {/* Status */}
            <div className="flex items-center justify-between p-4 bg-gray-50 rounded-xl">
              <div className="flex items-center gap-3">
                <div className={`flex items-center gap-2 px-3 py-1.5 rounded-full ${statusStyle.bg}`}>
                  <div className={`w-2 h-2 rounded-full ${statusStyle.dot} ${deployment.status === 'running' ? 'animate-pulse' : ''}`} />
                  <span className={`text-sm font-medium ${statusStyle.text}`}>
                    {deployment.status}
                  </span>
                </div>
              </div>
              <div className="flex items-center gap-3">
                <button
                  onClick={() => setShowLogs(true)}
                  className="flex items-center gap-1.5 text-sm text-gray-500 hover:text-gray-700 transition-colors"
                >
                  <ScrollText className="w-3.5 h-3.5" />
                  Logs
                </button>
                {deployment.managementUrl && (
                  <a
                    href={deployment.managementUrl}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="flex items-center gap-1.5 text-sm text-trust-blue hover:underline"
                  >
                    <ExternalLink className="w-3.5 h-3.5" />
                    Open
                  </a>
                )}
              </div>
            </div>

            {/* Info */}
            <div className="grid grid-cols-2 gap-3 text-sm">
              {deployment.flyAppName && (
                <div>
                  <span className="text-gray-400 text-xs uppercase tracking-wider">App</span>
                  <p className="text-gray-700 font-mono text-xs mt-0.5">{deployment.flyAppName}</p>
                </div>
              )}
              {deployment.region && (
                <div>
                  <span className="text-gray-400 text-xs uppercase tracking-wider">Region</span>
                  <p className="text-gray-700 mt-0.5">{deployment.region}</p>
                </div>
              )}
              {deployment.modelProvider && (
                <div>
                  <span className="text-gray-400 text-xs uppercase tracking-wider">Model</span>
                  <p className="text-gray-700 mt-0.5">
                    {deployment.modelProvider}/{deployment.modelName}
                  </p>
                </div>
              )}
              {deployment.createdAt && (
                <div>
                  <span className="text-gray-400 text-xs uppercase tracking-wider">Deployed</span>
                  <p className="text-gray-700 mt-0.5">
                    {new Date(deployment.createdAt).toLocaleDateString()}
                  </p>
                </div>
              )}
            </div>

            {/* Actions */}
            <div className="flex items-center gap-2 pt-2 border-t border-gray-100">
              {deployment.status === 'stopped' && (
                <button
                  onClick={() => startMutation.mutate()}
                  disabled={isLoading}
                  className="flex items-center gap-1.5 px-4 py-2 text-sm font-medium text-white bg-emerald-500 hover:bg-emerald-600 rounded-lg transition-colors disabled:opacity-50"
                >
                  {startMutation.isPending ? <Loader2 className="w-4 h-4 animate-spin" /> : <Play className="w-4 h-4" />}
                  Start
                </button>
              )}
              {deployment.status === 'running' && (
                <button
                  onClick={() => stopMutation.mutate()}
                  disabled={isLoading}
                  className="flex items-center gap-1.5 px-4 py-2 text-sm font-medium text-white bg-gray-500 hover:bg-gray-600 rounded-lg transition-colors disabled:opacity-50"
                >
                  {stopMutation.isPending ? <Loader2 className="w-4 h-4 animate-spin" /> : <Square className="w-4 h-4" />}
                  Stop
                </button>
              )}
              <button
                onClick={() => redeployMutation.mutate()}
                disabled={isLoading}
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
                disabled={isLoading}
                className="flex items-center gap-1.5 px-4 py-2 text-sm font-medium text-red-600 hover:bg-red-50 rounded-lg transition-colors disabled:opacity-50"
              >
                {destroyMutation.isPending ? <Loader2 className="w-4 h-4 animate-spin" /> : <Trash2 className="w-4 h-4" />}
                Destroy
              </button>
            </div>
          </div>
        ) : showDeployForm ? (
          <form onSubmit={handleDeploy} className="space-y-4">
            <div>
              <label className="block text-xs font-medium text-gray-500 uppercase tracking-wider mb-1.5">
                Telegram Bot Token *
              </label>
              <input
                type="text"
                value={config.telegramToken}
                onChange={(e) => setConfig({ ...config, telegramToken: e.target.value })}
                className="w-full border border-gray-200 rounded-lg px-3 py-2.5 text-sm font-mono focus:ring-2 focus:ring-trust-blue/20 focus:border-trust-blue transition-all outline-none"
                placeholder="123456789:ABC..."
                required
              />
            </div>
            <div>
              <label className="block text-xs font-medium text-gray-500 uppercase tracking-wider mb-1.5">
                Telegram User ID (optional)
              </label>
              <input
                type="text"
                value={config.telegramUserId}
                onChange={(e) => setConfig({ ...config, telegramUserId: e.target.value })}
                className="w-full border border-gray-200 rounded-lg px-3 py-2.5 text-sm focus:ring-2 focus:ring-trust-blue/20 focus:border-trust-blue transition-all outline-none"
                placeholder="Restrict to this user ID"
              />
            </div>
            <div className="grid grid-cols-2 gap-3">
              <div>
                <label className="block text-xs font-medium text-gray-500 uppercase tracking-wider mb-1.5">
                  Model Provider
                </label>
                <select
                  value={config.modelProvider}
                  onChange={(e) => {
                    const provider = e.target.value;
                    const defaultModel = provider === 'openai-codex' ? 'o3' : 'claude-sonnet-4-5';
                    setConfig({ ...config, modelProvider: provider, modelName: defaultModel });
                  }}
                  className="w-full border border-gray-200 rounded-lg px-3 py-2.5 text-sm focus:ring-2 focus:ring-trust-blue/20 focus:border-trust-blue transition-all outline-none bg-white"
                >
                  <option value="anthropic">Anthropic</option>
                  <option value="openai">OpenAI</option>
                </select>
              </div>
              <div>
                <label className="block text-xs font-medium text-gray-500 uppercase tracking-wider mb-1.5">
                  Model
                </label>
                <input
                  type="text"
                  value={config.modelName}
                  onChange={(e) => setConfig({ ...config, modelName: e.target.value })}
                  className="w-full border border-gray-200 rounded-lg px-3 py-2.5 text-sm focus:ring-2 focus:ring-trust-blue/20 focus:border-trust-blue transition-all outline-none"
                />
              </div>
            </div>
            <div>
              <label className="block text-xs font-medium text-gray-500 uppercase tracking-wider mb-1.5">
                Region
              </label>
              <select
                value={config.region}
                onChange={(e) => setConfig({ ...config, region: e.target.value })}
                className="w-full border border-gray-200 rounded-lg px-3 py-2.5 text-sm focus:ring-2 focus:ring-trust-blue/20 focus:border-trust-blue transition-all outline-none bg-white"
              >
                <option value="iad">IAD (Virginia)</option>
                <option value="ord">ORD (Chicago)</option>
                <option value="lax">LAX (Los Angeles)</option>
                <option value="sjc">SJC (San Jose)</option>
                <option value="ams">AMS (Amsterdam)</option>
                <option value="lhr">LHR (London)</option>
                <option value="nrt">NRT (Tokyo)</option>
              </select>
            </div>
            <div>
              <label className="block text-xs font-medium text-gray-500 uppercase tracking-wider mb-1.5">
                SOUL.md (optional)
              </label>
              <textarea
                value={config.soulMd}
                onChange={(e) => setConfig({ ...config, soulMd: e.target.value })}
                className="w-full border border-gray-200 rounded-lg px-3 py-2.5 text-sm font-mono focus:ring-2 focus:ring-trust-blue/20 focus:border-trust-blue transition-all outline-none"
                rows={4}
                placeholder="Custom personality and instructions..."
              />
            </div>
            <div className="flex items-center gap-2 pt-2">
              <button
                type="submit"
                disabled={deployMutation.isPending || !config.telegramToken.trim()}
                className="flex items-center gap-1.5 px-4 py-2.5 text-sm font-medium text-white bg-trust-blue hover:bg-trust-blue/90 rounded-lg transition-colors disabled:opacity-50"
              >
                {deployMutation.isPending ? <Loader2 className="w-4 h-4 animate-spin" /> : <Rocket className="w-4 h-4" />}
                Deploy
              </button>
              <button
                type="button"
                onClick={() => setShowDeployForm(false)}
                className="px-4 py-2.5 text-sm font-medium text-gray-500 hover:text-gray-700 transition-colors"
              >
                Cancel
              </button>
            </div>
          </form>
        ) : (
          <div className="text-center py-8">
            <Rocket className="w-10 h-10 text-gray-300 mx-auto mb-3" />
            <p className="text-sm text-gray-500 mb-4">
              {deploymentQuery.isError
                ? 'No active deployment. Deploy this agent to Fly.io or local Docker.'
                : deploymentQuery.isLoading
                  ? 'Checking deployment status...'
                  : 'No active deployment.'}
            </p>
            <button
              onClick={() => setShowDeployForm(true)}
              className="flex items-center gap-1.5 px-4 py-2.5 text-sm font-medium text-white bg-trust-blue hover:bg-trust-blue/90 rounded-lg transition-colors mx-auto"
            >
              <Rocket className="w-4 h-4" />
              New Deployment
            </button>
          </div>
        )}

        {showLogs && (
          <LogsPanel
            agentId={agentId}
            agentName={agentName}
            onClose={() => setShowLogs(false)}
          />
        )}
      </div>
    </div>
  );
}
