import { useEffect, useRef, useState } from 'react';
import { X, Download, Trash2 } from 'lucide-react';

interface LogViewerProps {
  agentId: string;
  agentName: string;
  streamUrl: string;
  onClose: () => void;
}

export default function LogViewer({ agentId: _agentId, agentName, streamUrl, onClose }: LogViewerProps) {
  const [lines, setLines] = useState<string[]>([]);
  const [connected, setConnected] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const bottomRef = useRef<HTMLDivElement>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const autoScrollRef = useRef(true);

  useEffect(() => {
    setLines([]);
    const es = new EventSource(streamUrl, { withCredentials: true });

    es.onopen = () => { setConnected(true); setError(null); };

    es.onmessage = (e) => {
      const line = e.data.replace(/\\n/g, '\n');
      setLines((prev) => [...prev.slice(-2000), line]); // keep last 2000 lines
    };

    es.onerror = () => {
      setConnected(false);
      setError('Connection lost. Logs may have stopped.');
      es.close();
    };

    return () => es.close();
  }, [streamUrl]);

  // Auto-scroll to bottom when new lines arrive
  useEffect(() => {
    if (autoScrollRef.current) {
      bottomRef.current?.scrollIntoView({ behavior: 'instant' });
    }
  }, [lines]);

  const handleScroll = () => {
    const el = containerRef.current;
    if (!el) return;
    const nearBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 60;
    autoScrollRef.current = nearBottom;
  };

  const handleDownload = () => {
    const blob = new Blob([lines.join('\n')], { type: 'text/plain' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `${agentName}-logs.txt`;
    a.click();
    URL.revokeObjectURL(url);
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm p-4">
      <div className="w-full max-w-5xl h-[80vh] flex flex-col bg-gray-950 rounded-xl border border-gray-800 shadow-2xl overflow-hidden">
        {/* Header */}
        <div className="flex items-center justify-between px-4 py-3 border-b border-gray-800 bg-gray-900 shrink-0">
          <div className="flex items-center gap-3">
            <div className={`w-2 h-2 rounded-full ${connected ? 'bg-emerald-400 animate-pulse' : 'bg-gray-500'}`} />
            <span className="text-sm font-mono text-gray-200">{agentName} — live logs</span>
            {error && <span className="text-xs text-amber-400">{error}</span>}
          </div>
          <div className="flex items-center gap-1">
            <button
              onClick={() => setLines([])}
              className="p-1.5 text-gray-500 hover:text-gray-300 hover:bg-gray-800 rounded transition-colors"
              title="Clear"
            >
              <Trash2 className="w-4 h-4" />
            </button>
            <button
              onClick={handleDownload}
              className="p-1.5 text-gray-500 hover:text-gray-300 hover:bg-gray-800 rounded transition-colors"
              title="Download"
            >
              <Download className="w-4 h-4" />
            </button>
            <button
              onClick={onClose}
              className="p-1.5 text-gray-500 hover:text-gray-300 hover:bg-gray-800 rounded transition-colors"
            >
              <X className="w-4 h-4" />
            </button>
          </div>
        </div>

        {/* Log output */}
        <div
          ref={containerRef}
          onScroll={handleScroll}
          className="flex-1 overflow-y-auto p-4 font-mono text-xs text-gray-300 leading-relaxed"
        >
          {lines.length === 0 && (
            <p className="text-gray-600 italic">Waiting for logs…</p>
          )}
          {lines.map((line, i) => (
            <div key={i} className="whitespace-pre-wrap break-all hover:bg-gray-900/50 px-1 rounded">
              {line}
            </div>
          ))}
          <div ref={bottomRef} />
        </div>

        {/* Footer */}
        <div className="px-4 py-2 border-t border-gray-800 bg-gray-900 shrink-0">
          <span className="text-xs text-gray-600">{lines.length} lines</span>
        </div>
      </div>
    </div>
  );
}
