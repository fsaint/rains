import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Activity, Filter, Download, ChevronLeft, ChevronRight } from 'lucide-react';
import { audit } from '../api/client';

interface AuditEntry {
  id: number;
  timestamp: string;
  eventType: string;
  agentId?: string;
  tool?: string;
  arguments?: Record<string, unknown>;
  result?: string;
  durationMs?: number;
  metadata?: Record<string, unknown>;
}

interface AuditResponse {
  data: AuditEntry[];
  pagination: {
    total: number;
    limit: number;
    offset: number;
    hasMore: boolean;
  };
}

export default function AuditLog() {
  const [filters, setFilters] = useState({
    eventType: '',
    agentId: '',
    result: '',
    limit: 50,
    offset: 0,
  });

  const { data, isLoading } = useQuery<AuditResponse>({
    queryKey: ['audit', filters],
    queryFn: () => audit.query(filters) as Promise<AuditResponse>,
  });

  const resultColors: Record<string, string> = {
    success: 'bg-safe-green/10 text-safe-green',
    blocked: 'bg-alert-red/10 text-alert-red',
    error: 'bg-caution-amber/10 text-caution-amber',
    pending: 'bg-gray-100 text-gray-600',
  };

  const eventTypeLabels: Record<string, string> = {
    tool_call: 'Tool Call',
    approval: 'Approval',
    policy_change: 'Policy Change',
    auth: 'Authentication',
    connection: 'Connection',
    agent_event: 'Agent Event',
  };

  const handlePrevPage = () => {
    setFilters((f) => ({ ...f, offset: Math.max(0, f.offset - f.limit) }));
  };

  const handleNextPage = () => {
    if (data?.pagination.hasMore) {
      setFilters((f) => ({ ...f, offset: f.offset + f.limit }));
    }
  };

  const exportAsCsv = () => {
    if (!data?.data) return;

    const headers = ['Timestamp', 'Event Type', 'Agent', 'Tool', 'Result', 'Duration (ms)'];
    const rows = data.data.map((entry) => [
      new Date(entry.timestamp).toISOString(),
      entry.eventType,
      entry.agentId || '',
      entry.tool || '',
      entry.result || '',
      entry.durationMs?.toString() || '',
    ]);

    const csv = [headers, ...rows].map((row) => row.join(',')).join('\n');
    const blob = new Blob([csv], { type: 'text/csv' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `reins-audit-${new Date().toISOString().split('T')[0]}.csv`;
    a.click();
    URL.revokeObjectURL(url);
  };

  return (
    <div className="p-8">
      <div className="flex items-center justify-between mb-8">
        <div>
          <h1 className="text-2xl font-semibold text-reins-navy">Audit Log</h1>
          <p className="text-gray-500 mt-1">View all agent activity and system events</p>
        </div>
        <button
          onClick={exportAsCsv}
          className="flex items-center gap-2 border border-gray-300 text-gray-700 px-4 py-2 rounded-lg hover:bg-gray-50 transition-colors"
        >
          <Download className="w-5 h-5" />
          Export CSV
        </button>
      </div>

      {/* Filters */}
      <div className="bg-white rounded-xl p-4 shadow-sm border border-gray-100 mb-6">
        <div className="flex items-center gap-4 flex-wrap">
          <div className="flex items-center gap-2">
            <Filter className="w-4 h-4 text-gray-400" />
            <span className="text-sm font-medium text-gray-600">Filters:</span>
          </div>
          <select
            value={filters.eventType}
            onChange={(e) => setFilters({ ...filters, eventType: e.target.value, offset: 0 })}
            className="border border-gray-300 rounded-lg px-3 py-1.5 text-sm"
          >
            <option value="">All Events</option>
            <option value="tool_call">Tool Calls</option>
            <option value="approval">Approvals</option>
            <option value="agent_event">Agent Events</option>
            <option value="auth">Authentication</option>
            <option value="connection">Connections</option>
          </select>
          <select
            value={filters.result}
            onChange={(e) => setFilters({ ...filters, result: e.target.value, offset: 0 })}
            className="border border-gray-300 rounded-lg px-3 py-1.5 text-sm"
          >
            <option value="">All Results</option>
            <option value="success">Success</option>
            <option value="blocked">Blocked</option>
            <option value="error">Error</option>
          </select>
          <input
            type="text"
            value={filters.agentId}
            onChange={(e) => setFilters({ ...filters, agentId: e.target.value, offset: 0 })}
            placeholder="Filter by Agent ID..."
            className="border border-gray-300 rounded-lg px-3 py-1.5 text-sm w-48"
          />
          {(filters.eventType || filters.result || filters.agentId) && (
            <button
              onClick={() => setFilters({ eventType: '', agentId: '', result: '', limit: 50, offset: 0 })}
              className="text-sm text-trust-blue hover:underline"
            >
              Clear filters
            </button>
          )}
        </div>
      </div>

      {isLoading ? (
        <div className="flex items-center justify-center py-12">
          <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-trust-blue"></div>
        </div>
      ) : !data?.data?.length ? (
        <div className="bg-white rounded-xl p-12 shadow-sm border border-gray-100 text-center">
          <Activity className="w-12 h-12 text-gray-300 mx-auto mb-4" />
          <p className="text-gray-500">No audit entries found</p>
        </div>
      ) : (
        <>
          <div className="bg-white rounded-xl shadow-sm border border-gray-100 overflow-hidden">
            <table className="w-full">
              <thead className="bg-gray-50 border-b border-gray-100">
                <tr>
                  <th className="text-left px-6 py-3 text-xs font-medium text-gray-500 uppercase tracking-wider">Timestamp</th>
                  <th className="text-left px-6 py-3 text-xs font-medium text-gray-500 uppercase tracking-wider">Event</th>
                  <th className="text-left px-6 py-3 text-xs font-medium text-gray-500 uppercase tracking-wider">Agent</th>
                  <th className="text-left px-6 py-3 text-xs font-medium text-gray-500 uppercase tracking-wider">Tool</th>
                  <th className="text-left px-6 py-3 text-xs font-medium text-gray-500 uppercase tracking-wider">Result</th>
                  <th className="text-left px-6 py-3 text-xs font-medium text-gray-500 uppercase tracking-wider">Duration</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-gray-100">
                {data.data.map((entry) => (
                  <tr key={entry.id} className="hover:bg-gray-50">
                    <td className="px-6 py-4 text-sm text-gray-500">
                      {new Date(entry.timestamp).toLocaleString()}
                    </td>
                    <td className="px-6 py-4">
                      <span className="text-sm font-medium">
                        {eventTypeLabels[entry.eventType] || entry.eventType}
                      </span>
                    </td>
                    <td className="px-6 py-4 text-sm font-mono">
                      {entry.agentId || '-'}
                    </td>
                    <td className="px-6 py-4 text-sm font-mono">
                      {entry.tool || '-'}
                    </td>
                    <td className="px-6 py-4">
                      {entry.result ? (
                        <span className={`inline-flex px-2 py-1 text-xs font-medium rounded-full ${resultColors[entry.result]}`}>
                          {entry.result}
                        </span>
                      ) : (
                        '-'
                      )}
                    </td>
                    <td className="px-6 py-4 text-sm text-gray-500">
                      {entry.durationMs ? `${entry.durationMs}ms` : '-'}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          {/* Pagination */}
          <div className="flex items-center justify-between mt-4">
            <p className="text-sm text-gray-500">
              Showing {filters.offset + 1} - {Math.min(filters.offset + data.data.length, data.pagination.total)} of {data.pagination.total}
            </p>
            <div className="flex items-center gap-2">
              <button
                onClick={handlePrevPage}
                disabled={filters.offset === 0}
                className="p-2 border border-gray-300 rounded-lg disabled:opacity-50 hover:bg-gray-50"
              >
                <ChevronLeft className="w-4 h-4" />
              </button>
              <button
                onClick={handleNextPage}
                disabled={!data.pagination.hasMore}
                className="p-2 border border-gray-300 rounded-lg disabled:opacity-50 hover:bg-gray-50"
              >
                <ChevronRight className="w-4 h-4" />
              </button>
            </div>
          </div>
        </>
      )}
    </div>
  );
}
