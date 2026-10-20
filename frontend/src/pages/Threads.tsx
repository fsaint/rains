import { useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { Link, useNavigate } from 'react-router-dom';
import { Route, Plus, X, Loader2, Calendar } from 'lucide-react';
import { threads, memoryScopes, ApiError } from '../api/client';
import type { ThreadStatus } from '../api/client';
import { formatTimeAgo } from '../utils/format';

const TABS: Array<{ status: ThreadStatus; label: string }> = [
  { status: 'active', label: 'Active' },
  { status: 'paused', label: 'Paused' },
  { status: 'closed', label: 'Closed' },
];

const EMPTY_COPY: Record<ThreadStatus, string> = {
  active: "No active threads. Threads are the few things you've chosen to focus on.",
  paused: 'No paused threads.',
  closed: 'No closed threads.',
};

const formatDay = (iso: string) => new Date(iso).toLocaleDateString();

function NewThreadForm({ onClose }: { onClose: () => void }) {
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const [title, setTitle] = useState('');
  const [goal, setGoal] = useState('');
  const [scope, setScope] = useState('');
  const [targetDate, setTargetDate] = useState('');

  const { data: scopes } = useQuery({
    queryKey: ['memory-scopes'],
    queryFn: () => memoryScopes.list(),
  });

  const create = useMutation({
    mutationFn: () =>
      threads.create({
        title: title.trim(),
        ...(goal.trim() && { goal: goal.trim() }),
        ...(scope && { scope }),
        ...(targetDate && { targetDate }),
      }),
    onSuccess: (thread) => {
      queryClient.invalidateQueries({ queryKey: ['threads'] });
      queryClient.invalidateQueries({ queryKey: ['threads-badge'] });
      navigate(`/threads/${thread.id}`);
    },
  });

  const inputClass =
    'w-full bg-white/5 border border-white/10 rounded-lg px-3 py-2 text-sm text-white placeholder-gray-500 focus:outline-none focus:border-trust-blue';

  return (
    <form
      onSubmit={(e) => {
        e.preventDefault();
        if (title.trim()) create.mutate();
      }}
      className="bg-white/5 rounded-xl p-4 border border-white/10 mb-6 space-y-3"
    >
      <div className="flex items-center justify-between">
        <h2 className="font-medium">New thread</h2>
        <button type="button" onClick={onClose} className="text-gray-400 hover:text-white" aria-label="Cancel">
          <X className="w-4 h-4" />
        </button>
      </div>

      <div>
        <label htmlFor="thread-title" className="block text-xs text-gray-400 mb-1">Title</label>
        <input id="thread-title" className={inputClass} value={title} onChange={(e) => setTitle(e.target.value)} />
      </div>
      <div>
        <label htmlFor="thread-goal" className="block text-xs text-gray-400 mb-1">Goal</label>
        <input id="thread-goal" className={inputClass} value={goal} onChange={(e) => setGoal(e.target.value)} />
      </div>
      <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
        <div>
          <label htmlFor="thread-scope" className="block text-xs text-gray-400 mb-1">Scope</label>
          <select id="thread-scope" className={inputClass} value={scope} onChange={(e) => setScope(e.target.value)}>
            <option value="">Default scope</option>
            {scopes?.map((s) => (
              <option key={s.id} value={s.slug}>{s.name}</option>
            ))}
          </select>
        </div>
        <div>
          <label htmlFor="thread-target" className="block text-xs text-gray-400 mb-1">Target date</label>
          <input
            id="thread-target"
            type="date"
            className={inputClass}
            value={targetDate}
            onChange={(e) => setTargetDate(e.target.value)}
          />
        </div>
      </div>

      {create.error && (
        <p className="text-sm text-red-400">
          {create.error instanceof ApiError ? create.error.message : 'Could not create the thread.'}
        </p>
      )}

      <div className="flex justify-end">
        <button
          type="submit"
          disabled={!title.trim() || create.isPending}
          className="px-4 py-2 bg-trust-blue text-white text-sm rounded-lg hover:bg-trust-blue/90 disabled:opacity-50 disabled:cursor-not-allowed"
        >
          Create thread
        </button>
      </div>
    </form>
  );
}

export default function Threads() {
  const [status, setStatus] = useState<ThreadStatus>('active');
  const [showForm, setShowForm] = useState(false);

  const { data, isLoading, error } = useQuery({
    queryKey: ['threads', status],
    queryFn: () => threads.list(status),
  });

  return (
    <div className="p-4 sm:p-8 max-w-4xl mx-auto">
      <div className="flex items-center justify-between mb-6">
        <div className="flex items-center gap-3">
          <Route className="w-6 h-6 text-trust-blue" />
          <h1 className="text-2xl font-semibold">Threads</h1>
        </div>
        {!showForm && (
          <button
            onClick={() => setShowForm(true)}
            className="flex items-center gap-2 px-4 py-2 bg-trust-blue text-white text-sm rounded-lg hover:bg-trust-blue/90"
          >
            <Plus className="w-4 h-4" />
            New thread
          </button>
        )}
      </div>

      {showForm && <NewThreadForm onClose={() => setShowForm(false)} />}

      <div className="flex gap-1 mb-6 border-b border-white/10">
        {TABS.map((tab) => (
          <button
            key={tab.status}
            onClick={() => setStatus(tab.status)}
            className={`px-4 py-2 text-sm font-medium border-b-2 -mb-px transition-colors ${
              status === tab.status
                ? 'border-trust-blue text-white'
                : 'border-transparent text-gray-400 hover:text-white'
            }`}
          >
            {tab.label}
          </button>
        ))}
      </div>

      {isLoading ? (
        <div className="flex justify-center py-12">
          <Loader2 className="w-6 h-6 animate-spin text-gray-400" />
        </div>
      ) : error ? (
        <p className="text-red-400">Failed to load threads.</p>
      ) : !data || data.length === 0 ? (
        <p className="text-center text-gray-400 py-12">{EMPTY_COPY[status]}</p>
      ) : (
        <div className="space-y-3">
          {data.map((thread) => (
            <Link
              key={thread.id}
              to={`/threads/${thread.id}`}
              className="block bg-white/5 rounded-xl p-4 border border-white/10 hover:border-trust-blue/50 transition-all"
            >
              <div className="flex items-start justify-between gap-4">
                <h3 className="font-medium">{thread.title}</h3>
                <span className="text-xs text-gray-500 shrink-0">{formatTimeAgo(thread.updatedAt)}</span>
              </div>
              {thread.goal && <p className="text-sm text-gray-400 mt-1">{thread.goal}</p>}
              {thread.nextDueAt && (
                <p className="flex items-center gap-1.5 text-xs text-gray-400 mt-3">
                  <Calendar className="w-3.5 h-3.5" />
                  Next due {formatDay(thread.nextDueAt)}
                </p>
              )}
            </Link>
          ))}
        </div>
      )}
    </div>
  );
}
