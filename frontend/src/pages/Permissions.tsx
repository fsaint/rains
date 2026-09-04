import { useState, useEffect } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import {
  permissions,
  agents,
  credentials,
  ApiError,
  type ServiceType,
  type ToolPermission,
  type PermissionLevel,
  type PendingRegistration,
  type DrivePathConfig,
  type DrivePathRule,
  type HermeneutixInstanceConfig,
  skills as skillsApi,
} from '../api/client';
import {
  Mail,
  HardDrive,
  Calendar,
  Search,
  Globe,
  CheckCircle,
  AlertCircle,
  X,
  Key,
  Shield,
  ChevronDown,
  ChevronRight,
  Plus,
  Trash2,
  Tag,
  Rocket,
  Power,
  PowerOff,
  Loader2,
  Radio,
  Send,
  ShieldAlert,
  ShieldCheck,
} from 'lucide-react';
import { DeploymentPanel } from '../components/DeploymentPanel';
import AgentSkillToggles from '../components/AgentSkillToggles';

/**
 * Kept in step with ADMIN_SERVICE_TYPE in backend/src/services/permissions.ts,
 * which is where the rule is enforced. This copy only decides what the picker
 * says before the click.
 */
const ADMIN_SERVICE_TYPE = 'helm-admin';

const serviceIcons: Record<string, React.ReactNode> = {
  gmail: <Mail className="w-5 h-5" />,
  drive: <HardDrive className="w-5 h-5" />,
  calendar: <Calendar className="w-5 h-5" />,
  'web-search': <Search className="w-5 h-5" />,
  browser: <Globe className="w-5 h-5" />,
  [ADMIN_SERVICE_TYPE]: <ShieldCheck className="w-5 h-5" />,
};

const permissionColors: Record<ToolPermission, string> = {
  allow: 'bg-safe-green/10 text-safe-green border-safe-green/30',
  block: 'bg-alert-red/10 text-alert-red border-alert-red/30',
  require_approval: 'bg-caution-amber/10 text-caution-amber border-caution-amber/30',
};

const credentialStatusColors: Record<string, string> = {
  connected: 'text-safe-green',
  missing: 'text-gray-400',
  expired: 'text-alert-red',
  not_linked: 'text-gray-400',
};

const permissionLevelBadge: Record<PermissionLevel, { label: string; color: string }> = {
  none: { label: 'Off', color: 'bg-gray-100 text-gray-500' },
  read: { label: 'Read Only', color: 'bg-trust-blue/10 text-trust-blue' },
  full: { label: 'Read + Write', color: 'bg-safe-green/10 text-safe-green' },
  custom: { label: 'Custom', color: 'bg-caution-amber/10 text-caution-amber' },
};

const permissionLevelDescriptions: Record<PermissionLevel, { label: string; description: string }> = {
  none: { label: 'Off', description: 'Service disabled for this agent' },
  read: { label: 'Read Only', description: 'Can view and search — no modifications allowed' },
  full: { label: 'Read + Write (with approval)', description: 'Reads are automatic. Writes go to the approval queue for your review.' },
  custom: { label: 'Custom', description: 'Individual tool permissions configured manually' },
};

const servicePermissionDetails: Record<ServiceType, { read: string; full: string }> = {
  gmail: {
    read: 'List, read, and search emails',
    full: 'Read emails freely. Creating drafts and sending require your approval.',
  },
  drive: {
    read: 'List, read, and search files',
    full: 'Read files freely. Creating and updating files require your approval.',
  },
  calendar: {
    read: 'List, view, and search events',
    full: 'View events freely. Creating and updating events require your approval.',
  },
  'web-search': {
    read: 'Search the web',
    full: 'Full search access',
  },
  browser: {
    read: 'Navigate pages and take screenshots',
    full: 'Navigate freely. Clicking and typing require your approval.',
  },
};

export default function Permissions() {
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const [expandedAgents, setExpandedAgents] = useState<Set<string>>(new Set());
  const [selectedInstance, setSelectedInstance] = useState<string | null>(null);
  const [addServiceAgent, setAddServiceAgent] = useState<{
    agentId: string;
    agentName: string;
    instances: Array<{ id: string; serviceType: string; credentialId: string | null }>;
  } | null>(null);
  const [deployAgentId, setDeployAgentId] = useState<string | null>(null);

  const { data: agentPerms, isLoading } = useQuery({
    queryKey: ['permissions', 'agents'],
    queryFn: permissions.getAgentPermissions,
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
      queryClient.invalidateQueries({ queryKey: ['permissions'] });
    },
  });

  const updateMutation = useMutation({
    mutationFn: ({ id, data }: { id: string; data: { status: string } }) => agents.update(id, data),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['agents'] });
      queryClient.invalidateQueries({ queryKey: ['permissions'] });
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

  // Skills and Memory never sign in, so "no account" is not a gap for them.
  const serviceNeedsAccount = (serviceType: string) =>
    agentPerms?.availableServices.find((s) => s.type === serviceType)?.authRequired ?? true;

  const toggleAgent = (agentId: string) => {
    setExpandedAgents((prev) => {
      const next = new Set(prev);
      if (next.has(agentId)) next.delete(agentId);
      else next.add(agentId);
      return next;
    });
  };

  if (isLoading) {
    return (
      <div className="p-8 max-w-6xl">
        <div className="flex items-center justify-center py-12">
          <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-trust-blue"></div>
        </div>
      </div>
    );
  }

  const hasAgents = agentPerms && agentPerms.agents.length > 0;
  const hasPending = pendingList && pendingList.length > 0;

  if (!hasAgents && !hasPending) {
    return (
      <div className="p-8 max-w-6xl">
        <div className="flex items-end justify-between mb-8">
          <div>
            <h1 className="text-2xl font-semibold text-reins-navy tracking-tight">Agents</h1>
            <p className="text-gray-400 mt-1 text-sm">Manage AI agents, their services, and permissions</p>
          </div>
          <button
            onClick={() => navigate('/agents/new')}
            className="flex items-center gap-2 bg-trust-blue text-white px-4 py-2 rounded-lg hover:bg-blue-600 transition-all text-sm font-medium shadow-sm shadow-trust-blue/20"
          >
            <Plus className="w-4 h-4" />
            Add Agent
          </button>
        </div>
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
      </div>
    );
  }

  // Check if any instance has missing credentials
  const hasMissingCreds = hasAgents && agentPerms.agents.some((a) =>
    a.instances.some(
      (i) => i.enabled && (i.credentialStatus === 'missing' || i.credentialStatus === 'not_linked')
    )
  );

  return (
    <div className="p-4 sm:p-8 max-w-6xl">
      <div className="flex flex-col sm:flex-row sm:items-end sm:justify-between gap-4 mb-6 sm:mb-8">
        <div>
          <h1 className="text-2xl font-semibold text-reins-navy tracking-tight">Agents</h1>
          <p className="text-gray-400 mt-1 text-sm">Manage AI agents, their services, and permissions</p>
        </div>
        <button
          onClick={() => navigate('/agents/new')}
          className="flex items-center gap-2 bg-trust-blue text-white px-4 py-2 rounded-lg hover:bg-blue-600 transition-all text-sm font-medium shadow-sm shadow-trust-blue/20 self-start sm:self-auto"
        >
          <Plus className="w-4 h-4" />
          Add Agent
        </button>
      </div>

      {/* Pending Registrations */}
      {hasPending && (
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
            {pendingList!.map((pending) => (
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
                    className="text-gray-300 hover:text-alert-red transition-colors sm:opacity-0 sm:group-hover:opacity-100 shrink-0 ml-2"
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

      {/* Legend */}
      <div className="flex flex-wrap gap-x-6 gap-y-2 mb-6 text-sm">
        <div className="flex items-center gap-2">
          <div className="w-4 h-4 rounded bg-safe-green/20 border border-safe-green/30"></div>
          <span className="text-gray-600">Active</span>
        </div>
        <div className="flex items-center gap-2">
          <div className="w-4 h-4 rounded bg-caution-amber/20 border border-caution-amber/30"></div>
          <span className="text-gray-600">Needs Credential</span>
        </div>
        <div className="flex items-center gap-2">
          <div className="w-4 h-4 rounded bg-alert-red/20 border border-alert-red/30"></div>
          <span className="text-gray-600">Expired</span>
        </div>
        <div className="flex items-center gap-2">
          <div className="w-4 h-4 rounded bg-gray-100 border border-gray-200"></div>
          <span className="text-gray-600">Disabled</span>
        </div>
      </div>

      {/* Credential Warning Banner */}
      {hasMissingCreds && (
        <div className="mb-4 bg-caution-amber/5 border border-caution-amber/20 rounded-xl px-5 py-3 flex items-center justify-between">
          <div className="flex items-center gap-3">
            <AlertCircle className="w-5 h-5 text-caution-amber shrink-0" />
            <p className="text-sm text-gray-600">
              Some enabled services are missing credentials. Agents won&apos;t be able to use them until authenticated.
            </p>
          </div>
          <Link
            to="/credentials"
            className="shrink-0 text-sm font-medium text-trust-blue hover:text-blue-700"
          >
            Set up credentials
          </Link>
        </div>
      )}

      {/* Per-Agent Sections */}
      <div className="space-y-4">
        {agentPerms?.agents.map((agent) => {
          const isExpanded = expandedAgents.has(agent.id);
          return (
            <div
              key={agent.id}
              className="bg-white rounded-xl shadow-sm border border-gray-100 overflow-hidden"
            >
              {/* Agent Header */}
              <div className="group flex items-center justify-between px-6 py-4 hover:bg-gray-50/50">
                <button
                  onClick={() => toggleAgent(agent.id)}
                  className="flex items-center gap-3 flex-1 min-w-0"
                >
                  {isExpanded ? (
                    <ChevronDown className="w-4 h-4 text-gray-400 shrink-0" />
                  ) : (
                    <ChevronRight className="w-4 h-4 text-gray-400 shrink-0" />
                  )}
                  <div className="text-left min-w-0">
                    <div className="flex items-center gap-2">
                      <span className="font-medium text-reins-navy">{agent.name}</span>
                      <span
                        className={`text-[10px] font-medium uppercase tracking-wider px-1.5 py-0.5 rounded ${
                          agent.status === 'active'
                            ? 'bg-safe-green/8 text-safe-green'
                            : 'bg-gray-100 text-gray-400'
                        }`}
                      >
                        {agent.status}
                      </span>
                    </div>
                    <div className="text-xs text-gray-400 mt-0.5">
                      {agent.instances.length === 0
                        ? 'No services'
                        : `${agent.instances.length} service${agent.instances.length !== 1 ? 's' : ''}`}
                    </div>
                  </div>
                </button>
                <div className="flex items-center gap-1 shrink-0">
                  {/* Telegram bot link */}
                  {agent.telegramBotUsername && (
                    <a
                      href={`https://t.me/${agent.telegramBotUsername}`}
                      target="_blank"
                      rel="noopener noreferrer"
                      onClick={(e) => e.stopPropagation()}
                      className="hidden sm:flex items-center gap-1.5 mr-2 text-xs text-trust-blue hover:text-blue-600 transition-colors"
                      title="Open in Telegram"
                    >
                      <Send className="w-3.5 h-3.5" />
                      <span>@{agent.telegramBotUsername}</span>
                    </a>
                  )}
                  {/* Service type icons summary */}
                  <div className="hidden sm:flex items-center gap-1.5 mr-3">
                    {[...new Set(agent.instances.map((i) => i.serviceType))].map((st) => (
                      <div key={st} className="text-gray-300">
                        {serviceIcons[st] ?? <Globe className="w-4 h-4" />}
                      </div>
                    ))}
                  </div>
                  {/* Deploy */}
                  <button
                    onClick={(e) => { e.stopPropagation(); setDeployAgentId(agent.id); }}
                    className="flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium text-emerald-600 bg-emerald-50 hover:bg-emerald-100 border border-emerald-100 rounded-lg transition-all"
                    title="Deploy to Fly.io or Docker"
                  >
                    <Rocket className="w-3.5 h-3.5" />
                    Deploy
                  </button>
                  {/* Activate / Suspend */}
                  {agent.status === 'active' ? (
                    <button
                      onClick={(e) => { e.stopPropagation(); updateMutation.mutate({ id: agent.id, data: { status: 'suspended' } }); }}
                      className="p-1.5 text-gray-300 hover:text-caution-amber transition-colors sm:opacity-0 sm:group-hover:opacity-100"
                      title="Suspend"
                    >
                      <PowerOff className="w-4 h-4" />
                    </button>
                  ) : (
                    <button
                      onClick={(e) => { e.stopPropagation(); updateMutation.mutate({ id: agent.id, data: { status: 'active' } }); }}
                      className="p-1.5 text-gray-300 hover:text-safe-green transition-colors sm:opacity-0 sm:group-hover:opacity-100"
                      title="Activate"
                    >
                      <Power className="w-4 h-4" />
                    </button>
                  )}
                  {/* Delete */}
                  <button
                    onClick={(e) => { e.stopPropagation(); deleteMutation.mutate(agent.id); }}
                    disabled={deleteMutation.isPending && deleteMutation.variables === agent.id}
                    className="p-1.5 text-gray-300 hover:text-alert-red transition-colors sm:opacity-0 sm:group-hover:opacity-100 disabled:opacity-50 disabled:cursor-not-allowed"
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

              {/* Expanded: Instance Cards */}
              {isExpanded && (
                <div className="border-t border-gray-100 px-6 py-4 space-y-3">
                  {agent.instances.length === 0 && (
                    <p className="text-sm text-gray-400 text-center py-4">
                      No services added yet. Click &quot;Add Service&quot; to get started.
                    </p>
                  )}

                  {agent.instances.map((instance) => {
                    const statusColor =
                      !instance.enabled
                        ? 'border-gray-200'
                        : instance.credentialStatus === 'connected'
                          ? 'border-safe-green/30'
                          : instance.credentialStatus === 'expired'
                            ? 'border-alert-red/30'
                            : 'border-caution-amber/30';

                    const statusDot =
                      !instance.enabled
                        ? 'bg-gray-300'
                        : instance.credentialStatus === 'connected'
                          ? 'bg-safe-green'
                          : instance.credentialStatus === 'expired'
                            ? 'bg-alert-red'
                            : 'bg-caution-amber';

                    const badge = permissionLevelBadge[instance.permissionLevel];

                    return (
                      <button
                        key={instance.id}
                        onClick={() => setSelectedInstance(instance.id)}
                        className={`w-full flex items-center gap-4 p-4 rounded-lg border-2 transition-all hover:shadow-sm ${statusColor}`}
                      >
                        {/* Service Icon */}
                        <div className="p-2 bg-gray-50 rounded-lg text-gray-500 shrink-0">
                          {serviceIcons[instance.serviceType] ?? <Globe className="w-5 h-5" />}
                        </div>

                        {/* Info */}
                        <div className="flex-1 min-w-0 text-left">
                          <div className="flex items-center gap-2">
                            <span className="font-medium text-sm text-reins-navy truncate">
                              {instance.label || instance.serviceName}
                            </span>
                            {instance.isDefault && (
                              <span className="text-[10px] font-medium text-trust-blue bg-trust-blue/10 px-1.5 py-0.5 rounded">
                                Default
                              </span>
                            )}
                          </div>
                          <div className="text-xs text-gray-400 truncate mt-0.5">
                            {serviceNeedsAccount(instance.serviceType)
                              ? (instance.credentialEmail || 'No account linked')
                              : 'No sign-in needed'}
                          </div>
                          {typeof instance.config?.projectName === 'string' && (
                            <div className="text-xs text-gray-500 truncate mt-0.5">
                              Project: {instance.config.projectName}
                            </div>
                          )}
                        </div>

                        {/* Permission Level Badge */}
                        <span className={`text-xs font-medium px-2 py-1 rounded shrink-0 ${badge.color}`}>
                          {badge.label}
                        </span>

                        {/* Status Dot */}
                        <div className={`w-2.5 h-2.5 rounded-full shrink-0 ${statusDot}`} />
                      </button>
                    );
                  })}

                  {/* Add Service Button */}
                  <button
                    onClick={(e) => {
                      e.stopPropagation();
                      setAddServiceAgent({
                        agentId: agent.id,
                        agentName: agent.name,
                        // Needed to turn off a conflicting service by instance
                        // id when Helm Admin is refused next to one.
                        instances: agent.instances.map((i) => ({
                          id: i.id,
                          serviceType: i.serviceType,
                          credentialId: i.credentialId,
                        })),
                      });
                    }}
                    className="w-full flex items-center justify-center gap-2 p-3 rounded-lg border-2 border-dashed border-gray-200 text-sm font-medium text-gray-400 hover:text-trust-blue hover:border-trust-blue/30 transition-colors"
                  >
                    <Plus className="w-4 h-4" />
                    Add Service
                  </button>

                  {/* Skills depending on these services — shown here because
                      this is where a user disabling a service is looking. */}
                  <AgentSkillsStrip agentId={agent.id} />
                </div>
              )}
            </div>
          );
        })}
      </div>

      {/* Instance Config Modal */}
      {selectedInstance && (
        <InstanceConfigModal
          instanceId={selectedInstance}
          authRequired={serviceNeedsAccount}
          onClose={() => setSelectedInstance(null)}
          onUpdate={() => {
            queryClient.invalidateQueries({ queryKey: ['permissions'] });
          }}
        />
      )}

      {/* Add Service Modal */}
      {addServiceAgent && (
        <AddServiceModal
          agentId={addServiceAgent.agentId}
          agentName={addServiceAgent.agentName}
          agentInstances={addServiceAgent.instances}
          availableServices={agentPerms!.availableServices}
          onClose={() => setAddServiceAgent(null)}
          onAdded={() => {
            queryClient.invalidateQueries({ queryKey: ['permissions'] });
            setAddServiceAgent(null);
          }}
        />
      )}

      {/* Deploy Modal */}
      {deployAgentId && (
        <DeploymentPanel
          agentId={deployAgentId}
          agentName={
            agentPerms?.agents.find((a) => a.id === deployAgentId)?.name || 'Agent'
          }
          onClose={() => setDeployAgentId(null)}
        />
      )}
    </div>
  );
}

// ============================================================================
// Add Service Modal
// ============================================================================

interface AddServiceModalProps {
  agentId: string;
  agentName: string;
  agentInstances: Array<{ id: string; serviceType: string; credentialId: string | null }>;
  availableServices: Array<{ type: string; name: string; icon: string; authRequired: boolean }>;
  onClose: () => void;
  onAdded: () => void;
}

/**
 * What the backend refused, and enough context to offer the fix.
 *
 * Two distinct refusals land here. A combination conflict is resolvable in
 * place — turn the named services off and retry. Open MCP endpoints are not:
 * they are fixed on each agent's deployment panel, so this only explains.
 */
type AddServiceConflict =
  | { kind: 'combination'; serviceType: string; credentialId?: string; message: string; conflicting: string[] }
  | { kind: 'openEndpoints'; message: string; openAgents: Array<{ id: string; name: string }> };

function AddServiceModal({
  agentId, agentName, agentInstances, availableServices, onClose, onAdded,
}: AddServiceModalProps) {
  const navigate = useNavigate();
  const [conflict, setConflict] = useState<AddServiceConflict | null>(null);
  // Set while the user is choosing which of several accounts a service should use.
  const [accountPick, setAccountPick] = useState<{ serviceType: string; credentialId: string } | null>(null);
  // Set while the user is choosing which project Hermeneutix should be pinned to.
  // `projectId: null` is "All projects" — the instance is created without config.
  const [projectPick, setProjectPick] = useState<{ credentialId?: string; projectId: string | null } | null>(null);

  const createInstanceMutation = useMutation({
    mutationFn: ({ serviceType, credentialId, config }: {
      serviceType: string;
      credentialId?: string;
      config?: Record<string, unknown>;
    }) => permissions.createInstance(agentId, serviceType, undefined, credentialId, config),
    onSuccess: () => onAdded(),
    onError: (err: unknown, { serviceType, credentialId }) => {
      if (!(err instanceof ApiError)) return;
      const details = (err.details ?? {}) as {
        conflicting?: string[];
        openAgents?: Array<{ id: string; name: string }>;
      };
      if (err.code === 'SERVICE_COMBINATION_NOT_ALLOWED') {
        setConflict({
          kind: 'combination',
          serviceType,
          credentialId,
          message: err.message,
          conflicting: details.conflicting ?? [],
        });
      } else if (err.code === 'UNAUTHENTICATED_ENDPOINTS_OPEN') {
        setConflict({
          kind: 'openEndpoints',
          message: err.message,
          openAgents: details.openAgents ?? [],
        });
      }
    },
  });

  /**
   * Turn off what is blocking, then add the service that was refused.
   *
   * Sequential rather than parallel: each delete re-evaluates the same guard on
   * the server, and a batch that half-applied would leave the agent in a state
   * neither the user nor the next retry expects.
   */
  const resolveConflictMutation = useMutation({
    mutationFn: async (c: Extract<AddServiceConflict, { kind: 'combination' }>) => {
      for (const serviceType of c.conflicting) {
        const instance = agentInstances.find((i) => i.serviceType === serviceType);
        if (instance) await permissions.deleteInstance(instance.id);
        // The guard also counts the legacy per-service access row, which can
        // stay enabled with no instance left. Turn it off too, or the retry
        // meets the same refusal and this button can never clear it.
        await permissions.setServiceAccess(agentId, serviceType, false);
      }
      return permissions.createInstance(agentId, c.serviceType, undefined, c.credentialId);
    },
    onSuccess: () => {
      setConflict(null);
      onAdded();
    },
  });

  const serviceLabel = (type: string) =>
    availableServices.find((s) => s.type === type)?.name ?? type;

  const { data: allCredentials = [] } = useQuery({
    queryKey: ['credentials'],
    queryFn: () => credentials.list(),
  });

  function getMatchingCredentials(serviceType: string) {
    return allCredentials.filter(
      (c) => c.serviceId === serviceType || c.grantedServices?.includes(serviceType)
    );
  }

  /**
   * The accounts that could still be added: each account becomes its own
   * instance, so one already on this agent is not offered again — the server
   * would answer with the instance it already has, and the modal would close
   * as if something happened.
   */
  function getAvailableCredentials(serviceType: string) {
    const attached = new Set(
      agentInstances.filter((i) => i.serviceType === serviceType && i.credentialId).map((i) => i.credentialId)
    );
    return getMatchingCredentials(serviceType).filter((c) => !attached.has(c.id));
  }

  // Services that don't need credentials — always addable
  const noAuthServices = availableServices.filter((s) => !s.authRequired);
  // Services that need credentials and have one not yet on this agent
  const servicesWithCreds = availableServices.filter(
    (s) => s.authRequired && getAvailableCredentials(s.type).length > 0
  );
  // Services whose every connected account is already on this agent
  const servicesFullyAttached = availableServices.filter(
    (s) => s.authRequired && getMatchingCredentials(s.type).length > 0 && getAvailableCredentials(s.type).length === 0
  );
  // Services that need credentials but none connected yet
  const servicesNeedingCreds = availableServices.filter(
    (s) => s.authRequired && getMatchingCredentials(s.type).length === 0
  );

  /**
   * Add a service, asking which account first when there is more than one to
   * choose from. One account is not a guess; several would be, and a guess
   * the user then has to find and correct is worse than a question.
   */
  const addService = (serviceType: string) => {
    const available = getAvailableCredentials(serviceType);
    if (available.length > 1) {
      setAccountPick({ serviceType, credentialId: available[0].id });
      return;
    }
    confirmAccount(serviceType, available[0]?.id);
  };

  /**
   * The account is settled; create the instance — except Hermeneutix, which
   * asks one more question first: which project the instance is scoped to.
   */
  const confirmAccount = (serviceType: string, credentialId?: string) => {
    if (serviceType === HERMENEUTIX_SERVICE_TYPE) {
      setProjectPick({ credentialId, projectId: null });
      return;
    }
    createInstanceMutation.mutate({ serviceType, credentialId });
  };

  const serviceButton = (service: { type: string; name: string; icon: string }, badge?: React.ReactNode) => (
    <button
      key={service.type}
      onClick={() => addService(service.type)}
      disabled={createInstanceMutation.isPending}
      className="w-full flex items-center gap-3 p-4 rounded-lg border-2 border-gray-200 hover:border-trust-blue/30 hover:bg-trust-blue/5 transition-all disabled:opacity-50"
    >
      <div className="p-2 bg-gray-50 rounded-lg text-gray-500">
        {serviceIcons[service.type] ?? <Globe className="w-5 h-5" />}
      </div>
      <div className="text-left flex-1">
        <div className="font-medium text-sm text-reins-navy">{service.name}</div>
        {service.type === ADMIN_SERVICE_TYPE && (
          // Said before the click, not only in the error afterwards.
          <div className="text-xs text-amber-600 mt-0.5">
            Must be the only service on an agent (memory aside)
          </div>
        )}
      </div>
      {badge}
    </button>
  );

  // A refusal from the server outranks the picker it was raised from.
  if (projectPick && !conflict) {
    return (
      <HermeneutixProjectPickScreen
        agentId={agentId}
        agentName={agentName}
        pick={projectPick}
        onPick={(projectId) => setProjectPick({ ...projectPick, projectId })}
        onConfirm={(config) =>
          createInstanceMutation.mutate({
            serviceType: HERMENEUTIX_SERVICE_TYPE,
            credentialId: projectPick.credentialId,
            config,
          })
        }
        // Back lands on the account question when there was one to ask.
        onBack={() => setProjectPick(null)}
        pending={createInstanceMutation.isPending}
        error={createInstanceMutation.isError ? (createInstanceMutation.error as Error).message : null}
      />
    );
  }

  if (accountPick && !conflict) {
    const name = serviceLabel(accountPick.serviceType);
    const options = getAvailableCredentials(accountPick.serviceType);
    return (
      <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50">
        <div className="bg-white rounded-xl w-full max-w-md shadow-xl p-6">
          <div className="flex items-start gap-3 mb-4">
            <div className="p-2 bg-trust-blue/10 rounded-lg text-trust-blue shrink-0">
              <Key className="w-5 h-5" />
            </div>
            <div>
              <h2 className="text-lg font-semibold text-reins-navy">Which account should {name} use?</h2>
              <p className="text-sm text-gray-600 mt-1">
                {agentName} will act as this account. You can change it later in the service details.
              </p>
            </div>
          </div>

          <div className="space-y-2 mb-4">
            {options.map((cred) => {
              const isSelected = accountPick.credentialId === cred.id;
              return (
                <label
                  key={cred.id}
                  className={`flex items-center gap-3 p-3 rounded-lg border-2 cursor-pointer transition-all ${
                    isSelected ? 'border-trust-blue bg-trust-blue/5' : 'border-gray-200 hover:border-gray-300'
                  }`}
                >
                  <input
                    type="radio"
                    name="add-service-account"
                    checked={isSelected}
                    onChange={() => setAccountPick({ ...accountPick, credentialId: cred.id })}
                    className="h-4 w-4 text-trust-blue focus:ring-trust-blue"
                  />
                  <div className="flex-1 min-w-0">
                    <div className="font-medium text-sm text-reins-navy truncate">
                      {cred.accountEmail || cred.type}
                    </div>
                    {cred.accountName && (
                      <div className="text-xs text-gray-400 truncate">{cred.accountName}</div>
                    )}
                  </div>
                </label>
              );
            })}
          </div>

          <div className="flex gap-2">
            <button
              onClick={() => confirmAccount(accountPick.serviceType, accountPick.credentialId)}
              disabled={createInstanceMutation.isPending}
              className="flex-1 bg-trust-blue text-white px-4 py-2.5 rounded-lg text-sm font-semibold hover:bg-trust-blue/90 disabled:opacity-50"
            >
              {createInstanceMutation.isPending ? 'Adding…' : `Add ${name}`}
            </button>
            <button
              onClick={() => setAccountPick(null)}
              className="px-4 py-2.5 rounded-lg text-sm font-medium text-gray-500 hover:text-gray-700"
            >
              Back
            </button>
          </div>
          {createInstanceMutation.isError && (
            <p className="text-sm text-red-600 mt-3">
              {(createInstanceMutation.error as Error).message}
            </p>
          )}
        </div>
      </div>
    );
  }

  if (conflict) {
    return (
      <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50">
        <div className="bg-white rounded-xl w-full max-w-md shadow-xl p-6">
          <div className="flex items-start gap-3 mb-4">
            <div className="p-2 bg-amber-50 rounded-lg text-amber-600 shrink-0">
              <ShieldAlert className="w-5 h-5" />
            </div>
            <div>
              <h2 className="text-lg font-semibold text-reins-navy">
                {conflict.kind === 'combination' ? 'These cannot share an agent' : 'Close these endpoints first'}
              </h2>
              <p className="text-sm text-gray-600 mt-1">{conflict.message}</p>
            </div>
          </div>

          {conflict.kind === 'combination' ? (
            <>
              <div className="bg-gray-50 rounded-lg p-3 mb-4">
                <p className="text-xs font-semibold text-gray-400 uppercase tracking-wider mb-2">
                  Would be turned off
                </p>
                <ul className="text-sm text-reins-navy space-y-1">
                  {conflict.conflicting.map((type) => (
                    <li key={type}>{serviceLabel(type)}</li>
                  ))}
                </ul>
              </div>
              <div className="flex gap-2">
                <button
                  onClick={() => resolveConflictMutation.mutate(conflict)}
                  disabled={resolveConflictMutation.isPending}
                  className="flex-1 bg-trust-blue text-white px-4 py-2.5 rounded-lg text-sm font-semibold hover:bg-trust-blue/90 disabled:opacity-50"
                >
                  {resolveConflictMutation.isPending
                    ? 'Applying…'
                    : `Turn those off and add ${serviceLabel(conflict.serviceType)}`}
                </button>
                <button
                  onClick={() => setConflict(null)}
                  className="px-4 py-2.5 rounded-lg text-sm font-medium text-gray-500 hover:text-gray-700"
                >
                  Cancel
                </button>
              </div>
              {resolveConflictMutation.isError && (
                <p className="text-sm text-red-600 mt-3">
                  {(resolveConflictMutation.error as Error).message}
                </p>
              )}
            </>
          ) : (
            <>
              <div className="bg-gray-50 rounded-lg p-3 mb-4">
                <p className="text-xs font-semibold text-gray-400 uppercase tracking-wider mb-2">
                  Still open
                </p>
                <ul className="text-sm text-reins-navy space-y-1">
                  {conflict.openAgents.map((a) => (
                    <li key={a.id}>{a.name}</li>
                  ))}
                </ul>
                <p className="text-xs text-gray-500 mt-2">
                  Open each one's Deploy panel and turn off unauthenticated access.
                </p>
              </div>
              <button
                onClick={() => setConflict(null)}
                className="w-full px-4 py-2.5 rounded-lg text-sm font-medium border border-gray-200 text-gray-600 hover:bg-gray-50"
              >
                Back
              </button>
            </>
          )}
        </div>
      </div>
    );
  }

  return (
    <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50">
      <div className="bg-white rounded-xl w-full max-w-md shadow-xl flex flex-col max-h-[90vh]">
        <div className="flex items-center justify-between p-6 pb-4 flex-shrink-0">
          <div>
            <h2 className="text-lg font-semibold text-reins-navy">Add Service</h2>
            <p className="text-sm text-gray-500">Choose a service to add to {agentName}</p>
          </div>
          <button onClick={onClose} className="text-gray-400 hover:text-gray-600">
            <X className="w-5 h-5" />
          </button>
        </div>

        <div className="space-y-2 overflow-y-auto px-6 pb-6">
          {noAuthServices.length > 0 && (
            <>
              <p className="text-xs font-semibold text-gray-400 uppercase tracking-wider px-1 pb-1">
                No sign-in required
              </p>
              {noAuthServices.map((service) => serviceButton(service))}
            </>
          )}

          {noAuthServices.length > 0 && (servicesWithCreds.length > 0 || servicesFullyAttached.length > 0) && (
            <div className="flex items-center gap-2 py-2">
              <div className="flex-1 border-t border-gray-100" />
              <span className="text-xs text-gray-400">Connected accounts</span>
              <div className="flex-1 border-t border-gray-100" />
            </div>
          )}

          {(servicesWithCreds.length > 0 || servicesFullyAttached.length > 0) && noAuthServices.length === 0 && (
            <p className="text-xs font-semibold text-gray-400 uppercase tracking-wider px-1 pb-1">
              Connected accounts
            </p>
          )}

          {servicesWithCreds.map((service) => {
            const count = getAvailableCredentials(service.type).length;
            return serviceButton(service,
              <span className="flex items-center gap-1 text-xs font-medium text-safe-green bg-safe-green/10 px-2 py-0.5 rounded-full">
                <span className="w-1.5 h-1.5 rounded-full bg-safe-green inline-block" />
                {count} account{count !== 1 ? 's' : ''}
              </span>
            );
          })}

          {servicesFullyAttached.map((service) => {
            const count = getMatchingCredentials(service.type).length;
            return (
              <div
                key={service.type}
                className="w-full flex items-center gap-3 p-4 rounded-lg border-2 border-dashed border-gray-200 bg-gray-50/50"
              >
                <div className="p-2 bg-gray-100 rounded-lg text-gray-400">
                  {serviceIcons[service.type] ?? <Globe className="w-5 h-5" />}
                </div>
                <div className="text-left flex-1">
                  <div className="font-medium text-sm text-gray-400">{service.name}</div>
                  <div className="text-xs text-gray-400">
                    {count === 1 ? 'Already connected' : `All ${count} accounts already connected`}
                  </div>
                </div>
                <button
                  onClick={() => { onClose(); navigate(`/credentials?connect=${service.type}`); }}
                  className="text-xs font-medium text-trust-blue hover:underline whitespace-nowrap"
                >
                  Connect another →
                </button>
              </div>
            );
          })}

          {servicesNeedingCreds.length > 0 && (servicesWithCreds.length > 0 || servicesFullyAttached.length > 0 || noAuthServices.length > 0) && (
            <div className="flex items-center gap-2 py-2">
              <div className="flex-1 border-t border-gray-100" />
              <span className="text-xs text-gray-400">No credentials yet</span>
              <div className="flex-1 border-t border-gray-100" />
            </div>
          )}

          {servicesNeedingCreds.map((service) => (
            <div
              key={service.type}
              className="w-full flex items-center gap-3 p-4 rounded-lg border-2 border-dashed border-gray-200 bg-gray-50/50"
            >
              <div className="p-2 bg-gray-100 rounded-lg text-gray-400">
                {serviceIcons[service.type] ?? <Globe className="w-5 h-5" />}
              </div>
              <div className="text-left flex-1">
                <div className="font-medium text-sm text-gray-400">{service.name}</div>
              </div>
              <button
                onClick={() => { onClose(); navigate('/credentials'); }}
                className="text-xs font-medium text-trust-blue hover:underline whitespace-nowrap"
              >
                Add Credential →
              </button>
            </div>
          ))}
        </div>

        <div className="flex justify-end px-6 py-4 border-t border-gray-100 flex-shrink-0">
          <button
            onClick={onClose}
            className="px-4 py-2 text-sm font-medium text-gray-700 bg-gray-100 rounded-lg hover:bg-gray-200"
          >
            Cancel
          </button>
        </div>
      </div>
    </div>
  );
}

// ============================================================================
// Instance Config Modal
// ============================================================================

interface InstanceConfigModalProps {
  instanceId: string;
  /** Whether a service type signs in to an account — no-auth services get no Account section. */
  authRequired: (serviceType: string) => boolean;
  onClose: () => void;
  onUpdate: () => void;
}

function InstanceConfigModal({ instanceId, authRequired, onClose, onUpdate }: InstanceConfigModalProps) {
  const queryClient = useQueryClient();
  const [showAdvanced, setShowAdvanced] = useState(false);
  const [editingLabel, setEditingLabel] = useState(false);
  const [labelValue, setLabelValue] = useState('');

  const { data: config, isLoading } = useQuery({
    queryKey: ['permissions', 'instance', instanceId],
    queryFn: () => permissions.getInstanceConfig(instanceId),
  });

  const { data: availableCredentials } = useQuery({
    queryKey: ['permissions', 'credentials', config?.serviceType],
    queryFn: () => permissions.getServiceCredentials(config!.serviceType),
    enabled: !!config,
  });

  const setLevelMutation = useMutation({
    mutationFn: (level: PermissionLevel) => permissions.setInstanceLevel(instanceId, level),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['permissions'] });
      onUpdate();
    },
  });

  const updateInstanceMutation = useMutation({
    mutationFn: (data: { label?: string; credentialId?: string; enabled?: boolean; config?: Record<string, unknown> | null }) =>
      permissions.updateInstance(instanceId, data),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['permissions'] });
      onUpdate();
    },
  });

  const deleteInstanceMutation = useMutation({
    mutationFn: () => permissions.deleteInstance(instanceId),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['permissions'] });
      onUpdate();
      onClose();
    },
  });

  const setToolPermissionMutation = useMutation({
    mutationFn: ({ toolName, permission }: { toolName: string; permission: ToolPermission }) =>
      permissions.setInstanceToolPermission(instanceId, toolName, permission),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['permissions'] });
      onUpdate();
    },
  });

  const currentLevel = config?.permissionLevel || 'none';

  return (
    <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50">
      <div className="bg-white rounded-xl p-6 w-full max-w-2xl shadow-xl max-h-[90vh] overflow-y-auto">
        <div className="flex items-center justify-between mb-6">
          <div className="flex items-center gap-3">
            <div className="p-2 bg-trust-blue/10 rounded-lg text-trust-blue">
              {config ? (serviceIcons[config.serviceType] ?? <Globe className="w-5 h-5" />) : null}
            </div>
            <div>
              {editingLabel && config ? (
                <div className="flex items-center gap-2">
                  <input
                    type="text"
                    value={labelValue}
                    onChange={(e) => setLabelValue(e.target.value)}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter') {
                        updateInstanceMutation.mutate({ label: labelValue });
                        setEditingLabel(false);
                      }
                      if (e.key === 'Escape') setEditingLabel(false);
                    }}
                    className="text-lg font-semibold text-reins-navy border border-trust-blue rounded px-2 py-0.5 focus:outline-none focus:ring-2 focus:ring-trust-blue/30"
                    autoFocus
                  />
                  <button
                    onClick={() => {
                      updateInstanceMutation.mutate({ label: labelValue });
                      setEditingLabel(false);
                    }}
                    className="text-xs text-trust-blue"
                  >
                    Save
                  </button>
                </div>
              ) : (
                <h2
                  className="text-lg font-semibold text-reins-navy cursor-pointer hover:text-trust-blue flex items-center gap-1"
                  onClick={() => {
                    if (config) {
                      setLabelValue(config.label || config.serviceName);
                      setEditingLabel(true);
                    }
                  }}
                >
                  {config?.label || config?.serviceName || 'Loading...'}
                  <Tag className="w-3.5 h-3.5 text-gray-300" />
                </h2>
              )}
              <p className="text-sm text-gray-500">
                {config?.credentialEmail || 'Configure access and permissions'}
              </p>
            </div>
          </div>
          <button onClick={onClose} className="text-gray-400 hover:text-gray-600">
            <X className="w-5 h-5" />
          </button>
        </div>

        {isLoading ? (
          <div className="flex items-center justify-center py-12">
            <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-trust-blue"></div>
          </div>
        ) : config ? (
          <div className="space-y-6">
            {/* Permission Level Selector */}
            <div className="p-4 bg-gray-50 rounded-lg">
              <div className="flex items-center gap-3 mb-4">
                <Shield className="w-5 h-5 text-gray-400" />
                <div>
                  <div className="font-medium text-reins-navy">Permission Level</div>
                  <div className="text-sm text-gray-500">
                    Choose what this agent can do with this service
                  </div>
                </div>
              </div>

              <div className="space-y-2">
                {(['none', 'read', 'full'] as const).map((level) => {
                  const getDescription = () => {
                    if (level === 'none') return permissionLevelDescriptions.none.description;
                    const serviceDetails = servicePermissionDetails[config.serviceType];
                    if (serviceDetails && (level === 'read' || level === 'full')) {
                      return serviceDetails[level];
                    }
                    return permissionLevelDescriptions[level].description;
                  };

                  return (
                    <label
                      key={level}
                      className={`flex items-start gap-3 p-3 rounded-lg cursor-pointer transition-colors ${
                        currentLevel === level
                          ? 'bg-trust-blue/10 border-2 border-trust-blue'
                          : 'bg-white border-2 border-gray-200 hover:border-gray-300'
                      } ${setLevelMutation.isPending ? 'opacity-50 cursor-wait' : ''}`}
                    >
                      <input
                        type="radio"
                        name="permissionLevel"
                        value={level}
                        checked={currentLevel === level}
                        onChange={() => setLevelMutation.mutate(level)}
                        disabled={setLevelMutation.isPending}
                        className="mt-1 h-4 w-4 text-trust-blue focus:ring-trust-blue"
                      />
                      <div className="flex-1">
                        <div className="font-medium text-reins-navy">
                          {permissionLevelDescriptions[level].label}
                        </div>
                        <div className="text-sm text-gray-500">{getDescription()}</div>
                      </div>
                      {currentLevel === level && !setLevelMutation.isPending && (
                        <CheckCircle className="w-5 h-5 text-trust-blue mt-0.5" />
                      )}
                      {currentLevel === level && setLevelMutation.isPending && (
                        <div className="w-5 h-5 border-2 border-trust-blue border-t-transparent rounded-full animate-spin mt-0.5" />
                      )}
                    </label>
                  );
                })}

                {currentLevel === 'custom' && (
                  <div className="flex items-start gap-3 p-3 rounded-lg bg-caution-amber/10 border-2 border-caution-amber">
                    <div className="mt-1 h-4 w-4 rounded-full border-2 border-caution-amber bg-caution-amber flex items-center justify-center">
                      <div className="w-2 h-2 rounded-full bg-white" />
                    </div>
                    <div className="flex-1">
                      <div className="font-medium text-reins-navy">
                        {permissionLevelDescriptions.custom.label}
                      </div>
                      <div className="text-sm text-gray-500">
                        {permissionLevelDescriptions.custom.description}
                      </div>
                    </div>
                    <AlertCircle className="w-5 h-5 text-caution-amber mt-0.5" />
                  </div>
                )}
              </div>
            </div>

            {/* Skills: pick what the agent can use, in place of an account */}
            {config.serviceType === 'skills' && (
              <AgentSkillToggles agentId={config.agentId} />
            )}

            {/* Credential / Account Section — only for services that sign in */}
            {currentLevel !== 'none' && authRequired(config.serviceType) && (
              <div className="p-4 bg-gray-50 rounded-lg">
                <div className="flex items-center gap-3 mb-3">
                  <Key className="w-5 h-5 text-gray-400" />
                  <div>
                    <div className="font-medium text-reins-navy">Account</div>
                    <div className="text-sm text-gray-500">
                      Which account should this instance use?
                    </div>
                  </div>
                </div>

                {availableCredentials && availableCredentials.length > 0 ? (
                  <div className="space-y-2 mt-2">
                    {availableCredentials.map((cred) => {
                      const isSelected = config.credentialId === cred.id;
                      return (
                        <button
                          key={cred.id}
                          onClick={() => {
                            if (!isSelected) {
                              updateInstanceMutation.mutate({ credentialId: cred.id });
                            }
                          }}
                          disabled={updateInstanceMutation.isPending}
                          className={`w-full flex items-center gap-3 p-3 rounded-lg border-2 transition-all ${
                            isSelected
                              ? 'border-trust-blue bg-trust-blue/5'
                              : 'border-gray-200 bg-white hover:border-gray-300'
                          } ${updateInstanceMutation.isPending ? 'opacity-50' : ''}`}
                        >
                          <div className={`w-4 h-4 rounded-full border-2 flex items-center justify-center ${
                            isSelected ? 'border-trust-blue bg-trust-blue' : 'border-gray-300'
                          }`}>
                            {isSelected && <div className="w-2 h-2 rounded-full bg-white" />}
                          </div>
                          <div className={`w-8 h-8 rounded-full flex items-center justify-center text-sm font-medium ${
                            isSelected ? 'bg-trust-blue text-white' : 'bg-gray-100 text-gray-400'
                          }`}>
                            {(cred.accountEmail || cred.type).charAt(0).toUpperCase()}
                          </div>
                          <div className="flex-1 min-w-0 text-left">
                            <div className="font-medium text-sm text-reins-navy truncate">
                              {cred.accountEmail || cred.type}
                            </div>
                            {cred.accountName && (
                              <div className="text-xs text-gray-400 truncate">{cred.accountName}</div>
                            )}
                          </div>
                          <span className={`text-xs ${credentialStatusColors[cred.status]}`}>
                            {cred.status}
                          </span>
                        </button>
                      );
                    })}
                    <Link
                      to={`/credentials?connect=${config.serviceType}`}
                      className="flex items-center justify-center gap-1.5 text-xs font-medium text-gray-400 hover:text-trust-blue py-2 transition-colors"
                    >
                      <Plus className="w-3 h-3" />
                      Connect another account
                    </Link>
                  </div>
                ) : (
                  <div className="mt-2 bg-caution-amber/5 border border-caution-amber/20 rounded-lg p-3">
                    <div className="flex items-start gap-2">
                      <AlertCircle className="w-4 h-4 text-caution-amber shrink-0 mt-0.5" />
                      <div>
                        <p className="text-sm font-medium text-caution-amber">
                          No accounts connected for {config.serviceName}
                        </p>
                        <p className="text-xs text-gray-500 mt-0.5">
                          Connect an account first so this agent can authenticate.
                        </p>
                        <Link
                          to={`/credentials?connect=${config.serviceType}`}
                          className="inline-flex items-center gap-1 text-xs font-medium text-trust-blue hover:text-blue-700 mt-2"
                        >
                          <Key className="w-3 h-3" />
                          Connect Account
                        </Link>
                      </div>
                    </div>
                  </div>
                )}
              </div>
            )}

            {/* Advanced: Individual Tool Permissions */}
            {currentLevel !== 'none' && config.tools && (
              <div className="border border-gray-200 rounded-lg">
                <button
                  onClick={() => setShowAdvanced(!showAdvanced)}
                  className="w-full flex items-center justify-between p-4 text-left hover:bg-gray-50"
                >
                  <div className="flex items-center gap-2">
                    {showAdvanced ? (
                      <ChevronDown className="w-4 h-4 text-gray-400" />
                    ) : (
                      <ChevronRight className="w-4 h-4 text-gray-400" />
                    )}
                    <span className="text-sm font-medium text-gray-700">
                      Advanced: Individual tool permissions
                    </span>
                  </div>
                  {currentLevel === 'custom' && (
                    <span className="text-xs text-caution-amber bg-caution-amber/10 px-2 py-1 rounded">
                      Custom configuration active
                    </span>
                  )}
                </button>

                {showAdvanced && (
                  <div className="border-t border-gray-200 p-4 space-y-2">
                    <p className="text-xs text-gray-500 mb-3">
                      Modifying individual tools will switch to custom configuration mode.
                    </p>
                    {config.tools.map((tool) => (
                      <div
                        key={tool.toolName}
                        className="flex items-center justify-between p-3 bg-gray-50 rounded-lg"
                      >
                        <div className="flex-1 min-w-0">
                          <div className="font-medium text-sm text-reins-navy truncate">
                            {tool.toolName}
                          </div>
                          <div className="text-xs text-gray-500 truncate">
                            {tool.description}
                          </div>
                        </div>
                        <div className="flex items-center gap-2 ml-4">
                          {!tool.isDefault && (
                            <span className="text-xs text-gray-400">(custom)</span>
                          )}
                          <select
                            value={tool.permission}
                            onChange={(e) =>
                              setToolPermissionMutation.mutate({
                                toolName: tool.toolName,
                                permission: e.target.value as ToolPermission,
                              })
                            }
                            disabled={setToolPermissionMutation.isPending}
                            className={`text-xs font-medium px-2 py-1 rounded border ${permissionColors[tool.permission]}`}
                          >
                            <option value="allow">Allow</option>
                            <option value="require_approval">Requires Approval</option>
                            <option value="block">Block</option>
                          </select>
                        </div>
                      </div>
                    ))}
                  </div>
                )}
              </div>
            )}

            {/* Drive: Path-Based Permissions */}
            {config.serviceType === 'drive' && currentLevel !== 'none' && (
              <DrivePathEditor agentId={config.agentId} />
            )}

            {/* Memory: which scopes this agent may reach */}
            {config.serviceType === 'memory' && currentLevel !== 'none' && (
              <MemoryScopeEditor agentId={config.agentId} />
            )}

            {/* Hermeneutix: which project this instance is pinned to */}
            {config.serviceType === HERMENEUTIX_SERVICE_TYPE && currentLevel !== 'none' && (
              <HermeneutixProjectEditor instance={config} />
            )}

            {/* Remove Instance */}
            <div className="pt-2">
              <button
                onClick={() => {
                  if (confirm('Remove this service instance? This cannot be undone.')) {
                    deleteInstanceMutation.mutate();
                  }
                }}
                disabled={deleteInstanceMutation.isPending}
                className="flex items-center gap-2 text-sm text-alert-red hover:text-red-700 transition-colors disabled:opacity-50"
              >
                <Trash2 className="w-4 h-4" />
                Remove this service
              </button>
            </div>
          </div>
        ) : (
          <p className="text-gray-500">Failed to load configuration</p>
        )}

        <div className="flex justify-end mt-6 pt-4 border-t border-gray-100">
          <button
            onClick={onClose}
            className="px-4 py-2 text-sm font-medium text-gray-700 bg-gray-100 rounded-lg hover:bg-gray-200"
          >
            Close
          </button>
        </div>
      </div>
    </div>
  );
}

// ============================================================================
// Hermeneutix project scope
// ============================================================================

const HERMENEUTIX_SERVICE_TYPE = 'hermeneutix';

/** Load the projects a Hermeneutix account can see; the same query backs both pickers. */
function useHermeneutixProjects(agentId: string, credentialId?: string | null, opts: { enabled?: boolean } = {}) {
  return useQuery({
    queryKey: ['permissions', agentId, 'hermeneutix-projects', credentialId ?? null],
    queryFn: () => permissions.listHermeneutixProjects(agentId, credentialId ?? undefined),
    enabled: opts.enabled ?? true,
  });
}

/**
 * Why the project list is unavailable, and the one fix the user can apply.
 *
 * Every cause seen so far — a stale token, a credential the server no longer
 * finds, an account already marked expired — is repaired the same way, by
 * reconnecting the account. So every message carries the link, not only the
 * token one; a bare "Credential not found" left users with nothing to do.
 */
function HermeneutixProjectsUnavailable({ message }: { message: string }) {
  return (
    <p className="text-sm text-red-600">
      {message}{' '}
      <Link to="/credentials" className="underline hover:text-red-700">
        Reconnect on the Credentials page
      </Link>
      .
    </p>
  );
}

function loadErrorMessage(error: unknown): string {
  return error instanceof Error && error.message ? error.message : 'Could not load projects';
}

interface HermeneutixProjectPickScreenProps {
  agentId: string;
  agentName: string;
  pick: { credentialId?: string; projectId: string | null };
  onPick: (projectId: string | null) => void;
  onConfirm: (config: HermeneutixInstanceConfig | undefined) => void;
  onBack: () => void;
  pending: boolean;
  error: string | null;
}

/**
 * The project step of adding Hermeneutix. "All projects" is first and
 * preselected: it is the default and means the instance carries no config.
 */
function HermeneutixProjectPickScreen({
  agentId, agentName, pick, onPick, onConfirm, onBack, pending, error,
}: HermeneutixProjectPickScreenProps) {
  const { data: projects, isLoading, error: loadError } = useHermeneutixProjects(agentId, pick.credentialId);

  const chosen = projects?.find((p) => p.id === pick.projectId);
  const confirm = () =>
    onConfirm(chosen ? { projectId: chosen.id, projectName: chosen.name } : undefined);

  const option = (id: string | null, name: string, hint?: string) => {
    const isSelected = pick.projectId === id;
    return (
      <label
        key={id ?? '__all__'}
        className={`flex items-center gap-3 p-3 rounded-lg border-2 cursor-pointer transition-all ${
          isSelected ? 'border-trust-blue bg-trust-blue/5' : 'border-gray-200 hover:border-gray-300'
        }`}
      >
        <input
          type="radio"
          name="add-service-project"
          checked={isSelected}
          onChange={() => onPick(id)}
          className="h-4 w-4 text-trust-blue focus:ring-trust-blue"
        />
        <div className="flex-1 min-w-0">
          <div className="font-medium text-sm text-reins-navy truncate">{name}</div>
          {hint && <div className="text-xs text-gray-400 truncate">{hint}</div>}
        </div>
      </label>
    );
  };

  return (
    <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50">
      <div className="bg-white rounded-xl w-full max-w-md shadow-xl p-6">
        <div className="flex items-start gap-3 mb-4">
          <div className="p-2 bg-trust-blue/10 rounded-lg text-trust-blue shrink-0">
            <Key className="w-5 h-5" />
          </div>
          <div>
            <h2 className="text-lg font-semibold text-reins-navy">Which project should Hermeneutix use?</h2>
            <p className="text-sm text-gray-600 mt-1">
              {agentName} will only see meetings from the project you pick. You can change it later in the service details.
            </p>
          </div>
        </div>

        {loadError ? (
          <div className="mb-4 px-3 py-2">
            <HermeneutixProjectsUnavailable message={loadErrorMessage(loadError)} />
          </div>
        ) : (
          <div className="space-y-2 mb-4 max-h-80 overflow-y-auto">
            {option(null, 'All projects', 'Every project this account can see')}
            {isLoading && <div className="text-xs text-gray-500 px-3 py-2">Loading projects…</div>}
            {projects?.map((p) => option(p.id, p.name))}
          </div>
        )}

        <div className="flex gap-2">
          <button
            onClick={confirm}
            disabled={pending || !!loadError}
            className="flex-1 bg-trust-blue text-white px-4 py-2.5 rounded-lg text-sm font-semibold hover:bg-trust-blue/90 disabled:opacity-50"
          >
            {pending ? 'Adding…' : 'Add Hermeneutix'}
          </button>
          <button
            onClick={onBack}
            className="px-4 py-2.5 rounded-lg text-sm font-medium text-gray-500 hover:text-gray-700"
          >
            Back
          </button>
        </div>
        {error && <p className="text-sm text-red-600 mt-3">{error}</p>}
      </div>
    </div>
  );
}

/**
 * Change which project an existing Hermeneutix instance is pinned to.
 * Saves on change; "All projects" clears the config rather than storing an empty one.
 */
function HermeneutixProjectEditor({ instance }: {
  instance: {
    id: string;
    agentId: string;
    credentialId: string | null;
    credentialStatus: 'connected' | 'missing' | 'expired' | 'not_linked';
    config: Record<string, unknown> | null;
  };
}) {
  const queryClient = useQueryClient();
  // An account already known to be broken cannot list anything: say so
  // straight away instead of fetching a failure to report.
  const accountBroken = instance.credentialStatus === 'missing' || instance.credentialStatus === 'expired';
  const { data: projects, isLoading, error } = useHermeneutixProjects(
    instance.agentId, instance.credentialId, { enabled: !accountBroken }
  );

  const updateMutation = useMutation({
    mutationFn: (config: HermeneutixInstanceConfig | null) =>
      permissions.updateInstance(instance.id, { config }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['permissions', 'instance', instance.id] });
      queryClient.invalidateQueries({ queryKey: ['permissions', 'agents'] });
    },
  });

  const current = typeof instance.config?.projectId === 'string' ? instance.config.projectId : '';
  const selectId = `hermeneutix-project-${instance.id}`;

  const onChange = (projectId: string) => {
    if (!projectId) {
      updateMutation.mutate(null);
      return;
    }
    const project = projects?.find((p) => p.id === projectId);
    if (project) updateMutation.mutate({ projectId: project.id, projectName: project.name });
  };

  const unavailable = accountBroken
    ? `This account is ${instance.credentialStatus}, so its projects cannot be listed.`
    : error
      ? loadErrorMessage(error)
      : null;

  return (
    <div className="p-4 bg-gray-50 rounded-lg">
      <div className="flex items-center gap-3 mb-3">
        <Search className="w-5 h-5 text-gray-400" />
        <div>
          {unavailable ? (
            <div className="font-medium text-reins-navy">Project</div>
          ) : (
            <label htmlFor={selectId} className="font-medium text-reins-navy">Project</label>
          )}
          <div className="text-sm text-gray-500">
            Which project should this agent see? Limit it to one, or let it see every project this account can.
          </div>
        </div>
      </div>

      {unavailable ? (
        <HermeneutixProjectsUnavailable message={unavailable} />
      ) : (
        <>
          <select
            id={selectId}
            value={current}
            onChange={(e) => onChange(e.target.value)}
            disabled={isLoading || updateMutation.isPending}
            className="w-full text-sm px-3 py-2 rounded-lg border border-gray-200 bg-white text-reins-navy focus:border-trust-blue focus:ring-trust-blue disabled:opacity-50"
          >
            <option value="">All projects</option>
            {/* Keep the pinned project selectable while the list is still loading. */}
            {!projects && current && (
              <option value={current}>
                {typeof instance.config?.projectName === 'string' ? instance.config.projectName : current}
              </option>
            )}
            {projects?.map((p) => (
              <option key={p.id} value={p.id}>{p.name}</option>
            ))}
          </select>

          {isLoading && <p className="text-xs text-gray-500 mt-2">Loading projects…</p>}
          {updateMutation.isError && (
            <p className="text-sm text-red-600 mt-2">{(updateMutation.error as Error).message}</p>
          )}
        </>
      )}
    </div>
  );
}

// ============================================================================
// Drive Path-Based Permissions Editor
// ============================================================================

interface DrivePathEditorProps {
  agentId: string;
}

/**
 * Which memory scopes an agent may reach.
 *
 * Unrestricted is the default and means every scope its owner has, including
 * ones created later. Restricting is opt-in: an agent with no grants recorded
 * keeps working exactly as it did before scopes existed.
 */
function MemoryScopeEditor({ agentId }: { agentId: string }) {
  const queryClient = useQueryClient();

  const { data: grants, isLoading } = useQuery({
    queryKey: ['permissions', agentId, 'memory-scopes'],
    queryFn: () => permissions.getAgentMemoryScopes(agentId),
  });

  const updateMutation = useMutation({
    mutationFn: (next: { mode: 'all' } | { mode: 'restricted'; scopeIds: string[]; defaultScopeId: string }) =>
      permissions.setAgentMemoryScopes(agentId, next),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['permissions', agentId, 'memory-scopes'] });
    },
  });

  if (isLoading || !grants) {
    return <div className="text-xs text-gray-500">Loading scopes…</div>;
  }

  const restricted = grants.mode === 'restricted';
  // With no grant rows the agent reaches every scope, so show them all ticked.
  // The checkbox reflects effective access, not whether a row happens to exist —
  // "which scopes can this agent reach" is the question being asked.
  const granted = new Set(
    restricted ? grants.grantedScopeIds : grants.availableScopes.map((s) => s.id)
  );

  /** Ticking or unticking always lands in restricted mode — that is what a choice means. */
  const toggle = (scopeId: string) => {
    const next = new Set(granted);
    if (next.has(scopeId)) next.delete(scopeId);
    else next.add(scopeId);
    // An empty set would mean an agent with memory enabled that can reach none of it.
    if (next.size === 0) return;
    const ids = [...next];
    updateMutation.mutate({
      mode: 'restricted',
      scopeIds: ids,
      defaultScopeId: ids.includes(grants.defaultScopeId) ? grants.defaultScopeId : ids[0],
    });
  };

  const setDefault = (scopeId: string) => {
    updateMutation.mutate({
      mode: 'restricted',
      scopeIds: [...granted],
      defaultScopeId: scopeId,
    });
  };

  const onlyScope = grants.availableScopes.length === 1;

  return (
    <div>
      <h4 className="text-sm font-medium text-white mb-1">Memory scopes</h4>
      <p className="text-xs text-gray-500 mb-3">
        Which compartments of your vault this agent can read and write.{' '}
        <span className="text-gray-400">Default</span> is where its entries land when it
        does not name a scope.
      </p>

      <div className="space-y-1">
        {grants.availableScopes.map((s) => {
          const on = granted.has(s.id);
          const isDefault = on && grants.defaultScopeId === s.id;
          return (
            <div key={s.id} className="flex items-center justify-between px-3 py-2 rounded bg-white/5">
              <label className="flex items-center gap-2 cursor-pointer min-w-0">
                <input
                  type="checkbox"
                  checked={on}
                  onChange={() => toggle(s.id)}
                  disabled={onlyScope && on}
                  title={onlyScope && on ? 'The only scope — an agent cannot be left with none' : undefined}
                  className="accent-trust-blue disabled:opacity-50"
                />
                <span className="text-sm text-white truncate">{s.name}</span>
                {s.archived_at && (
                  <span className="text-[10px] text-gray-500 italic">(archived)</span>
                )}
                <span className="text-[10px] text-gray-500">{s.slug}</span>
              </label>
              {on && (
                <label className="flex items-center gap-1.5 cursor-pointer shrink-0">
                  <input
                    type="radio"
                    name={`default-scope-${agentId}`}
                    checked={isDefault}
                    onChange={() => setDefault(s.id)}
                    className="accent-trust-blue"
                  />
                  <span className="text-[11px] text-gray-400">default</span>
                </label>
              )}
            </div>
          );
        })}
      </div>

      <div className="mt-2 flex items-center justify-between gap-3">
        <p className="text-xs text-gray-500">
          {restricted
            ? `Restricted to ${granted.size} of ${grants.availableScopes.length}.`
            : `Reaches all ${grants.availableScopes.length}, including any you add later.`}
        </p>
        {restricted && (
          <button
            onClick={() => updateMutation.mutate({ mode: 'all' })}
            className="text-xs text-trust-blue hover:underline shrink-0"
          >
            Reset to all scopes
          </button>
        )}
      </div>
    </div>
  );
}

function DrivePathEditor({ agentId }: DrivePathEditorProps) {
  const queryClient = useQueryClient();
  const [newFolderId, setNewFolderId] = useState('');
  const [newLabel, setNewLabel] = useState('');
  const [newPermission, setNewPermission] = useState<'read' | 'write' | 'blocked'>('write');

  const { data: config, isLoading } = useQuery({
    queryKey: ['permissions', agentId, 'drive-path-config'],
    queryFn: () => permissions.getDrivePathConfig(agentId),
  });

  const updateMutation = useMutation({
    mutationFn: (updated: DrivePathConfig) => permissions.setDrivePathConfig(agentId, updated),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['permissions', agentId, 'drive-path-config'] });
    },
  });

  const setDefault = (level: 'read' | 'write' | 'blocked') => {
    updateMutation.mutate({ defaultLevel: level, rules: config?.rules ?? [] });
  };

  const addRule = () => {
    if (!newFolderId.trim()) return;
    const rules = [...(config?.rules ?? []), { folderId: newFolderId.trim(), label: newLabel.trim() || undefined, permission: newPermission }];
    updateMutation.mutate({ defaultLevel: config?.defaultLevel ?? 'write', rules });
    setNewFolderId('');
    setNewLabel('');
    setNewPermission('write');
  };

  const removeRule = (folderId: string) => {
    const rules = (config?.rules ?? []).filter((r) => r.folderId !== folderId);
    updateMutation.mutate({ defaultLevel: config?.defaultLevel ?? 'write', rules });
  };

  if (isLoading) return null;

  const defaultLevel = config?.defaultLevel ?? 'write';
  const rules = config?.rules ?? [];

  const levelColors: Record<string, string> = {
    read: 'bg-trust-blue/10 text-trust-blue',
    write: 'bg-safe-green/10 text-safe-green',
    blocked: 'bg-alert-red/10 text-alert-red',
  };

  return (
    <div className="border border-gray-200 rounded-lg overflow-hidden">
      <div className="px-4 py-3 bg-gray-50 border-b border-gray-200 flex items-center gap-2">
        <HardDrive className="w-4 h-4 text-gray-400" />
        <span className="text-sm font-medium text-gray-700">Folder Permissions</span>
      </div>

      <div className="p-4 space-y-4">
        {/* Default Level */}
        <div>
          <div className="text-xs font-medium text-gray-500 uppercase tracking-wide mb-2">Default (all folders)</div>
          <div className="flex gap-2">
            {(['read', 'write', 'blocked'] as const).map((level) => (
              <button
                key={level}
                onClick={() => setDefault(level)}
                disabled={updateMutation.isPending}
                className={`flex-1 py-1.5 text-xs font-medium rounded-lg border-2 transition-all capitalize ${
                  defaultLevel === level
                    ? `${levelColors[level]} border-current`
                    : 'bg-white text-gray-500 border-gray-200 hover:border-gray-300'
                }`}
              >
                {level}
              </button>
            ))}
          </div>
        </div>

        {/* Folder Rules */}
        {rules.length > 0 && (
          <div>
            <div className="text-xs font-medium text-gray-500 uppercase tracking-wide mb-2">Folder overrides</div>
            <div className="space-y-2">
              {rules.map((rule: DrivePathRule) => (
                <div key={rule.folderId} className="flex items-center gap-2 p-2 bg-gray-50 rounded-lg">
                  <div className="flex-1 min-w-0">
                    <div className="text-sm font-medium text-reins-navy truncate">
                      {rule.label || rule.folderId}
                    </div>
                    {rule.label && (
                      <div className="text-xs text-gray-400 truncate">{rule.folderId}</div>
                    )}
                  </div>
                  <span className={`text-xs font-medium px-2 py-0.5 rounded ${levelColors[rule.permission]} capitalize`}>
                    {rule.permission}
                  </span>
                  <button
                    onClick={() => removeRule(rule.folderId)}
                    disabled={updateMutation.isPending}
                    className="text-gray-300 hover:text-alert-red transition-colors"
                  >
                    <X className="w-4 h-4" />
                  </button>
                </div>
              ))}
            </div>
          </div>
        )}

        {/* Add Rule */}
        <div>
          <div className="text-xs font-medium text-gray-500 uppercase tracking-wide mb-2">Add folder override</div>
          <div className="space-y-2">
            <input
              type="text"
              placeholder="Folder ID (from Drive URL)"
              value={newFolderId}
              onChange={(e) => setNewFolderId(e.target.value)}
              className="w-full text-sm border border-gray-200 rounded-lg px-3 py-1.5 focus:outline-none focus:ring-2 focus:ring-trust-blue/30 focus:border-trust-blue"
            />
            <div className="flex gap-2">
              <input
                type="text"
                placeholder="Label (optional, e.g. /my_folder)"
                value={newLabel}
                onChange={(e) => setNewLabel(e.target.value)}
                className="flex-1 text-sm border border-gray-200 rounded-lg px-3 py-1.5 focus:outline-none focus:ring-2 focus:ring-trust-blue/30 focus:border-trust-blue"
              />
              <select
                value={newPermission}
                onChange={(e) => setNewPermission(e.target.value as 'read' | 'write' | 'blocked')}
                className="text-sm border border-gray-200 rounded-lg px-2 py-1.5 focus:outline-none focus:ring-2 focus:ring-trust-blue/30"
              >
                <option value="read">Read</option>
                <option value="write">Write</option>
                <option value="blocked">Blocked</option>
              </select>
              <button
                onClick={addRule}
                disabled={!newFolderId.trim() || updateMutation.isPending}
                className="flex items-center gap-1 bg-trust-blue text-white px-3 py-1.5 rounded-lg text-sm font-medium hover:bg-blue-600 transition-all disabled:opacity-50 disabled:cursor-not-allowed"
              >
                <Plus className="w-3.5 h-3.5" />
                Add
              </button>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}

/**
 * Read-only list of the skills attached to an agent, with a warning when a
 * required service is no longer connected. Authoring lives on /skills.
 */
function AgentSkillsStrip({ agentId }: { agentId: string }) {
  const { data: assigned = [] } = useQuery({
    queryKey: ['agent-skills', agentId],
    queryFn: () => skillsApi.listForAgent(agentId),
  });

  if (assigned.length === 0) return null;

  return (
    <div className="pt-3 mt-1 border-t border-gray-100">
      <div className="flex items-center justify-between mb-2">
        <span className="text-xs text-gray-400 uppercase tracking-wider">Skills</span>
        <Link to="/skills" className="text-xs text-trust-blue hover:underline">
          Manage
        </Link>
      </div>
      <div className="flex flex-wrap gap-1.5">
        {assigned.map((skill) => (
          <span
            key={skill.id}
            title={
              skill.available
                ? skill.description
                : `Needs ${skill.missingServices.join(', ')} \u2014 unavailable to the agent until reconnected`
            }
            className={`inline-flex items-center gap-1 text-xs px-2 py-1 rounded-lg border ${
              skill.available
                ? 'bg-white text-gray-600 border-gray-200'
                : 'bg-caution-amber/5 text-caution-amber border-caution-amber/30'
            }`}
          >
            {!skill.available && <AlertCircle className="w-3 h-3 shrink-0" />}
            {skill.name}
          </span>
        ))}
      </div>
    </div>
  );
}
