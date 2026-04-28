import { CheckCircle } from 'lucide-react';
import { useSearchParams } from 'react-router-dom';

export default function OAuthComplete() {
  const [params] = useSearchParams();
  const success = params.get('success') === 'true';

  return (
    <div className="min-h-screen bg-reins-navy flex items-center justify-center p-6">
      <div className="max-w-md w-full text-center space-y-6">
        {success ? (
          <>
            <CheckCircle className="w-16 h-16 text-safe-green mx-auto" />
            <h1 className="text-2xl font-semibold text-white">Gmail connected</h1>
            <p className="text-gray-400">
              You're all set. Head back to Telegram and continue the setup there.
            </p>
            <a
              href="https://t.me/SpecialAgentHelmBot"
              className="inline-block mt-2 px-6 py-3 bg-trust-blue text-white rounded-lg font-medium hover:bg-trust-blue/90 transition-colors"
            >
              Open Telegram
            </a>
          </>
        ) : (
          <>
            <div className="w-16 h-16 rounded-full bg-red-500/20 flex items-center justify-center mx-auto">
              <span className="text-red-400 text-3xl">✕</span>
            </div>
            <h1 className="text-2xl font-semibold text-white">Something went wrong</h1>
            <p className="text-gray-400">
              The Gmail connection didn't go through. Go back to Telegram and try again.
            </p>
          </>
        )}
      </div>
    </div>
  );
}
