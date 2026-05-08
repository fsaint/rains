import { useState, useEffect } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { useMutation, useQuery } from '@tanstack/react-query';
import { ArrowLeft, Loader2, ChevronDown, ChevronUp, Mail, MessageCircle } from 'lucide-react';
import { agents, initialPromptTemplates, config as apiConfig, auth, oauth, credentials, permissions, type CreateAndDeployData, type Credential } from '../api/client';

const DEFAULT_SOUL = `You are a helpful AI assistant. Be concise, friendly, and thoughtful in your responses.`;

const EMAIL_CALENDAR_SOUL = `# Email & Calendar Agent

You are a focused personal assistant responsible for managing email and calendar on behalf of the user. Your primary job is to keep their inbox organized and their schedule conflict-free.

---

## MCP Servers

Use the following MCP servers for all email and calendar operations:
- **gmail** — read, label, and manage email messages
- **google-calendar** — read and write calendar events

---

## Daily Email Review

Every day at **7:00 AM** (user's local time), automatically:
1. Fetch all unread emails from the inbox.
2. Triage each email according to the rules below.
3. Send the user a morning summary via Telegram with:
   - VIP messages that need attention
   - Meeting/event invitations found
   - Count of generic emails marked as read

---

## VIP List

Emails from the following senders or domains are **high priority** and must ALWAYS be surfaced to the user immediately — never auto-marked as read.

\`\`\`
# --- VIP DOMAINS ---
# example.com
# mycompany.com

# --- VIP PEOPLE (email addresses) ---
# boss@example.com
# important-client@example.com
\`\`\`

> To customize: add domain names (one per line) under VIP DOMAINS, and full email addresses under VIP PEOPLE.

---

## Generic Email Handling

If an email is **not** from a VIP sender and does **not** contain a meeting or event invitation, apply the following automatically:
1. Mark the email as **read**.
2. Apply the label **\`agent_read\`** to it.
3. Do not notify the user about it individually.

---

## Meeting & Event Invitations

When an email suggests, requests, or contains an invitation for a meeting or event:

1. **Extract** the proposed date(s), time(s), and duration.
2. **Check the calendar** for any existing events that overlap with the proposed time window.
3. If there is **no conflict**:
   - Show the user the invitation details.
   - Ask: "No conflicts found. Should I add this to your calendar?"
   - Only add the event **after explicit user confirmation**.
4. If there **is a conflict**:
   - Show the user both the invitation and the conflicting event(s).
   - Ask: "This conflicts with [event name] at [time]. How would you like to proceed?"
   - Never add an event to the calendar without user confirmation when a conflict exists.

---

## Tone & Communication Style

- Be brief and to the point in all summaries.
- Use bullet points for the morning digest.
- Always ask before taking any irreversible action (adding events, sending replies).
- When in doubt, surface the email to the user rather than auto-handling it.

---

## Telegram Interaction Style

When communicating via Telegram, **prefer inline buttons over free-text prompts** whenever the expected response is:
- A yes/no question (e.g. "Add to calendar?" → buttons: ✅ Yes / ❌ No)
- A small fixed set of options (e.g. "How to handle this conflict?" → buttons: \`Keep existing\` / \`Replace with new\` / \`Add both\` / \`Skip\`)
- A confirmation step before any action

Only fall back to free-text input when the user needs to provide open-ended information (e.g. a custom event title or a reply message body).`;

// Steps per flow
const EMAIL_CAL_STEPS = ['Setup'];
const CUSTOM_STEPS = ['Basics', 'Model', 'Personality', 'Deploy'];
const MANUAL_STEPS = ['Basics', 'Finish'];

type AgentType = 'email-calendar' | 'custom' | 'manual' | null;

export default function AgentNew() {
  const navigate = useNavigate();
  const [searchParams, setSearchParams] = useSearchParams();
  const [agentType, setAgentType] = useState<AgentType>(() => {
    const type = searchParams.get('type');
    return (type === 'email-calendar' || type === 'custom' || type === 'manual') ? type : null;
  });
  const [step, setStep] = useState(0);
  const [form, setForm] = useState<CreateAndDeployData>({
    name: '',
    telegramToken: '',
    telegramUserId: '',
    modelProvider: 'minimax',
    modelName: 'MiniMax-M2.7',
    soulMd: DEFAULT_SOUL,
    region: 'iad',
    openaiApiKey: '',
    modelCredentials: '',
    mcpServers: '',
    runtime: 'openclaw',
  });
  const [showAdvanced, setShowAdvanced] = useState(false);
  const [error, setError] = useState('');
  const [reauthApprovalId, setReauthApprovalId] = useState<string | null>(null);
  const [useCustomBot, setUseCustomBot] = useState(false);
  const [createdAgentId, setCreatedAgentId] = useState<string | null>(() => searchParams.get('created'));
  const [gmailConnected, setGmailConnected] = useState(() => searchParams.get('gmail_connected') === 'true');
  const restoredBotUsername = sessionStorage.getItem('pendingGmailBotUsername');

  // Clean URL params on mount to avoid stale state on refresh
  useEffect(() => {
    if (searchParams.get('created') || searchParams.get('type') || searchParams.get('gmail_connected')) {
      setSearchParams({}, { replace: true });
    }
    sessionStorage.removeItem('pendingGmailBotUsername');
  }, []);

  const { data: templatesData } = useQuery({
    queryKey: ['initial-prompt-templates'],
    queryFn: () => initialPromptTemplates.list(),
  });
  const templates = templatesData?.templates ?? [];

  const { data: publicConfig } = useQuery({
    queryKey: ['public-config'],
    queryFn: () => apiConfig.getPublic(),
  });
  const sharedBotEnabled = publicConfig?.sharedBotEnabled ?? false;

  const { data: sessionData } = useQuery({
    queryKey: ['session'],
    queryFn: () => auth.session(),
  });
  const knownTelegramUserId = sessionData?.user?.telegramUserId;

  useEffect(() => {
    if (knownTelegramUserId && !form.telegramUserId) {
      update({ telegramUserId: knownTelegramUserId });
    }
  }, [knownTelegramUserId]);

  // When email-calendar is chosen, wire up the soul + initial prompt template
  useEffect(() => {
    if (agentType === 'email-calendar' && templates.length > 0) {
      const tpl = templates.find((t) => t.id === 'email-and-calendar');
      update({ soulMd: EMAIL_CALENDAR_SOUL, initialPrompt: tpl?.content ?? undefined });
    }
  }, [agentType, templates.length]);

  const steps = agentType === 'email-calendar'
    ? EMAIL_CAL_STEPS
    : agentType === 'manual'
    ? MANUAL_STEPS
    : CUSTOM_STEPS;

  const { data: deployingAgent } = useQuery({
    queryKey: ['agent-detail', createdAgentId],
    queryFn: () => agents.getDetail(createdAgentId!),
    enabled: !!createdAgentId,
    refetchInterval: (query) => {
      const data = query.state.data;
      const status = data?.deployment?.status;
      if (status === 'error') return false;
      if (status === 'running') return false;
      return 3000;
    },
  });

  const { data: existingCreds } = useQuery({
    queryKey: ['credentials'],
    queryFn: () => credentials.list(),
    enabled: agentType === 'email-calendar' && !!createdAgentId,
  });
  const googleCreds: Credential[] = existingCreds?.filter((c) => c.serviceId === 'google') ?? [];

  const [linkingCredId, setLinkingCredId] = useState<string | null>(null);

  const handleLinkExistingCredential = async (cred: Credential) => {
    if (!createdAgentId) return;
    setLinkingCredId(cred.id);
    const GOOGLE_SERVICES = ['gmail', 'calendar', 'drive'] as const;
    try {
      await Promise.all(
        GOOGLE_SERVICES.map((svc) =>
          permissions.setServiceAccess(createdAgentId, svc, true)
            .then(() => permissions.linkCredential(createdAgentId, svc, cred.id))
            .catch(() => { /* best-effort */ })
        )
      );
      setGmailConnected(true);
    } finally {
      setLinkingCredId(null);
    }
  };

  const createMutation = useMutation({
    mutationFn: (data: CreateAndDeployData) => agents.createAndDeploy(data),
    onSuccess: (result) => {
      setCreatedAgentId(result.id);
    },
    onError: (err: unknown) => {
      const details = err instanceof Error && 'details' in err
        ? (err as any).details as { approvalId?: string }
        : undefined;
      if (details?.approvalId) {
        setReauthApprovalId(details.approvalId);
        setError('');
      } else {
        setError(err instanceof Error ? err.message : 'Failed to create agent');
      }
    },
  });

  const createManualMutation = useMutation({
    mutationFn: () => agents.createManual({
      name: form.name.trim(),
      description: form.description || undefined,
      soulMd: form.soulMd || undefined,
    }),
    onSuccess: (result) => {
      navigate(`/agents/${result.id}`);
    },
    onError: (err: unknown) => {
      setError(err instanceof Error ? err.message : 'Failed to create agent');
    },
  });

  const update = (patch: Partial<CreateAndDeployData>) => setForm((f) => ({ ...f, ...patch }));

  const canAdvance = () => {
    const tokenOk = (sharedBotEnabled && !useCustomBot) || (form.telegramToken?.trim() ?? '') !== '';
    if (agentType === 'email-calendar') {
      return form.name.trim() !== '' && tokenOk;
    }
    if (agentType === 'manual') {
      if (step === 0) return form.name.trim() !== '';
      return true;
    }
    // Custom flow
    if (step === 0) return form.name.trim() !== '' && tokenOk;
    if (step === 1) {
      if (form.modelProvider === 'openai' || form.modelProvider === 'anthropic') return !!form.openaiApiKey?.trim();
      return true;
    }
    return true;
  };

  const handleNext = () => {
    if (step < steps.length - 1) setStep((s) => s + 1);
  };

  const handleBack = () => {
    if (step > 0) setStep((s) => s - 1);
  };

  const handleSubmit = () => {
    setError('');
    if (agentType === 'manual') {
      createManualMutation.mutate();
      return;
    }
    createMutation.mutate({
      ...form,
      telegramToken: (sharedBotEnabled && !useCustomBot) ? undefined : (form.telegramToken || undefined),
      telegramUserId: form.telegramUserId || undefined,
      soulMd: form.soulMd || undefined,
      openaiApiKey: form.openaiApiKey || undefined,
      modelCredentials: form.modelCredentials || undefined,
      mcpServers: form.mcpServers || undefined,
      description: form.description || undefined,
    });
  };

  const isLastStep = step === steps.length - 1;

  // ── Success / deploying screen ──────────────────────────────────────────────
  if (createdAgentId) {
    const depStatus = deployingAgent?.deployment?.status;
    const botUsername = deployingAgent?.deployment?.telegramBotUsername ?? restoredBotUsername;
    const isRunning = depStatus === 'running' || (!!restoredBotUsername && !deployingAgent);
    const isError = depStatus === 'error';

    const handleConnectGmail = async () => {
      sessionStorage.setItem('pendingGmailAgentSetup', createdAgentId);
      sessionStorage.setItem('pendingGmailAgentType', agentType ?? 'email-calendar');
      if (botUsername) sessionStorage.setItem('pendingGmailBotUsername', botUsername);
      try {
        const { authUrl } = await oauth.initiateGoogle(['gmail', 'calendar', 'drive']);
        window.location.href = authUrl;
      } catch {
        // user can connect from the agent dashboard
      }
    };

    return (
      <div className="p-4 sm:p-8 max-w-2xl">
        <div className="flex items-center gap-4 mb-8">
          <div>
            <h1 className="text-2xl font-semibold text-reins-navy tracking-tight">
              {isRunning ? 'Agent Live' : isError ? 'Deployment Failed' : 'Creating Agent'}
            </h1>
            <p className="text-gray-400 text-sm mt-0.5">{deployingAgent?.name ?? 'Your new agent'}</p>
          </div>
        </div>

        <div className="rounded-xl border border-gray-200 p-8 text-center space-y-6">
          {isError ? (
            <>
              <div className="text-4xl">⚠️</div>
              <p className="font-semibold text-reins-navy">Deployment failed</p>
              <p className="text-sm text-gray-500">Something went wrong. Check the agent dashboard for details.</p>
              <button
                type="button"
                onClick={() => navigate(`/agents/${createdAgentId}`)}
                className="mt-2 px-5 py-2.5 bg-trust-blue text-white rounded-xl text-sm font-medium hover:bg-blue-600 transition-colors"
              >
                Go to dashboard
              </button>
            </>
          ) : isRunning ? (
            <>
              <div className="text-5xl">🎉</div>
              <div>
                <p className="text-xl font-semibold text-reins-navy">Your agent is live!</p>
                <p className="text-sm text-gray-400 mt-1">
                  {deployingAgent?.name ?? 'Your agent'} is ready to use.
                </p>
              </div>

              {/* Primary CTA — Telegram */}
              {botUsername ? (
                <a
                  href={`https://t.me/${botUsername}`}
                  target="_blank"
                  rel="noreferrer"
                  className="inline-flex items-center justify-center gap-2.5 w-full px-6 py-4 bg-trust-blue text-white rounded-xl text-base font-semibold hover:bg-blue-600 transition-colors shadow-md shadow-trust-blue/25"
                >
                  <MessageCircle className="w-5 h-5" />
                  Message your agent on Telegram
                </a>
              ) : (
                <div className="inline-flex items-center justify-center gap-2.5 w-full px-6 py-4 bg-gray-100 text-gray-400 rounded-xl text-base font-semibold cursor-not-allowed">
                  <MessageCircle className="w-5 h-5" />
                  Loading Telegram link…
                </div>
              )}

              <button
                type="button"
                onClick={() => navigate(`/agents/${createdAgentId}`)}
                className="text-sm text-gray-400 hover:text-gray-600 underline underline-offset-2"
              >
                Go to dashboard
              </button>
            </>
          ) : (
            <>
              <Loader2 className="w-8 h-8 animate-spin text-trust-blue mx-auto" />
              <p className="font-semibold text-reins-navy">Deploying your agent…</p>
              <p className="text-sm text-gray-500 capitalize">{depStatus ?? 'starting'}</p>
            </>
          )}
        </div>

        {/* Gmail connect — shown immediately while deploy is in progress */}
        {agentType === 'email-calendar' && !isError && (
          gmailConnected ? (
            <div className="mt-4 rounded-xl border border-green-200 bg-green-50 px-5 py-5 text-left space-y-1">
              <div className="flex items-center gap-2">
                <Mail className="w-4 h-4 text-green-600" />
                <p className="text-sm font-semibold text-green-800">Gmail connected</p>
              </div>
              <p className="text-xs text-green-700">
                Gmail, Calendar, and Drive access have been granted. Your agent is ready to manage your inbox.
              </p>
            </div>
          ) : googleCreds.length > 0 ? (
            <div className="mt-4 rounded-xl border border-blue-100 bg-blue-50 px-5 py-5 text-left space-y-3">
              <div className="flex items-center gap-2">
                <Mail className="w-4 h-4 text-trust-blue" />
                <p className="text-sm font-semibold text-reins-navy">Connect Gmail to activate your agent</p>
              </div>
              <p className="text-xs text-gray-500">
                You have existing Google accounts connected. Use one, or connect a different account.
              </p>
              <div className="space-y-2">
                {googleCreds.map((cred) => (
                  <button
                    key={cred.id}
                    type="button"
                    disabled={!!linkingCredId}
                    onClick={() => handleLinkExistingCredential(cred)}
                    className="flex items-center justify-between w-full px-4 py-2.5 bg-white border border-blue-200 rounded-lg text-sm hover:bg-blue-50 transition-colors disabled:opacity-50"
                  >
                    <span className="font-medium text-reins-navy truncate">
                      {cred.accountEmail ?? cred.accountName ?? 'Google account'}
                    </span>
                    {linkingCredId === cred.id
                      ? <Loader2 className="w-4 h-4 animate-spin text-trust-blue shrink-0" />
                      : <span className="text-xs text-trust-blue shrink-0 ml-2">Use this account</span>
                    }
                  </button>
                ))}
              </div>
              <button
                type="button"
                onClick={handleConnectGmail}
                className="flex items-center gap-2 text-xs text-gray-400 hover:text-trust-blue transition-colors"
              >
                <Mail className="w-3.5 h-3.5" />
                Connect a different account
              </button>
            </div>
          ) : (
            <div className="mt-4 rounded-xl border border-blue-100 bg-blue-50 px-5 py-5 text-left space-y-3">
              <div className="flex items-center gap-2">
                <Mail className="w-4 h-4 text-trust-blue" />
                <p className="text-sm font-semibold text-reins-navy">Connect Gmail to activate your agent</p>
              </div>
              <p className="text-xs text-gray-500">
                Your agent needs Gmail, Calendar, and Drive access to read email and manage your schedule.
                You can connect now while it deploys.
              </p>
              <button
                type="button"
                onClick={handleConnectGmail}
                className="flex items-center gap-2 px-4 py-2.5 bg-trust-blue text-white rounded-lg text-sm font-medium hover:bg-blue-600 transition-colors"
              >
                <Mail className="w-4 h-4" />
                Connect Gmail
              </button>
            </div>
          )
        )}
      </div>
    );
  }

  // ── Main creation form ──────────────────────────────────────────────────────
  return (
    <div className="p-4 sm:p-8 max-w-2xl">
      {/* Header */}
      <div className="flex items-center gap-4 mb-8">
        <button
          onClick={() => {
            if (agentType && step === 0) { setAgentType(null); }
            else if (step === 0) { navigate('/agents'); }
            else { handleBack(); }
          }}
          className="p-2 text-gray-400 hover:text-reins-navy hover:bg-gray-100 rounded-lg transition-all"
        >
          <ArrowLeft className="w-5 h-5" />
        </button>
        <div>
          <h1 className="text-2xl font-semibold text-reins-navy tracking-tight">Create Agent</h1>
          <p className="text-gray-400 text-sm mt-0.5">
            {agentType === 'email-calendar'
              ? 'Email & Calendar agent'
              : agentType === 'custom'
              ? 'Custom agent'
              : agentType === 'manual'
              ? 'Manual agent — MCP endpoint only'
              : 'Configure and deploy a new AI agent'}
          </p>
        </div>
      </div>

      {/* ── Type picker ── */}
      {!agentType && (
        <div className="space-y-4">
          <p className="text-sm text-gray-500">What kind of agent do you want?</p>
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
            <button
              type="button"
              onClick={() => {
                setAgentType('email-calendar');
                update({ soulMd: EMAIL_CALENDAR_SOUL });
              }}
              className="p-5 rounded-xl border-2 border-gray-200 hover:border-trust-blue hover:bg-trust-blue/5 text-left transition-all"
            >
              <Mail className="w-6 h-6 text-trust-blue mb-3" />
              <p className="font-semibold text-reins-navy">Email & Calendar</p>
              <p className="text-xs text-gray-400 mt-1">
                Reads your inbox at 7 AM, triages email, and manages your calendar. Connect Gmail and go.
              </p>
            </button>
            <button
              type="button"
              onClick={() => {
                setAgentType('custom');
                update({ soulMd: DEFAULT_SOUL, initialPrompt: undefined });
              }}
              className="p-5 rounded-xl border-2 border-gray-200 hover:border-trust-blue hover:bg-trust-blue/5 text-left transition-all"
            >
              <div className="text-2xl mb-3">✦</div>
              <p className="font-semibold text-reins-navy">Custom Agent</p>
              <p className="text-xs text-gray-400 mt-1">
                Define your own personality, model, and tools. Full control over everything.
              </p>
            </button>
          </div>
          <div className="text-center pt-2">
            <button
              type="button"
              onClick={() => setAgentType('manual')}
              className="text-xs text-gray-300 hover:text-gray-500 transition-colors underline underline-offset-2"
            >
              Bring your own agent (MCP endpoint only)
            </button>
          </div>
        </div>
      )}

      {/* ── Step indicator (multi-step flows only) ── */}
      {(agentType === 'custom' || agentType === 'manual') && (
        <div className="flex items-center gap-2 mb-8">
          {steps.map((label, i) => (
            <div key={label} className="flex items-center gap-2">
              <div className="flex items-center gap-1.5">
                <div
                  className={`w-6 h-6 rounded-full flex items-center justify-center text-xs font-semibold transition-all ${
                    i < step
                      ? 'bg-trust-blue text-white'
                      : i === step
                      ? 'bg-trust-blue text-white ring-4 ring-trust-blue/20'
                      : 'bg-gray-100 text-gray-400'
                  }`}
                >
                  {i < step ? '✓' : i + 1}
                </div>
                <span
                  className={`text-xs font-medium transition-colors ${
                    i === step ? 'text-reins-navy' : i < step ? 'text-trust-blue' : 'text-gray-400'
                  }`}
                >
                  {label}
                </span>
              </div>
              {i < steps.length - 1 && (
                <div className={`h-px w-8 transition-colors ${i < step ? 'bg-trust-blue' : 'bg-gray-200'}`} />
              )}
            </div>
          ))}
        </div>
      )}

      {/* Error / reauth banners */}
      {agentType && error && (
        <div className="mb-6 p-4 bg-red-50 border border-red-100 rounded-xl text-sm text-red-700">
          {error}
        </div>
      )}
      {agentType && reauthApprovalId && (
        <div className="mb-6 p-4 bg-amber-50 border border-amber-200 rounded-xl space-y-2">
          <p className="text-sm font-medium text-amber-800">Authentication required</p>
          <p className="text-sm text-amber-700">
            Deployment failed due to an authentication error. A re-auth request has been created.
          </p>
          <button
            type="button"
            onClick={() => navigate(`/approvals?id=${reauthApprovalId}`)}
            className="text-sm font-medium text-amber-800 underline underline-offset-2 hover:text-amber-900"
          >
            View re-auth request →
          </button>
        </div>
      )}

      {/* ── Email & Calendar: single setup step ── */}
      {agentType === 'email-calendar' && step === 0 && (
        <div className="space-y-4">
          <section className="bg-white rounded-xl border border-gray-100 p-6 space-y-4">
            <h2 className="text-sm font-semibold text-gray-500 uppercase tracking-wider">Setup</h2>
            <div>
              <label className="block text-xs font-medium text-gray-500 uppercase tracking-wider mb-1.5">
                Agent Name *
              </label>
              <input
                type="text"
                value={form.name}
                onChange={(e) => update({ name: e.target.value })}
                className="w-full border border-gray-200 rounded-lg px-3 py-2.5 text-sm focus:ring-2 focus:ring-trust-blue/20 focus:border-trust-blue transition-all outline-none"
                placeholder="e.g. My Email Assistant"
                autoFocus
              />
            </div>

            {sharedBotEnabled ? (
              <div className="space-y-3">
                <div className="rounded-lg bg-blue-50 border border-blue-100 px-4 py-3 text-sm text-blue-700 flex items-center justify-between">
                  <span>Uses the platform bot — no personal bot token required.</span>
                  <button
                    type="button"
                    onClick={() => { setUseCustomBot((v) => !v); update({ telegramToken: '' }); }}
                    className="ml-4 text-xs text-blue-600 underline underline-offset-2 hover:text-blue-800 whitespace-nowrap"
                  >
                    {useCustomBot ? 'Use platform bot' : 'Use custom bot'}
                  </button>
                </div>
                {useCustomBot && (
                  <div>
                    <label className="block text-xs font-medium text-gray-500 uppercase tracking-wider mb-1.5">
                      Telegram Bot Token *
                    </label>
                    <input
                      type="text"
                      value={form.telegramToken ?? ''}
                      onChange={(e) => update({ telegramToken: e.target.value })}
                      className="w-full border border-gray-200 rounded-lg px-3 py-2.5 text-sm font-mono focus:ring-2 focus:ring-trust-blue/20 focus:border-trust-blue transition-all outline-none"
                      placeholder="123456789:ABC..."
                    />
                    <p className="text-xs text-gray-400 mt-1">
                      Get this from{' '}
                      <a href="https://t.me/BotFather" target="_blank" rel="noreferrer" className="text-trust-blue hover:underline">
                        @BotFather
                      </a>{' '}
                      on Telegram
                    </p>
                  </div>
                )}
              </div>
            ) : (
              <div>
                <label className="block text-xs font-medium text-gray-500 uppercase tracking-wider mb-1.5">
                  Telegram Bot Token *
                </label>
                <input
                  type="text"
                  value={form.telegramToken ?? ''}
                  onChange={(e) => update({ telegramToken: e.target.value })}
                  className="w-full border border-gray-200 rounded-lg px-3 py-2.5 text-sm font-mono focus:ring-2 focus:ring-trust-blue/20 focus:border-trust-blue transition-all outline-none"
                  placeholder="123456789:ABC..."
                />
                <p className="text-xs text-gray-400 mt-1">
                  Get this from{' '}
                  <a href="https://t.me/BotFather" target="_blank" rel="noreferrer" className="text-trust-blue hover:underline">
                    @BotFather
                  </a>{' '}
                  on Telegram
                </p>
              </div>
            )}

            <div>
              <label className="block text-xs font-medium text-gray-500 uppercase tracking-wider mb-1.5">
                Telegram User ID <span className="normal-case font-normal text-gray-400">(optional)</span>
              </label>
              <input
                type="text"
                value={form.telegramUserId || ''}
                onChange={(e) => update({ telegramUserId: e.target.value })}
                className="w-full border border-gray-200 rounded-lg px-3 py-2.5 text-sm focus:ring-2 focus:ring-trust-blue/20 focus:border-trust-blue transition-all outline-none"
                placeholder="Restrict to this user ID"
              />
              {knownTelegramUserId
                ? <p className="text-xs text-emerald-600 mt-1">Autofilled from your linked Telegram account</p>
                : <p className="text-xs text-gray-400 mt-1">Find your ID using <a href="https://t.me/userinfobot" target="_blank" rel="noreferrer" className="text-trust-blue hover:underline">@userinfobot</a></p>
              }
            </div>
          </section>

          <div className="rounded-xl border border-blue-100 bg-blue-50 px-5 py-4 flex items-start gap-3">
            <Mail className="w-4 h-4 text-trust-blue mt-0.5 shrink-0" />
            <p className="text-sm text-blue-700">
              After deployment you'll connect your Gmail account to activate email and calendar features.
            </p>
          </div>
        </div>
      )}

      {/* ── Custom: Step 0 — Basics ── */}
      {agentType === 'custom' && step === 0 && (
        <section className="bg-white rounded-xl border border-gray-100 p-6 space-y-4">
          <h2 className="text-sm font-semibold text-gray-500 uppercase tracking-wider">Basics</h2>
          <div>
            <label className="block text-xs font-medium text-gray-500 uppercase tracking-wider mb-1.5">
              Agent Name *
            </label>
            <input
              type="text"
              value={form.name}
              onChange={(e) => update({ name: e.target.value })}
              className="w-full border border-gray-200 rounded-lg px-3 py-2.5 text-sm focus:ring-2 focus:ring-trust-blue/20 focus:border-trust-blue transition-all outline-none"
              placeholder="e.g. My Assistant"
              autoFocus
            />
          </div>
          <div>
            <label className="block text-xs font-medium text-gray-500 uppercase tracking-wider mb-1.5">
              Description
            </label>
            <input
              type="text"
              value={form.description || ''}
              onChange={(e) => update({ description: e.target.value })}
              className="w-full border border-gray-200 rounded-lg px-3 py-2.5 text-sm focus:ring-2 focus:ring-trust-blue/20 focus:border-trust-blue transition-all outline-none"
              placeholder="What does this agent do?"
            />
          </div>

          {sharedBotEnabled ? (
            <div className="space-y-3">
              <div className="rounded-lg bg-blue-50 border border-blue-100 px-4 py-3 text-sm text-blue-700 flex items-center justify-between">
                <span>Uses the platform bot — no personal bot token required.</span>
                <button
                  type="button"
                  onClick={() => { setUseCustomBot((v) => !v); update({ telegramToken: '' }); }}
                  className="ml-4 text-xs text-blue-600 underline underline-offset-2 hover:text-blue-800 whitespace-nowrap"
                >
                  {useCustomBot ? 'Use platform bot' : 'Use custom bot'}
                </button>
              </div>
              {useCustomBot && (
                <div>
                  <label className="block text-xs font-medium text-gray-500 uppercase tracking-wider mb-1.5">
                    Telegram Bot Token *
                  </label>
                  <input
                    type="text"
                    value={form.telegramToken ?? ''}
                    onChange={(e) => update({ telegramToken: e.target.value })}
                    className="w-full border border-gray-200 rounded-lg px-3 py-2.5 text-sm font-mono focus:ring-2 focus:ring-trust-blue/20 focus:border-trust-blue transition-all outline-none"
                    placeholder="123456789:ABC..."
                    autoFocus
                  />
                  <p className="text-xs text-gray-400 mt-1">Get this from <a href="https://t.me/BotFather" target="_blank" rel="noreferrer" className="text-trust-blue hover:underline">@BotFather</a> on Telegram</p>
                </div>
              )}
            </div>
          ) : (
            <div>
              <label className="block text-xs font-medium text-gray-500 uppercase tracking-wider mb-1.5">
                Telegram Bot Token *
              </label>
              <input
                type="text"
                value={form.telegramToken ?? ''}
                onChange={(e) => update({ telegramToken: e.target.value })}
                className="w-full border border-gray-200 rounded-lg px-3 py-2.5 text-sm font-mono focus:ring-2 focus:ring-trust-blue/20 focus:border-trust-blue transition-all outline-none"
                placeholder="123456789:ABC..."
              />
              <p className="text-xs text-gray-400 mt-1">Get this from <a href="https://t.me/BotFather" target="_blank" rel="noreferrer" className="text-trust-blue hover:underline">@BotFather</a> on Telegram</p>
            </div>
          )}

          <div>
            <label className="block text-xs font-medium text-gray-500 uppercase tracking-wider mb-1.5">
              Telegram User ID <span className="normal-case font-normal text-gray-400">(optional)</span>
            </label>
            <input
              type="text"
              value={form.telegramUserId || ''}
              onChange={(e) => update({ telegramUserId: e.target.value })}
              className="w-full border border-gray-200 rounded-lg px-3 py-2.5 text-sm focus:ring-2 focus:ring-trust-blue/20 focus:border-trust-blue transition-all outline-none"
              placeholder="Restrict to this user ID"
            />
            {knownTelegramUserId
              ? <p className="text-xs text-emerald-600 mt-1">Autofilled from your linked Telegram account</p>
              : <p className="text-xs text-gray-400 mt-1">Find your ID using <a href="https://t.me/userinfobot" target="_blank" rel="noreferrer" className="text-trust-blue hover:underline">@userinfobot</a></p>
            }
          </div>
        </section>
      )}

      {/* ── Custom: Step 1 — Engine + Model ── */}
      {agentType === 'custom' && step === 1 && (
        <>
          <section className="bg-white rounded-xl border border-gray-100 p-6 space-y-4">
            <h2 className="text-sm font-semibold text-gray-500 uppercase tracking-wider">Agent Engine</h2>
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
              <button
                type="button"
                onClick={() => update({ runtime: 'openclaw' })}
                className={`relative p-4 rounded-xl border-2 text-left transition-all ${
                  form.runtime !== 'hermes'
                    ? 'border-trust-blue bg-trust-blue/5'
                    : 'border-gray-200 hover:border-gray-300'
                }`}
              >
                <span className="absolute top-2 right-2 text-[10px] font-semibold bg-emerald-100 text-emerald-700 px-1.5 py-0.5 rounded-full">Recommended</span>
                <p className="font-medium text-reins-navy">OpenClaw</p>
                <p className="text-xs text-gray-400 mt-1">Full-featured runtime with browser, plugins, and code execution.</p>
              </button>
              <button
                type="button"
                onClick={() => update({ runtime: 'hermes', modelProvider: form.modelProvider === 'openai-codex' ? 'anthropic' : form.modelProvider })}
                className={`relative p-4 rounded-xl border-2 text-left transition-all ${
                  form.runtime === 'hermes'
                    ? 'border-trust-blue bg-trust-blue/5'
                    : 'border-gray-200 hover:border-gray-300'
                }`}
              >
                <span className="absolute top-2 right-2 text-[10px] font-semibold bg-orange-100 text-orange-600 px-1.5 py-0.5 rounded-full">Unstable</span>
                <p className="font-medium text-reins-navy">Hermes</p>
                <p className="text-xs text-gray-400 mt-1">Lightweight Python agent with memory, skills, and 15+ messaging platforms.</p>
              </button>
            </div>
          </section>

          <section className="bg-white rounded-xl border border-gray-100 p-6 space-y-4">
            <h2 className="text-sm font-semibold text-gray-500 uppercase tracking-wider">Model Provider</h2>
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
              <button
                type="button"
                onClick={() => update({ modelProvider: 'minimax', modelName: 'MiniMax-M2.7', openaiApiKey: '' })}
                className={`relative p-4 rounded-xl border-2 text-left transition-all ${
                  form.modelProvider === 'minimax'
                    ? 'border-trust-blue bg-trust-blue/5'
                    : 'border-gray-200 hover:border-gray-300'
                }`}
              >
                <span className="absolute top-2 right-2 text-[10px] font-semibold bg-emerald-100 text-emerald-700 px-1.5 py-0.5 rounded-full">Recommended</span>
                <p className="font-medium text-reins-navy">MiniMax</p>
                <p className="text-xs text-gray-400 mt-1">Affordable, fast API-key LLM. No subscription needed.</p>
              </button>
              <button
                type="button"
                onClick={() => update({ modelProvider: 'anthropic', modelName: 'claude-sonnet-4-5', openaiApiKey: '' })}
                className={`relative p-4 rounded-xl border-2 text-left transition-all ${
                  form.modelProvider === 'anthropic'
                    ? 'border-trust-blue bg-trust-blue/5'
                    : 'border-gray-200 hover:border-gray-300'
                }`}
              >
                <span className="absolute top-2 right-2 text-[10px] font-semibold bg-amber-100 text-amber-700 px-1.5 py-0.5 rounded-full">Expensive</span>
                <p className="font-medium text-reins-navy">Anthropic Claude</p>
                <p className="text-xs text-gray-400 mt-1">Requires your Anthropic API key</p>
              </button>
              <button
                type="button"
                onClick={() => update({ modelProvider: 'openai', modelName: 'gpt-4.1', openaiApiKey: '' })}
                className={`relative p-4 rounded-xl border-2 text-left transition-all ${
                  form.modelProvider === 'openai'
                    ? 'border-trust-blue bg-trust-blue/5'
                    : 'border-gray-200 hover:border-gray-300'
                }`}
              >
                <span className="absolute top-2 right-2 text-[10px] font-semibold bg-red-100 text-red-600 px-1.5 py-0.5 rounded-full">Wrong Choice</span>
                <p className="font-medium text-reins-navy">OpenAI</p>
                <p className="text-xs text-gray-400 mt-1">Uses your OpenAI API key</p>
              </button>
            </div>

            {form.modelProvider === 'anthropic' && (
              <div className="space-y-4">
                <div>
                  <label className="block text-xs font-medium text-gray-500 uppercase tracking-wider mb-1.5">Model</label>
                  <select
                    value={form.modelName}
                    onChange={(e) => update({ modelName: e.target.value })}
                    className="w-full border border-gray-200 rounded-lg px-3 py-2.5 text-sm focus:ring-2 focus:ring-trust-blue/20 focus:border-trust-blue transition-all outline-none bg-white"
                  >
                    <option value="claude-sonnet-4-5">Claude Sonnet 4.5</option>
                    <option value="claude-opus-4-6">Claude Opus 4.6</option>
                    <option value="claude-haiku-4-5">Claude Haiku 4.5</option>
                  </select>
                </div>
                <div>
                  <label className="block text-xs font-medium text-gray-500 uppercase tracking-wider mb-1.5">
                    Anthropic API Key *
                  </label>
                  <input
                    type="password"
                    value={form.openaiApiKey || ''}
                    onChange={(e) => update({ openaiApiKey: e.target.value })}
                    placeholder="sk-ant-api03-..."
                    className="w-full border border-gray-200 rounded-lg px-3 py-2.5 text-sm font-mono focus:ring-2 focus:ring-trust-blue/20 focus:border-trust-blue transition-all outline-none"
                  />
                  <p className="text-xs text-gray-400 mt-1">Get your key at <a href="https://console.anthropic.com/settings/keys" target="_blank" rel="noreferrer" className="text-trust-blue hover:underline">console.anthropic.com</a></p>
                </div>
              </div>
            )}

            {form.modelProvider === 'openai' && (
              <div className="space-y-4">
                <div>
                  <label className="block text-xs font-medium text-gray-500 uppercase tracking-wider mb-1.5">Model</label>
                  <select
                    value={form.modelName || 'gpt-4.1'}
                    onChange={(e) => update({ modelName: e.target.value })}
                    className="w-full border border-gray-200 rounded-lg px-3 py-2.5 text-sm focus:ring-2 focus:ring-trust-blue/20 focus:border-trust-blue transition-all outline-none bg-white"
                  >
                    <optgroup label="Flagship">
                      <option value="gpt-5.4">GPT-5.4</option>
                      <option value="gpt-5.4-mini">GPT-5.4 Mini</option>
                      <option value="gpt-5">GPT-5</option>
                    </optgroup>
                    <optgroup label="GPT-4.1">
                      <option value="gpt-4.1">GPT-4.1 (default)</option>
                      <option value="gpt-4.1-mini">GPT-4.1 Mini</option>
                      <option value="gpt-4.1-nano">GPT-4.1 Nano</option>
                    </optgroup>
                    <optgroup label="GPT-4o">
                      <option value="gpt-4o">GPT-4o</option>
                      <option value="gpt-4o-mini">GPT-4o Mini</option>
                    </optgroup>
                    <optgroup label="Reasoning">
                      <option value="o3">o3</option>
                      <option value="o4-mini">o4-mini</option>
                    </optgroup>
                  </select>
                </div>
                <div>
                  <label className="block text-xs font-medium text-gray-500 uppercase tracking-wider mb-1.5">OpenAI API Key</label>
                  <input
                    type="password"
                    value={form.openaiApiKey || ''}
                    onChange={(e) => update({ openaiApiKey: e.target.value })}
                    placeholder="sk-..."
                    className="w-full border border-gray-200 rounded-lg px-3 py-2.5 text-sm font-mono focus:ring-2 focus:ring-trust-blue/20 focus:border-trust-blue transition-all outline-none"
                  />
                  <p className="text-xs text-gray-400 mt-1">Get your key at <a href="https://platform.openai.com/api-keys" target="_blank" rel="noreferrer" className="text-trust-blue hover:underline">platform.openai.com/api-keys</a></p>
                </div>
              </div>
            )}

            {form.modelProvider === 'minimax' && (
              <div className="space-y-4">
                <div>
                  <label className="block text-xs font-medium text-gray-500 uppercase tracking-wider mb-1.5">Model</label>
                  <select
                    value={form.modelName || 'MiniMax-M2.7'}
                    onChange={(e) => update({ modelName: e.target.value })}
                    className="w-full border border-gray-200 rounded-lg px-3 py-2.5 text-sm focus:ring-2 focus:ring-trust-blue/20 focus:border-trust-blue transition-all outline-none bg-white"
                  >
                    <option value="MiniMax-M2.7">MiniMax M2.7 (default)</option>
                    <option value="MiniMax-M2.7-highspeed">MiniMax M2.7 Highspeed</option>
                    <option value="MiniMax-M2.5">MiniMax M2.5</option>
                    <option value="MiniMax-M2.5-highspeed">MiniMax M2.5 Highspeed</option>
                  </select>
                </div>
                <div className="rounded-lg bg-emerald-50 border border-emerald-100 px-4 py-3 text-sm text-emerald-700">
                  Platform API key will be used — no key required.
                </div>
                <div>
                  <label className="block text-xs font-medium text-gray-500 uppercase tracking-wider mb-1.5">
                    MiniMax API Key <span className="normal-case font-normal text-gray-400">(optional — use your own)</span>
                  </label>
                  <input
                    type="password"
                    value={form.openaiApiKey || ''}
                    onChange={(e) => update({ openaiApiKey: e.target.value })}
                    placeholder="sk-cp-... (leave blank to use platform key)"
                    className="w-full border border-gray-200 rounded-lg px-3 py-2.5 text-sm font-mono focus:ring-2 focus:ring-trust-blue/20 focus:border-trust-blue transition-all outline-none"
                  />
                </div>
              </div>
            )}
          </section>
        </>
      )}

      {/* ── Custom: Step 2 — Personality (soul editor only) ── */}
      {agentType === 'custom' && step === 2 && (
        <div className="space-y-4">
          <section className="bg-white rounded-xl border border-gray-100 p-6 space-y-3">
            <div>
              <h2 className="text-xs font-semibold text-gray-500 uppercase tracking-wider">SOUL.md — Agent Instructions</h2>
              <p className="text-xs text-gray-400 mt-1">Define your agent's personality, behavior, and capabilities.</p>
            </div>
            <textarea
              value={form.soulMd || ''}
              onChange={(e) => update({ soulMd: e.target.value })}
              className="w-full border border-gray-200 rounded-lg px-3 py-2.5 text-sm font-mono focus:ring-2 focus:ring-trust-blue/20 focus:border-trust-blue transition-all outline-none resize-none"
              rows={14}
              placeholder="Define your agent's personality and instructions..."
            />
          </section>
          {templates.length > 0 && (
            <section className="bg-white rounded-xl border border-gray-100 p-6 space-y-3">
              <div>
                <h2 className="text-xs font-semibold text-gray-500 uppercase tracking-wider">First Run Setup</h2>
                <p className="text-xs text-gray-400 mt-1">Optional tasks the agent runs once on first launch, then marks complete.</p>
              </div>
              <select
                value={templates.find((t) => t.content === form.initialPrompt)?.id ?? ''}
                onChange={(e) => {
                  const tpl = templates.find((t) => t.id === e.target.value);
                  update({ initialPrompt: tpl?.content ?? undefined });
                }}
                className="w-full border border-gray-200 rounded-lg px-3 py-2.5 text-sm focus:ring-2 focus:ring-trust-blue/20 focus:border-trust-blue transition-all outline-none bg-white"
              >
                <option value="">None</option>
                {templates.map((t) => (
                  <option key={t.id} value={t.id}>{t.name}</option>
                ))}
              </select>
            </section>
          )}
        </div>
      )}

      {/* ── Custom: Step 3 — Deploy ── */}
      {agentType === 'custom' && step === 3 && (
        <div className="space-y-4">
          <section className="bg-white rounded-xl border border-gray-100 p-6 space-y-4">
            <h2 className="text-sm font-semibold text-gray-500 uppercase tracking-wider">Region</h2>
            <select
              value={form.region}
              onChange={(e) => update({ region: e.target.value })}
              className="w-full border border-gray-200 rounded-lg px-3 py-2.5 text-sm focus:ring-2 focus:ring-trust-blue/20 focus:border-trust-blue transition-all outline-none bg-white"
            >
              <option value="iad">IAD — Virginia</option>
              <option value="ord">ORD — Chicago</option>
              <option value="lax">LAX — Los Angeles</option>
              <option value="sjc">SJC — San Jose</option>
              <option value="ams">AMS — Amsterdam</option>
              <option value="lhr">LHR — London</option>
              <option value="nrt">NRT — Tokyo</option>
            </select>
          </section>

          <section className="bg-white rounded-xl border border-gray-100 overflow-hidden">
            <button
              type="button"
              onClick={() => setShowAdvanced(!showAdvanced)}
              className="w-full flex items-center justify-between p-6 text-left"
            >
              <h2 className="text-sm font-semibold text-gray-500 uppercase tracking-wider">Advanced</h2>
              {showAdvanced ? (
                <ChevronUp className="w-4 h-4 text-gray-400" />
              ) : (
                <ChevronDown className="w-4 h-4 text-gray-400" />
              )}
            </button>
            {showAdvanced && (
              <div className="px-6 pb-6 space-y-4">
                <div>
                  <label className="block text-xs font-medium text-gray-500 uppercase tracking-wider mb-1.5">
                    MCP Servers <span className="normal-case font-normal text-gray-400">(JSON)</span>
                  </label>
                  <textarea
                    value={form.mcpServers || ''}
                    onChange={(e) => update({ mcpServers: e.target.value })}
                    className="w-full border border-gray-200 rounded-lg px-3 py-2.5 text-sm font-mono focus:ring-2 focus:ring-trust-blue/20 focus:border-trust-blue transition-all outline-none resize-none"
                    rows={4}
                    placeholder={`[{"name": "server-name", "url": "https://...", "transport": "http"}]`}
                  />
                  <p className="text-xs text-gray-400 mt-1">AgentHelm proxy is added automatically</p>
                </div>
              </div>
            )}
          </section>
        </div>
      )}

      {/* ── Manual: Step 0 — Basics ── */}
      {agentType === 'manual' && step === 0 && (
        <section className="bg-white rounded-xl border border-gray-100 p-6 space-y-4">
          <h2 className="text-sm font-semibold text-gray-500 uppercase tracking-wider">Basics</h2>
          <div>
            <label className="block text-xs font-medium text-gray-500 uppercase tracking-wider mb-1.5">
              Agent Name *
            </label>
            <input
              type="text"
              value={form.name}
              onChange={(e) => update({ name: e.target.value })}
              className="w-full border border-gray-200 rounded-lg px-3 py-2.5 text-sm focus:ring-2 focus:ring-trust-blue/20 focus:border-trust-blue transition-all outline-none"
              placeholder="e.g. My Assistant"
              autoFocus
            />
          </div>
          <div>
            <label className="block text-xs font-medium text-gray-500 uppercase tracking-wider mb-1.5">
              Description
            </label>
            <input
              type="text"
              value={form.description || ''}
              onChange={(e) => update({ description: e.target.value })}
              className="w-full border border-gray-200 rounded-lg px-3 py-2.5 text-sm focus:ring-2 focus:ring-trust-blue/20 focus:border-trust-blue transition-all outline-none"
              placeholder="What does this agent do?"
            />
          </div>
        </section>
      )}

      {/* ── Manual: Step 1 — Finish ── */}
      {agentType === 'manual' && step === 1 && (
        <section className="bg-white rounded-xl border border-gray-100 p-6 space-y-3">
          <h2 className="text-sm font-semibold text-gray-500 uppercase tracking-wider">Ready to Connect</h2>
          <p className="text-sm text-gray-600">
            Clicking <strong>Create Agent</strong> will provision an AgentHelm agent and give you an MCP endpoint URL.
            Paste that URL into any MCP-compatible AI agent — no hosted runtime required.
          </p>
          <ul className="text-sm text-gray-500 space-y-1 list-disc list-inside">
            <li>Works with Claude Desktop, Claude Code, OpenAI, and any MCP client</li>
            <li>AgentHelm enforces policies and manages OAuth credentials</li>
            <li>Add credentials and permissions after creation</li>
          </ul>
        </section>
      )}

      {/* ── Navigation ── */}
      {agentType && (
        <div className="flex items-center justify-between mt-8">
          <button
            type="button"
            onClick={() => (step === 0 ? setAgentType(null) : handleBack())}
            className="px-5 py-2.5 text-sm text-gray-500 hover:text-gray-700 transition-colors"
          >
            {step === 0 ? 'Cancel' : 'Back'}
          </button>

          {isLastStep ? (
            <button
              type="button"
              onClick={handleSubmit}
              disabled={createMutation.isPending || createManualMutation.isPending || !canAdvance()}
              className="flex items-center gap-2 px-6 py-2.5 bg-trust-blue text-white rounded-xl hover:bg-blue-600 transition-colors disabled:opacity-50 text-sm font-medium shadow-sm shadow-trust-blue/20"
            >
              {(createMutation.isPending || createManualMutation.isPending) && <Loader2 className="w-4 h-4 animate-spin" />}
              {agentType === 'manual'
                ? createManualMutation.isPending ? 'Creating…' : 'Create Agent'
                : createMutation.isPending ? 'Deploying…' : 'Create & Deploy'}
            </button>
          ) : (
            <button
              type="button"
              onClick={handleNext}
              disabled={!canAdvance()}
              className="px-6 py-2.5 bg-trust-blue text-white rounded-xl hover:bg-blue-600 transition-colors disabled:opacity-50 text-sm font-medium shadow-sm shadow-trust-blue/20"
            >
              Next
            </button>
          )}
        </div>
      )}
    </div>
  );
}
