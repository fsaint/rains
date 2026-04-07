import { useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import {
  Rocket,
  Square,
  Play,
  RefreshCw,
  RotateCcw,
  Trash2,
  ExternalLink,
  Loader2,
  AlertCircle,
  X,
  ScrollText,
  MessageSquare,
  Copy,
  Check,
  Wrench,
} from 'lucide-react';
import { agents, type DeployConfig } from '../api/client';
import LogViewer from './LogViewer';
import ChatModal from './ChatModal';

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
  const [showChat, setShowChat] = useState(false);
  const [config, setConfig] = useState<DeployConfig>({
    telegramToken: '',
    telegramUserId: '',
    soulMd: '',
    modelProvider: 'anthropic',
    modelName: 'claude-sonnet-4-5',
    region: 'iad',
  });

  const [copiedKey, setCopiedKey] = useState<string | null>(null);

  const copyToClipboard = (text: string, key: string) => {
    navigator.clipboard.writeText(text);
    setCopiedKey(key);
    setTimeout(() => setCopiedKey(null), 2000);
  };

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

  const connectPromptQuery = useQuery({
    queryKey: ['connect-prompt', agentId],
    queryFn: () => agents.getConnectPrompt(agentId),
    enabled: deploymentQuery.data?.isManual === true,
    retry: false,
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

  const restartMutation = useMutation({
    mutationFn: () => agents.restartDeployment(agentId),
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
    restartMutation.isPending ||
    redeployMutation.isPending ||
    destroyMutation.isPending;

  const error =
    deployMutation.error ||
    startMutation.error ||
    stopMutation.error ||
    restartMutation.error ||
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
            {/* Manual agent: MCP config panel */}
            {deployment.isManual ? (
              <div className="space-y-4">
                <div className="flex items-center gap-2 p-3 bg-purple-50 border border-purple-100 rounded-xl">
                  <Wrench className="w-4 h-4 text-purple-500 shrink-0" />
                  <span className="text-sm font-medium text-purple-700">Manual Agent — bring your own runtime</span>
                </div>

                {connectPromptQuery.isLoading && (
                  <div className="flex items-center gap-2 text-sm text-gray-400">
                    <Loader2 className="w-4 h-4 animate-spin" /> Loading MCP config...
                  </div>
                )}

                {connectPromptQuery.data && (
                  <>
                    {/* MCP URL */}
                    <div>
                      <label className="block text-xs font-medium text-gray-400 uppercase tracking-wider mb-1.5">MCP Endpoint URL</label>
                      <div className="flex items-center gap-2 p-3 bg-gray-50 rounded-lg font-mono text-xs text-gray-700 border border-gray-200">
                        <span className="flex-1 break-all">{connectPromptQuery.data.mcpUrl}</span>
                        <button
                          onClick={() => copyToClipboard(connectPromptQuery.data!.mcpUrl, 'url')}
                          className="shrink-0 text-gray-400 hover:text-gray-600 transition-colors"
                        >
                          {copiedKey === 'url' ? <Check className="w-4 h-4 text-emerald-500" /> : <Copy className="w-4 h-4" />}
                        </button>
                      </div>
                    </div>

                    {/* Claude Code config */}
                    <div>
                      <label className="block text-xs font-medium text-gray-400 uppercase tracking-wider mb-1.5">Claude Code / Claude Desktop</label>
                      <div className="relative">
                        <pre className="p-3 bg-gray-900 text-gray-100 rounded-lg text-xs overflow-x-auto leading-relaxed">
                          {JSON.stringify(connectPromptQuery.data.claudeCodeConfig, null, 2)}
                        </pre>
                        <button
                          onClick={() => copyToClipboard(JSON.stringify(connectPromptQuery.data!.claudeCodeConfig, null, 2), 'claude')}
                          className="absolute top-2 right-2 text-gray-400 hover:text-gray-200 transition-colors"
                        >
                          {copiedKey === 'claude' ? <Check className="w-4 h-4 text-emerald-400" /> : <Copy className="w-4 h-4" />}
                        </button>
                      </div>
                    </div>

                    {/* OpenAI/OpenClaw config */}
                    <div>
                      <label className="block text-xs font-medium text-gray-400 uppercase tracking-wider mb-1.5">OpenAI / OpenClaw</label>
                      <div className="relative">
                        <pre className="p-3 bg-gray-900 text-gray-100 rounded-lg text-xs overflow-x-auto leading-relaxed">
                          {JSON.stringify(connectPromptQuery.data.openaiClawConfig, null, 2)}
                        </pre>
                        <button
                          onClick={() => copyToClipboard(JSON.stringify(connectPromptQuery.data!.openaiClawConfig, null, 2), 'openai')}
                          className="absolute top-2 right-2 text-gray-400 hover:text-gray-200 transition-colors"
                        >
                          {copiedKey === 'openai' ? <Check className="w-4 h-4 text-emerald-400" /> : <Copy className="w-4 h-4" />}
                        </button>
                      </div>
                    </div>
                  </>
                )}

                {/* Destroy only */}
                <div className="flex justify-end pt-2 border-t border-gray-100">
                  <button
                    onClick={() => {
                      if (confirm('Remove this manual agent? This cannot be undone.')) {
                        destroyMutation.mutate();
                      }
                    }}
                    disabled={destroyMutation.isPending}
                    className="flex items-center gap-1.5 px-4 py-2 text-sm font-medium text-red-600 hover:bg-red-50 rounded-lg transition-colors disabled:opacity-50"
                  >
                    {destroyMutation.isPending ? <Loader2 className="w-4 h-4 animate-spin" /> : <Trash2 className="w-4 h-4" />}
                    Remove
                  </button>
                </div>
              </div>
            ) : (
            <>
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
                {deployment.status === 'running' && (
                  <button
                    onClick={() => setShowChat(true)}
                    className="flex items-center gap-1.5 text-sm text-trust-blue hover:text-trust-blue/80 font-medium transition-colors"
                  >
                    <MessageSquare className="w-3.5 h-3.5" />
                    Chat
                  </button>
                )}
                {deployment.managementUrl && (
                  <a
                    href={deployment.managementUrl}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="flex items-center gap-1.5 text-sm text-gray-400 hover:text-gray-600 transition-colors"
                  >
                    <ExternalLink className="w-3.5 h-3.5" />
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
              {deployment.status === 'running' && (
                <button
                  onClick={() => restartMutation.mutate()}
                  disabled={isLoading}
                  className="flex items-center gap-1.5 px-4 py-2 text-sm font-medium text-amber-600 bg-amber-50 hover:bg-amber-100 border border-amber-100 rounded-lg transition-colors disabled:opacity-50"
                >
                  {restartMutation.isPending ? <Loader2 className="w-4 h-4 animate-spin" /> : <RotateCcw className="w-4 h-4" />}
                  Restart
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
            </>
            )}
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
                    const defaultModel = provider === 'openai-codex' ? 'gpt-5.4' : 'claude-sonnet-4-5';
                    setConfig({ ...config, modelProvider: provider, modelName: defaultModel });
                  }}
                  className="w-full border border-gray-200 rounded-lg px-3 py-2.5 text-sm focus:ring-2 focus:ring-trust-blue/20 focus:border-trust-blue transition-all outline-none bg-white"
                >
                  <option value="anthropic">Anthropic</option>
                  <option value="openai-codex">OpenAI (ChatGPT)</option>
                </select>
              </div>
              <div>
                <label className="block text-xs font-medium text-gray-500 uppercase tracking-wider mb-1.5">
                  Model
                </label>
                <select
                  value={config.modelName}
                  onChange={(e) => setConfig({ ...config, modelName: e.target.value })}
                  className="w-full border border-gray-200 rounded-lg px-3 py-2.5 text-sm focus:ring-2 focus:ring-trust-blue/20 focus:border-trust-blue transition-all outline-none bg-white"
                >
                  {config.modelProvider === 'openai-codex' ? (
                    <>
                      <option value="gpt-5.4">GPT-5.4 (default)</option>
                      <option value="gpt-5.4-mini">GPT-5.4 Mini</option>
                      <option value="gpt-5.3-codex">GPT-5.3 Codex</option>
                      <option value="gpt-5.3-codex-spark">GPT-5.3 Codex Spark</option>
                      <option value="gpt-5-codex">GPT-5 Codex</option>
                      <option value="gpt-5-codex-mini">GPT-5 Codex Mini</option>
                    </>
                  ) : (
                    <>
                      <option value="claude-sonnet-4-5">Claude Sonnet 4.5</option>
                      <option value="claude-opus-4-6">Claude Opus 4.6</option>
                      <option value="claude-haiku-4-5">Claude Haiku 4.5</option>
                    </>
                  )}
                </select>
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
          <LogViewer
            agentId={agentId}
            agentName={agentName}
            streamUrl={agents.logsStreamUrl(agentId)}
            onClose={() => setShowLogs(false)}
          />
        )}
        {showChat && (
          <ChatModal
            agentId={agentId}
            agentName={agentName}
            onClose={() => setShowChat(false)}
          />
        )}
      </div>
    </div>
  );
}
