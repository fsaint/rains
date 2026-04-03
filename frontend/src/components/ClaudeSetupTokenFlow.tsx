import { useState } from 'react';
import { Check, AlertCircle, Terminal } from 'lucide-react';

const TOKEN_PREFIX = 'sk-ant-oat01-';
const TOKEN_MIN_LENGTH = 80;

function validateToken(raw: string): string | undefined {
  const t = raw.trim();
  if (!t) return 'Required';
  if (!t.startsWith(TOKEN_PREFIX)) return `Token must start with ${TOKEN_PREFIX}`;
  if (t.length < TOKEN_MIN_LENGTH) return 'Token looks too short — paste the full setup-token';
  return undefined;
}

interface Props {
  onComplete: (token: string) => void;
}

export function ClaudeSetupTokenFlow({ onComplete }: Props) {
  const [expanded, setExpanded] = useState(false);
  const [token, setToken] = useState('');
  const [error, setError] = useState('');
  const [done, setDone] = useState(false);

  if (done) {
    return (
      <div className="flex items-center gap-2 p-3 bg-emerald-50 border border-emerald-100 rounded-xl">
        <Check className="w-4 h-4 text-emerald-600" />
        <span className="text-sm font-medium text-emerald-700">Claude account connected</span>
      </div>
    );
  }

  if (!expanded) {
    return (
      <button
        type="button"
        onClick={() => setExpanded(true)}
        className="w-full flex items-center justify-center gap-2 px-4 py-3 bg-reins-navy text-white rounded-xl hover:bg-reins-navy/90 transition-colors text-sm font-medium"
      >
        Connect Claude Account
      </button>
    );
  }

  const handleSubmit = () => {
    const err = validateToken(token);
    if (err) {
      setError(err);
      return;
    }
    setError('');
    setDone(true);
    onComplete(token.trim());
  };

  return (
    <div className="space-y-3 p-4 bg-gray-50 border border-gray-200 rounded-xl">
      <div>
        <p className="text-sm font-medium text-gray-700 mb-1">Generate a setup token</p>
        <p className="text-xs text-gray-500">
          Run this command in your terminal where Claude Code is installed:
        </p>
      </div>

      <div className="flex items-center gap-2 bg-reins-navy text-green-400 font-mono text-sm px-3 py-2.5 rounded-lg select-all">
        <Terminal className="w-3.5 h-3.5 shrink-0 text-gray-500" />
        claude setup-token
      </div>

      <p className="text-xs text-gray-500">
        This generates a <span className="font-mono text-gray-700">sk-ant-oat01-…</span> token tied to your Claude.ai subscription. Paste it below.
      </p>

      <div>
        <input
          type="password"
          value={token}
          onChange={(e) => { setToken(e.target.value); setError(''); }}
          onKeyDown={(e) => e.key === 'Enter' && handleSubmit()}
          className="w-full border border-gray-200 rounded-lg px-3 py-2.5 text-sm font-mono focus:ring-2 focus:ring-trust-blue/20 focus:border-trust-blue transition-all outline-none bg-white"
          placeholder="sk-ant-oat01-…"
          autoFocus
        />
        {error && (
          <div className="flex items-center gap-1.5 mt-1.5">
            <AlertCircle className="w-3.5 h-3.5 text-red-500 shrink-0" />
            <p className="text-xs text-red-600">{error}</p>
          </div>
        )}
      </div>

      <div className="flex items-center gap-2">
        <button
          type="button"
          onClick={handleSubmit}
          className="flex-1 px-4 py-2 bg-trust-blue text-white rounded-lg hover:bg-blue-600 transition-colors text-sm font-medium"
        >
          Connect
        </button>
        <button
          type="button"
          onClick={() => { setExpanded(false); setToken(''); setError(''); }}
          className="px-4 py-2 text-sm text-gray-500 hover:text-gray-700 transition-colors"
        >
          Cancel
        </button>
      </div>
    </div>
  );
}
