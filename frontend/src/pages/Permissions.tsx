import { useState } from 'react';
import { Link } from 'react-router-dom';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import {
  permissions,
  type PermissionMatrixCell,
  type ServiceType,
  type ToolPermission,
  type PermissionLevel,
} from '../api/client';
import {
  Lock,
  Mail,
  HardDrive,
  Calendar,
  Search,
  Globe,
  CheckCircle,
  XCircle,
  AlertCircle,
  X,
  Key,
  Shield,
  ChevronDown,
  ChevronRight,
  Plus,
} from 'lucide-react';

const serviceIcons: Record<ServiceType, React.ReactNode> = {
  gmail: <Mail className="w-5 h-5" />,
  drive: <HardDrive className="w-5 h-5" />,
  calendar: <Calendar className="w-5 h-5" />,
  'web-search': <Search className="w-5 h-5" />,
  browser: <Globe className="w-5 h-5" />,
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

export default function Permissions() {
  const queryClient = useQueryClient();
  const [selectedCell, setSelectedCell] = useState<{
    agentId: string;
    agentName: string;
    serviceType: ServiceType;
    serviceName: string;
  } | null>(null);

  const { data: matrix, isLoading } = useQuery({
    queryKey: ['permissions', 'matrix'],
    queryFn: permissions.getMatrix,
  });

  const getCellData = (
    agentId: string,
    serviceType: ServiceType
  ): PermissionMatrixCell | undefined => {
    return matrix?.cells.find(
      (c) => c.agentId === agentId && c.serviceType === serviceType
    );
  };

  const getCellStatus = (cell: PermissionMatrixCell | undefined) => {
    if (!cell) return 'disabled';
    if (!cell.enabled) return 'disabled';
    if (cell.credentialStatus === 'missing' || cell.credentialStatus === 'not_linked')
      return 'needs-credential';
    if (cell.credentialStatus === 'expired') return 'expired';
    return 'active';
  };

  const getCellColor = (status: string) => {
    switch (status) {
      case 'active':
        return 'bg-safe-green/10 border-safe-green/30 hover:bg-safe-green/20';
      case 'needs-credential':
        return 'bg-caution-amber/10 border-caution-amber/30 hover:bg-caution-amber/20';
      case 'expired':
        return 'bg-alert-red/10 border-alert-red/30 hover:bg-alert-red/20';
      default:
        return 'bg-gray-50 border-gray-200 hover:bg-gray-100';
    }
  };

  const handleCellClick = (
    agentId: string,
    agentName: string,
    serviceType: ServiceType,
    serviceName: string
  ) => {
    setSelectedCell({ agentId, agentName, serviceType, serviceName });
  };

  if (isLoading) {
    return (
      <div className="p-8">
        <div className="flex items-center justify-center py-12">
          <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-trust-blue"></div>
        </div>
      </div>
    );
  }

  if (!matrix || matrix.agents.length === 0) {
    return (
      <div className="p-8">
        <div className="flex items-center justify-between mb-8">
          <div>
            <h1 className="text-2xl font-semibold text-reins-navy">Permissions</h1>
            <p className="text-gray-500 mt-1">
              Configure which services each agent can access
            </p>
          </div>
        </div>
        <div className="bg-white rounded-xl p-12 shadow-sm border border-gray-100 text-center">
          <Lock className="w-12 h-12 text-gray-300 mx-auto mb-4" />
          <p className="text-gray-500">No agents configured yet</p>
          <p className="text-sm text-gray-400 mt-2">
            Create an agent first to configure permissions
          </p>
        </div>
      </div>
    );
  }

  return (
    <div className="p-8">
      <div className="flex items-center justify-between mb-8">
        <div>
          <h1 className="text-2xl font-semibold text-reins-navy">Permissions</h1>
          <p className="text-gray-500 mt-1">
            Configure which services each agent can access
          </p>
        </div>
      </div>

      {/* Legend */}
      <div className="flex gap-6 mb-6 text-sm">
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
      {matrix.cells.some(
        (c) => c.enabled && (c.credentialStatus === 'missing' || c.credentialStatus === 'not_linked')
      ) && (
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

      {/* Permission Matrix */}
      <div className="bg-white rounded-xl shadow-sm border border-gray-100 overflow-hidden">
        <div className="overflow-x-auto">
          <table className="w-full">
            <thead className="bg-gray-50 border-b border-gray-100">
              <tr>
                <th className="text-left px-6 py-4 text-xs font-medium text-gray-500 uppercase tracking-wider w-48">
                  Agent
                </th>
                {matrix.services.map((service) => (
                  <th
                    key={service.type}
                    className="text-center px-4 py-4 text-xs font-medium text-gray-500 uppercase tracking-wider w-32"
                  >
                    <div className="flex flex-col items-center gap-1">
                      {serviceIcons[service.type]}
                      <span>{service.name}</span>
                    </div>
                  </th>
                ))}
              </tr>
            </thead>
            <tbody className="divide-y divide-gray-100">
              {matrix.agents.map((agent) => (
                <tr key={agent.id} className="hover:bg-gray-50/50">
                  <td className="px-6 py-4">
                    <div className="font-medium text-reins-navy">{agent.name}</div>
                    <div className="text-xs text-gray-400 mt-0.5">
                      {agent.status === 'active' ? (
                        <span className="text-safe-green">Active</span>
                      ) : (
                        <span className="text-gray-400">{agent.status}</span>
                      )}
                    </div>
                  </td>
                  {matrix.services.map((service) => {
                    const cell = getCellData(agent.id, service.type);
                    const status = getCellStatus(cell);
                    const color = getCellColor(status);

                    return (
                      <td key={service.type} className="px-4 py-4">
                        <button
                          onClick={() =>
                            handleCellClick(agent.id, agent.name, service.type, service.name)
                          }
                          className={`w-full p-3 rounded-lg border-2 transition-all ${color}`}
                        >
                          <div className="flex flex-col items-center gap-1">
                            {status === 'active' && (
                              <CheckCircle className="w-5 h-5 text-safe-green" />
                            )}
                            {status === 'needs-credential' && (
                              <AlertCircle className="w-5 h-5 text-caution-amber" />
                            )}
                            {status === 'expired' && (
                              <XCircle className="w-5 h-5 text-alert-red" />
                            )}
                            {status === 'disabled' && (
                              <XCircle className="w-5 h-5 text-gray-300" />
                            )}
                            {cell && cell.enabled && (
                              <div className="text-xs text-gray-500">
                                {cell.permissionLevel === 'read' && 'Read Only'}
                                {cell.permissionLevel === 'full' && 'Read + Write'}
                                {cell.permissionLevel === 'custom' && 'Custom'}
                                {cell.permissionLevel === 'none' && 'Off'}
                                {cell.linkedCredentialCount > 1 && (
                                  <span className="ml-1 text-trust-blue">
                                    ({cell.linkedCredentialCount} accounts)
                                  </span>
                                )}
                              </div>
                            )}
                          </div>
                        </button>
                      </td>
                    );
                  })}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>

      {/* Service Configuration Modal */}
      {selectedCell && (
        <ServiceConfigModal
          agentId={selectedCell.agentId}
          agentName={selectedCell.agentName}
          serviceType={selectedCell.serviceType}
          serviceName={selectedCell.serviceName}
          onClose={() => setSelectedCell(null)}
          onUpdate={() => {
            queryClient.invalidateQueries({ queryKey: ['permissions', 'matrix'] });
          }}
        />
      )}
    </div>
  );
}

interface ServiceConfigModalProps {
  agentId: string;
  agentName: string;
  serviceType: ServiceType;
  serviceName: string;
  onClose: () => void;
  onUpdate: () => void;
}

const permissionLevelDescriptions: Record<PermissionLevel, { label: string; description: string }> = {
  none: { label: 'Off', description: 'Service disabled for this agent' },
  read: { label: 'Read Only', description: 'Can view and search — no modifications allowed' },
  full: { label: 'Read + Write (with approval)', description: 'Reads are automatic. Writes go to the approval queue for your review.' },
  custom: { label: 'Custom', description: 'Individual tool permissions configured manually' },
};

// Service-specific descriptions for each permission level
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

function ServiceConfigModal({
  agentId,
  agentName,
  serviceType,
  serviceName,
  onClose,
  onUpdate,
}: ServiceConfigModalProps) {
  const queryClient = useQueryClient();
  const [showAdvanced, setShowAdvanced] = useState(false);

  const { data: config, isLoading } = useQuery({
    queryKey: ['permissions', agentId, serviceType],
    queryFn: () => permissions.getServiceConfig(agentId, serviceType),
  });

  const { data: availableCredentials } = useQuery({
    queryKey: ['permissions', 'credentials', serviceType],
    queryFn: () => permissions.getServiceCredentials(serviceType),
  });

  const setPermissionLevelMutation = useMutation({
    mutationFn: (level: PermissionLevel) =>
      permissions.setPermissionLevel(agentId, serviceType, level),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['permissions'] });
      onUpdate();
    },
  });

  const addServiceCredentialMutation = useMutation({
    mutationFn: (credentialId: string) =>
      permissions.addServiceCredential(agentId, serviceType, credentialId),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['permissions'] });
      onUpdate();
    },
  });

  const removeServiceCredentialMutation = useMutation({
    mutationFn: (credentialId: string) =>
      permissions.removeServiceCredential(agentId, serviceType, credentialId),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['permissions'] });
      onUpdate();
    },
  });

  const setDefaultCredentialMutation = useMutation({
    mutationFn: (credentialId: string) =>
      permissions.setDefaultCredential(agentId, serviceType, credentialId),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['permissions'] });
      onUpdate();
    },
  });

  const setToolPermissionMutation = useMutation({
    mutationFn: ({ toolName, permission }: { toolName: string; permission: ToolPermission }) =>
      permissions.setToolPermission(agentId, serviceType, toolName, permission),
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
              {serviceIcons[serviceType]}
            </div>
            <div>
              <h2 className="text-lg font-semibold text-reins-navy">
                {serviceName} for {agentName}
              </h2>
              <p className="text-sm text-gray-500">Configure access and permissions</p>
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
                    Choose what this agent can do with {serviceName}
                  </div>
                </div>
              </div>

              <div className="space-y-2">
                {(['none', 'read', 'full'] as const).map((level) => {
                  const getDescription = () => {
                    if (level === 'none') return permissionLevelDescriptions.none.description;
                    const serviceDetails = servicePermissionDetails[serviceType];
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
                      } ${setPermissionLevelMutation.isPending ? 'opacity-50 cursor-wait' : ''}`}
                    >
                      <input
                        type="radio"
                        name="permissionLevel"
                        value={level}
                        checked={currentLevel === level}
                        onChange={() => setPermissionLevelMutation.mutate(level)}
                        disabled={setPermissionLevelMutation.isPending}
                        className="mt-1 h-4 w-4 text-trust-blue focus:ring-trust-blue"
                      />
                      <div className="flex-1">
                        <div className="font-medium text-reins-navy">
                          {permissionLevelDescriptions[level].label}
                        </div>
                        <div className="text-sm text-gray-500">
                          {getDescription()}
                        </div>
                      </div>
                      {currentLevel === level && !setPermissionLevelMutation.isPending && (
                        <CheckCircle className="w-5 h-5 text-trust-blue mt-0.5" />
                      )}
                      {currentLevel === level && setPermissionLevelMutation.isPending && (
                        <div className="w-5 h-5 border-2 border-trust-blue border-t-transparent rounded-full animate-spin mt-0.5" />
                      )}
                    </label>
                  );
                })}

                {/* Show custom option if currently set */}
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

            {/* Credential / Account Section - only show when service is enabled */}
            {currentLevel !== 'none' && (
              <div className="p-4 bg-gray-50 rounded-lg">
                <div className="flex items-center gap-3 mb-3">
                  <Key className="w-5 h-5 text-gray-400" />
                  <div>
                    <div className="font-medium text-reins-navy">Account</div>
                    <div className="text-sm text-gray-500">
                      Which account should this agent use for {serviceName}?
                    </div>
                  </div>
                </div>

                {/* Account selector - checkboxes for multi-account support */}
                {availableCredentials && availableCredentials.length > 0 ? (
                  <div className="space-y-2 mt-2">
                    {availableCredentials.map((cred) => {
                      const linkedCred = config.linkedCredentials?.find(
                        (lc) => lc.credentialId === cred.id
                      );
                      const isLinked = !!linkedCred;
                      const isDefault = linkedCred?.isDefault ?? false;
                      const isMutating = addServiceCredentialMutation.isPending
                        || removeServiceCredentialMutation.isPending
                        || setDefaultCredentialMutation.isPending;

                      return (
                        <div
                          key={cred.id}
                          className={`w-full flex items-center gap-3 p-3 rounded-lg border-2 transition-all ${
                            isLinked
                              ? 'border-trust-blue bg-trust-blue/5'
                              : 'border-gray-200 bg-white hover:border-gray-300'
                          } ${isMutating ? 'opacity-50' : ''}`}
                        >
                          <button
                            onClick={() => {
                              if (isLinked) {
                                removeServiceCredentialMutation.mutate(cred.id);
                              } else {
                                addServiceCredentialMutation.mutate(cred.id);
                              }
                            }}
                            disabled={isMutating}
                            className="shrink-0"
                          >
                            <div className={`w-5 h-5 rounded border-2 flex items-center justify-center ${
                              isLinked
                                ? 'bg-trust-blue border-trust-blue'
                                : 'border-gray-300 hover:border-gray-400'
                            }`}>
                              {isLinked && <CheckCircle className="w-3 h-3 text-white" />}
                            </div>
                          </button>
                          <div className={`w-8 h-8 rounded-full flex items-center justify-center text-sm font-medium ${
                            isLinked ? 'bg-trust-blue text-white' : 'bg-gray-100 text-gray-400'
                          }`}>
                            {(cred.accountEmail || cred.type).charAt(0).toUpperCase()}
                          </div>
                          <div className="flex-1 min-w-0">
                            <div className="font-medium text-sm text-reins-navy truncate">
                              {cred.accountEmail || cred.type}
                            </div>
                            {cred.accountName && (
                              <div className="text-xs text-gray-400 truncate">{cred.accountName}</div>
                            )}
                          </div>
                          <div className="flex items-center gap-2 shrink-0">
                            <span className={`text-xs ${credentialStatusColors[cred.status]}`}>
                              {cred.status}
                            </span>
                            {isLinked && isDefault && (
                              <span className="text-xs font-medium text-trust-blue bg-trust-blue/10 px-1.5 py-0.5 rounded">
                                Default
                              </span>
                            )}
                            {isLinked && !isDefault && (
                              <button
                                onClick={() => setDefaultCredentialMutation.mutate(cred.id)}
                                disabled={isMutating}
                                className="text-xs text-gray-400 hover:text-trust-blue transition-colors"
                              >
                                Set default
                              </button>
                            )}
                          </div>
                        </div>
                      );
                    })}
                    <Link
                      to={`/credentials?connect=${serviceType}`}
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
                          No accounts connected for {serviceName}
                        </p>
                        <p className="text-xs text-gray-500 mt-0.5">
                          Connect a Google account first so this agent can authenticate.
                        </p>
                        <Link
                          to={`/credentials?connect=${serviceType}`}
                          className="inline-flex items-center gap-1 text-xs font-medium text-trust-blue hover:text-blue-700 mt-2"
                        >
                          <Key className="w-3 h-3" />
                          Connect Google Account
                        </Link>
                      </div>
                    </div>
                  </div>
                )}
              </div>
            )}

            {/* Advanced: Individual Tool Permissions */}
            {currentLevel !== 'none' && (
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
