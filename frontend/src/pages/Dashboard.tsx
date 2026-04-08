import { useQuery } from '@tanstack/react-query';
import { Users, Key, CheckCircle, Activity, AlertTriangle } from 'lucide-react';
import { agents, credentials, approvals, audit, connections } from '../api/client';

interface StatCardProps {
  title: string;
  value: string | number;
  icon: React.ReactNode;
  color: string;
  subtitle?: string;
}

function StatCard({ title, value, icon, color, subtitle }: StatCardProps) {
  return (
    <div className="bg-white rounded-xl p-6 shadow-sm border border-gray-100">
      <div className="flex items-start justify-between">
        <div>
          <p className="text-sm text-gray-500 font-medium">{title}</p>
          <p className="text-3xl font-semibold mt-1">{value}</p>
          {subtitle && <p className="text-xs text-gray-400 mt-1">{subtitle}</p>}
        </div>
        <div className={`p-3 rounded-lg ${color}`}>
          {icon}
        </div>
      </div>
    </div>
  );
}

interface ActivityItemProps {
  type: string;
  tool?: string;
  agentId?: string;
  result?: string;
  timestamp: Date;
}

function ActivityItem({ type, tool, agentId, result, timestamp }: ActivityItemProps) {
  const resultColors: Record<string, string> = {
    success: 'text-safe-green',
    blocked: 'text-alert-red',
    error: 'text-caution-amber',
    pending: 'text-gray-500',
  };

  const timeLabel = (() => {
    if (!timestamp) return '';
    const d = new Date(timestamp);
    return isNaN(d.getTime()) ? '' : d.toLocaleTimeString();
  })();

  const typeLabel = type
    ? (type === 'tool_call' ? `Tool: ${tool ?? ''}` : type.replace(/_/g, ' '))
    : 'event';

  return (
    <div className="flex items-center gap-4 py-3 border-b border-gray-100 last:border-0">
      <div className={`w-2 h-2 rounded-full ${result === 'success' ? 'bg-safe-green' : result === 'blocked' ? 'bg-alert-red' : 'bg-caution-amber'}`} />
      <div className="flex-1 min-w-0">
        <p className="text-sm font-medium truncate">{typeLabel}</p>
        <p className="text-xs text-gray-500">{agentId || 'System'}</p>
      </div>
      <div className="text-right">
        <p className={`text-sm font-medium ${resultColors[result || 'pending']}`}>
          {result || 'pending'}
        </p>
        <p className="text-xs text-gray-400">{timeLabel}</p>
      </div>
    </div>
  );
}

export default function Dashboard() {
  const { data: agentsList } = useQuery({
    queryKey: ['agents'],
    queryFn: agents.list,
  });

  const { data: credentialsList } = useQuery({
    queryKey: ['credentials'],
    queryFn: credentials.list,
  });

  const { data: approvalsList } = useQuery({
    queryKey: ['approvals'],
    queryFn: () => approvals.list(),
  });

  const { data: connectionsList } = useQuery({
    queryKey: ['connections'],
    queryFn: connections.list,
  });

  const { data: recentActivity } = useQuery({
    queryKey: ['audit', 'recent'],
    queryFn: () => audit.query({ limit: 10 }),
  });

  const activeAgents = (agentsList as Array<{ status: string }> || []).filter(a => a.status === 'active').length;
  const pendingApprovals = (approvalsList as unknown[] || []).length;

  return (
    <div className="p-8">
      <div className="mb-8">
        <h1 className="text-2xl font-semibold text-reins-navy">Dashboard</h1>
        <p className="text-gray-500 mt-1">Overview of your AI agent trust layer</p>
      </div>

      {/* Stats Grid */}
      <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-6 mb-8">
        <StatCard
          title="Active Agents"
          value={activeAgents}
          subtitle={`${(agentsList as unknown[] || []).length} total`}
          icon={<Users className="w-6 h-6 text-white" />}
          color="bg-trust-blue"
        />
        <StatCard
          title="Credentials"
          value={(credentialsList as unknown[] || []).length}
          icon={<Key className="w-6 h-6 text-white" />}
          color="bg-reins-navy"
        />
        <StatCard
          title="Pending Approvals"
          value={pendingApprovals}
          icon={pendingApprovals > 0 ? <AlertTriangle className="w-6 h-6 text-white" /> : <CheckCircle className="w-6 h-6 text-white" />}
          color={pendingApprovals > 0 ? 'bg-caution-amber' : 'bg-safe-green'}
        />
      </div>

      {/* Active Connections & Recent Activity */}
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
        {/* Active Connections */}
        <div className="bg-white rounded-xl p-6 shadow-sm border border-gray-100">
          <div className="flex items-center gap-2 mb-4">
            <Activity className="w-5 h-5 text-trust-blue" />
            <h2 className="text-lg font-semibold">Active Connections</h2>
          </div>
          {(connectionsList as Array<{ id: string; agentId: string; serverId: string; toolCount: number }> || []).length === 0 ? (
            <p className="text-gray-500 text-sm py-8 text-center">No active connections</p>
          ) : (
            <div className="space-y-3">
              {(connectionsList as Array<{ id: string; agentId: string; serverId: string; toolCount: number }> || []).map((conn) => (
                <div key={conn.id} className="flex items-center justify-between py-2 border-b border-gray-100 last:border-0">
                  <div>
                    <p className="font-medium text-sm">{conn.agentId}</p>
                    <p className="text-xs text-gray-500">{conn.serverId}</p>
                  </div>
                  <span className="text-xs bg-gray-100 px-2 py-1 rounded">
                    {conn.toolCount} tools
                  </span>
                </div>
              ))}
            </div>
          )}
        </div>

        {/* Recent Activity */}
        <div className="bg-white rounded-xl p-6 shadow-sm border border-gray-100">
          <div className="flex items-center gap-2 mb-4">
            <Activity className="w-5 h-5 text-trust-blue" />
            <h2 className="text-lg font-semibold">Recent Activity</h2>
          </div>
          {!recentActivity || (recentActivity as { data: unknown[] }).data?.length === 0 ? (
            <p className="text-gray-500 text-sm py-8 text-center">No recent activity</p>
          ) : (
            <div>
              {((recentActivity as { data: Array<ActivityItemProps> })?.data || []).slice(0, 5).map((entry, i) => (
                <ActivityItem key={i} {...entry} />
              ))}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
