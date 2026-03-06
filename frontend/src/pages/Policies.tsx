import { useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import {
  Plus,
  Trash2,
  Edit,
  FileText,
  X,
  Mail,
  HardDrive,
  Calendar,
  Search,
  Globe,
  Shield,
  ChevronDown,
  ChevronRight,
  Check,
} from 'lucide-react';
import { policies } from '../api/client';

interface Policy {
  id: string;
  name: string;
  version: string;
  yaml: string;
  createdAt: string;
  updatedAt: string;
}

type ServiceType = 'gmail' | 'drive' | 'calendar' | 'web-search' | 'browser';
type PermissionLevel = 'none' | 'read' | 'full' | 'custom';
type ToolPermission = 'allow' | 'block' | 'require_approval';

interface ServiceConfig {
  enabled: boolean;
  level: PermissionLevel;
  customTools?: Record<string, ToolPermission>;
}

// Human-readable tool names
const TOOL_LABELS: Record<string, string> = {
  // Gmail
  gmail_list_messages: 'List Messages',
  gmail_get_message: 'Read Message',
  gmail_search: 'Search Emails',
  gmail_list_labels: 'List Labels',
  gmail_create_draft: 'Create Draft',
  gmail_send_draft: 'Send Draft',
  gmail_send_message: 'Send Message',
  gmail_delete_message: 'Delete Message',
  // Drive
  drive_list_files: 'List Files',
  drive_get_file: 'Get File Info',
  drive_read_file: 'Read File',
  drive_search: 'Search Files',
  drive_create_file: 'Create File',
  drive_update_file: 'Update File',
  drive_share_file: 'Share File',
  drive_delete_file: 'Delete File',
  // Calendar
  calendar_list_events: 'List Events',
  calendar_get_event: 'Get Event',
  calendar_search_events: 'Search Events',
  calendar_list_calendars: 'List Calendars',
  calendar_create_event: 'Create Event',
  calendar_update_event: 'Update Event',
  calendar_delete_event: 'Delete Event',
  // Web Search
  web_search: 'Web Search',
  web_search_news: 'News Search',
  web_search_images: 'Image Search',
  // Browser
  browser_navigate: 'Navigate',
  browser_screenshot: 'Screenshot',
  browser_get_content: 'Get Content',
  browser_close: 'Close Tab',
  browser_click: 'Click',
  browser_type: 'Type Text',
  browser_evaluate: 'Run JavaScript',
};

const SERVICES: Array<{
  type: ServiceType;
  name: string;
  icon: React.ReactNode;
  description: string;
  readDescription?: string;
  fullDescription?: string;
  hasLevels: boolean; // true for services with read/full distinction
}> = [
  {
    type: 'gmail',
    name: 'Gmail',
    icon: <Mail className="w-5 h-5" />,
    description: 'Access to Gmail',
    readDescription: 'List and read emails',
    fullDescription: 'Read + create drafts (send blocked)',
    hasLevels: true,
  },
  {
    type: 'drive',
    name: 'Google Drive',
    icon: <HardDrive className="w-5 h-5" />,
    description: 'Access to Google Drive',
    readDescription: 'List and read files',
    fullDescription: 'Read + create/update files',
    hasLevels: true,
  },
  {
    type: 'calendar',
    name: 'Google Calendar',
    icon: <Calendar className="w-5 h-5" />,
    description: 'Access to Google Calendar',
    readDescription: 'View events and calendars',
    fullDescription: 'Read + create/update events',
    hasLevels: true,
  },
  {
    type: 'web-search',
    name: 'Web Search',
    icon: <Search className="w-5 h-5" />,
    description: 'Search the web',
    hasLevels: false,
  },
  {
    type: 'browser',
    name: 'Browser',
    icon: <Globe className="w-5 h-5" />,
    description: 'Browse websites and take screenshots',
    hasLevels: false,
  },
];

// Tool definitions for each service
const SERVICE_TOOLS: Record<ServiceType, { read: string[]; write: string[]; blocked: string[] }> = {
  gmail: {
    read: ['gmail_list_messages', 'gmail_get_message', 'gmail_search', 'gmail_list_labels'],
    write: ['gmail_create_draft', 'gmail_send_draft'],
    blocked: ['gmail_send_message', 'gmail_delete_message'],
  },
  drive: {
    read: ['drive_list_files', 'drive_get_file', 'drive_read_file', 'drive_search'],
    write: ['drive_create_file', 'drive_update_file'],
    blocked: ['drive_share_file', 'drive_delete_file'],
  },
  calendar: {
    read: ['calendar_list_events', 'calendar_get_event', 'calendar_search_events', 'calendar_list_calendars'],
    write: ['calendar_create_event', 'calendar_update_event'],
    blocked: ['calendar_delete_event'],
  },
  'web-search': {
    read: ['web_search', 'web_search_news', 'web_search_images'],
    write: [],
    blocked: [],
  },
  browser: {
    read: ['browser_navigate', 'browser_screenshot', 'browser_get_content', 'browser_close'],
    write: ['browser_click', 'browser_type'],
    blocked: ['browser_evaluate'],
  },
};

function generatePolicyYaml(
  services: Record<ServiceType, ServiceConfig>
): string {
  const enabledServices = Object.entries(services)
    .filter(([_, config]) => config.enabled)
    .map(([type, config]) => ({ type: type as ServiceType, config }));

  if (enabledServices.length === 0) {
    return `version: "1.0"
services: {}
`;
  }

  let yaml = `version: "1.0"
services:
`;

  for (const { type, config } of enabledServices) {
    const tools = SERVICE_TOOLS[type];
    const serviceInfo = SERVICES.find(s => s.type === type);
    const hasLevels = serviceInfo?.hasLevels ?? false;

    let allowList: string[];
    let blockList: string[];
    let approvalRequired: string[];

    if (config.level === 'custom' && config.customTools) {
      // Custom mode - use individual tool settings
      allowList = [];
      blockList = [];
      approvalRequired = [];

      for (const [tool, permission] of Object.entries(config.customTools)) {
        if (permission === 'allow') {
          allowList.push(tool);
        } else if (permission === 'block') {
          blockList.push(tool);
        } else if (permission === 'require_approval') {
          allowList.push(tool);
          approvalRequired.push(tool);
        }
      }
    } else if (!hasLevels) {
      // Simple on/off service - allow all tools
      allowList = [...tools.read, ...tools.write];
      blockList = tools.blocked;
      approvalRequired = tools.write;
    } else if (config.level === 'read') {
      allowList = tools.read;
      blockList = [...tools.write, ...tools.blocked];
      approvalRequired = [];
    } else {
      // Full access
      allowList = [...tools.read, ...tools.write];
      blockList = tools.blocked;
      approvalRequired = tools.write;
    }

    yaml += `  ${type}:
    tools:
      allow:
`;
    for (const tool of allowList) {
      yaml += `        - ${tool}
`;
    }

    if (blockList.length > 0) {
      yaml += `      block:
`;
      for (const tool of blockList) {
        yaml += `        - ${tool}
`;
      }
    }

    if (approvalRequired.length > 0) {
      yaml += `    approval_required:
`;
      for (const tool of approvalRequired) {
        yaml += `      - ${tool}
`;
      }
    }
  }

  return yaml;
}

const defaultServiceConfig = (): Record<ServiceType, ServiceConfig> => ({
  gmail: { enabled: false, level: 'none' },
  drive: { enabled: false, level: 'none' },
  calendar: { enabled: false, level: 'none' },
  'web-search': { enabled: false, level: 'none' },
  browser: { enabled: false, level: 'none' },
});

export default function Policies() {
  const queryClient = useQueryClient();
  const [showCreateModal, setShowCreateModal] = useState(false);
  const [editingPolicy, setEditingPolicy] = useState<Policy | null>(null);
  const [showYamlEditor, setShowYamlEditor] = useState(false);

  // Form state for new policy
  const [policyName, setPolicyName] = useState('');
  const [serviceConfigs, setServiceConfigs] = useState<Record<ServiceType, ServiceConfig>>(
    defaultServiceConfig()
  );

  const { data: policiesList, isLoading } = useQuery<Policy[]>({
    queryKey: ['policies'],
    queryFn: policies.list as () => Promise<Policy[]>,
  });

  const createMutation = useMutation({
    mutationFn: policies.create,
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['policies'] });
      setShowCreateModal(false);
      setPolicyName('');
      setServiceConfigs(defaultServiceConfig());
    },
  });

  const updateMutation = useMutation({
    mutationFn: ({ id, data }: { id: string; data: { name?: string; yaml?: string } }) =>
      policies.update(id, data),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['policies'] });
      setEditingPolicy(null);
    },
  });

  const deleteMutation = useMutation({
    mutationFn: policies.delete,
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['policies'] });
    },
  });

  const handleCreate = (e: React.FormEvent) => {
    e.preventDefault();
    const yaml = generatePolicyYaml(serviceConfigs);
    createMutation.mutate({ name: policyName, yaml });
  };

  const handleServiceToggle = (serviceType: ServiceType) => {
    const service = SERVICES.find(s => s.type === serviceType);
    const defaultLevel = service?.hasLevels ? 'read' : 'full';

    setServiceConfigs((prev) => ({
      ...prev,
      [serviceType]: {
        ...prev[serviceType],
        enabled: !prev[serviceType].enabled,
        level: !prev[serviceType].enabled ? defaultLevel : 'none',
        customTools: undefined,
      },
    }));
  };

  const handleLevelChange = (serviceType: ServiceType, level: PermissionLevel) => {
    const tools = SERVICE_TOOLS[serviceType];

    // Initialize custom tools if switching to custom mode
    let customTools: Record<string, ToolPermission> | undefined;
    if (level === 'custom') {
      customTools = {};
      // Start with "full" defaults
      for (const tool of tools.read) {
        customTools[tool] = 'allow';
      }
      for (const tool of tools.write) {
        customTools[tool] = 'require_approval';
      }
      for (const tool of tools.blocked) {
        customTools[tool] = 'block';
      }
    }

    setServiceConfigs((prev) => ({
      ...prev,
      [serviceType]: {
        ...prev[serviceType],
        level,
        enabled: level !== 'none',
        customTools,
      },
    }));
  };

  const handleToolPermissionChange = (
    serviceType: ServiceType,
    toolName: string,
    permission: ToolPermission
  ) => {
    setServiceConfigs((prev) => ({
      ...prev,
      [serviceType]: {
        ...prev[serviceType],
        customTools: {
          ...prev[serviceType].customTools,
          [toolName]: permission,
        },
      },
    }));
  };

  const enabledCount = Object.values(serviceConfigs).filter((c) => c.enabled).length;
  const generatedYaml = generatePolicyYaml(serviceConfigs);

  return (
    <div className="p-8">
      <div className="flex items-center justify-between mb-8">
        <div>
          <h1 className="text-2xl font-semibold text-reins-navy">Policies</h1>
          <p className="text-gray-500 mt-1">Define what services and tools agents can access</p>
        </div>
        <button
          onClick={() => setShowCreateModal(true)}
          className="flex items-center gap-2 bg-trust-blue text-white px-4 py-2 rounded-lg hover:bg-blue-700 transition-colors"
        >
          <Plus className="w-5 h-5" />
          Create Policy
        </button>
      </div>

      {isLoading ? (
        <div className="flex items-center justify-center py-12">
          <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-trust-blue"></div>
        </div>
      ) : !policiesList?.length ? (
        <div className="bg-white rounded-xl p-12 shadow-sm border border-gray-100 text-center">
          <FileText className="w-12 h-12 text-gray-300 mx-auto mb-4" />
          <p className="text-gray-500">No policies created yet</p>
          <p className="text-sm text-gray-400 mt-2">
            Policies define what services and tools an agent can use
          </p>
          <button
            onClick={() => setShowCreateModal(true)}
            className="mt-4 text-trust-blue hover:underline"
          >
            Create your first policy
          </button>
        </div>
      ) : (
        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-6">
          {policiesList.map((policy) => (
            <PolicyCard
              key={policy.id}
              policy={policy}
              onEdit={() => setEditingPolicy(policy)}
              onDelete={() => deleteMutation.mutate(policy.id)}
            />
          ))}
        </div>
      )}

      {/* Create Policy Modal */}
      {showCreateModal && (
        <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50">
          <div className="bg-white rounded-xl p-6 w-full max-w-2xl shadow-xl max-h-[90vh] overflow-auto">
            <div className="flex items-center justify-between mb-6">
              <div>
                <h2 className="text-lg font-semibold text-reins-navy">Create New Policy</h2>
                <p className="text-sm text-gray-500">
                  Choose which services this policy allows access to
                </p>
              </div>
              <button
                onClick={() => {
                  setShowCreateModal(false);
                  setPolicyName('');
                  setServiceConfigs(defaultServiceConfig());
                }}
                className="text-gray-400 hover:text-gray-600"
              >
                <X className="w-5 h-5" />
              </button>
            </div>

            <form onSubmit={handleCreate}>
              <div className="space-y-6">
                {/* Policy Name */}
                <div>
                  <label className="block text-sm font-medium text-gray-700 mb-1">
                    Policy Name
                  </label>
                  <input
                    type="text"
                    value={policyName}
                    onChange={(e) => setPolicyName(e.target.value)}
                    className="w-full border border-gray-300 rounded-lg px-3 py-2 focus:ring-2 focus:ring-trust-blue focus:border-transparent"
                    placeholder="e.g., Research Assistant, Email Helper"
                    required
                  />
                </div>

                {/* Services */}
                <div>
                  <label className="block text-sm font-medium text-gray-700 mb-3">
                    Services ({enabledCount} enabled)
                  </label>
                  <div className="space-y-3">
                    {SERVICES.map((service) => {
                      const config = serviceConfigs[service.type];
                      const tools = SERVICE_TOOLS[service.type];
                      const allTools = [...tools.read, ...tools.write, ...tools.blocked];

                      const getDescription = () => {
                        if (!config.enabled) return 'Not enabled';
                        if (!service.hasLevels) return service.description;
                        if (config.level === 'custom') return 'Custom tool permissions';
                        return config.level === 'read' ? service.readDescription : service.fullDescription;
                      };

                      return (
                        <div
                          key={service.type}
                          className={`border-2 rounded-lg transition-colors ${
                            config.enabled
                              ? 'border-trust-blue bg-trust-blue/5'
                              : 'border-gray-200 bg-white'
                          }`}
                        >
                          <div
                            onClick={() => handleServiceToggle(service.type)}
                            className="flex items-center gap-3 p-4 cursor-pointer"
                          >
                            <div
                              className={`p-2 rounded-lg ${
                                config.enabled
                                  ? 'bg-trust-blue text-white'
                                  : 'bg-gray-100 text-gray-400'
                              }`}
                            >
                              {service.icon}
                            </div>
                            <div className="flex-1">
                              <div className="font-medium text-reins-navy">{service.name}</div>
                              <div className="text-sm text-gray-500">
                                {getDescription()}
                              </div>
                            </div>
                            <div
                              className={`w-5 h-5 rounded border-2 flex items-center justify-center ${
                                config.enabled
                                  ? 'border-trust-blue bg-trust-blue'
                                  : 'border-gray-300'
                              }`}
                            >
                              {config.enabled && <Check className="w-3 h-3 text-white" />}
                            </div>
                          </div>

                          {/* Permission Level Selector - only for services with levels */}
                          {config.enabled && service.hasLevels && (
                            <div className="px-4 pb-4 pt-0 space-y-3">
                              <div className="flex gap-2">
                                <button
                                  type="button"
                                  onClick={(e) => {
                                    e.stopPropagation();
                                    handleLevelChange(service.type, 'read');
                                  }}
                                  className={`flex-1 py-2 px-3 rounded-lg text-sm font-medium transition-colors ${
                                    config.level === 'read'
                                      ? 'bg-trust-blue text-white'
                                      : 'bg-gray-100 text-gray-600 hover:bg-gray-200'
                                  }`}
                                >
                                  Read-Only
                                </button>
                                <button
                                  type="button"
                                  onClick={(e) => {
                                    e.stopPropagation();
                                    handleLevelChange(service.type, 'full');
                                  }}
                                  className={`flex-1 py-2 px-3 rounded-lg text-sm font-medium transition-colors ${
                                    config.level === 'full'
                                      ? 'bg-trust-blue text-white'
                                      : 'bg-gray-100 text-gray-600 hover:bg-gray-200'
                                  }`}
                                >
                                  Full Access
                                </button>
                                <button
                                  type="button"
                                  onClick={(e) => {
                                    e.stopPropagation();
                                    handleLevelChange(service.type, 'custom');
                                  }}
                                  className={`flex-1 py-2 px-3 rounded-lg text-sm font-medium transition-colors ${
                                    config.level === 'custom'
                                      ? 'bg-caution-amber text-white'
                                      : 'bg-gray-100 text-gray-600 hover:bg-gray-200'
                                  }`}
                                >
                                  Custom
                                </button>
                              </div>

                              {/* Custom Tool Permissions */}
                              {config.level === 'custom' && config.customTools && (
                                <div className="bg-white rounded-lg border border-gray-200 p-3 space-y-2">
                                  {allTools.map((tool) => {
                                    const permission = config.customTools?.[tool] || 'block';
                                    return (
                                      <div
                                        key={tool}
                                        className="flex items-center justify-between py-1"
                                        onClick={(e) => e.stopPropagation()}
                                      >
                                        <span className="text-sm text-gray-700">
                                          {TOOL_LABELS[tool] || tool}
                                        </span>
                                        <select
                                          value={permission}
                                          onChange={(e) =>
                                            handleToolPermissionChange(
                                              service.type,
                                              tool,
                                              e.target.value as ToolPermission
                                            )
                                          }
                                          className={`text-xs font-medium px-2 py-1 rounded border ${
                                            permission === 'allow'
                                              ? 'bg-safe-green/10 text-safe-green border-safe-green/30'
                                              : permission === 'require_approval'
                                              ? 'bg-caution-amber/10 text-caution-amber border-caution-amber/30'
                                              : 'bg-alert-red/10 text-alert-red border-alert-red/30'
                                          }`}
                                        >
                                          <option value="allow">Allow</option>
                                          <option value="require_approval">Approval</option>
                                          <option value="block">Block</option>
                                        </select>
                                      </div>
                                    );
                                  })}
                                </div>
                              )}
                            </div>
                          )}

                          {/* Custom mode for simple on/off services */}
                          {config.enabled && !service.hasLevels && (
                            <div className="px-4 pb-4 pt-0">
                              <button
                                type="button"
                                onClick={(e) => {
                                  e.stopPropagation();
                                  handleLevelChange(service.type, config.level === 'custom' ? 'full' : 'custom');
                                }}
                                className={`w-full py-2 px-3 rounded-lg text-sm font-medium transition-colors ${
                                  config.level === 'custom'
                                    ? 'bg-caution-amber text-white'
                                    : 'bg-gray-100 text-gray-600 hover:bg-gray-200'
                                }`}
                              >
                                {config.level === 'custom' ? 'Using Custom Permissions' : 'Customize Tools'}
                              </button>

                              {config.level === 'custom' && config.customTools && (
                                <div className="mt-3 bg-white rounded-lg border border-gray-200 p-3 space-y-2">
                                  {allTools.map((tool) => {
                                    const permission = config.customTools?.[tool] || 'block';
                                    return (
                                      <div
                                        key={tool}
                                        className="flex items-center justify-between py-1"
                                        onClick={(e) => e.stopPropagation()}
                                      >
                                        <span className="text-sm text-gray-700">
                                          {TOOL_LABELS[tool] || tool}
                                        </span>
                                        <select
                                          value={permission}
                                          onChange={(e) =>
                                            handleToolPermissionChange(
                                              service.type,
                                              tool,
                                              e.target.value as ToolPermission
                                            )
                                          }
                                          className={`text-xs font-medium px-2 py-1 rounded border ${
                                            permission === 'allow'
                                              ? 'bg-safe-green/10 text-safe-green border-safe-green/30'
                                              : permission === 'require_approval'
                                              ? 'bg-caution-amber/10 text-caution-amber border-caution-amber/30'
                                              : 'bg-alert-red/10 text-alert-red border-alert-red/30'
                                          }`}
                                        >
                                          <option value="allow">Allow</option>
                                          <option value="require_approval">Approval</option>
                                          <option value="block">Block</option>
                                        </select>
                                      </div>
                                    );
                                  })}
                                </div>
                              )}
                            </div>
                          )}
                        </div>
                      );
                    })}
                  </div>
                </div>

                {/* Show YAML Toggle */}
                <div className="border border-gray-200 rounded-lg">
                  <button
                    type="button"
                    onClick={() => setShowYamlEditor(!showYamlEditor)}
                    className="w-full flex items-center justify-between p-3 text-left hover:bg-gray-50"
                  >
                    <div className="flex items-center gap-2 text-sm text-gray-600">
                      {showYamlEditor ? (
                        <ChevronDown className="w-4 h-4" />
                      ) : (
                        <ChevronRight className="w-4 h-4" />
                      )}
                      View generated YAML
                    </div>
                  </button>
                  {showYamlEditor && (
                    <div className="border-t border-gray-200 p-3">
                      <pre className="text-xs bg-gray-50 p-3 rounded-lg overflow-auto max-h-48 font-mono text-gray-700">
                        {generatedYaml}
                      </pre>
                    </div>
                  )}
                </div>
              </div>

              <div className="flex justify-end gap-3 mt-6 pt-4 border-t border-gray-100">
                <button
                  type="button"
                  onClick={() => {
                    setShowCreateModal(false);
                    setPolicyName('');
                    setServiceConfigs(defaultServiceConfig());
                  }}
                  className="px-4 py-2 text-gray-700 hover:bg-gray-100 rounded-lg"
                >
                  Cancel
                </button>
                <button
                  type="submit"
                  disabled={createMutation.isPending || enabledCount === 0}
                  className="px-4 py-2 bg-trust-blue text-white rounded-lg hover:bg-blue-700 disabled:opacity-50 disabled:cursor-not-allowed"
                >
                  {createMutation.isPending ? 'Creating...' : 'Create Policy'}
                </button>
              </div>
            </form>
          </div>
        </div>
      )}

      {/* Edit Modal (YAML editor for advanced users) */}
      {editingPolicy && (
        <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50">
          <div className="bg-white rounded-xl p-6 w-full max-w-2xl shadow-xl max-h-[90vh] overflow-auto">
            <div className="flex items-center justify-between mb-4">
              <h2 className="text-lg font-semibold text-reins-navy">Edit Policy</h2>
              <button
                onClick={() => setEditingPolicy(null)}
                className="text-gray-400 hover:text-gray-600"
              >
                <X className="w-5 h-5" />
              </button>
            </div>
            <form
              onSubmit={(e) => {
                e.preventDefault();
                updateMutation.mutate({
                  id: editingPolicy.id,
                  data: { name: editingPolicy.name, yaml: editingPolicy.yaml },
                });
              }}
            >
              <div className="space-y-4">
                <div>
                  <label className="block text-sm font-medium text-gray-700 mb-1">Name</label>
                  <input
                    type="text"
                    value={editingPolicy.name}
                    onChange={(e) => setEditingPolicy({ ...editingPolicy, name: e.target.value })}
                    className="w-full border border-gray-300 rounded-lg px-3 py-2 focus:ring-2 focus:ring-trust-blue focus:border-transparent"
                    required
                  />
                </div>
                <div>
                  <label className="block text-sm font-medium text-gray-700 mb-1">
                    Policy YAML
                  </label>
                  <textarea
                    value={editingPolicy.yaml}
                    onChange={(e) => setEditingPolicy({ ...editingPolicy, yaml: e.target.value })}
                    className="w-full border border-gray-300 rounded-lg px-3 py-2 font-mono text-sm focus:ring-2 focus:ring-trust-blue focus:border-transparent"
                    rows={15}
                    required
                  />
                </div>
              </div>
              <div className="flex justify-end gap-3 mt-6">
                <button
                  type="button"
                  onClick={() => setEditingPolicy(null)}
                  className="px-4 py-2 text-gray-700 hover:bg-gray-100 rounded-lg"
                >
                  Cancel
                </button>
                <button
                  type="submit"
                  disabled={updateMutation.isPending}
                  className="px-4 py-2 bg-trust-blue text-white rounded-lg hover:bg-blue-700 disabled:opacity-50"
                >
                  {updateMutation.isPending ? 'Saving...' : 'Save Changes'}
                </button>
              </div>
            </form>
          </div>
        </div>
      )}
    </div>
  );
}

// Policy Card Component
function PolicyCard({
  policy,
  onEdit,
  onDelete,
}: {
  policy: Policy;
  onEdit: () => void;
  onDelete: () => void;
}) {
  // Parse the YAML to show enabled services
  const enabledServices: string[] = [];
  try {
    const lines = policy.yaml.split('\n');
    let inServices = false;
    for (const line of lines) {
      if (line.trim() === 'services:') {
        inServices = true;
        continue;
      }
      if (inServices && line.match(/^\s{2}\w/)) {
        const serviceName = line.trim().replace(':', '');
        const service = SERVICES.find((s) => s.type === serviceName);
        if (service) {
          enabledServices.push(service.name);
        }
      }
    }
  } catch {
    // Ignore parsing errors
  }

  return (
    <div className="bg-white rounded-xl p-6 shadow-sm border border-gray-100 hover:shadow-md transition-shadow">
      <div className="flex items-start justify-between mb-4">
        <div>
          <h3 className="font-semibold text-lg text-reins-navy">{policy.name}</h3>
          <p className="text-sm text-gray-500">v{policy.version}</p>
        </div>
        <div className="flex gap-1">
          <button
            onClick={onEdit}
            className="p-1.5 text-gray-400 hover:text-trust-blue hover:bg-gray-100 rounded"
          >
            <Edit className="w-4 h-4" />
          </button>
          <button
            onClick={onDelete}
            className="p-1.5 text-gray-400 hover:text-alert-red hover:bg-gray-100 rounded"
          >
            <Trash2 className="w-4 h-4" />
          </button>
        </div>
      </div>

      {/* Enabled Services */}
      <div className="flex flex-wrap gap-2 mb-4">
        {enabledServices.length > 0 ? (
          enabledServices.map((name) => (
            <span
              key={name}
              className="inline-flex items-center gap-1 px-2 py-1 bg-trust-blue/10 text-trust-blue text-xs font-medium rounded"
            >
              <Shield className="w-3 h-3" />
              {name}
            </span>
          ))
        ) : (
          <span className="text-xs text-gray-400">No services configured</span>
        )}
      </div>

      <div className="text-xs text-gray-400">
        Updated {new Date(policy.updatedAt).toLocaleDateString()}
      </div>
    </div>
  );
}
