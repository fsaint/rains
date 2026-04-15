import { useState, useEffect } from 'react';
import { useSearchParams } from 'react-router-dom';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { CheckCircle, XCircle, Clock, AlertTriangle, MessageCircle, Loader, Users } from 'lucide-react';
import { approvals, telegram, auth } from '../api/client';
import { ReauthApprovalCard } from '../components/ReauthApprovalCard';
import { ReauthModal } from '../components/ReauthModal';

interface Approval {
  id: string;
  agentId: string;
  tool: string;
  arguments: Record<string, unknown>;
  context?: string;
  status: string;
  requestedAt: string;
  expiresAt: string;
}

export default function Approvals() {
  const queryClient = useQueryClient();
  const [searchParams] = useSearchParams();
  const targetId = searchParams.get('id');

  const [activeReauth, setActiveReauth] = useState<Approval | null>(null);
  const [telegramBannerDismissed, setTelegramBannerDismissed] = useState(false);

  const { data: session } = useQuery({
    queryKey: ['session'],
    queryFn: () => auth.session(),
  });

  const telegramLinked = session?.user?.telegramLinked ?? false;

  const telegramLinkMutation = useMutation({
    mutationFn: () => telegram.createLink(),
    onSuccess: (data) => {
      window.open(data.url, '_blank', 'noopener,noreferrer');
      // Poll for link completion
      let elapsed = 0;
      const poll = setInterval(async () => {
        elapsed += 2000;
        await queryClient.invalidateQueries({ queryKey: ['session'] });
        if (elapsed >= 90000) clearInterval(poll);
      }, 2000);
    },
  });

  const { data: approvalsList, isLoading } = useQuery<Approval[]>({
    queryKey: ['approvals'],
    queryFn: () => approvals.list() as Promise<Approval[]>,
    refetchInterval: 5000,
  });

  // Auto-open reauth modal when navigating from an email link (/approvals?id=...)
  useEffect(() => {
    if (!targetId || !approvalsList) return;
    const target = approvalsList.find((a) => a.id === targetId);
    if (target?.tool === 'reauth') {
      setActiveReauth(target);
    }
  }, [targetId, approvalsList]);

  const approveMutation = useMutation({
    mutationFn: (id: string) => approvals.approve(id),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['approvals'] }),
  });

  const rejectMutation = useMutation({
    mutationFn: (id: string) => approvals.reject(id, 'Rejected by user'),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['approvals'] }),
  });

  const groupBehaviorMutation = useMutation({
    mutationFn: ({ id, behavior }: { id: string; behavior: 'all' | 'mention' | 'ignore' }) =>
      behavior === 'ignore'
        ? approvals.reject(id, 'User chose to ignore this group')
        : approvals.approve(id, behavior),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['approvals'] }),
  });

  const getTimeRemaining = (expiresAt: string) => {
    const diff = new Date(expiresAt).getTime() - Date.now();
    if (diff <= 0) return 'Expired';
    const minutes = Math.floor(diff / 60000);
    if (minutes < 60) return `${minutes}m remaining`;
    const hours = Math.floor(minutes / 60);
    return `${hours}h ${minutes % 60}m remaining`;
  };

  return (
    <div className="p-4 sm:p-8">
      <div className="mb-8">
        <h1 className="text-2xl font-semibold text-reins-navy">Pending Approvals</h1>
        <p className="text-gray-500 mt-1">Review and approve agent tool requests</p>
      </div>

      {/* Telegram CTA — shown until linked or dismissed */}
      {!telegramLinked && !telegramBannerDismissed && (
        <div className="mb-6 flex items-center gap-4 bg-blue-950/60 border border-blue-800/50 rounded-xl px-5 py-3.5">
          <MessageCircle className="w-5 h-5 text-blue-400 flex-shrink-0" />
          <p className="text-sm text-blue-200 flex-1">
            Want to receive approvals via Telegram?{' '}
            <button
              onClick={() => telegramLinkMutation.mutate()}
              disabled={telegramLinkMutation.isPending}
              className="inline-flex items-center gap-1 font-medium text-blue-300 hover:text-white underline underline-offset-2 disabled:opacity-50 transition-colors"
            >
              {telegramLinkMutation.isPending ? (
                <><Loader className="w-3 h-3 animate-spin" /> Generating link…</>
              ) : (
                <>Message @ReinsVerification_bot to activate</>
              )}
            </button>
          </p>
          <button
            onClick={() => setTelegramBannerDismissed(true)}
            className="text-blue-600 hover:text-blue-400 text-xs ml-2 flex-shrink-0"
            aria-label="Dismiss"
          >
            ✕
          </button>
        </div>
      )}

      {isLoading ? (
        <div className="flex items-center justify-center py-12">
          <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-trust-blue"></div>
        </div>
      ) : !approvalsList?.length ? (
        <div className="bg-white rounded-xl p-12 shadow-sm border border-gray-100 text-center">
          <CheckCircle className="w-12 h-12 text-safe-green mx-auto mb-4" />
          <p className="text-gray-500">No pending approvals</p>
          <p className="text-sm text-gray-400 mt-1">All caught up!</p>
        </div>
      ) : (
        <div className="space-y-4">
          {approvalsList.map((approval) =>
            approval.tool === 'reauth' ? (
              <ReauthApprovalCard
                key={approval.id}
                approval={approval}
                onReauth={() => setActiveReauth(approval)}
              />
            ) : approval.tool === 'telegram_group' ? (
              <div
                key={approval.id}
                className="bg-white rounded-xl p-4 sm:p-6 shadow-sm border border-gray-100"
              >
                <div className="flex flex-col sm:flex-row sm:items-start sm:justify-between gap-4">
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-3 mb-3">
                      <div className="w-9 h-9 rounded-full bg-blue-50 flex items-center justify-center shrink-0">
                        <Users className="w-4 h-4 text-trust-blue" />
                      </div>
                      <div>
                        <h3 className="font-semibold text-gray-900">Group Configuration</h3>
                        <p className="text-sm text-gray-500">
                          Your bot was added to{' '}
                          <span className="font-medium text-gray-700">
                            "{(approval.arguments.chatTitle as string) ?? 'a group'}"
                          </span>
                        </p>
                      </div>
                    </div>

                    <div className="grid grid-cols-2 gap-3 text-sm mt-2">
                      <div>
                        <p className="text-xs text-gray-500 uppercase tracking-wider">Agent</p>
                        <p className="font-medium truncate">{approval.agentId}</p>
                      </div>
                      {approval.arguments.addedBy && (
                        <div>
                          <p className="text-xs text-gray-500 uppercase tracking-wider">Added by</p>
                          <p className="font-medium">{approval.arguments.addedBy as string}</p>
                        </div>
                      )}
                    </div>

                    <p className="text-sm text-gray-600 mt-3">How should the bot behave in this group?</p>
                  </div>

                  <div className="flex sm:flex-col items-center sm:items-end justify-between sm:justify-start gap-3 shrink-0">
                    <div className="flex items-center gap-1 text-sm text-caution-amber">
                      <Clock className="w-4 h-4" />
                      <span>{getTimeRemaining(approval.expiresAt)}</span>
                    </div>

                    <div className="flex flex-col gap-2">
                      <button
                        onClick={() => groupBehaviorMutation.mutate({ id: approval.id, behavior: 'all' })}
                        disabled={groupBehaviorMutation.isPending}
                        className="px-3 py-1.5 text-sm bg-trust-blue text-white rounded-lg hover:bg-blue-600 disabled:opacity-50 transition-colors whitespace-nowrap"
                      >
                        All messages
                      </button>
                      <button
                        onClick={() => groupBehaviorMutation.mutate({ id: approval.id, behavior: 'mention' })}
                        disabled={groupBehaviorMutation.isPending}
                        className="px-3 py-1.5 text-sm border border-trust-blue text-trust-blue rounded-lg hover:bg-blue-50 disabled:opacity-50 transition-colors whitespace-nowrap"
                      >
                        @Mention only
                      </button>
                      <button
                        onClick={() => groupBehaviorMutation.mutate({ id: approval.id, behavior: 'ignore' })}
                        disabled={groupBehaviorMutation.isPending}
                        className="px-3 py-1.5 text-sm text-gray-500 hover:text-alert-red disabled:opacity-50 transition-colors"
                      >
                        Ignore group
                      </button>
                    </div>
                  </div>
                </div>
              </div>
            ) : (
              <div
                key={approval.id}
                className="bg-white rounded-xl p-4 sm:p-6 shadow-sm border border-gray-100"
              >
                <div className="flex flex-col sm:flex-row sm:items-start sm:justify-between gap-4">
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-3 mb-2">
                      <AlertTriangle className="w-5 h-5 text-caution-amber" />
                      <h3 className="font-semibold text-lg">
                        Tool Request: <span className="font-mono text-trust-blue">{approval.tool}</span>
                      </h3>
                    </div>

                    <div className="grid grid-cols-2 gap-4 mt-4">
                      <div>
                        <p className="text-xs text-gray-500 uppercase tracking-wider">Agent</p>
                        <p className="font-medium">{approval.agentId}</p>
                      </div>
                      <div>
                        <p className="text-xs text-gray-500 uppercase tracking-wider">Requested</p>
                        <p className="font-medium">{new Date(approval.requestedAt).toLocaleString()}</p>
                      </div>
                    </div>

                    {approval.context && (
                      <div className="mt-4">
                        <p className="text-xs text-gray-500 uppercase tracking-wider">Context</p>
                        <p className="text-sm mt-1">{approval.context}</p>
                      </div>
                    )}

                    <div className="mt-4">
                      <p className="text-xs text-gray-500 uppercase tracking-wider mb-1">Arguments</p>
                      <pre className="text-xs bg-gray-50 p-3 rounded-lg overflow-auto max-h-32 font-mono">
                        {JSON.stringify(approval.arguments, null, 2)}
                      </pre>
                    </div>
                  </div>

                  <div className="flex sm:flex-col items-center sm:items-end justify-between sm:justify-start gap-3 shrink-0">
                    <div className="flex items-center gap-1 text-sm text-caution-amber">
                      <Clock className="w-4 h-4" />
                      <span>{getTimeRemaining(approval.expiresAt)}</span>
                    </div>

                    <div className="flex gap-2">
                      <button
                        onClick={() => rejectMutation.mutate(approval.id)}
                        disabled={rejectMutation.isPending}
                        className="flex items-center gap-2 px-4 py-2 border border-alert-red text-alert-red rounded-lg hover:bg-alert-red/10 disabled:opacity-50"
                      >
                        <XCircle className="w-4 h-4" />
                        Reject
                      </button>
                      <button
                        onClick={() => approveMutation.mutate(approval.id)}
                        disabled={approveMutation.isPending}
                        className="flex items-center gap-2 px-4 py-2 bg-safe-green text-white rounded-lg hover:bg-green-700 disabled:opacity-50"
                      >
                        <CheckCircle className="w-4 h-4" />
                        Approve
                      </button>
                    </div>
                  </div>
                </div>
              </div>
            )
          )}
        </div>
      )}

      {activeReauth && (
        <ReauthModal
          approval={activeReauth}
          onComplete={() => {
            setActiveReauth(null);
            queryClient.invalidateQueries({ queryKey: ['approvals'] });
          }}
          onDismiss={() => setActiveReauth(null)}
        />
      )}
    </div>
  );
}
