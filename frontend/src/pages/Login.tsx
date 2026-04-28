import { useEffect, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { Shield, AlertCircle } from 'lucide-react';

interface LoginProps {
  onSuccess: (user: never) => void;
}

const ERROR_MESSAGES: Record<string, string> = {
  not_authorized: 'Your account hasn\'t been set up yet. Complete onboarding in Telegram first.',
  invalid_state: 'Sign-in session expired. Please try again.',
  token_failed: 'Google authentication failed. Please try again.',
  userinfo_failed: 'Could not retrieve your Google account info. Please try again.',
  internal: 'Something went wrong. Please try again.',
  true: 'Sign-in failed. Please try again.',
};

export default function Login(_props: LoginProps) {
  const [params] = useSearchParams();
  const [loading, setLoading] = useState(false);
  const errorKey = params.get('login_error');
  const error = errorKey ? (ERROR_MESSAGES[errorKey] ?? 'Sign-in failed. Please try again.') : null;

  useEffect(() => {
    // Clear the error param from the URL without navigating
    if (errorKey) {
      const url = new URL(window.location.href);
      url.searchParams.delete('login_error');
      window.history.replaceState({}, '', url.toString());
    }
  }, [errorKey]);

  const handleGoogleLogin = () => {
    setLoading(true);
    window.location.href = '/api/auth/google';
  };

  return (
    <div className="min-h-screen bg-reins-navy flex items-center justify-center relative overflow-hidden">
      <div className="absolute inset-0 opacity-[0.03]" style={{
        backgroundImage: `radial-gradient(circle at 1px 1px, white 1px, transparent 0)`,
        backgroundSize: '32px 32px',
      }} />
      <div className="absolute top-1/4 -right-32 w-96 h-96 bg-trust-blue/10 rounded-full blur-3xl" />
      <div className="absolute bottom-1/4 -left-32 w-96 h-96 bg-safe-green/5 rounded-full blur-3xl" />

      <div className="relative w-full max-w-sm mx-4">
        <div className="flex items-center justify-center gap-3 mb-10">
          <Shield className="w-8 h-8 text-trust-blue" />
          <span className="text-2xl font-semibold text-white tracking-tight">AgentHelm</span>
        </div>

        <div className="bg-white/[0.04] backdrop-blur-sm border border-white/[0.06] rounded-2xl p-8">
          <div className="mb-6">
            <h1 className="text-lg font-medium text-white">Sign in</h1>
            <p className="text-sm text-gray-400 mt-1">Use your Google account to continue</p>
          </div>

          {error && (
            <div className="flex items-start gap-2 text-alert-red text-sm mb-5 bg-alert-red/10 rounded-lg px-3 py-2.5">
              <AlertCircle className="w-4 h-4 shrink-0 mt-0.5" />
              <span>{error}</span>
            </div>
          )}

          <button
            onClick={handleGoogleLogin}
            disabled={loading}
            className="w-full flex items-center justify-center gap-3 bg-white text-gray-800 rounded-xl px-4 py-3 text-sm font-medium hover:bg-gray-50 disabled:opacity-60 transition-all shadow-lg"
          >
            {loading ? (
              <div className="animate-spin rounded-full h-4 w-4 border-2 border-gray-300 border-t-gray-800" />
            ) : (
              <>
                <svg className="w-5 h-5" viewBox="0 0 24 24">
                  <path fill="#4285F4" d="M22.56 12.25c0-.78-.07-1.53-.2-2.25H12v4.26h5.92c-.26 1.37-1.04 2.53-2.21 3.31v2.77h3.57c2.08-1.92 3.28-4.74 3.28-8.09z"/>
                  <path fill="#34A853" d="M12 23c2.97 0 5.46-.98 7.28-2.66l-3.57-2.77c-.98.66-2.23 1.06-3.71 1.06-2.86 0-5.29-1.93-6.16-4.53H2.18v2.84C3.99 20.53 7.7 23 12 23z"/>
                  <path fill="#FBBC05" d="M5.84 14.09c-.22-.66-.35-1.36-.35-2.09s.13-1.43.35-2.09V7.07H2.18C1.43 8.55 1 10.22 1 12s.43 3.45 1.18 4.93l2.85-2.22.81-.62z"/>
                  <path fill="#EA4335" d="M12 5.38c1.62 0 3.06.56 4.21 1.64l3.15-3.15C17.45 2.09 14.97 1 12 1 7.7 1 3.99 3.47 2.18 7.07l3.66 2.84c.87-2.6 3.3-4.53 6.16-4.53z"/>
                </svg>
                Continue with Google
              </>
            )}
          </button>
        </div>

        <p className="text-center text-xs text-gray-600 mt-6">
          The trust layer for AI agents
        </p>
      </div>
    </div>
  );
}
