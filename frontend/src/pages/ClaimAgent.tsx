import { useState, useEffect } from 'react';
import { useParams, useNavigate, Link } from 'react-router-dom';
import { useMutation, useQuery } from '@tanstack/react-query';
import { Shield, CheckCircle, XCircle, Clock, ArrowLeft } from 'lucide-react';
import { agents } from '../api/client';

interface PendingAgent {
  id: string;
  name: string;
  description: string | null;
  claimCode: string;
  expiresAt: string;
}

export default function ClaimAgent() {
  const { code } = useParams<{ code: string }>();
  const navigate = useNavigate();
  const [claimCode, setClaimCode] = useState(code || '');
  const [error, setError] = useState('');
  const [success, setSuccess] = useState(false);

  // Look up pending registration by code
  const { data: pendingList } = useQuery({
    queryKey: ['agents', 'pending'],
    queryFn: agents.listPending,
    refetchInterval: 5000,
  });

  const pendingAgent = pendingList?.find(
    (p: PendingAgent) => p.claimCode === claimCode.toUpperCase()
  );

  const claimMutation = useMutation({
    mutationFn: agents.claim,
    onSuccess: () => {
      setSuccess(true);
      setError('');
      // Redirect to agents page after 2 seconds
      setTimeout(() => navigate('/agents'), 2000);
    },
    onError: () => {
      setError('Invalid or expired claim code. Please try again.');
    },
  });

  useEffect(() => {
    if (code) {
      setClaimCode(code.toUpperCase());
    }
  }, [code]);

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    setError('');
    claimMutation.mutate(claimCode.toUpperCase().trim());
  };

  const getTimeRemaining = (expiresAt: string) => {
    const remaining = new Date(expiresAt).getTime() - Date.now();
    if (remaining <= 0) return 'Expired';
    const minutes = Math.floor(remaining / 60000);
    const seconds = Math.floor((remaining % 60000) / 1000);
    return `${minutes}:${seconds.toString().padStart(2, '0')}`;
  };

  if (success) {
    return (
      <div className="min-h-screen bg-gray-50 flex items-center justify-center p-4">
        <div className="bg-white rounded-xl p-8 shadow-lg max-w-md w-full text-center">
          <CheckCircle className="w-16 h-16 text-safe-green mx-auto mb-4" />
          <h1 className="text-2xl font-semibold text-reins-navy mb-2">Agent Claimed!</h1>
          <p className="text-gray-600 mb-4">
            The agent has been successfully registered and is now active.
          </p>
          <p className="text-sm text-gray-500">Redirecting to agents page...</p>
        </div>
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-gray-50 flex items-center justify-center p-4">
      <div className="bg-white rounded-xl p-8 shadow-lg max-w-md w-full">
        {/* Header */}
        <div className="text-center mb-6">
          <Shield className="w-12 h-12 text-trust-blue mx-auto mb-3" />
          <h1 className="text-2xl font-semibold text-reins-navy">Claim Agent</h1>
          <p className="text-gray-500 mt-1">
            Complete registration for your AI agent
          </p>
        </div>

        {/* Agent Preview (if code matches) */}
        {pendingAgent && (
          <div className="bg-safe-green/10 border border-safe-green/20 rounded-lg p-4 mb-6">
            <div className="flex items-start gap-3">
              <CheckCircle className="w-5 h-5 text-safe-green flex-shrink-0 mt-0.5" />
              <div>
                <p className="font-medium text-reins-navy">{pendingAgent.name}</p>
                {pendingAgent.description && (
                  <p className="text-sm text-gray-600 mt-1">{pendingAgent.description}</p>
                )}
                <div className="flex items-center gap-1 mt-2 text-sm text-gray-500">
                  <Clock className="w-4 h-4" />
                  <span>Expires in {getTimeRemaining(pendingAgent.expiresAt)}</span>
                </div>
              </div>
            </div>
          </div>
        )}

        {/* Claim Form */}
        <form onSubmit={handleSubmit}>
          <div className="mb-4">
            <label className="block text-sm font-medium text-gray-700 mb-2">
              Claim Code
            </label>
            <input
              type="text"
              value={claimCode}
              onChange={(e) => {
                setClaimCode(e.target.value.toUpperCase());
                setError('');
              }}
              placeholder="ABC123"
              maxLength={6}
              className="w-full text-center text-3xl font-mono font-bold tracking-[0.5em] border border-gray-300 rounded-lg px-3 py-4 focus:ring-2 focus:ring-trust-blue focus:border-transparent uppercase"
              autoFocus
            />
            {error && (
              <div className="flex items-center gap-2 mt-2 text-alert-red text-sm">
                <XCircle className="w-4 h-4" />
                <span>{error}</span>
              </div>
            )}
          </div>

          <button
            type="submit"
            disabled={claimMutation.isPending || claimCode.length !== 6}
            className="w-full bg-trust-blue text-white py-3 rounded-lg font-medium hover:bg-blue-700 disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
          >
            {claimMutation.isPending ? 'Claiming...' : 'Claim Agent'}
          </button>
        </form>

        {/* Back Link */}
        <div className="mt-6 text-center">
          <Link
            to="/agents"
            className="inline-flex items-center gap-2 text-gray-500 hover:text-gray-700 text-sm"
          >
            <ArrowLeft className="w-4 h-4" />
            Back to Agents
          </Link>
        </div>

        {/* Help Text */}
        <div className="mt-6 pt-6 border-t border-gray-100">
          <p className="text-sm text-gray-500 text-center">
            Your AI agent should have provided a 6-character code.
            <br />
            Enter it above to complete registration.
          </p>
        </div>
      </div>
    </div>
  );
}
