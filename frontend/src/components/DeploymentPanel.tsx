import { useState, useEffect } from 'react';
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
  Plus,
  Settings,
  ChevronDown,
  ChevronRight,
} from 'lucide-react';
import { agents, type DeployConfig, type TelegramGroup, type TopicPrompt } from '../api/client';
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
  const [showSettings, setShowSettings] = useState(false);
  const [settingsGroups, setSettingsGroups] = useState<TelegramGroup[]>([]);
  const [settingsOpenaiKey, setSettingsOpenaiKey] = useState<string>('');
  const [settingsResult, setSettingsResult] = useState<string | null>(null);
  const [expandedTopics, setExpandedTopics] = useState<Record<number, boolean>>({});

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

  const settingsMutation = useMutation({
    mutationFn: (payload: { telegramGroups: TelegramGroup[]; openaiApiKey: string | null | undefined }) =>
      agents.updateSettings(agentId, {
        telegramGroups: payload.telegramGroups,
        openaiApiKey: payload.openaiApiKey,
      }),
    onSuccess: (data) => {
      queryClient.invalidateQueries({ queryKey: ['deployment', agentId] });
      if (!data?.changed) {
        setSettingsResult('No changes detected.');
      } else if (data?.restarted) {
        setSettingsResult('Applied! Agent is restarting...');
      } else {
        setSettingsResult('Saved. Changes take effect on next redeploy.');
      }
    },
  });

  // Sync settings state when deployment data loads
  const deploymentDetail = deploymentQuery.data;
  useEffect(() => {
    if (deploymentDetail) {
      setSettingsGroups((deploymentDetail as unknown as { telegramGroups?: TelegramGroup[] }).telegramGroups ?? []);
      setSettingsOpenaiKey((deploymentDetail as unknown as { openaiApiKey?: string | null }).openaiApiKey ?? '');
    }
  }, [deploymentDetail]);

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
              {deployment.runtime && deployment.runtime !== 'openclaw' && (
                <div className="flex items-center justify-between py-2 border-b border-gray-50">
                  <span className="text-xs text-gray-400 uppercase tracking-wide">Runtime</span>
                  <span className="text-xs font-medium bg-purple-50 text-purple-700 px-2 py-0.5 rounded-full capitalize">{deployment.runtime}</span>
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

            {/* Runtime Settings */}
            <div className="border border-gray-100 rounded-xl overflow-hidden">
              <button
                type="button"
                onClick={() => { setShowSettings(!showSettings); setSettingsResult(null); }}
                className="flex items-center justify-between w-full px-4 py-3 text-sm font-medium text-gray-600 hover:bg-gray-50 transition-colors"
              >
                <span className="flex items-center gap-2">
                  <Settings className="w-4 h-4 text-gray-400" />
                  Runtime Settings
                </span>
                <span className="text-xs text-gray-400">{showSettings ? 'Hide' : 'Edit'}</span>
              </button>

              {showSettings && (
                <div className="border-t border-gray-100 p-4 space-y-4 bg-gray-50">
                  {/* Telegram Groups */}
                  <div>
                    <label className="block text-xs font-medium text-gray-500 uppercase tracking-wider mb-1.5">
                      Telegram Groups
                    </label>
                    <p className="text-xs text-gray-400 mb-2">
                      Add the bot to a group, then paste its numeric chat ID (e.g. <code className="bg-gray-100 px-1 rounded">-1001234567890</code>). Find it via <a href="https://t.me/RawDataBot" target="_blank" rel="noreferrer" className="text-trust-blue hover:underline">@RawDataBot</a>.
                    </p>
                    <div className="space-y-2">
                      {settingsGroups.map((g, i) => (
                        <div key={i} className="bg-white border border-gray-200 rounded-lg overflow-hidden">
                          <div className="flex items-center gap-2 p-2">
                            <div className="flex-1 min-w-0">
                              {g.name && (
                                <div className="text-xs font-medium text-gray-700 truncate mb-0.5">{g.name}</div>
                              )}
                              <input
                                type="text"
                                value={g.chatId}
                                onChange={(e) => {
                                  const updated = [...settingsGroups];
                                  updated[i] = { ...updated[i], chatId: e.target.value };
                                  setSettingsGroups(updated);
                                }}
                                className="w-full text-sm font-mono border-none outline-none bg-transparent"
                                placeholder="-1001234567890"
                              />
                            </div>
                            <label className="flex items-center gap-1 text-xs text-gray-500 shrink-0">
                              <input
                                type="checkbox"
                                checked={g.requireMention !== false}
                                onChange={(e) => {
                                  const updated = [...settingsGroups];
                                  updated[i] = { ...updated[i], requireMention: e.target.checked };
                                  setSettingsGroups(updated);
                                }}
                              />
                              @mention
                            </label>
                            <button
                              type="button"
                              onClick={() => setExpandedTopics(prev => ({ ...prev, [i]: !prev[i] }))}
                              className="flex items-center gap-0.5 text-xs text-gray-400 hover:text-trust-blue transition-colors shrink-0"
                              title="Per-topic prompts"
                            >
                              {expandedTopics[i] ? <ChevronDown className="w-3.5 h-3.5" /> : <ChevronRight className="w-3.5 h-3.5" />}
                              <span>Topics{g.topicPrompts && g.topicPrompts.length > 0 ? ` (${g.topicPrompts.length})` : ''}</span>
                            </button>
                            <button
                              type="button"
                              onClick={() => setSettingsGroups(settingsGroups.filter((_, j) => j !== i))}
                              className="text-gray-300 hover:text-red-500 transition-colors"
                            >
                              <X className="w-4 h-4" />
                            </button>
                          </div>
                          {expandedTopics[i] && (
                            <div className="border-t border-gray-100 bg-gray-50 p-2 space-y-2">
                              <p className="text-xs text-gray-400">
                                Override the agent's system prompt for specific forum topics. Find a topic's thread ID: right-click a message in the topic → <em>Copy Link</em> — the number after the last <code className="bg-gray-100 px-0.5 rounded">/</code> is the thread ID.
                              </p>
                              {(g.topicPrompts ?? []).map((tp: TopicPrompt, ti: number) => (
                                <div key={ti} className="space-y-1 bg-white border border-gray-200 rounded p-2">
                                  <div className="flex items-center gap-2">
                                    <span className="text-xs text-gray-400 shrink-0">Thread ID</span>
                                    <input
                                      type="number"
                                      min={1}
                                      value={tp.threadId || ''}
                                      onChange={(e) => {
                                        const updated = [...settingsGroups];
                                        const prompts = [...(updated[i].topicPrompts ?? [])];
                                        prompts[ti] = { ...prompts[ti], threadId: parseInt(e.target.value) || 0 };
                                        updated[i] = { ...updated[i], topicPrompts: prompts };
                                        setSettingsGroups(updated);
                                      }}
                                      className="w-28 text-sm font-mono border border-gray-200 rounded px-2 py-0.5 outline-none focus:border-trust-blue"
                                      placeholder="42"
                                    />
                                    <button
                                      type="button"
                                      onClick={() => {
                                        const updated = [...settingsGroups];
                                        const prompts = (updated[i].topicPrompts ?? []).filter((_, j) => j !== ti);
                                        updated[i] = { ...updated[i], topicPrompts: prompts };
                                        setSettingsGroups(updated);
                                      }}
                                      className="ml-auto text-gray-300 hover:text-red-500 transition-colors"
                                    >
                                      <X className="w-3.5 h-3.5" />
                                    </button>
                                  </div>
                                  <textarea
                                    value={tp.prompt}
                                    onChange={(e) => {
                                      const updated = [...settingsGroups];
                                      const prompts = [...(updated[i].topicPrompts ?? [])];
                                      prompts[ti] = { ...prompts[ti], prompt: e.target.value };
                                      updated[i] = { ...updated[i], topicPrompts: prompts };
                                      setSettingsGroups(updated);
                                    }}
                                    rows={3}
                                    className="w-full text-xs border border-gray-200 rounded px-2 py-1.5 outline-none focus:border-trust-blue resize-y font-mono"
                                    placeholder="You are a billing specialist. Help users with invoices, payments, and subscription questions..."
                                  />
                                </div>
                              ))}
                              <button
                                type="button"
                                onClick={() => {
                                  const updated = [...settingsGroups];
                                  updated[i] = {
                                    ...updated[i],
                                    topicPrompts: [...(updated[i].topicPrompts ?? []), { threadId: 0, prompt: '' }],
                                  };
                                  setSettingsGroups(updated);
                                }}
                                className="flex items-center gap-1 text-xs text-trust-blue hover:text-trust-blue/80 transition-colors"
                              >
                                <Plus className="w-3 h-3" /> Add topic prompt
                              </button>
                            </div>
                          )}
                        </div>
                      ))}
                      <button
                        type="button"
                        onClick={() => setSettingsGroups([...settingsGroups, { chatId: '', requireMention: true }])}
                        className="flex items-center gap-1 text-xs text-trust-blue hover:text-trust-blue/80 transition-colors"
                      >
                        <Plus className="w-3 h-3" /> Add group
                      </button>
                    </div>
                  </div>

                  {/* LLM / Whisper API Key */}
                  <div>
                    <label className="block text-xs font-medium text-gray-500 uppercase tracking-wider mb-1.5">
                      {deployment?.modelProvider === 'minimax'
                        ? 'MiniMax API Key'
                        : <>OpenAI API Key <span className="normal-case font-normal text-gray-400">(Whisper speech-to-text)</span></>
                      }
                    </label>
                    <input
                      type="password"
                      value={settingsOpenaiKey}
                      onChange={(e) => setSettingsOpenaiKey(e.target.value)}
                      className="w-full border border-gray-200 rounded-lg px-3 py-2.5 text-sm bg-white focus:ring-2 focus:ring-trust-blue/20 focus:border-trust-blue transition-all outline-none"
                      placeholder={settingsOpenaiKey === '***' ? 'Key stored (enter new key to replace)' : (deployment?.modelProvider === 'minimax' ? 'Enter MiniMax API key' : 'sk-...')}
                    />
                    {settingsOpenaiKey === '***' && (
                      <p className="text-xs text-gray-400 mt-1">A key is stored. Clear to remove it.</p>
                    )}
                  </div>

                  {settingsResult && (
                    <p className="text-xs text-emerald-600 font-medium">{settingsResult}</p>
                  )}
                  {settingsMutation.isError && (
                    <p className="text-xs text-red-500">{(settingsMutation.error as Error).message}</p>
                  )}

                  <div className="flex items-center gap-2 pt-1">
                    <button
                      type="button"
                      disabled={settingsMutation.isPending}
                      onClick={() => settingsMutation.mutate({ telegramGroups: settingsGroups, openaiApiKey: settingsOpenaiKey === '***' ? undefined : (settingsOpenaiKey || null) })}
                      className="flex items-center gap-1.5 px-4 py-2 text-sm font-medium text-white bg-trust-blue hover:bg-trust-blue/90 rounded-lg transition-colors disabled:opacity-50"
                    >
                      {settingsMutation.isPending ? <Loader2 className="w-4 h-4 animate-spin" /> : <RefreshCw className="w-4 h-4" />}
                      Save & apply
                    </button>
                    <p className="text-xs text-gray-400">Restarts agent (~30s downtime)</p>
                  </div>
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
                    const defaultModel = provider === 'openai-codex' ? 'gpt-5.4' : provider === 'minimax' ? 'MiniMax-M2.7' : 'claude-sonnet-4-5';
                    setConfig({ ...config, modelProvider: provider, modelName: defaultModel });
                  }}
                  className="w-full border border-gray-200 rounded-lg px-3 py-2.5 text-sm focus:ring-2 focus:ring-trust-blue/20 focus:border-trust-blue transition-all outline-none bg-white"
                >
                  <option value="anthropic">Anthropic</option>
                  <option value="openai-codex">OpenAI (ChatGPT)</option>
                  <option value="minimax">MiniMax</option>
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
                  ) : config.modelProvider === 'minimax' ? (
                    <>
                      <option value="MiniMax-M2.7">MiniMax M2.7 (default)</option>
                      <option value="MiniMax-M2.7-highspeed">MiniMax M2.7 Highspeed</option>
                      <option value="MiniMax-M2.5">MiniMax M2.5</option>
                      <option value="MiniMax-M2.5-highspeed">MiniMax M2.5 Highspeed</option>
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
