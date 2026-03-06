import { useState } from 'react';
import { Shield, ArrowRight, AlertCircle } from 'lucide-react';
import { auth } from '../api/client';

interface LoginProps {
  onSuccess: () => void;
}

export default function Login({ onSuccess }: LoginProps) {
  const [password, setPassword] = useState('');
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError('');
    setLoading(true);
    try {
      const result = await auth.login(password);
      if (result.authenticated) {
        onSuccess();
      }
    } catch {
      setError('Invalid password');
      setPassword('');
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="min-h-screen bg-reins-navy flex items-center justify-center relative overflow-hidden">
      {/* Background texture */}
      <div className="absolute inset-0 opacity-[0.03]" style={{
        backgroundImage: `radial-gradient(circle at 1px 1px, white 1px, transparent 0)`,
        backgroundSize: '32px 32px',
      }} />

      {/* Subtle gradient orb */}
      <div className="absolute top-1/4 -right-32 w-96 h-96 bg-trust-blue/10 rounded-full blur-3xl" />
      <div className="absolute bottom-1/4 -left-32 w-96 h-96 bg-safe-green/5 rounded-full blur-3xl" />

      <div className="relative w-full max-w-sm mx-4">
        {/* Logo */}
        <div className="flex items-center justify-center gap-3 mb-10">
          <Shield className="w-8 h-8 text-trust-blue" />
          <span className="text-2xl font-semibold text-white tracking-tight">Reins</span>
        </div>

        {/* Login card */}
        <div className="bg-white/[0.04] backdrop-blur-sm border border-white/[0.06] rounded-2xl p-8">
          <div className="mb-6">
            <h1 className="text-lg font-medium text-white">Sign in</h1>
            <p className="text-sm text-gray-400 mt-1">Enter your admin password to continue</p>
          </div>

          <form onSubmit={handleSubmit}>
            <div className="space-y-4">
              <div>
                <input
                  type="password"
                  value={password}
                  onChange={(e) => { setPassword(e.target.value); setError(''); }}
                  placeholder="Password"
                  autoFocus
                  className="w-full bg-white/[0.06] border border-white/[0.08] rounded-xl px-4 py-3 text-sm text-white placeholder:text-gray-500 focus:outline-none focus:ring-2 focus:ring-trust-blue/40 focus:border-trust-blue/30 transition-all"
                />
              </div>

              {error && (
                <div className="flex items-center gap-2 text-alert-red text-sm">
                  <AlertCircle className="w-4 h-4 shrink-0" />
                  {error}
                </div>
              )}

              <button
                type="submit"
                disabled={loading || !password}
                className="w-full flex items-center justify-center gap-2 bg-trust-blue text-white rounded-xl px-4 py-3 text-sm font-medium hover:bg-blue-600 disabled:opacity-40 disabled:hover:bg-trust-blue transition-all shadow-lg shadow-trust-blue/20"
              >
                {loading ? (
                  <div className="animate-spin rounded-full h-4 w-4 border-2 border-white/30 border-t-white" />
                ) : (
                  <>
                    Continue
                    <ArrowRight className="w-4 h-4" />
                  </>
                )}
              </button>
            </div>
          </form>
        </div>

        <p className="text-center text-xs text-gray-600 mt-6">
          The trust layer for AI agents
        </p>
      </div>
    </div>
  );
}
