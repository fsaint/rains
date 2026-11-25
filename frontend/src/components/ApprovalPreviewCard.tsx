import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { AlertTriangle } from 'lucide-react';
import { approvals } from '../api/client';

/** Approvals that are not tool calls, so there is nothing to look up for them. */
export const NO_PREVIEW_TOOLS = new Set(['reauth', 'telegram_group']);

/** Long bodies are clipped with a toggle rather than stretching the card. */
const BODY_PREVIEW_CHARS = 1500;

/**
 * What an approval would do, with its ids resolved to names. Rendered from the
 * same preview as the Telegram message; shows nothing for a tool that has none,
 * and the raw arguments below it remain.
 */
export function ApprovalPreviewCard({ approvalId }: { approvalId: string }) {
  const [expanded, setExpanded] = useState(false);
  const { data, isLoading, isError } = useQuery({
    queryKey: ['approval-preview', approvalId],
    queryFn: () => approvals.preview(approvalId),
    // The lookup may call an outside service; the approval itself does not change.
    staleTime: Infinity,
  });

  if (isLoading || isError || !data) return null;

  const body = data.body?.text ?? '';
  const clipped = body.length > BODY_PREVIEW_CHARS;

  return (
    <div className="mt-4 rounded-lg border border-gray-200 overflow-hidden" data-testid="approval-preview">
      <div
        className={`px-4 py-2 text-sm ${
          data.destructive ? 'bg-red-50 text-alert-red' : 'bg-blue-50 text-blue-900'
        }`}
      >
        <span aria-hidden="true">{data.icon}</span> <span className="font-semibold">{data.heading}</span>
        {data.note && <span className="text-xs opacity-80"> — {data.note}</span>}
      </div>

      <div className="px-4 py-3 space-y-1">
        {data.warning && (
          <p className="flex items-start gap-2 text-sm text-alert-red mb-2">
            <AlertTriangle className="w-4 h-4 mt-0.5 shrink-0" />
            {data.warning}
          </p>
        )}
        {data.rows.map((row) => (
          <div key={row.label} className="flex gap-3 text-sm">
            <span className="w-24 shrink-0 text-gray-500">{row.label}</span>
            <span className="min-w-0 break-words text-gray-900">
              {row.was !== undefined && (
                <>
                  <span className="text-gray-400 line-through">{row.was || '(empty)'}</span>
                  <span className="mx-1 text-gray-400">→</span>
                </>
              )}
              <span className={row.was !== undefined ? 'font-medium' : undefined}>{row.value}</span>
            </span>
          </div>
        ))}
        {data.items && (
          <div className="pt-1">
            <p className="text-sm text-gray-500">{data.items.label}</p>
            <ul className="mt-1 space-y-1">
              {data.items.list.map((item, index) => (
                <li key={index} className="text-sm min-w-0 break-words">
                  <span className="text-gray-900">{item.title}</span>
                  {item.detail && <span className="text-gray-500"> — {item.detail}</span>}
                </li>
              ))}
            </ul>
            {data.items.more > 0 && <p className="mt-1 text-xs text-gray-500">…and {data.items.more} more</p>}
          </div>
        )}
      </div>

      {body && (
        <div className="border-t border-gray-100 px-4 py-3">
          {data.body?.label && <p className="mb-1 text-xs text-gray-500">{data.body.label}</p>}
          <p className="whitespace-pre-wrap break-words text-sm text-gray-800">
            {clipped && !expanded ? `${body.slice(0, BODY_PREVIEW_CHARS)}…` : body}
          </p>
          {clipped && (
            <button
              type="button"
              onClick={() => setExpanded((v) => !v)}
              className="mt-1 text-xs text-trust-blue hover:underline"
            >
              {expanded ? 'Show less' : 'Show all'}
            </button>
          )}
        </div>
      )}
    </div>
  );
}
