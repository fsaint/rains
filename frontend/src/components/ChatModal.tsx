import { useEffect, useState } from 'react';
import { X, Loader2, ExternalLink, AlertCircle } from 'lucide-react';
import { agents } from '../api/client';

interface ChatModalProps {
  agentId: string;
  agentName: string;
  onClose: () => void;
}

export default function ChatModal({ agentId, agentName, onClose }: ChatModalProps) {
  const [url, setUrl] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    agents.getManagementUrl(agentId)
      .then((res) => { setUrl(res.url); })
      .catch((err) => { setError(err.message || 'Could not load chat URL'); })
      .finally(() => setLoading(false));
  }, [agentId]);

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm p-4">
      <div className="w-full max-w-5xl h-[90vh] flex flex-col bg-white rounded-xl border border-gray-200 shadow-2xl overflow-hidden">
        {/* Header */}
        <div className="flex items-center justify-between px-4 py-3 border-b border-gray-200 bg-white shrink-0">
          <div className="flex items-center gap-2">
            <div className="w-2 h-2 rounded-full bg-emerald-400 animate-pulse" />
            <span className="text-sm font-medium text-gray-800">{agentName}</span>
          </div>
          <div className="flex items-center gap-1">
            {url && (
              <a
                href={url}
                target="_blank"
                rel="noopener noreferrer"
                className="p-1.5 text-gray-400 hover:text-gray-700 hover:bg-gray-100 rounded transition-colors"
                title="Open in new tab"
              >
                <ExternalLink className="w-4 h-4" />
              </a>
            )}
            <button
              onClick={onClose}
              className="p-1.5 text-gray-400 hover:text-gray-700 hover:bg-gray-100 rounded transition-colors"
            >
              <X className="w-4 h-4" />
            </button>
          </div>
        </div>

        {/* Content */}
        <div className="flex-1 relative overflow-hidden">
          {loading && (
            <div className="absolute inset-0 flex items-center justify-center bg-white">
              <Loader2 className="w-6 h-6 animate-spin text-gray-400" />
            </div>
          )}
          {error && (
            <div className="absolute inset-0 flex flex-col items-center justify-center bg-white gap-3">
              <AlertCircle className="w-8 h-8 text-red-400" />
              <p className="text-sm text-gray-500">{error}</p>
              <p className="text-xs text-gray-400">Make sure the agent is running.</p>
            </div>
          )}
          {url && !error && (
            <iframe
              src={url}
              className="w-full h-full border-0"
              title={`Chat with ${agentName}`}
              allow="clipboard-write"
            />
          )}
        </div>
      </div>
    </div>
  );
}
