import { useQuery, useMutation } from '@tanstack/react-query';
import { useSearchParams, Link } from 'react-router-dom';
import { CheckCircle, AlertTriangle, XCircle, CreditCard, ExternalLink } from 'lucide-react';
import { billing } from '../api/client';

function StatusBadge({ status }: { status: string }) {
  if (status === 'active') {
    return (
      <span className="inline-flex items-center gap-1 text-green-700 bg-green-100 text-xs font-semibold px-2.5 py-1 rounded-full">
        <CheckCircle className="w-3 h-3" /> Active
      </span>
    );
  }
  if (status === 'past_due') {
    return (
      <span className="inline-flex items-center gap-1 text-amber-700 bg-amber-100 text-xs font-semibold px-2.5 py-1 rounded-full">
        <AlertTriangle className="w-3 h-3" /> Past due
      </span>
    );
  }
  return (
    <span className="inline-flex items-center gap-1 text-red-700 bg-red-100 text-xs font-semibold px-2.5 py-1 rounded-full">
      <XCircle className="w-3 h-3" /> {status}
    </span>
  );
}

export default function Billing() {
  const [searchParams] = useSearchParams();
  const justSubscribed = searchParams.get('success') === '1';

  const { data, isLoading } = useQuery({
    queryKey: ['billing-status'],
    queryFn: () => billing.status(),
  });

  const portalMutation = useMutation({
    mutationFn: () => billing.openPortal(),
    onSuccess: (url) => { window.location.href = url; },
  });

  if (isLoading) {
    return <div className="p-8 text-gray-500">Loading billing status…</div>;
  }

  return (
    <div className="p-8 max-w-2xl mx-auto">
      <h1 className="text-2xl font-bold text-gray-900 mb-2">Billing</h1>
      <p className="text-gray-500 mb-8 text-sm">Manage your AgentHelm subscription.</p>

      {justSubscribed && (
        <div className="mb-6 p-4 bg-green-50 border border-green-200 rounded-lg flex items-center gap-3">
          <CheckCircle className="w-5 h-5 text-green-600 shrink-0" />
          <p className="text-green-800 text-sm font-medium">
            Subscription activated! Your agents are ready to deploy.
          </p>
        </div>
      )}

      {!data?.subscribed ? (
        <div className="bg-white border border-gray-200 rounded-xl p-6 text-center">
          <CreditCard className="w-10 h-10 text-gray-400 mx-auto mb-3" />
          <p className="text-gray-700 font-medium mb-1">No active subscription</p>
          <p className="text-gray-500 text-sm mb-5">Subscribe to start deploying agents.</p>
          <Link
            to="/pricing"
            className="inline-block bg-indigo-600 text-white px-6 py-2.5 rounded-lg font-semibold hover:bg-indigo-700 transition-colors"
          >
            View plans
          </Link>
        </div>
      ) : (
        <div className="bg-white border border-gray-200 rounded-xl divide-y divide-gray-100">
          <div className="p-6 flex items-center justify-between">
            <div>
              <p className="text-xs text-gray-400 uppercase tracking-wide mb-1">Current plan</p>
              <p className="text-lg font-semibold text-gray-900">
                {data.plan === 'managed' ? 'Managed MiniMax' : 'BYOK'} —{' '}
                ${data.plan === 'managed' ? '119' : '19'}/mo
              </p>
            </div>
            <StatusBadge status={data.status ?? 'active'} />
          </div>

          {data.currentPeriodEnd && (
            <div className="px-6 py-4">
              <p className="text-xs text-gray-400 uppercase tracking-wide mb-1">Next renewal</p>
              <p className="text-sm text-gray-700">
                {new Date(data.currentPeriodEnd).toLocaleDateString('en-US', {
                  year: 'numeric',
                  month: 'long',
                  day: 'numeric',
                })}
              </p>
            </div>
          )}

          {data.graceUntil && (
            <div className="px-6 py-4 bg-amber-50">
              <p className="text-sm text-amber-800 font-medium">
                Payment failed. Your agents will be paused on{' '}
                {new Date(data.graceUntil).toLocaleDateString('en-US', {
                  year: 'numeric',
                  month: 'long',
                  day: 'numeric',
                })}{' '}
                unless renewed.
              </p>
            </div>
          )}

          <div className="px-6 py-4">
            <button
              onClick={() => portalMutation.mutate()}
              disabled={portalMutation.isPending}
              className="flex items-center gap-2 text-sm text-indigo-600 hover:text-indigo-800 font-medium"
            >
              <ExternalLink className="w-4 h-4" />
              {portalMutation.isPending ? 'Opening portal…' : 'Manage subscription in Stripe'}
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
