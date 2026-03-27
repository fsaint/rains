import { useState, useEffect, useRef, useCallback } from 'react';
import { X, RefreshCw, ArrowDown } from 'lucide-react';
import { agents } from '../api/client';

interface LogEntry {
  timestamp: string;
  message: string;
  level: string;
  instance: string;
  region: string;
}

interface LogsPanelProps {
  agentId: string;
  agentName: string;
  onClose: () => void;
}

const LEVEL_COLORS: Record<string, string> = {
  error: 'text-red-400',
  warn: 'text-yellow-400',
  warning: 'text-yellow-400',
  info: 'text-blue-400',
  debug: 'text-gray-500',
};

export function LogsPanel({ agentId, agentName, onClose }: LogsPanelProps) {
  const [logs, setLogs] = useState<LogEntry[]>([]);
  const [, setNextToken] = useState<string | undefined>();
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [autoScroll, setAutoScroll] = useState(true);
  const [polling, setPolling] = useState(true);
  const scrollRef = useRef<HTMLDivElement>(null);
  const tokenRef = useRef<string | undefined>();

  const fetchLogs = useCallback(async (token?: string) => {
    try {
      const result = await agents.getLogs(agentId, token);
      if (result.logs.length > 0) {
        setLogs(prev => [...prev, ...result.logs]);
      }
      tokenRef.current = result.nextToken;
      setNextToken(result.nextToken);
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to fetch logs');
    } finally {
      setLoading(false);
    }
  }, [agentId]);

  // Initial fetch
  useEffect(() => {
    fetchLogs();
  }, [fetchLogs]);

  // Polling for new logs
  useEffect(() => {
    if (!polling) return;
    const interval = setInterval(() => {
      if (tokenRef.current) {
        fetchLogs(tokenRef.current);
      }
    }, 3000);
    return () => clearInterval(interval);
  }, [polling, fetchLogs]);

  // Auto-scroll
  useEffect(() => {
    if (autoScroll && scrollRef.current) {
      scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
    }
  }, [logs, autoScroll]);

  const handleScroll = () => {
    if (!scrollRef.current) return;
    const { scrollTop, scrollHeight, clientHeight } = scrollRef.current;
    setAutoScroll(scrollHeight - scrollTop - clientHeight < 50);
  };

  const formatTime = (ts: string) => {
    try {
      return new Date(ts).toLocaleTimeString('en-US', { hour12: false, fractionalSecondDigits: 3 });
    } catch {
      return ts;
    }
  };

  return (
    <div className="fixed inset-0 bg-reins-navy/80 backdrop-blur-sm flex items-center justify-center z-[60]">
      <div className="bg-gray-950 rounded-2xl w-full max-w-4xl h-[80vh] shadow-2xl border border-gray-800 flex flex-col">
        {/* Header */}
        <div className="flex items-center justify-between px-5 py-3 border-b border-gray-800">
          <div className="flex items-center gap-3">
            <h2 className="text-sm font-semibold text-gray-200">Logs</h2>
            <span className="text-xs text-gray-500 font-mono">{agentName}</span>
            {polling && (
              <span className="flex items-center gap-1 text-xs text-emerald-500">
                <span className="w-1.5 h-1.5 bg-emerald-500 rounded-full animate-pulse" />
                live
              </span>
            )}
          </div>
          <div className="flex items-center gap-2">
            <button
              onClick={() => setPolling(!polling)}
              className={`px-2.5 py-1 text-xs rounded-md transition-colors ${
                polling
                  ? 'bg-emerald-900/50 text-emerald-400 hover:bg-emerald-900/70'
                  : 'bg-gray-800 text-gray-400 hover:bg-gray-700'
              }`}
            >
              {polling ? 'Pause' : 'Resume'}
            </button>
            <button
              onClick={() => { setLogs([]); tokenRef.current = undefined; setLoading(true); fetchLogs(); }}
              className="p-1.5 text-gray-500 hover:text-gray-300 transition-colors"
              title="Refresh"
            >
              <RefreshCw className="w-3.5 h-3.5" />
            </button>
            <button onClick={onClose} className="p-1.5 text-gray-500 hover:text-gray-300 transition-colors">
              <X className="w-4 h-4" />
            </button>
          </div>
        </div>

        {/* Logs */}
        <div
          ref={scrollRef}
          onScroll={handleScroll}
          className="flex-1 overflow-y-auto font-mono text-xs leading-5 p-4"
        >
          {loading && logs.length === 0 ? (
            <div className="flex items-center justify-center h-full text-gray-600">
              Loading logs...
            </div>
          ) : error && logs.length === 0 ? (
            <div className="flex items-center justify-center h-full text-red-500">
              {error}
            </div>
          ) : logs.length === 0 ? (
            <div className="flex items-center justify-center h-full text-gray-600">
              No logs available yet
            </div>
          ) : (
            logs.map((log, i) => (
              <div key={i} className="flex gap-2 hover:bg-gray-900/50 px-1 -mx-1 rounded">
                <span className="text-gray-600 shrink-0 select-none">{formatTime(log.timestamp)}</span>
                <span className={`shrink-0 w-12 text-right select-none ${LEVEL_COLORS[log.level] || 'text-gray-500'}`}>
                  {log.level}
                </span>
                <span className="text-gray-300 break-all whitespace-pre-wrap">{log.message}</span>
              </div>
            ))
          )}
        </div>

        {/* Footer */}
        {!autoScroll && (
          <button
            onClick={() => {
              setAutoScroll(true);
              scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight, behavior: 'smooth' });
            }}
            className="absolute bottom-16 right-8 flex items-center gap-1 px-3 py-1.5 bg-gray-800 text-gray-300 text-xs rounded-full border border-gray-700 shadow-lg hover:bg-gray-700 transition-colors"
          >
            <ArrowDown className="w-3 h-3" />
            Scroll to bottom
          </button>
        )}

        <div className="px-5 py-2 border-t border-gray-800 text-xs text-gray-600">
          {logs.length} log entries
        </div>
      </div>
    </div>
  );
}
