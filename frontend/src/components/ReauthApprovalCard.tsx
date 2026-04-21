import { Clock, KeyRound, ShieldAlert } from 'lucide-react';

const PROVIDER_LABELS: Record<string, string> = {
  anthropic: 'Anthropic Claude',
  'openai-codex': 'OpenAI',
  minimax: 'MiniMax',
  fly: 'Fly.io',
  docker: 'Docker',
  gmail: 'Gmail',
  drive: 'Google Drive',
  calendar: 'Google Calendar',
  github: 'GitHub',
  linear: 'Linear',
  notion: 'Notion',
  'outlook-mail': 'Outlook Mail',
  'outlook-calendar': 'Outlook Calendar',
  microsoft: 'Microsoft',
  hermeneutix: 'Hermeneutix',
};

export interface ReauthApproval {
  id: string;
  agentId: string;
  tool: string;
  arguments: Record<string, unknown>;
  context?: string;
  status: string;
  requestedAt: string;
  expiresAt: string;
}

interface Props {
  approval: ReauthApproval;
  onReauth: () => void;
}

function getTimeRemaining(expiresAt: string) {
  const diff = new Date(expiresAt).getTime() - Date.now();
  if (diff <= 0) return 'Expired';
  const minutes = Math.floor(diff / 60000);
  if (minutes < 60) return `${minutes}m remaining`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ${minutes % 60}m remaining`;
  return `${Math.floor(hours / 24)}d remaining`;
}

export function ReauthApprovalCard({ approval, onReauth }: Props) {
  const provider = (approval.arguments.provider as string) ?? 'unknown';
  const source = approval.arguments.source as string | undefined;
  const providerLabel = PROVIDER_LABELS[provider] ?? provider;
  const isFromToolCall = source === 'mcp_tool_call';
  const isFromMonitor = source === 'token_monitor' || source === 'health_monitor';

  return (
    <div className="bg-white rounded-xl p-6 shadow-sm border border-amber-100">
      <div className="flex flex-col sm:flex-row sm:items-start sm:justify-between gap-4">
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-3 mb-2">
            <div className="w-8 h-8 rounded-lg bg-amber-50 flex items-center justify-center shrink-0">
              <ShieldAlert className="w-4 h-4 text-amber-600" />
            </div>
            <div>
              <h3 className="font-semibold text-gray-900">
                Re-authenticate {providerLabel}
              </h3>
              <p className="text-xs text-gray-500 mt-0.5">
                {isFromToolCall
                  ? 'Credentials expired during a tool call'
                  : isFromMonitor
                  ? 'Token expired — agent is unable to start'
                  : 'Credentials required for deployment'}
              </p>
            </div>
          </div>

          <div className="grid grid-cols-2 gap-4 mt-4">
            <div>
              <p className="text-xs text-gray-500 uppercase tracking-wider">Agent</p>
              <p className="font-medium text-sm">{approval.agentId}</p>
            </div>
            <div>
              <p className="text-xs text-gray-500 uppercase tracking-wider">Requested</p>
              <p className="font-medium text-sm">{new Date(approval.requestedAt).toLocaleString()}</p>
            </div>
          </div>

          {approval.context && (
            <div className="mt-4 p-3 bg-amber-50 rounded-lg border border-amber-100">
              <p className="text-xs text-amber-800 leading-relaxed">{approval.context}</p>
            </div>
          )}
        </div>

        <div className="flex sm:flex-col items-center sm:items-end justify-between sm:justify-start gap-3 shrink-0">
          <div className="flex items-center gap-1 text-sm text-amber-600">
            <Clock className="w-4 h-4" />
            <span>{getTimeRemaining(approval.expiresAt)}</span>
          </div>

          <button
            onClick={onReauth}
            className="flex items-center gap-2 px-4 py-2 bg-trust-blue text-white rounded-lg hover:bg-blue-600 transition-colors text-sm font-medium whitespace-nowrap"
          >
            <KeyRound className="w-4 h-4" />
            Re-authenticate
          </button>
        </div>
      </div>
    </div>
  );
}
