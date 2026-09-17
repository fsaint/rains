import { useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { ShieldAlert, ShieldCheck } from 'lucide-react';
import { mcpTokens, ApiError } from '../api/client';

/**
 * Which clients can reach this agent's MCP endpoint, and whether the
 * unauthenticated URL is still open.
 *
 * Both are shown while both work. Hiding the old URL while it still functions
 * is how you get tickets from someone whose configuration stopped being
 * documented but kept running.
 */
export default function McpAccessSection({ agentId }: { agentId: string }) {
  const queryClient = useQueryClient();
  const [confirming, setConfirming] = useState(false);

  const { data, isLoading } = useQuery({
    queryKey: ['mcp-tokens', agentId],
    queryFn: () => mcpTokens.list(agentId),
  });

  const invalidate = () => queryClient.invalidateQueries({ queryKey: ['mcp-tokens', agentId] });

  const setUnauth = useMutation({
    mutationFn: (allowed: boolean) => mcpTokens.setUnauthenticated(agentId, allowed),
    onSuccess: () => { setConfirming(false); invalidate(); },
  });

  const revoke = useMutation({
    mutationFn: (tokenId: string) => mcpTokens.revoke(agentId, tokenId),
    onSuccess: invalidate,
  });

  if (isLoading || !data) return null;

  const open = data.allowUnauthenticated;

  return (
    <div className="space-y-3">
      <div>
        <label className="block text-xs font-medium text-gray-400 uppercase tracking-wider mb-1.5">
          Connected clients
        </label>
        {data.tokens.length === 0 ? (
          <p className="text-xs text-gray-500 p-3 bg-gray-50 rounded-lg border border-gray-200">
            No client has authenticated yet. Add this server to Claude Code or Claude and approve
            the connection, and it will appear here.
          </p>
        ) : (
          <div className="space-y-1">
            {data.tokens.map((t) => (
              <div
                key={t.id}
                className="flex items-center justify-between gap-3 p-2.5 bg-gray-50 rounded-lg border border-gray-200"
              >
                <div className="min-w-0">
                  <div className="text-sm text-gray-800 truncate">{t.name}</div>
                  <div className="text-[11px] text-gray-500">
                    {t.lastUsedAt
                      ? `last used ${new Date(t.lastUsedAt).toLocaleString()}`
                      : 'never used'}
                    {' · '}
                    <span className="font-mono">{t.tokenPrefix}…</span>
                  </div>
                </div>
                <button
                  onClick={() => revoke.mutate(t.id)}
                  className="shrink-0 text-xs text-gray-500 hover:text-red-600 transition-colors"
                >
                  Revoke
                </button>
              </div>
            ))}
          </div>
        )}
      </div>

      <div
        className={`p-3 rounded-lg border ${
          open ? 'bg-amber-50 border-amber-200' : 'bg-emerald-50 border-emerald-200'
        }`}
      >
        <div className="flex items-start gap-2">
          {open ? (
            <ShieldAlert className="w-4 h-4 text-amber-600 shrink-0 mt-0.5" />
          ) : (
            <ShieldCheck className="w-4 h-4 text-emerald-600 shrink-0 mt-0.5" />
          )}
          <div className="min-w-0 flex-1">
            {open ? (
              <>
                <p className="text-xs text-amber-900 font-medium">
                  The URL above also works without a token
                </p>
                <p className="text-xs text-amber-800 mt-0.5">
                  Anyone who has it can act as this agent. Close it once the clients listed above
                  are the only ones you use — you can reopen it at any time.
                </p>
                {confirming ? (
                  <div className="flex items-center gap-2 mt-2">
                    <button
                      onClick={() => setUnauth.mutate(false)}
                      disabled={setUnauth.isPending}
                      className="px-2.5 py-1 rounded bg-amber-600 text-white text-xs hover:bg-amber-700 disabled:opacity-50"
                    >
                      Yes, require a token
                    </button>
                    <button
                      onClick={() => setConfirming(false)}
                      className="px-2.5 py-1 rounded text-xs text-amber-800 hover:bg-amber-100"
                    >
                      Cancel
                    </button>
                  </div>
                ) : (
                  <button
                    onClick={() => setConfirming(true)}
                    className="mt-2 px-2.5 py-1 rounded bg-white border border-amber-300 text-amber-900 text-xs hover:bg-amber-100"
                  >
                    Disable unauthenticated access
                  </button>
                )}
              </>
            ) : (
              <>
                <p className="text-xs text-emerald-900 font-medium">
                  A token is required to reach this agent
                </p>
                <p className="text-xs text-emerald-800 mt-0.5">
                  Any client still using the plain URL will get a 401.
                </p>
                <button
                  onClick={() => setUnauth.mutate(true)}
                  disabled={setUnauth.isPending}
                  className="mt-2 px-2.5 py-1 rounded bg-white border border-emerald-300 text-emerald-900 text-xs hover:bg-emerald-100 disabled:opacity-50"
                >
                  Allow unauthenticated access again
                </button>
                {/* The latch. Re-opening is refused while an admin agent exists,
                    because an agent id is a credential on an open endpoint —
                    the admin agent could grant this one access and then use it
                    directly. Explained here, where the click happens. */}
                {setUnauth.isError && (setUnauth.error as ApiError)?.code === 'ADMIN_AGENT_EXISTS' && (
                  <p className="text-xs text-amber-800 mt-2 p-2 bg-amber-50 border border-amber-200 rounded">
                    {(setUnauth.error as ApiError).message}
                  </p>
                )}
              </>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
