import type { ThreadItem } from '../api/client';

const MAX_PER_SIDE = 10;

const formatDay = (iso: string) => new Date(iso).toLocaleDateString();

/**
 * Horizontal band: past events left of a Today marker, upcoming dated
 * deadlines, milestones and todos right of it. Capped at 20 items in all.
 */
export default function ThreadTimeline({ items: all, now = new Date() }: { items: ThreadItem[]; now?: Date }) {
  const items = all.filter((item, i) => all.findIndex((o) => o.id === item.id) === i);
  const past = items
    .filter((i) => i.kind === 'event' && i.occurredAt)
    .sort((a, b) => a.occurredAt!.localeCompare(b.occurredAt!))
    .slice(-MAX_PER_SIDE);
  const future = items
    .filter((i) => i.status === 'open' && ['deadline', 'milestone', 'todo'].includes(i.kind) && i.dueAt)
    .sort((a, b) => a.dueAt!.localeCompare(b.dueAt!))
    .slice(0, MAX_PER_SIDE);

  const node = (item: ThreadItem, side: 'past' | 'future') => {
    const when = side === 'past' ? item.occurredAt! : item.dueAt!;
    const overdue = side === 'future' && new Date(when) < now;
    return (
      <div
        key={item.id}
        data-testid="timeline-item"
        data-side={side}
        className="shrink-0 w-32 flex flex-col items-center text-center"
      >
        <span className="text-xs text-gray-300 line-clamp-2 mb-1">{item.title}</span>
        <span
          className={`w-2.5 h-2.5 rounded-full ${
            side === 'past' ? 'bg-gray-500' : overdue ? 'bg-red-400' : 'bg-trust-blue'
          }`}
        />
        <span className={`text-xs mt-1 ${overdue ? 'text-red-400' : 'text-gray-500'}`}>{formatDay(when)}</span>
      </div>
    );
  };

  return (
    <div className="bg-white/5 rounded-xl p-4 border border-white/10 overflow-x-auto">
      <div className="flex items-end gap-4 min-w-max">
        {past.map((i) => node(i, 'past'))}
        <div className="shrink-0 flex flex-col items-center self-stretch">
          <span className="text-xs font-medium text-trust-blue mb-1">Today</span>
          <span className="w-px flex-1 bg-trust-blue min-h-8" />
        </div>
        {future.map((i) => node(i, 'future'))}
      </div>
    </div>
  );
}
