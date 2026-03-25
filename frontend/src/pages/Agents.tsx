import { useState, useEffect } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import {
  Plus,
  Trash2,
  Power,
  PowerOff,
  Key,
  X,
  Terminal,
  Copy,
  Check,
  Radio,
  Zap,
  ChevronRight,
  Rocket,
} from 'lucide-react';
import { agents, type PendingRegistration } from '../api/client';
import { DeploymentPanel } from '../components/DeploymentPanel';

function RegistrationPrompt({ compact = false }: { compact?: boolean }) {
  const [promptCopied, setPromptCopied] = useState(false);
  const registerUrl = `${window.location.origin}/api/agents/register`;

  const prompt = `You can register yourself with a Reins gateway to gain access to managed tools (Gmail, Drive, Calendar, web search, browser, etc).

To register, send a POST request:

POST ${registerUrl}
Content-Type: application/json

{"name":"<your agent name>","description":"<brief description of what you do>"}

The response will include a claim code and a claim URL. Tell the user to visit the claim URL or enter the code in the Reins dashboard to approve your registration. Then poll for status:

GET ${registerUrl.replace('/register', '')}/<agentId>/registration-status

Once claimed, you will receive your MCP endpoint URL for tool access.`;

  const handleCopyPrompt = async () => {
    await navigator.clipboard.writeText(prompt);
    setPromptCopied(true);
    setTimeout(() => setPromptCopied(false), 2000);
  };

  return (
    <div className={compact ? '' : 'mt-6'}>
      <div className="flex items-center gap-2 mb-2">
        <Terminal className="w-4 h-4 text-gray-400" />
        <span className="text-xs font-medium text-gray-500 uppercase tracking-wider">
          Self-Registration Prompt
        </span>
      </div>
      <p className="text-xs text-gray-400 mb-2">
        Paste this into your agent&apos;s system prompt so it can register itself with Reins.
      </p>
      <div className="relative rounded-xl overflow-hidden">
        <div className="bg-[#0d1117] rounded-xl">
          <div className="flex items-center justify-between px-4 py-2 border-b border-white/5">
            <div className="flex items-center gap-1.5">
              <div className="w-2 h-2 rounded-full bg-[#ff5f57]"></div>
              <div className="w-2 h-2 rounded-full bg-[#febc2e]"></div>
              <div className="w-2 h-2 rounded-full bg-[#28c840]"></div>
            </div>
            <button
              onClick={handleCopyPrompt}
              className={`flex items-center gap-1.5 text-xs px-2.5 py-1 rounded-md transition-all ${
                promptCopied
                  ? 'bg-safe-green/20 text-safe-green'
                  : 'text-gray-500 hover:text-gray-300 hover:bg-white/5'
              }`}
            >
              {promptCopied ? (
                <><Check className="w-3 h-3" /> Copied</>
              ) : (
                <><Copy className="w-3 h-3" /> Copy</>
              )}
            </button>
          </div>
          <pre className={`px-4 py-3 text-[12px] leading-relaxed font-mono text-gray-300 whitespace-pre-wrap overflow-auto selection:bg-trust-blue/30 ${compact ? 'max-h-48' : 'max-h-64'}`}>
            {prompt}
          </pre>
        </div>
      </div>
    </div>
  );
}

interface Agent {
  id: string;
  name: string;
  description?: string;
  status: string;
  credentials: string[];
  createdAt: string;
}

export default function Agents() {
  const queryClient = useQueryClient();
  const [showCreateModal, setShowCreateModal] = useState(false);
  const [showClaimModal, setShowClaimModal] = useState(false);
  const [newAgent, setNewAgent] = useState({ name: '', description: '' });
  const [claimCode, setClaimCode] = useState('');
  const [claimError, setClaimError] = useState('');
  const [connectAgentId, setConnectAgentId] = useState<string | null>(null);
  const [deployAgentId, setDeployAgentId] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const [copiedConfig, setCopiedConfig] = useState<string | null>(null);

  const { data: agentsList, isLoading } = useQuery<Agent[]>({
    queryKey: ['agents'],
    queryFn: agents.list as () => Promise<Agent[]>,
  });

  const { data: pendingList } = useQuery<PendingRegistration[]>({
    queryKey: ['agents', 'pending'],
    queryFn: agents.listPending,
    refetchInterval: 5000,
  });

  const { data: connectPrompt, isLoading: isLoadingPrompt } = useQuery({
    queryKey: ['agents', connectAgentId, 'connect-prompt'],
    queryFn: () => agents.getConnectPrompt(connectAgentId!),
    enabled: !!connectAgentId,
  });

  const createMutation = useMutation({
    mutationFn: agents.create,
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['agents'] });
      setShowCreateModal(false);
      setNewAgent({ name: '', description: '' });
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

  const handleCreate = (e: React.FormEvent) => {
    e.preventDefault();
    createMutation.mutate(newAgent);
  };

  const handleClaim = (e: React.FormEvent) => {
    e.preventDefault();
    setClaimError('');
    claimMutation.mutate(claimCode.toUpperCase().trim());
  };

  const handleCopy = async () => {
    if (connectPrompt?.prompt) {
      await navigator.clipboard.writeText(connectPrompt.prompt);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    }
  };

  const getTimeRemaining = (expiresAt: string) => {
    const remaining = new Date(expiresAt).getTime() - Date.now();
    if (remaining <= 0) return 'Expired';
    const minutes = Math.floor(remaining / 60000);
    const seconds = Math.floor((remaining % 60000) / 1000);
    return `${minutes}:${seconds.toString().padStart(2, '0')}`;
  };

  // Auto-refresh pending countdowns
  const [, setTick] = useState(0);
  useEffect(() => {
    if (!pendingList?.length) return;
    const interval = setInterval(() => setTick((t) => t + 1), 1000);
    return () => clearInterval(interval);
  }, [pendingList?.length]);

  return (
    <div className="p-8 max-w-6xl">
      {/* Header */}
      <div className="flex items-end justify-between mb-8">
        <div>
          <h1 className="text-2xl font-semibold text-reins-navy tracking-tight">Agents</h1>
          <p className="text-gray-400 mt-1 text-sm">Registered AI agents and their connection endpoints</p>
        </div>
        <div className="flex gap-2">
          <button
            onClick={() => setShowClaimModal(true)}
            className="flex items-center gap-2 bg-reins-navy/5 text-reins-navy border border-reins-navy/10 px-4 py-2 rounded-lg hover:bg-reins-navy/10 transition-all text-sm font-medium"
          >
            <Key className="w-4 h-4" />
            Claim
          </button>
          <button
            onClick={() => setShowCreateModal(true)}
            className="flex items-center gap-2 bg-trust-blue text-white px-4 py-2 rounded-lg hover:bg-blue-600 transition-all text-sm font-medium shadow-sm shadow-trust-blue/20"
          >
            <Plus className="w-4 h-4" />
            Add Agent
          </button>
        </div>
      </div>

      {/* Pending Registrations */}
      {pendingList && pendingList.length > 0 && (
        <div className="mb-6">
          <div className="flex items-center gap-2 mb-3">
            <span className="relative flex h-2.5 w-2.5">
              <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-caution-amber opacity-75"></span>
              <span className="relative inline-flex rounded-full h-2.5 w-2.5 bg-caution-amber"></span>
            </span>
            <h2 className="text-sm font-medium text-gray-500 uppercase tracking-wider">
              Awaiting Claim
            </h2>
          </div>
          <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-3">
            {pendingList.map((pending) => (
              <div
                key={pending.id}
                className="group bg-white border border-caution-amber/20 rounded-xl p-4 relative overflow-hidden"
              >
                <div className="absolute top-0 left-0 right-0 h-0.5 bg-gradient-to-r from-caution-amber/60 via-caution-amber to-caution-amber/60"></div>
                <div className="flex items-start justify-between">
                  <div className="min-w-0">
                    <p className="font-medium text-reins-navy truncate">{pending.name}</p>
                    {pending.description && (
                      <p className="text-xs text-gray-400 mt-0.5 truncate">{pending.description}</p>
                    )}
                  </div>
                  <button
                    onClick={() => cancelPendingMutation.mutate(pending.id)}
                    className="text-gray-300 hover:text-alert-red transition-colors opacity-0 group-hover:opacity-100 shrink-0 ml-2"
                    title="Cancel"
                  >
                    <X className="w-4 h-4" />
                  </button>
                </div>
                <div className="mt-3 flex items-end justify-between">
                  <div className="font-mono text-2xl font-bold text-caution-amber tracking-[0.2em] select-all">
                    {pending.claimCode}
                  </div>
                  <div className="text-xs text-gray-400 font-mono tabular-nums">
                    {getTimeRemaining(pending.expiresAt)}
                  </div>
                </div>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Agent Cards */}
      {isLoading ? (
        <div className="flex items-center justify-center py-20">
          <div className="flex items-center gap-3 text-gray-400">
            <div className="animate-spin rounded-full h-5 w-5 border-2 border-gray-300 border-t-trust-blue"></div>
            <span className="text-sm">Loading agents...</span>
          </div>
        </div>
      ) : !agentsList?.length ? (
        <div className="border border-dashed border-gray-200 rounded-xl p-10">
          <div className="text-center">
            <div className="w-12 h-12 rounded-full bg-gray-100 flex items-center justify-center mx-auto mb-4">
              <Radio className="w-6 h-6 text-gray-400" />
            </div>
            <p className="text-gray-500 font-medium">No agents registered</p>
            <p className="text-sm text-gray-400 mt-1 max-w-md mx-auto">
              Give an agent the prompt below so it can register itself, or add one manually.
            </p>
            <div className="flex justify-center gap-4 mt-4">
              <button
                onClick={() => setShowClaimModal(true)}
                className="text-sm text-reins-navy hover:text-trust-blue transition-colors font-medium"
              >
                Claim with code
              </button>
              <span className="text-gray-300">|</span>
              <button
                onClick={() => setShowCreateModal(true)}
                className="text-sm text-trust-blue hover:text-blue-700 transition-colors font-medium"
              >
                Add manually
              </button>
            </div>
          </div>
          <div className="max-w-2xl mx-auto">
            <RegistrationPrompt />
          </div>
        </div>
      ) : (
        <div className="space-y-3">
          {agentsList.map((agent) => {
            const isActive = agent.status === 'active';
            return (
              <div
                key={agent.id}
                className="group bg-white rounded-xl border border-gray-100 hover:border-gray-200 transition-all hover:shadow-sm"
              >
                <div className="flex items-center gap-4 px-5 py-4">
                  {/* Status indicator */}
                  <div className="shrink-0">
                    <div
                      className={`w-2.5 h-2.5 rounded-full ${
                        isActive ? 'bg-safe-green shadow-sm shadow-safe-green/40' : 'bg-gray-300'
                      }`}
                    />
                  </div>

                  {/* Agent info */}
                  <div className="min-w-0 flex-1">
                    <div className="flex items-center gap-2">
                      <span className="font-medium text-reins-navy">{agent.name}</span>
                      <span
                        className={`text-[10px] font-medium uppercase tracking-wider px-1.5 py-0.5 rounded ${
                          isActive
                            ? 'bg-safe-green/8 text-safe-green'
                            : 'bg-gray-100 text-gray-400'
                        }`}
                      >
                        {agent.status}
                      </span>
                    </div>
                    {agent.description && (
                      <p className="text-sm text-gray-400 truncate mt-0.5">{agent.description}</p>
                    )}
                  </div>

                  {/* Meta */}
                  <div className="hidden sm:flex items-center gap-6 shrink-0 text-xs text-gray-400">
                    {agent.credentials.length > 0 && (
                      <div className="flex items-center gap-1.5">
                        <Key className="w-3 h-3 text-gray-300" />
                        <span>{agent.credentials.length}</span>
                      </div>
                    )}
                    <span className="tabular-nums">
                      {new Date(agent.createdAt).toLocaleDateString('en-US', {
                        month: 'short',
                        day: 'numeric',
                      })}
                    </span>
                  </div>

                  {/* Actions */}
                  <div className="flex items-center gap-1 shrink-0">
                    <button
                      onClick={() => {
                        setConnectAgentId(agent.id);
                        setCopied(false);
                      }}
                      className="flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium text-trust-blue bg-trust-blue/5 hover:bg-trust-blue/10 border border-trust-blue/10 rounded-lg transition-all"
                      title="Connection instructions"
                    >
                      <Terminal className="w-3.5 h-3.5" />
                      Connect
                    </button>
                    <button
                      onClick={() => setDeployAgentId(agent.id)}
                      className="flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium text-emerald-600 bg-emerald-50 hover:bg-emerald-100 border border-emerald-100 rounded-lg transition-all"
                      title="Deploy to Fly.io or Docker"
                    >
                      <Rocket className="w-3.5 h-3.5" />
                      Deploy
                    </button>
                    {isActive ? (
                      <button
                        onClick={() =>
                          updateMutation.mutate({ id: agent.id, data: { status: 'suspended' } })
                        }
                        className="p-1.5 text-gray-300 hover:text-caution-amber transition-colors opacity-0 group-hover:opacity-100"
                        title="Suspend"
                      >
                        <PowerOff className="w-4 h-4" />
                      </button>
                    ) : (
                      <button
                        onClick={() =>
                          updateMutation.mutate({ id: agent.id, data: { status: 'active' } })
                        }
                        className="p-1.5 text-gray-300 hover:text-safe-green transition-colors opacity-0 group-hover:opacity-100"
                        title="Activate"
                      >
                        <Power className="w-4 h-4" />
                      </button>
                    )}
                    <button
                      onClick={() => deleteMutation.mutate(agent.id)}
                      className="p-1.5 text-gray-300 hover:text-alert-red transition-colors opacity-0 group-hover:opacity-100"
                      title="Delete"
                    >
                      <Trash2 className="w-4 h-4" />
                    </button>
                  </div>
                </div>
              </div>
            );
          })}
        </div>
      )}

      {/* Create Modal */}
      {showCreateModal && (
        <div className="fixed inset-0 bg-reins-navy/60 backdrop-blur-sm flex items-center justify-center z-50">
          <div className="bg-white rounded-2xl p-6 w-full max-w-2xl shadow-2xl shadow-reins-navy/10 border border-gray-100 max-h-[90vh] overflow-y-auto">
            <div className="flex items-center justify-between mb-5">
              <h2 className="text-lg font-semibold text-reins-navy">Register Agent</h2>
              <button
                onClick={() => setShowCreateModal(false)}
                className="text-gray-300 hover:text-gray-500 transition-colors"
              >
                <X className="w-5 h-5" />
              </button>
            </div>
            <form onSubmit={handleCreate}>
              <div className="space-y-4">
                <div>
                  <label className="block text-xs font-medium text-gray-500 uppercase tracking-wider mb-1.5">
                    Name
                  </label>
                  <input
                    type="text"
                    value={newAgent.name}
                    onChange={(e) => setNewAgent({ ...newAgent, name: e.target.value })}
                    className="w-full border border-gray-200 rounded-lg px-3 py-2.5 text-sm focus:ring-2 focus:ring-trust-blue/20 focus:border-trust-blue transition-all outline-none"
                    placeholder="e.g. Research Assistant"
                    required
                  />
                </div>
                <div>
                  <label className="block text-xs font-medium text-gray-500 uppercase tracking-wider mb-1.5">
                    Description
                  </label>
                  <textarea
                    value={newAgent.description}
                    onChange={(e) => setNewAgent({ ...newAgent, description: e.target.value })}
                    className="w-full border border-gray-200 rounded-lg px-3 py-2.5 text-sm focus:ring-2 focus:ring-trust-blue/20 focus:border-trust-blue transition-all outline-none resize-none"
                    rows={2}
                    placeholder="What does this agent do?"
                  />
                </div>
              </div>
              <div className="flex justify-end gap-2 mt-6">
                <button
                  type="button"
                  onClick={() => setShowCreateModal(false)}
                  className="px-4 py-2 text-sm text-gray-500 hover:text-gray-700 transition-colors"
                >
                  Cancel
                </button>
                <button
                  type="submit"
                  disabled={createMutation.isPending}
                  className="px-4 py-2 text-sm bg-trust-blue text-white rounded-lg hover:bg-blue-600 disabled:opacity-50 transition-all shadow-sm shadow-trust-blue/20"
                >
                  {createMutation.isPending ? 'Creating...' : 'Create'}
                </button>
              </div>
            </form>

            <div className="relative my-6">
              <div className="absolute inset-0 flex items-center">
                <div className="w-full border-t border-gray-200"></div>
              </div>
              <div className="relative flex justify-center">
                <span className="bg-white px-3 text-xs text-gray-400 uppercase tracking-wider">or let the agent register itself</span>
              </div>
            </div>

            <RegistrationPrompt compact />
          </div>
        </div>
      )}

      {/* Claim Modal */}
      {showClaimModal && (
        <div className="fixed inset-0 bg-reins-navy/60 backdrop-blur-sm flex items-center justify-center z-50">
          <div className="bg-white rounded-2xl p-6 w-full max-w-md shadow-2xl shadow-reins-navy/10 border border-gray-100">
            <div className="flex items-center justify-between mb-2">
              <h2 className="text-lg font-semibold text-reins-navy">Claim Agent</h2>
              <button
                onClick={() => {
                  setShowClaimModal(false);
                  setClaimCode('');
                  setClaimError('');
                }}
                className="text-gray-300 hover:text-gray-500 transition-colors"
              >
                <X className="w-5 h-5" />
              </button>
            </div>
            <p className="text-sm text-gray-400 mb-5">
              Enter the 6-character code from the agent to claim it.
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
                  placeholder="------"
                  maxLength={6}
                  className="w-full text-center text-3xl font-mono font-bold tracking-[0.5em] border border-gray-200 rounded-xl px-3 py-5 focus:ring-2 focus:ring-trust-blue/20 focus:border-trust-blue transition-all outline-none uppercase placeholder:text-gray-200 placeholder:tracking-[0.5em]"
                  autoFocus
                />
                {claimError && (
                  <p className="text-alert-red text-xs mt-2 text-center">{claimError}</p>
                )}
              </div>
              <div className="flex justify-end gap-2 mt-6">
                <button
                  type="button"
                  onClick={() => {
                    setShowClaimModal(false);
                    setClaimCode('');
                    setClaimError('');
                  }}
                  className="px-4 py-2 text-sm text-gray-500 hover:text-gray-700 transition-colors"
                >
                  Cancel
                </button>
                <button
                  type="submit"
                  disabled={claimMutation.isPending || claimCode.length !== 6}
                  className="px-4 py-2 text-sm bg-safe-green text-white rounded-lg hover:bg-green-600 disabled:opacity-50 transition-all shadow-sm shadow-safe-green/20"
                >
                  {claimMutation.isPending ? 'Claiming...' : 'Claim'}
                </button>
              </div>
            </form>
          </div>
        </div>
      )}

      {/* Connect Prompt Modal */}
      {connectAgentId && (
        <div className="fixed inset-0 bg-reins-navy/60 backdrop-blur-sm flex items-center justify-center z-50">
          <div className="bg-white rounded-2xl w-full max-w-2xl shadow-2xl shadow-reins-navy/10 border border-gray-100 overflow-hidden">
            {/* Header */}
            <div className="flex items-center justify-between px-6 py-4 border-b border-gray-100">
              <div className="flex items-center gap-3">
                <div className="w-8 h-8 rounded-lg bg-trust-blue/10 flex items-center justify-center">
                  <Terminal className="w-4 h-4 text-trust-blue" />
                </div>
                <div>
                  <h2 className="text-sm font-semibold text-reins-navy">Connection Prompt</h2>
                  <p className="text-xs text-gray-400">
                    {connectPrompt?.agentName || 'Loading...'}
                  </p>
                </div>
              </div>
              <button
                onClick={() => setConnectAgentId(null)}
                className="text-gray-300 hover:text-gray-500 transition-colors"
              >
                <X className="w-5 h-5" />
              </button>
            </div>

            {/* Body */}
            <div className="p-6">
              {isLoadingPrompt ? (
                <div className="flex items-center justify-center py-12">
                  <div className="flex items-center gap-3 text-gray-400">
                    <div className="animate-spin rounded-full h-5 w-5 border-2 border-gray-300 border-t-trust-blue"></div>
                    <span className="text-sm">Generating prompt...</span>
                  </div>
                </div>
              ) : connectPrompt ? (
                <>
                  <p className="text-sm text-gray-500 mb-3">
                    Paste this into your agent&apos;s system prompt or configuration to connect it to Reins.
                  </p>

                  {/* Prompt block */}
                  <div className="relative group/code rounded-xl overflow-hidden">
                    <div className="bg-[#0d1117] rounded-xl">
                      {/* Terminal chrome */}
                      <div className="flex items-center justify-between px-4 py-2.5 border-b border-white/5">
                        <div className="flex items-center gap-1.5">
                          <div className="w-2.5 h-2.5 rounded-full bg-[#ff5f57]"></div>
                          <div className="w-2.5 h-2.5 rounded-full bg-[#febc2e]"></div>
                          <div className="w-2.5 h-2.5 rounded-full bg-[#28c840]"></div>
                        </div>
                        <button
                          onClick={handleCopy}
                          className={`flex items-center gap-1.5 text-xs px-2.5 py-1 rounded-md transition-all ${
                            copied
                              ? 'bg-safe-green/20 text-safe-green'
                              : 'text-gray-500 hover:text-gray-300 hover:bg-white/5'
                          }`}
                        >
                          {copied ? (
                            <>
                              <Check className="w-3 h-3" />
                              Copied
                            </>
                          ) : (
                            <>
                              <Copy className="w-3 h-3" />
                              Copy
                            </>
                          )}
                        </button>
                      </div>

                      {/* Prompt content */}
                      <pre className="px-4 py-4 text-[13px] leading-relaxed font-mono text-gray-300 whitespace-pre-wrap overflow-auto max-h-72 selection:bg-trust-blue/30">
                        {connectPrompt.prompt}
                      </pre>
                    </div>
                  </div>

                  {/* Services + Endpoint quick reference */}
                  <div className="mt-4 flex flex-wrap items-center gap-2">
                    <div className="flex items-center gap-1.5 text-xs text-gray-400 bg-gray-50 px-2.5 py-1.5 rounded-lg font-mono">
                      <Zap className="w-3 h-3" />
                      {connectPrompt.mcpUrl}
                    </div>
                    {connectPrompt.enabledServices.map((s) => (
                      <span
                        key={s}
                        className="text-xs bg-trust-blue/5 text-trust-blue/70 px-2 py-1 rounded-md font-medium"
                      >
                        {s}
                      </span>
                    ))}
                    {connectPrompt.enabledServices.length === 0 && (
                      <span className="text-xs text-gray-400 italic">
                        No services enabled yet <ChevronRight className="w-3 h-3 inline" /> configure in Permissions
                      </span>
                    )}
                  </div>

                  {/* MCP Config Snippets */}
                  <div className="mt-5 space-y-3">
                    <h3 className="text-xs font-semibold text-gray-500 uppercase tracking-wider">MCP Configuration</h3>

                    {/* Claude Code */}
                    <div className="rounded-xl overflow-hidden border border-gray-200">
                      <div className="flex items-center justify-between px-4 py-2.5 bg-gray-50 border-b border-gray-200">
                        <span className="text-xs font-medium text-reins-navy">Claude Code</span>
                        <button
                          onClick={async () => {
                            await navigator.clipboard.writeText(JSON.stringify(connectPrompt.claudeCodeConfig, null, 2));
                            setCopiedConfig('claude');
                            setTimeout(() => setCopiedConfig(null), 2000);
                          }}
                          className={`flex items-center gap-1 text-xs px-2 py-0.5 rounded transition-all ${
                            copiedConfig === 'claude'
                              ? 'text-safe-green bg-safe-green/10'
                              : 'text-gray-400 hover:text-gray-600'
                          }`}
                        >
                          {copiedConfig === 'claude' ? (
                            <><Check className="w-3 h-3" /> Copied</>
                          ) : (
                            <><Copy className="w-3 h-3" /> Copy</>
                          )}
                        </button>
                      </div>
                      <pre className="px-4 py-3 text-[12px] leading-relaxed font-mono text-gray-600 bg-white overflow-x-auto">
                        {JSON.stringify(connectPrompt.claudeCodeConfig, null, 2)}
                      </pre>
                    </div>

                    {/* OpenAI CLA (openaclaw) */}
                    <div className="rounded-xl overflow-hidden border border-gray-200">
                      <div className="flex items-center justify-between px-4 py-2.5 bg-gray-50 border-b border-gray-200">
                        <span className="text-xs font-medium text-reins-navy">OpenAI CLA / ChatGPT</span>
                        <button
                          onClick={async () => {
                            await navigator.clipboard.writeText(JSON.stringify(connectPrompt.openaiClawConfig, null, 2));
                            setCopiedConfig('openai');
                            setTimeout(() => setCopiedConfig(null), 2000);
                          }}
                          className={`flex items-center gap-1 text-xs px-2 py-0.5 rounded transition-all ${
                            copiedConfig === 'openai'
                              ? 'text-safe-green bg-safe-green/10'
                              : 'text-gray-400 hover:text-gray-600'
                          }`}
                        >
                          {copiedConfig === 'openai' ? (
                            <><Check className="w-3 h-3" /> Copied</>
                          ) : (
                            <><Copy className="w-3 h-3" /> Copy</>
                          )}
                        </button>
                      </div>
                      <pre className="px-4 py-3 text-[12px] leading-relaxed font-mono text-gray-600 bg-white overflow-x-auto">
                        {JSON.stringify(connectPrompt.openaiClawConfig, null, 2)}
                      </pre>
                    </div>
                  </div>
                </>
              ) : (
                <div className="text-center py-8">
                  <p className="text-gray-400 text-sm">Failed to load connection instructions.</p>
                </div>
              )}
            </div>

            {/* Footer */}
            <div className="flex justify-end px-6 py-3 border-t border-gray-100 bg-gray-50/50">
              <button
                onClick={() => setConnectAgentId(null)}
                className="px-4 py-2 text-sm text-gray-500 hover:text-gray-700 transition-colors"
              >
                Done
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Deploy Modal */}
      {deployAgentId && (
        <DeploymentPanel
          agentId={deployAgentId}
          agentName={
            (agentsList as any[])?.find((a: any) => a.id === deployAgentId)?.name || 'Agent'
          }
          onClose={() => setDeployAgentId(null)}
        />
      )}
    </div>
  );
}
