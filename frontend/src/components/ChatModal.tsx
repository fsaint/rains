import { useEffect, useState } from 'react';
import { X, Loader2, ExternalLink, AlertCircle, Copy, Check } from 'lucide-react';
import { agents } from '../api/client';

interface ChatModalProps {
  agentId: string;
  agentName: string;
  onClose: () => void;
}

export default function ChatModal({ agentId, agentName, onClose }: ChatModalProps) {
  const [url, setUrl] = useState<string | null>(null);
  const [token, setToken] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    agents.getManagementUrl(agentId)
      .then((res) => {
        setUrl(res.url);
        // Extract token from URL query string
        try {
          const t = new URL(res.url).searchParams.get('token');
          setToken(t);
        } catch { /* ignore */ }
      })
      .catch((err) => setError(err.message || 'Could not load chat URL'))
      .finally(() => setLoading(false));
  }, [agentId]);

  const handleCopy = async () => {
    if (!token) return;
    await navigator.clipboard.writeText(token);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };

  const handleOpen = () => {
    if (url) window.open(url, '_blank', 'noopener,noreferrer');
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm p-4">
      <div className="w-full max-w-md flex flex-col bg-white rounded-xl border border-gray-200 shadow-2xl overflow-hidden">
        {/* Header */}
        <div className="flex items-center justify-between px-4 py-3 border-b border-gray-200">
          <div className="flex items-center gap-2">
            <div className="w-2 h-2 rounded-full bg-emerald-400 animate-pulse" />
            <span className="text-sm font-medium text-gray-800">{agentName}</span>
          </div>
          <button
            onClick={onClose}
            className="p-1.5 text-gray-400 hover:text-gray-700 hover:bg-gray-100 rounded transition-colors"
          >
            <X className="w-4 h-4" />
          </button>
        </div>

        {/* Content */}
        <div className="p-5 space-y-4">
          {loading && (
            <div className="flex items-center justify-center py-6">
              <Loader2 className="w-5 h-5 animate-spin text-gray-400" />
            </div>
          )}

          {error && (
            <div className="flex items-center gap-2 text-sm text-red-600">
              <AlertCircle className="w-4 h-4 shrink-0" />
              {error}
            </div>
          )}

          {!loading && !error && url && (
            <>
              {/* Step 1: Copy token */}
              <div>
                <p className="text-xs font-medium text-gray-500 uppercase tracking-wider mb-2">
                  Step 1 — Copy your gateway token
                </p>
                <div className="flex items-center gap-2 p-2.5 bg-gray-50 rounded-lg border border-gray-200">
                  <code className="flex-1 text-xs font-mono text-gray-700 truncate">
                    {token ?? '—'}
                  </code>
                  <button
                    onClick={handleCopy}
                    className={`flex items-center gap-1 px-2.5 py-1 text-xs rounded-md transition-all font-medium ${
                      copied
                        ? 'bg-emerald-50 text-emerald-600'
                        : 'bg-white border border-gray-200 text-gray-600 hover:border-gray-300'
                    }`}
                  >
                    {copied ? <Check className="w-3.5 h-3.5" /> : <Copy className="w-3.5 h-3.5" />}
                    {copied ? 'Copied' : 'Copy'}
                  </button>
                </div>
              </div>

              {/* Step 2: Open chat */}
              <div>
                <p className="text-xs font-medium text-gray-500 uppercase tracking-wider mb-2">
                  Step 2 — Open the chat
                </p>
                <button
                  onClick={handleOpen}
                  className="w-full flex items-center justify-center gap-2 px-4 py-2.5 text-sm font-medium text-white bg-trust-blue hover:bg-trust-blue/90 rounded-lg transition-colors"
                >
                  <ExternalLink className="w-4 h-4" />
                  Open Chat in New Tab
                </button>
              </div>

              {/* Hint */}
              <p className="text-xs text-gray-400 leading-relaxed">
                In the chat window, click <span className="font-medium text-gray-500">Settings</span> and paste the token above. This is only needed once — the browser remembers it.
              </p>
            </>
          )}
        </div>
      </div>
    </div>
  );
}
