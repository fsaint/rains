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
  ScrollText,
  MessageSquare,
  RotateCcw,
  KeyRound,
  X,
  Users,
  ChevronDown,
  ChevronRight,
  Hash,
} from 'lucide-react';
import { agents, type AgentDetail as AgentDetailType, type TelegramGroup } from '../api/client';
import LogViewer from '../components/LogViewer';
import ChatModal from '../components/ChatModal';
import { CodexDeviceFlow } from '../components/CodexDeviceFlow';

// ─── Telegram Groups Section ──────────────────────────────────────────────────

function TelegramGroupsSection({
  agentId,
  groups,
  onSaved,
}: {
  agentId: string;
  groups: TelegramGroup[];
  onSaved: () => void;
}) {
  const [expandedGroup, setExpandedGroup] = useState<string | null>(null);
  const [editingTopic, setEditingTopic] = useState<{ chatId: string; threadId: number; prompt: string } | null>(null);
  const [newThreadId, setNewThreadId] = useState('');
  const [newPrompt, setNewPrompt] = useState('');

  const updateSettings = useMutation({
    mutationFn: (updated: TelegramGroup[]) =>
      agents.updateSettings(agentId, { telegramGroups: updated }),
    onSuccess: () => onSaved(),
  });

  const saveTopicPrompt = (chatId: string, threadId: number, prompt: string) => {
    const updated = groups.map((g) => {
      if (g.chatId !== chatId) return g;
      const existing = (g.topicPrompts ?? []).filter((tp) => tp.threadId !== threadId);
      const newPrompts = prompt.trim() ? [...existing, { threadId, prompt }] : existing;
      return { ...g, topicPrompts: newPrompts };
    });
    updateSettings.mutate(updated);
    setEditingTopic(null);
  };

  const removeTopicPrompt = (chatId: string, threadId: number) => {
    saveTopicPrompt(chatId, threadId, '');
  };

  const toggleRequireMention = (chatId: string, current: boolean) => {
    const updated = groups.map((g) =>
      g.chatId === chatId ? { ...g, requireMention: !current } : g
    );
    updateSettings.mutate(updated);
  };

  if (groups.length === 0) {
    return (
      <div className="bg-white rounded-xl border border-gray-100 p-5">
        <div className="flex items-center gap-2 mb-1">
          <Users className="w-4 h-4 text-gray-400" />
          <h2 className="text-sm font-semibold text-gray-500 uppercase tracking-wider">Telegram Groups</h2>
        </div>
        <p className="text-sm text-gray-400 mt-2">
          No groups configured yet. Add the bot to a Telegram group to configure it.
        </p>
      </div>
    );
  }

  return (
    <div className="bg-white rounded-xl border border-gray-100 p-5 space-y-4">
      <div className="flex items-center gap-2">
        <Users className="w-4 h-4 text-gray-400" />
        <h2 className="text-sm font-semibold text-gray-500 uppercase tracking-wider">
          Telegram Groups ({groups.length})
        </h2>
      </div>

      <div className="space-y-2">
        {groups.map((group) => {
          const isExpanded = expandedGroup === group.chatId;
          const topics = group.topicPrompts ?? [];

          return (
            <div key={group.chatId} className="border border-gray-100 rounded-lg overflow-hidden">
              {/* Group header */}
              <div className="flex items-center gap-3 px-4 py-3 bg-gray-50">
                <button
                  onClick={() => setExpandedGroup(isExpanded ? null : group.chatId)}
                  className="flex items-center gap-2 flex-1 min-w-0 text-left"
                >
                  {isExpanded ? (
                    <ChevronDown className="w-4 h-4 text-gray-400 shrink-0" />
                  ) : (
                    <ChevronRight className="w-4 h-4 text-gray-400 shrink-0" />
                  )}
                  <div className="min-w-0">
                    <span className="text-sm font-medium text-reins-navy">
                      {group.name ?? group.chatId}
                    </span>
                    <span className="ml-2 text-xs text-gray-400 font-mono">{group.chatId}</span>
                  </div>
                </button>
                <button
                  onClick={() => toggleRequireMention(group.chatId, group.requireMention ?? true)}
                  disabled={updateSettings.isPending}
                  className={`text-xs px-2.5 py-1 rounded-full font-medium transition-colors ${
                    group.requireMention === false
                      ? 'bg-emerald-100 text-emerald-700'
                      : 'bg-gray-100 text-gray-500'
                  }`}
                  title="Toggle: respond to all messages vs @mention only"
                >
                  {group.requireMention === false ? '💬 All msgs' : '@mention only'}
                </button>
                {topics.length > 0 && (
                  <span className="text-xs text-gray-400">{topics.length} topic{topics.length > 1 ? 's' : ''}</span>
                )}
              </div>

              {/* Topics */}
              {isExpanded && (
                <div className="p-4 space-y-3">
                  {topics.length === 0 && (
                    <p className="text-xs text-gray-400">No topic-specific instructions yet.</p>
                  )}
                  {topics.map((tp) => (
                    <div key={tp.threadId} className="flex items-start gap-3 p-3 bg-gray-50 rounded-lg">
                      <Hash className="w-3.5 h-3.5 text-gray-400 mt-0.5 shrink-0" />
                      <div className="flex-1 min-w-0">
                        <span className="text-xs font-mono text-gray-500">Thread {tp.threadId}</span>
                        {editingTopic?.chatId === group.chatId && editingTopic.threadId === tp.threadId ? (
                          <div className="mt-1 space-y-2">
                            <textarea
                              value={editingTopic.prompt}
                              onChange={(e) => setEditingTopic({ ...editingTopic, prompt: e.target.value })}
                              className="w-full text-xs border border-gray-200 rounded px-2 py-1.5 focus:ring-1 focus:ring-trust-blue/30 focus:border-trust-blue outline-none resize-none"
                              rows={3}
                            />
                            <div className="flex gap-2">
                              <button
                                onClick={() => saveTopicPrompt(group.chatId, tp.threadId, editingTopic.prompt)}
                                disabled={updateSettings.isPending}
                                className="text-xs px-2.5 py-1 bg-trust-blue text-white rounded font-medium disabled:opacity-50"
                              >
                                Save
                              </button>
                              <button
                                onClick={() => setEditingTopic(null)}
                                className="text-xs px-2.5 py-1 text-gray-500 hover:bg-gray-100 rounded"
                              >
                                Cancel
                              </button>
                            </div>
                          </div>
                        ) : (
                          <div className="mt-1 flex items-start gap-2">
                            <p className="text-xs text-gray-600 flex-1 whitespace-pre-wrap line-clamp-2">{tp.prompt}</p>
                            <div className="flex gap-1 shrink-0">
                              <button
                                onClick={() => setEditingTopic({ chatId: group.chatId, threadId: tp.threadId, prompt: tp.prompt })}
                                className="text-xs text-trust-blue hover:underline"
                              >
                                Edit
                              </button>
                              <button
                                onClick={() => removeTopicPrompt(group.chatId, tp.threadId)}
                                className="text-xs text-red-400 hover:underline"
                              >
                                Remove
                              </button>
                            </div>
                          </div>
                        )}
                      </div>
                    </div>
                  ))}

                  {/* Add new topic prompt */}
                  <div className="pt-2 border-t border-gray-100">
                    <p className="text-xs font-medium text-gray-500 mb-2">Add topic instruction</p>
                    <div className="flex gap-2 items-start">
                      <input
                        type="number"
                        placeholder="Thread ID"
                        value={newThreadId}
                        onChange={(e) => setNewThreadId(e.target.value)}
                        className="w-24 text-xs border border-gray-200 rounded px-2 py-1.5 focus:ring-1 focus:ring-trust-blue/30 focus:border-trust-blue outline-none"
                      />
                      <textarea
                        placeholder="System prompt for this topic..."
                        value={newPrompt}
                        onChange={(e) => setNewPrompt(e.target.value)}
                        className="flex-1 text-xs border border-gray-200 rounded px-2 py-1.5 focus:ring-1 focus:ring-trust-blue/30 focus:border-trust-blue outline-none resize-none"
                        rows={2}
                      />
                      <button
                        onClick={() => {
                          const tid = parseInt(newThreadId, 10);
                          if (!isNaN(tid) && newPrompt.trim()) {
                            saveTopicPrompt(group.chatId, tid, newPrompt.trim());
                            setNewThreadId('');
                            setNewPrompt('');
                          }
                        }}
                        disabled={!newThreadId || !newPrompt.trim() || updateSettings.isPending}
                        className="text-xs px-3 py-1.5 bg-trust-blue text-white rounded font-medium disabled:opacity-40"
                      >
                        Add
                      </button>
                    </div>
                  </div>
                </div>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}

// ─── Main component ───────────────────────────────────────────────────────────

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
  const [showLogs, setShowLogs] = useState(false);
  const [showChat, setShowChat] = useState(false);
  const [showReauth, setShowReauth] = useState(false);
  const [reauthStatus, setReauthStatus] = useState<'idle' | 'working' | 'done' | 'error'>('idle');
  const [reauthError, setReauthError] = useState('');

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

  const restartMutation = useMutation({
    mutationFn: () => agents.restartDeployment(id!),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['agent-detail', id] }),
  });

  const soulMutation = useMutation({
    mutationFn: (newSoul: string) => agents.updateSoul(id!, newSoul),
    onSuccess: () => {
      setSoulDirty(false);
      queryClient.invalidateQueries({ queryKey: ['agent-detail', id] });
    },
  });

  const isActionLoading = startMutation.isPending || stopMutation.isPending || redeployMutation.isPending || destroyMutation.isPending || restartMutation.isPending;

  const handleCopyToken = async (token: string) => {
    await navigator.clipboard.writeText(token);
    setTokenCopied(true);
    setTimeout(() => setTokenCopied(false), 2000);
  };

  const handleReauthComplete = async (tokensJson: string) => {
    setReauthStatus('working');
    try {
      await agents.redeployAgent(id!, { modelCredentials: tokensJson });
      setReauthStatus('done');
      queryClient.invalidateQueries({ queryKey: ['agent-detail', id] });
      setTimeout(() => setShowReauth(false), 2000);
    } catch (err) {
      setReauthStatus('error');
      setReauthError(err instanceof Error ? err.message : 'Redeploy failed');
    }
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
    <div className="p-4 sm:p-8 max-w-4xl">
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
            <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-xs text-gray-400 mt-1">
              {dep?.region && <span>Region: {dep.region}</span>}
              {dep?.telegramBotUsername ? (
                <a
                  href={`https://t.me/${dep.telegramBotUsername}`}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="hover:text-blue-400 underline"
                >
                  @{dep.telegramBotUsername}
                </a>
              ) : dep?.telegramToken ? (
                <span>Telegram: {dep.telegramToken}</span>
              ) : null}
              {dep?.modelProvider && <span>Model: {dep.modelProvider}/{dep.modelName}</span>}
            </div>
          </div>
        </div>
      </div>

      {/* Modals */}
      {showLogs && (
        <LogViewer
          agentId={id!}
          agentName={agent.name}
          streamUrl={agents.logsStreamUrl(id!)}
          onClose={() => setShowLogs(false)}
        />
      )}
      {showChat && dep?.status === 'running' && (
        <ChatModal
          agentId={id!}
          agentName={agent.name}
          onClose={() => setShowChat(false)}
        />
      )}

      {/* OpenAI Re-authentication Modal */}
      {showReauth && (
        <div
          className="fixed inset-0 bg-black/40 flex items-center justify-center z-50 p-4"
          onClick={(e) => e.target === e.currentTarget && setShowReauth(false)}
        >
          <div className="bg-white rounded-2xl p-6 w-full max-w-md shadow-xl">
            <div className="flex items-center justify-between mb-5">
              <div className="flex items-center gap-3">
                <div className="w-9 h-9 rounded-xl bg-trust-blue/10 flex items-center justify-center">
                  <KeyRound className="w-4 h-4 text-trust-blue" />
                </div>
                <div>
                  <h2 className="font-semibold text-gray-900 text-base">Re-authenticate OpenAI</h2>
                  <p className="text-xs text-gray-500 mt-0.5">{agent.name}</p>
                </div>
              </div>
              <button
                onClick={() => setShowReauth(false)}
                className="w-8 h-8 flex items-center justify-center rounded-lg text-gray-400 hover:text-gray-600 hover:bg-gray-100 transition-colors"
              >
                <X className="w-4 h-4" />
              </button>
            </div>
            {reauthStatus === 'done' ? (
              <div className="flex items-center gap-3 p-4 bg-emerald-50 border border-emerald-100 rounded-xl">
                <Check className="w-5 h-5 text-emerald-600 shrink-0" />
                <div>
                  <p className="font-medium text-emerald-800 text-sm">Re-authentication successful</p>
                  <p className="text-xs text-emerald-600 mt-0.5">Agent is redeploying with new credentials.</p>
                </div>
              </div>
            ) : reauthStatus === 'working' ? (
              <div className="flex items-center gap-3 p-4 bg-blue-50 border border-blue-100 rounded-xl">
                <Loader2 className="w-5 h-5 text-blue-500 animate-spin shrink-0" />
                <p className="text-sm text-blue-700">Redeploying with new credentials…</p>
              </div>
            ) : (
              <CodexDeviceFlow onComplete={handleReauthComplete} />
            )}
            {reauthStatus === 'error' && (
              <div className="mt-3 p-3 bg-red-50 border border-red-100 rounded-lg">
                <p className="text-xs text-red-700">{reauthError}</p>
              </div>
            )}
          </div>
        </div>
      )}

      <div className="space-y-6">
        {/* Controls */}
        {dep && dep.status !== 'destroyed' && dep.status !== 'error' && (
          <div className="bg-white rounded-xl border border-gray-100 p-5">
            <div className="flex items-center gap-2 flex-wrap">
              {!dep.isManual && dep.status === 'stopped' && (
                <button
                  onClick={() => startMutation.mutate()}
                  disabled={isActionLoading}
                  className="flex items-center gap-1.5 px-4 py-2 text-sm font-medium text-white bg-emerald-500 hover:bg-emerald-600 rounded-lg transition-colors disabled:opacity-50"
                >
                  {startMutation.isPending ? <Loader2 className="w-4 h-4 animate-spin" /> : <Play className="w-4 h-4" />}
                  Start
                </button>
              )}
              {!dep.isManual && dep.status === 'running' && (
                <button
                  onClick={() => stopMutation.mutate()}
                  disabled={isActionLoading}
                  className="flex items-center gap-1.5 px-4 py-2 text-sm font-medium text-white bg-gray-500 hover:bg-gray-600 rounded-lg transition-colors disabled:opacity-50"
                >
                  {stopMutation.isPending ? <Loader2 className="w-4 h-4 animate-spin" /> : <Square className="w-4 h-4" />}
                  Stop
                </button>
              )}
              {!dep.isManual && dep.status === 'running' && (
                <button
                  onClick={() => restartMutation.mutate()}
                  disabled={isActionLoading}
                  className="flex items-center gap-1.5 px-4 py-2 text-sm font-medium text-gray-700 hover:bg-gray-100 border border-gray-200 rounded-lg transition-colors disabled:opacity-50"
                  title="Restart the gateway container"
                >
                  {restartMutation.isPending ? <Loader2 className="w-4 h-4 animate-spin" /> : <RotateCcw className="w-4 h-4" />}
                  Restart
                </button>
              )}
              {!dep.isManual && (
                <button
                  onClick={() => redeployMutation.mutate()}
                  disabled={isActionLoading}
                  className="flex items-center gap-1.5 px-4 py-2 text-sm font-medium text-trust-blue bg-trust-blue/5 hover:bg-trust-blue/10 border border-trust-blue/10 rounded-lg transition-colors disabled:opacity-50"
                >
                  {redeployMutation.isPending ? <Loader2 className="w-4 h-4 animate-spin" /> : <RefreshCw className="w-4 h-4" />}
                  Redeploy
                </button>
              )}
              {!dep.isManual && (
                <button
                  onClick={() => { setReauthStatus('idle'); setReauthError(''); setShowReauth(true); }}
                  disabled={isActionLoading}
                  className="flex items-center gap-1.5 px-4 py-2 text-sm font-medium text-amber-700 bg-amber-50 hover:bg-amber-100 border border-amber-200 rounded-lg transition-colors disabled:opacity-50"
                >
                  <KeyRound className="w-4 h-4" />
                  Re-auth OpenAI
                </button>
              )}
              <div className="flex-1" />
              {/* Logs & Chat — hidden for manual agents */}
              {!dep.isManual && (
                <button
                  onClick={() => setShowLogs(true)}
                  className="flex items-center gap-1.5 px-3 py-2 text-sm font-medium text-gray-600 hover:bg-gray-100 border border-gray-200 rounded-lg transition-colors"
                  title="View live logs"
                >
                  <ScrollText className="w-4 h-4" />
                  Logs
                </button>
              )}
              {!dep.isManual && dep.status === 'running' && (
                <button
                  onClick={() => setShowChat(true)}
                  className="flex items-center gap-1.5 px-3 py-2 text-sm font-medium text-white bg-trust-blue hover:bg-trust-blue/90 rounded-lg transition-colors"
                  title="Chat with this agent"
                >
                  <MessageSquare className="w-4 h-4" />
                  Chat
                </button>
              )}
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

        {/* Telegram Groups */}
        {dep && (
          <TelegramGroupsSection
            agentId={id!}
            groups={agent.deployment?.telegramGroups ?? []}
            onSaved={() => queryClient.invalidateQueries({ queryKey: ['agent-detail', id] })}
          />
        )}
      </div>
    </div>
  );
}
