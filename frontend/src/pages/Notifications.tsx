import { useState, useEffect, useRef } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { MessageCircle, Link, Unlink, CheckCircle, AlertCircle, Loader } from 'lucide-react';
import { telegram, auth } from '../api/client';

export default function Notifications() {
  const queryClient = useQueryClient();
  const [linkUrl, setLinkUrl] = useState<string | null>(null);
  const [linkError, setLinkError] = useState<string | null>(null);
  const pollingRef = useRef<ReturnType<typeof setInterval> | null>(null);

  const { data: session } = useQuery({
    queryKey: ['session'],
    queryFn: () => auth.session(),
  });

  const telegramLinked = session?.user?.telegramLinked ?? false;

  // Stop polling once linked
  useEffect(() => {
    if (telegramLinked && pollingRef.current) {
      clearInterval(pollingRef.current);
      pollingRef.current = null;
      setLinkUrl(null);
    }
  }, [telegramLinked]);

  // Clean up polling on unmount
  useEffect(() => {
    return () => {
      if (pollingRef.current) clearInterval(pollingRef.current);
    };
  }, []);

  const createLinkMutation = useMutation({
    mutationFn: () => telegram.createLink(),
    onSuccess: (data) => {
      setLinkError(null);
      setLinkUrl(data.url);
      window.open(data.url, '_blank', 'noopener,noreferrer');

      // Poll session every 2s for up to 90s to detect successful link
      let elapsed = 0;
      pollingRef.current = setInterval(async () => {
        elapsed += 2000;
        await queryClient.invalidateQueries({ queryKey: ['session'] });
        if (elapsed >= 90000 && pollingRef.current) {
          clearInterval(pollingRef.current);
          pollingRef.current = null;
        }
      }, 2000);
    },
    onError: (err: Error) => {
      setLinkError(err.message);
    },
  });

  const unlinkMutation = useMutation({
    mutationFn: () => telegram.unlink(),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['session'] });
    },
  });

  return (
    <div className="p-4 sm:p-8 max-w-2xl mx-auto">
      <div className="mb-8">
        <h1 className="text-2xl font-bold text-white">Notifications</h1>
        <p className="text-gray-400 mt-1">
          Manage how you receive approval requests from your agents.
        </p>
      </div>

      {/* Telegram section */}
      <div className="bg-gray-900 rounded-xl border border-gray-800 p-6">
        <div className="flex items-start gap-4">
          <div className="w-10 h-10 rounded-lg bg-blue-500/10 flex items-center justify-center flex-shrink-0">
            <MessageCircle className="w-5 h-5 text-blue-400" />
          </div>
          <div className="flex-1 min-w-0">
            <h2 className="text-white font-semibold text-lg">Telegram</h2>
            <p className="text-gray-400 text-sm mt-1">
              Receive approval requests as Telegram DMs with inline{' '}
              <span className="text-green-400">Approve</span> /{' '}
              <span className="text-red-400">Deny</span> buttons.
            </p>

            <div className="mt-4">
              {telegramLinked ? (
                <div className="space-y-3">
                  <div className="flex items-center gap-2 text-safe-green text-sm">
                    <CheckCircle className="w-4 h-4" />
                    <span>Connected — approvals will be sent to your Telegram.</span>
                  </div>
                  <button
                    onClick={() => unlinkMutation.mutate()}
                    disabled={unlinkMutation.isPending}
                    className="flex items-center gap-2 px-4 py-2 bg-gray-800 hover:bg-gray-700 text-gray-300 hover:text-white rounded-lg text-sm transition-colors disabled:opacity-50"
                  >
                    {unlinkMutation.isPending ? (
                      <Loader className="w-4 h-4 animate-spin" />
                    ) : (
                      <Unlink className="w-4 h-4" />
                    )}
                    Disconnect Telegram
                  </button>
                </div>
              ) : (
                <div className="space-y-3">
                  {linkUrl && !telegramLinked && (
                    <div className="flex items-center gap-2 text-trust-blue text-sm">
                      <Loader className="w-4 h-4 animate-spin" />
                      <span>
                        Waiting for you to open the bot link and send{' '}
                        <code className="font-mono text-xs bg-gray-800 px-1 py-0.5 rounded">/start</code>…
                      </span>
                    </div>
                  )}
                  {linkError && (
                    <div className="flex items-center gap-2 text-red-400 text-sm">
                      <AlertCircle className="w-4 h-4" />
                      <span>{linkError}</span>
                    </div>
                  )}
                  <button
                    onClick={() => createLinkMutation.mutate()}
                    disabled={createLinkMutation.isPending}
                    className="flex items-center gap-2 px-4 py-2 bg-trust-blue hover:bg-trust-blue/80 text-white rounded-lg text-sm font-medium transition-colors disabled:opacity-50"
                  >
                    {createLinkMutation.isPending ? (
                      <Loader className="w-4 h-4 animate-spin" />
                    ) : (
                      <Link className="w-4 h-4" />
                    )}
                    Connect Telegram
                  </button>
                  {linkUrl && (
                    <p className="text-gray-500 text-xs">
                      A Telegram link opened in a new tab. If it didn't open,{' '}
                      <a
                        href={linkUrl}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="text-trust-blue hover:underline"
                      >
                        click here
                      </a>
                      . The link expires in 10 minutes.
                    </p>
                  )}
                </div>
              )}
            </div>
          </div>
        </div>
      </div>

      {/* iOS Push (existing) */}
      <div className="bg-gray-900 rounded-xl border border-gray-800 p-6 mt-4 opacity-60">
        <div className="flex items-start gap-4">
          <div className="w-10 h-10 rounded-lg bg-gray-800 flex items-center justify-center flex-shrink-0">
            <span className="text-lg"></span>
          </div>
          <div className="flex-1">
            <h2 className="text-white font-semibold text-lg">iOS Push Notifications</h2>
            <p className="text-gray-400 text-sm mt-1">
              Automatically enabled when you install the AgentHelm iOS app on your device. No configuration needed here.
            </p>
          </div>
        </div>
      </div>
    </div>
  );
}
