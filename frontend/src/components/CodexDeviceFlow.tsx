import { useState, useEffect, useRef, useCallback } from 'react';
import { ExternalLink, Loader2, Check, Copy, AlertCircle } from 'lucide-react';

interface CodexDeviceFlowProps {
  onComplete: (tokensJson: string) => void;
}

export function CodexDeviceFlow({ onComplete }: CodexDeviceFlowProps) {
  const [state, setState] = useState<'idle' | 'waiting' | 'complete' | 'error'>('idle');
  const [userCode, setUserCode] = useState('');
  const [verificationUrl, setVerificationUrl] = useState('');
  const [error, setError] = useState('');
  const [codeCopied, setCodeCopied] = useState(false);
  const cancelledRef = useRef(false);

  const startFlow = useCallback(async () => {
    setState('waiting');
    setError('');
    cancelledRef.current = false;
    try {
      const res = await fetch('/api/auth/openai-device', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'start' }),
      });
      if (!res.ok) throw new Error(`Failed to start device flow: ${res.status}`);
      const json = await res.json();
      const data = json.data;
      setUserCode(data.userCode);
      setVerificationUrl(data.verificationUrl);

      // Start polling with recursive setTimeout (matching AgentX pattern)
      const poll = async () => {
        if (cancelledRef.current) return;
        try {
          const result = await openaiAuth.pollDeviceFlow(data.deviceAuthId, data.userCode);
          if (cancelledRef.current) return;
          if (result.status === 'complete' && result.tokens) {
            setState('complete');
            onComplete(result.tokens);
            return;
          }
          if (result.status === 'pending') {
            setTimeout(poll, (data.interval || 5) * 1000);
            return;
          }
          // error or expired
          setState('error');
          setError(result.error || 'Authorization failed');
        } catch (err) {
          if (cancelledRef.current) return;
          // ApiError means the backend responded with an error — don't retry blindly
          if (err && typeof err === 'object' && 'code' in err) {
            setState('error');
            setError(err instanceof Error ? err.message : 'Authorization failed');
            return;
          }
          // Network error — retry
          setTimeout(poll, (data.interval || 5) * 1000);
        }
      };
      setTimeout(poll, (data.interval || 5) * 1000);
    } catch (err) {
      setState('error');
      setError(err instanceof Error ? err.message : 'Failed to start device flow');
    }
  }, [onComplete]);

  useEffect(() => {
    return () => {
      cancelledRef.current = true;
    };
  }, []);

  const handleCopyCode = async () => {
    await navigator.clipboard.writeText(userCode);
    setCodeCopied(true);
    setTimeout(() => setCodeCopied(false), 2000);
  };

  if (state === 'idle') {
    return (
      <button
        type="button"
        onClick={startFlow}
        className="w-full flex items-center justify-center gap-2 px-4 py-3 bg-reins-navy text-white rounded-xl hover:bg-reins-navy/90 transition-colors text-sm font-medium"
      >
        Connect OpenAI Account
      </button>
    );
  }

  if (state === 'error') {
    return (
      <div className="space-y-3">
        <div className="p-3 bg-red-50 border border-red-100 rounded-xl flex items-start gap-2">
          <AlertCircle className="w-4 h-4 text-red-500 mt-0.5 shrink-0" />
          <p className="text-sm text-red-700">{error}</p>
        </div>
        <button
          type="button"
          onClick={startFlow}
          className="text-sm text-trust-blue hover:underline"
        >
          Try again
        </button>
      </div>
    );
  }

  if (state === 'complete') {
    return (
      <div className="flex items-center gap-2 p-3 bg-emerald-50 border border-emerald-100 rounded-xl">
        <Check className="w-4 h-4 text-emerald-600" />
        <span className="text-sm font-medium text-emerald-700">OpenAI account connected</span>
      </div>
    );
  }

  // waiting state
  return (
    <div className="space-y-3 p-4 bg-gray-50 border border-gray-200 rounded-xl">
      <div className="flex items-center gap-2 text-sm text-gray-600">
        <Loader2 className="w-4 h-4 animate-spin text-trust-blue" />
        <span>Waiting for authorization...</span>
      </div>

      <div className="flex items-center justify-between">
        <div>
          <p className="text-xs text-gray-500 mb-1">Your code:</p>
          <p className="text-2xl font-mono font-bold text-reins-navy tracking-widest select-all">
            {userCode}
          </p>
        </div>
        <button
          type="button"
          onClick={handleCopyCode}
          className={`flex items-center gap-1 text-xs px-2.5 py-1.5 rounded-lg transition-all ${
            codeCopied
              ? 'bg-emerald-100 text-emerald-700'
              : 'bg-white border border-gray-200 text-gray-500 hover:text-gray-700'
          }`}
        >
          {codeCopied ? <Check className="w-3 h-3" /> : <Copy className="w-3 h-3" />}
          {codeCopied ? 'Copied' : 'Copy'}
        </button>
      </div>

      <a
        href={verificationUrl}
        target="_blank"
        rel="noopener noreferrer"
        className="flex items-center justify-center gap-2 w-full px-4 py-2.5 bg-trust-blue text-white rounded-lg hover:bg-blue-600 transition-colors text-sm font-medium"
      >
        <ExternalLink className="w-4 h-4" />
        Open OpenAI Authorization Page
      </a>
    </div>
  );
}
