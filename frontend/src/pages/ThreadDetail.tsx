import { useState } from 'react';
import { useParams, Link, useNavigate } from 'react-router-dom';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { Route, ArrowLeft, Loader2, Check, X, Eye, ExternalLink } from 'lucide-react';
import { threads, ApiError } from '../api/client';
import type { ThreadItem, ThreadCloseInput } from '../api/client';
import ThreadTimeline from '../components/ThreadTimeline';
import { renderMarkdown } from '../utils/markdown';

const formatDay = (iso: string) => new Date(iso).toLocaleDateString();
const toDateInput = (iso: string | null) => (iso ? iso.slice(0, 10) : '');

const inputClass =
  'bg-white/5 border border-white/10 rounded-lg px-3 py-2 text-sm text-white placeholder-gray-500 focus:outline-none focus:border-trust-blue';
const smallButton =
  'px-3 py-1 text-xs rounded-lg border border-white/10 text-gray-300 hover:text-white hover:border-white/30 disabled:opacity-50';

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section className="bg-white/5 rounded-xl p-4 border border-white/10">
      <h2 className="text-sm font-medium text-gray-300 mb-3">{title}</h2>
      {children}
    </section>
  );
}

function Markdown({ text }: { text: string }) {
  if (!text.trim()) return <p className="text-sm text-gray-600 italic">Nothing yet.</p>;
  return (
    <div
      className="text-sm text-gray-300 leading-relaxed"
      dangerouslySetInnerHTML={{ __html: `<p class="mb-2">${renderMarkdown(text)}</p>` }}
    />
  );
}

function CloseDialog({
  threadId,
  items,
  onDone,
  onCancel,
}: {
  threadId: string;
  items: ThreadItem[];
  onDone: () => void;
  onCancel: () => void;
}) {
  const [retrospective, setRetrospective] = useState('');
  // 'cancel' | 'carry' (note in retrospective) | 'carry:<threadId>'
  const [choices, setChoices] = useState<Record<string, string>>({});

  const { data: active } = useQuery({
    queryKey: ['threads', 'active'],
    queryFn: () => threads.list('active'),
  });
  const targets = (active ?? []).filter((t) => t.id !== threadId);

  const close = useMutation({
    mutationFn: () => {
      const decisions: ThreadCloseInput['decisions'] = items.map((item) => {
        const choice = choices[item.id] ?? 'cancel';
        if (choice === 'cancel') return { itemId: item.id, action: 'cancel' };
        const successorThreadId = choice.startsWith('carry:') ? choice.slice('carry:'.length) : undefined;
        return { itemId: item.id, action: 'carry', ...(successorThreadId && { successorThreadId }) };
      });
      return threads.close(threadId, { retrospective: retrospective.trim(), decisions });
    },
    onSuccess: onDone,
  });

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4">
      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby="close-thread-title"
        className="bg-gray-900 border border-white/10 rounded-xl p-6 w-full max-w-lg max-h-[90vh] overflow-y-auto space-y-4"
      >
        <h2 id="close-thread-title" className="text-lg font-semibold">Close thread</h2>

        <div>
          <label htmlFor="retrospective" className="block text-xs text-gray-400 mb-1">Retrospective</label>
          <textarea
            id="retrospective"
            rows={4}
            className={`${inputClass} w-full`}
            value={retrospective}
            onChange={(e) => setRetrospective(e.target.value)}
          />
        </div>

        {items.length > 0 && (
          <div className="space-y-2">
            <p className="text-xs text-gray-400">Open items</p>
            {items.map((item) => (
              <div key={item.id} className="flex items-center justify-between gap-3">
                <span className="text-sm text-gray-200 truncate">{item.title}</span>
                <select
                  aria-label={item.title}
                  className={`${inputClass} py-1 shrink-0 max-w-[50%]`}
                  value={choices[item.id] ?? 'cancel'}
                  onChange={(e) => setChoices((c) => ({ ...c, [item.id]: e.target.value }))}
                >
                  <option value="cancel">Cancel</option>
                  <option value="carry">Note in retrospective</option>
                  {targets.map((t) => (
                    <option key={t.id} value={`carry:${t.id}`}>{t.title}</option>
                  ))}
                </select>
              </div>
            ))}
          </div>
        )}

        {close.error && (
          <p className="text-sm text-red-400">
            {close.error instanceof ApiError ? close.error.message : 'Could not close the thread.'}
          </p>
        )}

        <div className="flex justify-end gap-2">
          <button onClick={onCancel} className={smallButton}>Cancel</button>
          <button
            onClick={() => close.mutate()}
            disabled={!retrospective.trim() || close.isPending}
            className="px-4 py-2 bg-trust-blue text-white text-sm rounded-lg hover:bg-trust-blue/90 disabled:opacity-50 disabled:cursor-not-allowed"
          >
            Close thread
          </button>
        </div>
      </div>
    </div>
  );
}

export default function ThreadDetail() {
  const { id } = useParams<{ id: string }>();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const [closing, setClosing] = useState(false);

  const { data: brief, isLoading, error } = useQuery({
    queryKey: ['thread-brief', id],
    queryFn: () => threads.brief(id!),
    enabled: !!id,
    refetchInterval: 15000,
  });

  const { data: watchers } = useQuery({
    queryKey: ['thread-watchers', id],
    queryFn: () => threads.watchers(id!),
    enabled: !!id,
  });

  const refresh = () => {
    queryClient.invalidateQueries({ queryKey: ['thread-brief', id] });
    queryClient.invalidateQueries({ queryKey: ['thread-watchers', id] });
    queryClient.invalidateQueries({ queryKey: ['threads'] });
    queryClient.invalidateQueries({ queryKey: ['threads-badge'] });
  };

  const acknowledge = useMutation({ mutationFn: (itemId: string) => threads.acknowledge(id!, itemId), onSuccess: refresh });
  const updateItem = useMutation({
    mutationFn: ({ itemId, patch }: { itemId: string; patch: Partial<ThreadItem> }) =>
      threads.updateItem(id!, itemId, patch),
    onSuccess: refresh,
  });
  const accept = useMutation({ mutationFn: (cid: string) => threads.acceptCandidate(id!, cid), onSuccess: refresh });
  const dismiss = useMutation({ mutationFn: (cid: string) => threads.dismissCandidate(id!, cid), onSuccess: refresh });
  const removeWatcher = useMutation({ mutationFn: (wid: string) => threads.removeWatcher(id!, wid), onSuccess: refresh });
  const setStatus = useMutation({
    mutationFn: (status: 'active' | 'paused') => threads.setStatus(id!, status),
    onSuccess: refresh,
  });

  if (isLoading) {
    return (
      <div className="flex justify-center py-12">
        <Loader2 className="w-6 h-6 animate-spin text-gray-400" />
      </div>
    );
  }
  if (error || !brief) {
    return <p className="p-8 text-red-400">Failed to load thread.</p>;
  }

  const { thread, sections } = brief;
  const readOnly = thread.status === 'closed';
  const timelineItems = [...brief.events, ...brief.openTodos, ...brief.upcoming];
  const openItems = [...brief.openTodos, ...brief.upcoming, ...brief.firedUnacknowledged].filter(
    (item, i, all) => all.findIndex((o) => o.id === item.id) === i
  );

  return (
    <div className="p-4 sm:p-8 max-w-4xl mx-auto space-y-4">
      <Link to="/threads" className="inline-flex items-center gap-1.5 text-sm text-gray-400 hover:text-white">
        <ArrowLeft className="w-4 h-4" />
        Threads
      </Link>

      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex items-center gap-3">
          <Route className="w-6 h-6 text-trust-blue" />
          <h1 className="text-2xl font-semibold">{thread.title}</h1>
          <span className="px-2 py-0.5 text-xs rounded-full bg-white/10 text-gray-300">{thread.status}</span>
        </div>
        {!readOnly && (
          <div className="flex gap-2">
            <button
              className={smallButton}
              disabled={setStatus.isPending}
              onClick={() => setStatus.mutate(thread.status === 'paused' ? 'active' : 'paused')}
            >
              {thread.status === 'paused' ? 'Resume' : 'Pause'}
            </button>
            <button className={smallButton} onClick={() => setClosing(true)}>Close thread</button>
          </div>
        )}
      </div>

      <ThreadTimeline items={timelineItems} />

      <Section title="Now">
        <Markdown text={sections.Now} />
      </Section>

      <Section title="Goal / Next">
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
          <div>
            <p className="text-xs text-gray-500 mb-1">Goal</p>
            <Markdown text={sections.Goal || thread.goal || ''} />
          </div>
          <div>
            <p className="text-xs text-gray-500 mb-1">Next</p>
            <Markdown text={sections.Next} />
          </div>
        </div>
      </Section>

      {brief.firedUnacknowledged.length > 0 && (
        <Section title="Due now">
          <ul className="space-y-2">
            {brief.firedUnacknowledged.map((item) => (
              <li key={item.id} className="flex items-center justify-between gap-3">
                <span className="text-sm text-gray-200">{item.title}</span>
                {!readOnly && (
                  <button className={smallButton} onClick={() => acknowledge.mutate(item.id)}>Acknowledge</button>
                )}
              </li>
            ))}
          </ul>
        </Section>
      )}

      <Section title="Todos">
        {brief.openTodos.length === 0 ? (
          <p className="text-sm text-gray-500">No open todos.</p>
        ) : (
          <ul className="space-y-2">
            {brief.openTodos.map((item) => (
              <li key={item.id} className="flex items-center gap-3">
                {!readOnly && (
                  <input
                    type="checkbox"
                    aria-label={`Mark done: ${item.title}`}
                    onChange={() => updateItem.mutate({ itemId: item.id, patch: { status: 'done' } })}
                  />
                )}
                <span className="text-sm text-gray-200 flex-1">{item.title}</span>
                {item.dueAt && <span className="text-xs text-gray-500">{formatDay(item.dueAt)}</span>}
              </li>
            ))}
          </ul>
        )}
      </Section>

      <Section title="Deadlines & reminders">
        {brief.upcoming.length === 0 ? (
          <p className="text-sm text-gray-500">Nothing upcoming.</p>
        ) : (
          <ul className="space-y-2">
            {brief.upcoming.map((item) => {
              const field = item.kind === 'reminder' ? 'remindAt' : 'dueAt';
              const value = item[field];
              return (
                <li key={item.id} className="flex items-center justify-between gap-3">
                  <span className="text-sm text-gray-200">{item.title}</span>
                  {readOnly ? (
                    value && <span className="text-xs text-gray-500">{formatDay(value)}</span>
                  ) : (
                    <input
                      type="date"
                      aria-label={`Date for ${item.title}`}
                      className={`${inputClass} py-1`}
                      value={toDateInput(value)}
                      onChange={(e) =>
                        e.target.value &&
                        updateItem.mutate({
                          itemId: item.id,
                          patch: { [field]: new Date(e.target.value).toISOString() },
                        })
                      }
                    />
                  )}
                </li>
              );
            })}
          </ul>
        )}
      </Section>

      {brief.pendingCandidates.length > 0 && (
        <Section title="Candidates">
          <ul className="space-y-2">
            {brief.pendingCandidates.map((c) => (
              <li key={c.id} className="flex items-center justify-between gap-3">
                <span className="text-sm text-gray-200">{c.summary}</span>
                {!readOnly && (
                  <span className="flex gap-2 shrink-0">
                    <button className={smallButton} onClick={() => accept.mutate(c.id)}>
                      <Check className="w-3 h-3 inline mr-1" />Accept
                    </button>
                    <button className={smallButton} onClick={() => dismiss.mutate(c.id)}>
                      <X className="w-3 h-3 inline mr-1" />Dismiss
                    </button>
                  </span>
                )}
              </li>
            ))}
          </ul>
        </Section>
      )}

      <Section title="Watchers">
        {!watchers || watchers.length === 0 ? (
          <p className="text-sm text-gray-500">No watchers.</p>
        ) : (
          <ul className="space-y-2">
            {watchers.map((w) => (
              <li key={w.id} className="flex items-center justify-between gap-3">
                <span className="flex items-center gap-2 text-sm text-gray-200">
                  <Eye className="w-3.5 h-3.5 text-gray-500" />
                  {w.description}
                  {thread.status === 'paused' && (
                    <span className="px-2 py-0.5 text-xs rounded-full bg-amber-500/20 text-amber-300">suspended</span>
                  )}
                </span>
                {!readOnly && (
                  <button
                    aria-label={`Remove watcher: ${w.description}`}
                    className="text-gray-500 hover:text-red-400"
                    onClick={() => removeWatcher.mutate(w.id)}
                  >
                    <X className="w-4 h-4" />
                  </button>
                )}
              </li>
            ))}
          </ul>
        )}
      </Section>

      <Link
        to={`/memory/${thread.rootEntryId}`}
        className="inline-flex items-center gap-1.5 text-sm text-trust-blue hover:underline"
      >
        <ExternalLink className="w-4 h-4" />
        Open the memory entry
      </Link>

      {closing && (
        <CloseDialog
          threadId={thread.id}
          items={openItems}
          onCancel={() => setClosing(false)}
          onDone={() => {
            setClosing(false);
            refresh();
            navigate('/threads');
          }}
        />
      )}
    </div>
  );
}
