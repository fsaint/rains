import { useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import {
  permissions,
  type PermissionMatrixCell,
  type ServiceType,
  type ToolPermission,
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
  Settings,
  X,
  Key,
  Shield,
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
                                {cell.toolCount - cell.blockedCount} tools
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

function ServiceConfigModal({
  agentId,
  agentName,
  serviceType,
  serviceName,
  onClose,
  onUpdate,
}: ServiceConfigModalProps) {
  const queryClient = useQueryClient();

  const { data: config, isLoading } = useQuery({
    queryKey: ['permissions', agentId, serviceType],
    queryFn: () => permissions.getServiceConfig(agentId, serviceType),
  });

  const { data: availableCredentials } = useQuery({
    queryKey: ['permissions', 'credentials', serviceType],
    queryFn: () => permissions.getServiceCredentials(serviceType),
  });

  const toggleAccessMutation = useMutation({
    mutationFn: (enabled: boolean) =>
      permissions.setServiceAccess(agentId, serviceType, enabled),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['permissions'] });
      onUpdate();
    },
  });

  const linkCredentialMutation = useMutation({
    mutationFn: (credentialId: string) =>
      permissions.linkCredential(agentId, serviceType, credentialId),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['permissions'] });
      onUpdate();
    },
  });

  const unlinkCredentialMutation = useMutation({
    mutationFn: () => permissions.unlinkCredential(agentId, serviceType),
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
            {/* Service Toggle */}
            <div className="flex items-center justify-between p-4 bg-gray-50 rounded-lg">
              <div className="flex items-center gap-3">
                <Settings className="w-5 h-5 text-gray-400" />
                <div>
                  <div className="font-medium text-reins-navy">Service Access</div>
                  <div className="text-sm text-gray-500">
                    Enable or disable {serviceName} for this agent
                  </div>
                </div>
              </div>
              <button
                onClick={() => toggleAccessMutation.mutate(!config.enabled)}
                disabled={toggleAccessMutation.isPending}
                className={`relative inline-flex h-6 w-11 items-center rounded-full transition-colors ${
                  config.enabled ? 'bg-trust-blue' : 'bg-gray-300'
                }`}
              >
                <span
                  className={`inline-block h-4 w-4 transform rounded-full bg-white transition-transform ${
                    config.enabled ? 'translate-x-6' : 'translate-x-1'
                  }`}
                />
              </button>
            </div>

            {/* Credential Section */}
            <div className="p-4 bg-gray-50 rounded-lg">
              <div className="flex items-center gap-3 mb-3">
                <Key className="w-5 h-5 text-gray-400" />
                <div>
                  <div className="font-medium text-reins-navy">Credential</div>
                  <div className="text-sm text-gray-500">
                    Link a credential for authentication
                  </div>
                </div>
              </div>

              {config.credentialId ? (
                <div className="flex items-center justify-between mt-2">
                  <div className="flex items-center gap-2">
                    <CheckCircle
                      className={`w-4 h-4 ${credentialStatusColors[config.credentialStatus]}`}
                    />
                    <span className="text-sm">
                      {(() => {
                        const linkedCred = availableCredentials?.find((c) => c.id === config.credentialId);
                        if (linkedCred?.accountEmail) {
                          return `${linkedCred.accountEmail} (${config.credentialStatus})`;
                        }
                        return `Credential linked (${config.credentialStatus})`;
                      })()}
                    </span>
                  </div>
                  <button
                    onClick={() => unlinkCredentialMutation.mutate()}
                    className="text-xs text-gray-500 hover:text-alert-red"
                  >
                    Unlink
                  </button>
                </div>
              ) : (
                <div className="mt-2">
                  {availableCredentials && availableCredentials.length > 0 ? (
                    <select
                      onChange={(e) => {
                        if (e.target.value) {
                          linkCredentialMutation.mutate(e.target.value);
                        }
                      }}
                      className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm focus:ring-2 focus:ring-trust-blue focus:border-transparent"
                      defaultValue=""
                    >
                      <option value="">Select a credential...</option>
                      {availableCredentials.map((cred) => (
                        <option key={cred.id} value={cred.id}>
                          {cred.accountEmail || cred.type} ({cred.status})
                          {cred.expiresAt && ` - expires: ${new Date(cred.expiresAt).toLocaleDateString()}`}
                        </option>
                      ))}
                    </select>
                  ) : (
                    <p className="text-sm text-gray-500">
                      No credentials available for {serviceName}. Create one in the
                      Credentials page.
                    </p>
                  )}
                </div>
              )}
            </div>

            {/* Tool Permissions */}
            {config.enabled && (
              <div>
                <h3 className="font-medium text-reins-navy mb-3 flex items-center gap-2">
                  <Shield className="w-5 h-5 text-gray-400" />
                  Tool Permissions
                </h3>
                <div className="space-y-2">
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
