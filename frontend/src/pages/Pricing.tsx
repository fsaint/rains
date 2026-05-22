import { useState } from 'react';
import { Check, Zap, Crown } from 'lucide-react';
import { billing } from '../api/client';

const PLANS = [
  {
    id: 'byok' as const,
    name: 'BYOK',
    tagline: 'Bring Your Own Keys',
    price: 19,
    Icon: Zap,
    colorClass: 'indigo',
    features: [
      'Connect your own Anthropic / OpenAI / MiniMax API key',
      'Unlimited agents (subject to your API quota)',
      'Gmail, Calendar, Drive integrations',
      'Spend caps & approval workflows',
      'Audit trail with CSV export',
      'Telegram notifications',
    ],
  },
  {
    id: 'managed' as const,
    name: 'Managed',
    tagline: 'MiniMax included',
    price: 119,
    Icon: Crown,
    colorClass: 'violet',
    badge: 'Most popular',
    features: [
      'Everything in BYOK',
      'MiniMax API key managed by AgentHelm',
      'No token usage limits (fair-use)',
      'Priority support',
      'Early access to new integrations',
    ],
  },
] as const;

export default function Pricing() {
  const [loading, setLoading] = useState<'byok' | 'managed' | null>(null);
  const [error, setError] = useState<string | null>(null);

  const handleSubscribe = async (plan: 'byok' | 'managed') => {
    setLoading(plan);
    setError(null);
    try {
      const url = await billing.startCheckout(plan);
      window.location.href = url;
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Something went wrong');
      setLoading(null);
    }
  };

  return (
    <div className="min-h-screen bg-gray-50 py-16 px-4">
      <div className="max-w-4xl mx-auto">
        <div className="text-center mb-12">
          <h1 className="text-4xl font-bold text-gray-900 mb-3">Simple, transparent pricing</h1>
          <p className="text-lg text-gray-600">
            Deploy AI agents that work for you — with full control over what they can do.
          </p>
        </div>

        {error && (
          <div className="mb-8 p-4 bg-red-50 border border-red-200 rounded-lg text-red-700 text-center">
            {error}
          </div>
        )}

        <div className="grid md:grid-cols-2 gap-8">
          {PLANS.map((plan) => (
            <div
              key={plan.id}
              className={`relative bg-white rounded-2xl shadow-sm border-2 p-8 ${'badge' in plan ? 'border-violet-400' : 'border-gray-200'}`}
            >
              {'badge' in plan && (
                <span className="absolute -top-3 left-1/2 -translate-x-1/2 bg-violet-500 text-white text-xs font-semibold px-3 py-1 rounded-full">
                  {plan.badge}
                </span>
              )}
              <div className="flex items-center gap-3 mb-4">
                <div className={`p-2 rounded-lg ${plan.colorClass === 'violet' ? 'bg-violet-100' : 'bg-indigo-100'}`}>
                  <plan.Icon className={`w-5 h-5 ${plan.colorClass === 'violet' ? 'text-violet-600' : 'text-indigo-600'}`} />
                </div>
                <div>
                  <h2 className="text-xl font-bold text-gray-900">{plan.name}</h2>
                  <p className="text-sm text-gray-500">{plan.tagline}</p>
                </div>
              </div>

              <div className="mb-6">
                <span className="text-4xl font-bold text-gray-900">${plan.price}</span>
                <span className="text-gray-500">/month</span>
              </div>

              <ul className="space-y-3 mb-8">
                {plan.features.map((f) => (
                  <li key={f} className="flex items-start gap-2 text-sm text-gray-700">
                    <Check className="w-4 h-4 text-green-500 mt-0.5 shrink-0" />
                    {f}
                  </li>
                ))}
              </ul>

              <button
                onClick={() => handleSubscribe(plan.id)}
                disabled={loading !== null}
                className={`w-full py-3 px-4 rounded-xl font-semibold text-white transition-colors ${
                  plan.colorClass === 'violet'
                    ? 'bg-violet-600 hover:bg-violet-700 disabled:bg-violet-300'
                    : 'bg-indigo-600 hover:bg-indigo-700 disabled:bg-indigo-300'
                }`}
              >
                {loading === plan.id ? 'Redirecting to Stripe…' : 'Get started'}
              </button>
            </div>
          ))}
        </div>

        <p className="text-center text-sm text-gray-400 mt-10">
          Subscriptions renew monthly. Cancel any time from your billing portal.
        </p>
      </div>
    </div>
  );
}
