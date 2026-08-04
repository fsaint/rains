import { useState, useEffect } from 'react';
import { useSearchParams } from 'react-router-dom';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { CheckCircle, XCircle, Clock, AlertTriangle, MessageCircle, Loader, Users, Paperclip, Pencil } from 'lucide-react';
import { approvals, telegram, auth } from '../api/client';
import { ReauthApprovalCard } from '../components/ReauthApprovalCard';
import { ReauthModal } from '../components/ReauthModal';
import { formatBytes } from '../utils/format';

const ATTACHMENT_SOURCE_LABELS: Record<string, string> = {
  gmail: 'forwarded from an email',
  drive: 'from Google Drive',
  url: 'downloaded from a link',
  upload: 'uploaded by the agent',
  text: 'written by the agent',
  base64: 'inline data',
};

/** Display-level cap for historical rows persisted before args were redacted. */
const MAX_DISPLAYED_STRING = 2000;

function attachmentSummary(entry: unknown, index: number) {
  const item = (typeof entry === 'object' && entry !== null ? entry : {}) as Record<string, unknown>;

  const source =
    typeof item.source === 'string'
      ? item.source
      : typeof item.data === 'string'
        ? 'base64'
        : typeof item.content === 'string'
          ? 'text'
          : typeof item.attachmentId === 'string'
            ? 'gmail'
            : 'unknown';

  const name =
    typeof item.filename === 'string' && item.filename.trim() !== ''
      ? item.filename
      : source === 'gmail'
        ? '(original filename)'
        : `attachment-${index + 1}`;

  // `_bytes` is what the backend leaves behind in place of a redacted payload.
  const bytes =
    typeof item._bytes === 'number'
      ? item._bytes
      : typeof item.content === 'string'
        ? new Blob([item.content]).size
        : typeof item.data === 'string'
          ? Math.floor((item.data.length * 3) / 4)
          : undefined;

  return { name, bytes, origin: ATTACHMENT_SOURCE_LABELS[source] };
}

/** Args without attachments, with long strings capped for display. */
function displayableArgs(args: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(args ?? {})) {
    if (key === 'attachments') continue;
    out[key] =
      typeof value === 'string' && value.length > MAX_DISPLAYED_STRING
        ? `${value.slice(0, MAX_DISPLAYED_STRING)}…(${value.length - MAX_DISPLAYED_STRING} chars omitted)`
        : value;
  }
  return out;
}

/** Matches MAX_REVISIONS in backend/src/approvals/queue.ts */
const MAX_REVISIONS = 3;

interface Approval {
  id: string;
  agentId: string;
  tool: string;
  arguments: Record<string, unknown>;
  context?: string;
  status: string;
  requestedAt: string;
  expiresAt: string;
  /** 0 for an original request; n for the nth revision the agent resubmitted */
  revision?: number;
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

  // Which card has its correction box open, and what has been typed into it.
  const [correctingId, setCorrectingId] = useState<string | null>(null);
  const [feedback, setFeedback] = useState('');

  const requestChangesMutation = useMutation({
    mutationFn: ({ id, feedback }: { id: string; feedback: string }) =>
      approvals.requestChanges(id, feedback),
    onSuccess: () => {
      setCorrectingId(null);
      setFeedback('');
      queryClient.invalidateQueries({ queryKey: ['approvals'] });
    },
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
                <>Message @AgentHelmApprovalsBot to activate</>
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
                      {!!approval.arguments.addedBy && (
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
                      {(approval.revision ?? 0) > 0 && (
                        <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full bg-amber-50 text-caution-amber text-xs font-medium">
                          <Pencil className="w-3 h-3" />
                          Revision {approval.revision} of {MAX_REVISIONS}
                        </span>
                      )}
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

                    {Array.isArray(approval.arguments?.attachments) &&
                      approval.arguments.attachments.length > 0 && (
                        <div className="mt-4">
                          <p className="text-xs text-gray-500 uppercase tracking-wider mb-1">
                            Attachments
                          </p>
                          <ul className="space-y-1">
                            {(approval.arguments.attachments as unknown[]).map((entry, index) => {
                              const { name, bytes, origin } = attachmentSummary(entry, index);
                              return (
                                <li
                                  key={index}
                                  className="flex items-center gap-2 text-sm bg-gray-50 px-3 py-2 rounded-lg"
                                >
                                  <Paperclip className="w-4 h-4 text-gray-400 shrink-0" />
                                  <span className="font-medium truncate">{name}</span>
                                  {bytes !== undefined && (
                                    <span className="text-gray-500 shrink-0">
                                      {formatBytes(bytes)}
                                    </span>
                                  )}
                                  {origin && (
                                    <span className="text-gray-400 text-xs shrink-0">{origin}</span>
                                  )}
                                </li>
                              );
                            })}
                          </ul>
                        </div>
                      )}

                    <div className="mt-4">
                      <p className="text-xs text-gray-500 uppercase tracking-wider mb-1">Arguments</p>
                      <pre className="text-xs bg-gray-50 p-3 rounded-lg overflow-auto max-h-32 font-mono">
                        {JSON.stringify(displayableArgs(approval.arguments), null, 2)}
                      </pre>
                    </div>

                    {correctingId === approval.id && (
                      <div className="mt-4">
                        <label
                          htmlFor={`feedback-${approval.id}`}
                          className="block text-xs text-gray-500 uppercase tracking-wider mb-1"
                        >
                          What should the agent change?
                        </label>
                        <textarea
                          id={`feedback-${approval.id}`}
                          value={feedback}
                          onChange={(e) => setFeedback(e.target.value)}
                          rows={3}
                          maxLength={2000}
                          autoFocus
                          placeholder="e.g. drop Bob from the recipients, make it shorter"
                          className="w-full text-sm border border-gray-200 rounded-lg p-3 focus:outline-none focus:ring-2 focus:ring-trust-blue"
                        />
                        <div className="flex items-center gap-2 mt-2">
                          <button
                            onClick={() =>
                              requestChangesMutation.mutate({ id: approval.id, feedback: feedback.trim() })
                            }
                            disabled={!feedback.trim() || requestChangesMutation.isPending}
                            className="flex items-center gap-2 px-4 py-2 bg-trust-blue text-white rounded-lg hover:bg-blue-700 disabled:opacity-50"
                          >
                            {requestChangesMutation.isPending ? (
                              <Loader className="w-4 h-4 animate-spin" />
                            ) : (
                              <Pencil className="w-4 h-4" />
                            )}
                            Send back to agent
                          </button>
                          <button
                            onClick={() => {
                              setCorrectingId(null);
                              setFeedback('');
                            }}
                            className="px-4 py-2 text-gray-500 hover:text-gray-700"
                          >
                            Cancel
                          </button>
                        </div>
                        {requestChangesMutation.isError && (
                          <p className="text-sm text-alert-red mt-2">
                            Could not send that back. It may have already been handled.
                          </p>
                        )}
                      </div>
                    )}
                  </div>

                  <div className="flex sm:flex-col items-center sm:items-end justify-between sm:justify-start gap-3 shrink-0">
                    <div className="flex items-center gap-1 text-sm text-caution-amber">
                      <Clock className="w-4 h-4" />
                      <span>{getTimeRemaining(approval.expiresAt)}</span>
                    </div>

                    <div className="flex gap-2">
                      {(approval.revision ?? 0) < MAX_REVISIONS && correctingId !== approval.id && (
                        <button
                          onClick={() => {
                            setCorrectingId(approval.id);
                            setFeedback('');
                          }}
                          className="flex items-center gap-2 px-4 py-2 border border-gray-300 text-gray-700 rounded-lg hover:bg-gray-50"
                        >
                          <Pencil className="w-4 h-4" />
                          Request changes
                        </button>
                      )}
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
