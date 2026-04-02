import { useState, useEffect } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import {
  Plus,
  Trash2,
  Power,
  PowerOff,
  Key,
  X,
  Radio,
  Rocket,
  Loader2,
} from 'lucide-react';
import { agents, type PendingRegistration } from '../api/client';
import { DeploymentPanel } from '../components/DeploymentPanel';

interface Agent {
  id: string;
  name: string;
  description?: string;
  status: string;
  credentials: string[];
  createdAt: string;
}

export default function Agents() {
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const [deployAgentId, setDeployAgentId] = useState<string | null>(null);

  const { data: agentsList, isLoading } = useQuery<Agent[]>({
    queryKey: ['agents'],
    queryFn: agents.list as () => Promise<Agent[]>,
  });

  const { data: pendingList } = useQuery<PendingRegistration[]>({
    queryKey: ['agents', 'pending'],
    queryFn: agents.listPending,
    refetchInterval: 5000,
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

  const cancelPendingMutation = useMutation({
    mutationFn: agents.cancelPending,
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['agents', 'pending'] });
    },
  });


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
            onClick={() => navigate('/agents/new')}
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
            <p className="text-gray-500 font-medium">No agents yet</p>
            <p className="text-sm text-gray-400 mt-1 max-w-md mx-auto">
              Create your first agent to start managing AI tool access.
            </p>
            <button
              onClick={() => navigate('/agents/new')}
              className="mt-5 inline-flex items-center gap-2 bg-trust-blue text-white px-5 py-2.5 rounded-lg hover:bg-blue-600 transition-all text-sm font-medium shadow-sm shadow-trust-blue/20"
            >
              <Plus className="w-4 h-4" />
              Create Agent
            </button>
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
                      <Link to={`/agents/${agent.id}`} className="font-medium text-reins-navy hover:text-trust-blue transition-colors">{agent.name}</Link>
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
                      disabled={deleteMutation.isPending && deleteMutation.variables === agent.id}
                      className="p-1.5 text-gray-300 hover:text-alert-red transition-colors opacity-0 group-hover:opacity-100 disabled:opacity-50 disabled:cursor-not-allowed"
                      title="Delete"
                    >
                      {deleteMutation.isPending && deleteMutation.variables === agent.id ? (
                        <Loader2 className="w-4 h-4 animate-spin" />
                      ) : (
                        <Trash2 className="w-4 h-4" />
                      )}
                    </button>
                  </div>
                </div>
              </div>
            );
          })}
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
