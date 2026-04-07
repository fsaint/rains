import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useMutation } from '@tanstack/react-query';
import { ArrowLeft, Loader2, ChevronDown, ChevronUp, Mail, PenLine } from 'lucide-react';
import { agents, type CreateAndDeployData } from '../api/client';
import { CodexDeviceFlow } from '../components/CodexDeviceFlow';
import { ClaudeSetupTokenFlow } from '../components/ClaudeSetupTokenFlow';

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

const PRESET_AGENTS = [
  {
    id: 'email-calendar',
    icon: Mail,
    label: 'Email & Calendar',
    description: 'Reads email at 7 AM, triages inbox, checks calendar before adding events.',
    soul: EMAIL_CALENDAR_SOUL,
  },
  {
    id: 'custom',
    icon: PenLine,
    label: 'Custom',
    description: 'Start from scratch and define everything yourself.',
    soul: DEFAULT_SOUL,
  },
];

const STEPS = ['Basics', 'Model', 'Personality', 'Deploy'];
const MANUAL_STEPS = ['Basics', 'Personality', 'Finish'];

export default function AgentNew() {
  const navigate = useNavigate();
  const [agentType, setAgentType] = useState<'hosted' | 'manual' | null>(null);
  const [step, setStep] = useState(0);
  const [form, setForm] = useState<CreateAndDeployData>({
    name: '',
    telegramToken: '',
    telegramUserId: '',
    modelProvider: 'anthropic',
    modelName: 'claude-sonnet-4-5',
    soulMd: DEFAULT_SOUL,
    region: 'iad',
    openaiApiKey: '',
    modelCredentials: '',
    mcpServers: '',
  });
  const [showAdvanced, setShowAdvanced] = useState(false);
  const [error, setError] = useState('');
  const [reauthApprovalId, setReauthApprovalId] = useState<string | null>(null);

  const steps = agentType === 'manual' ? MANUAL_STEPS : STEPS;

  const createMutation = useMutation({
    mutationFn: (data: CreateAndDeployData) => agents.createAndDeploy(data),
    onSuccess: (result) => {
      navigate(`/agents/${result.id}`);
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
    if (step === 0) {
      if (agentType === 'manual') return form.name.trim() !== '';
      return form.name.trim() !== '' && form.telegramToken.trim() !== '';
    }
    // For hosted agents, step 1 is Model (requires credentials)
    if (agentType !== 'manual' && step === 1) return !!form.modelCredentials;
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
    } else {
      createMutation.mutate({
        ...form,
        telegramUserId: form.telegramUserId || undefined,
        soulMd: form.soulMd || undefined,
        openaiApiKey: form.openaiApiKey || undefined,
        modelCredentials: form.modelCredentials || undefined,
        mcpServers: form.mcpServers || undefined,
        description: form.description || undefined,
      });
    }
  };

  const isLastStep = step === steps.length - 1;

  return (
    <div className="p-8 max-w-2xl">
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
            {agentType === 'manual' ? 'Configure a manual / BYO agent' : 'Configure and deploy a new AI agent'}
          </p>
        </div>
      </div>

      {/* Agent type chooser */}
      {!agentType && (
        <div className="space-y-4">
          <p className="text-sm text-gray-500">How do you want to run this agent?</p>
          <div className="grid grid-cols-2 gap-4">
            <button
              type="button"
              onClick={() => setAgentType('hosted')}
              className="p-5 rounded-xl border-2 border-gray-200 hover:border-trust-blue hover:bg-trust-blue/5 text-left transition-all group"
            >
              <div className="text-2xl mb-2">🚀</div>
              <p className="font-semibold text-reins-navy">Hosted Agent</p>
              <p className="text-xs text-gray-400 mt-1">Deploy OpenClaw on Fly.io or local Docker. Includes Telegram, model, and runtime config.</p>
            </button>
            <button
              type="button"
              onClick={() => setAgentType('manual')}
              className="p-5 rounded-xl border-2 border-gray-200 hover:border-trust-blue hover:bg-trust-blue/5 text-left transition-all group"
            >
              <div className="text-2xl mb-2">🔧</div>
              <p className="font-semibold text-reins-navy">Manual Agent</p>
              <p className="text-xs text-gray-400 mt-1">Bring your own agent runtime. Get an MCP URL and credentials to paste into any AI agent.</p>
            </button>
          </div>
        </div>
      )}

      {/* Step indicator (only shown after type is chosen) */}
      {agentType && (
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

      {/* Step 1: Basics */}
      {agentType && step === 0 && (
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
          {agentType !== 'manual' && (
            <>
              <div>
                <label className="block text-xs font-medium text-gray-500 uppercase tracking-wider mb-1.5">
                  Telegram Bot Token *
                </label>
                <input
                  type="text"
                  value={form.telegramToken}
                  onChange={(e) => update({ telegramToken: e.target.value })}
                  className="w-full border border-gray-200 rounded-lg px-3 py-2.5 text-sm font-mono focus:ring-2 focus:ring-trust-blue/20 focus:border-trust-blue transition-all outline-none"
                  placeholder="123456789:ABC..."
                />
                <p className="text-xs text-gray-400 mt-1">Get this from <a href="https://t.me/BotFather" target="_blank" rel="noreferrer" className="text-trust-blue hover:underline">@BotFather</a> on Telegram</p>
              </div>
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
                <p className="text-xs text-gray-400 mt-1">Find your ID using <a href="https://t.me/userinfobot" target="_blank" rel="noreferrer" className="text-trust-blue hover:underline">@userinfobot</a></p>
              </div>
            </>
          )}
        </section>
      )}

      {/* Step 2: Model (hosted only) */}
      {agentType === 'hosted' && step === 1 && (
        <section className="bg-white rounded-xl border border-gray-100 p-6 space-y-4">
          <h2 className="text-sm font-semibold text-gray-500 uppercase tracking-wider">Model Provider</h2>
          <div className="grid grid-cols-2 gap-3">
            <button
              type="button"
              onClick={() => update({ modelProvider: 'anthropic', modelName: 'claude-sonnet-4-5' })}
              className={`p-4 rounded-xl border-2 text-left transition-all ${
                form.modelProvider === 'anthropic'
                  ? 'border-trust-blue bg-trust-blue/5'
                  : 'border-gray-200 hover:border-gray-300'
              }`}
            >
              <p className="font-medium text-reins-navy">Anthropic Claude</p>
              <p className="text-xs text-gray-400 mt-1">Uses your Anthropic API key</p>
            </button>
            <button
              type="button"
              onClick={() => update({ modelProvider: 'openai-codex', modelName: 'gpt-5.4' })}
              className={`p-4 rounded-xl border-2 text-left transition-all ${
                form.modelProvider === 'openai-codex'
                  ? 'border-trust-blue bg-trust-blue/5'
                  : 'border-gray-200 hover:border-gray-300'
              }`}
            >
              <p className="font-medium text-reins-navy">OpenAI (ChatGPT)</p>
              <p className="text-xs text-gray-400 mt-1">Uses your ChatGPT subscription</p>
            </button>
          </div>

          {form.modelProvider === 'openai-codex' && (
            <div className="space-y-4">
              <div>
                <label className="block text-xs font-medium text-gray-500 uppercase tracking-wider mb-1.5">
                  Model
                </label>
                <select
                  value={form.modelName || 'gpt-5.4'}
                  onChange={(e) => update({ modelName: e.target.value })}
                  className="w-full border border-gray-200 rounded-lg px-3 py-2.5 text-sm focus:ring-2 focus:ring-trust-blue/20 focus:border-trust-blue transition-all outline-none bg-white"
                >
                  <option value="gpt-5.4">GPT-5.4 (default)</option>
                  <option value="gpt-5.4-mini">GPT-5.4 Mini</option>
                  <option value="gpt-5.3-codex">GPT-5.3 Codex</option>
                  <option value="gpt-5.3-codex-spark">GPT-5.3 Codex Spark</option>
                  <option value="gpt-5-codex">GPT-5 Codex</option>
                  <option value="gpt-5-codex-mini">GPT-5 Codex Mini</option>
                </select>
              </div>
              <CodexDeviceFlow onComplete={(tokens) => update({ modelCredentials: tokens })} />
            </div>
          )}

          {form.modelProvider === 'anthropic' && (
            <div className="space-y-4">
              <div>
                <label className="block text-xs font-medium text-gray-500 uppercase tracking-wider mb-1.5">
                  Model
                </label>
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
              <ClaudeSetupTokenFlow
                onComplete={(token) => update({ modelCredentials: token })}
              />
            </div>
          )}
        </section>
      )}

      {/* Step 3: Personality (hosted step 2, manual step 1) */}
      {((agentType === 'hosted' && step === 2) || (agentType === 'manual' && step === 1)) && (
        <div className="space-y-4">
          <section className="bg-white rounded-xl border border-gray-100 p-6 space-y-4">
            <div>
              <h2 className="text-sm font-semibold text-gray-500 uppercase tracking-wider">Personality</h2>
              <p className="text-xs text-gray-400 mt-1">Choose a pre-made agent or customize from scratch.</p>
            </div>
            <div className="grid grid-cols-2 gap-3">
              {PRESET_AGENTS.map(({ id, icon: Icon, label, description, soul }) => {
                const isSelected = form.soulMd === soul;
                return (
                  <button
                    key={id}
                    type="button"
                    onClick={() => update({ soulMd: soul })}
                    className={`p-4 rounded-xl border-2 text-left transition-all ${
                      isSelected
                        ? 'border-trust-blue bg-trust-blue/5'
                        : 'border-gray-200 hover:border-gray-300'
                    }`}
                  >
                    <div className="flex items-center gap-2 mb-1">
                      <Icon className={`w-4 h-4 ${isSelected ? 'text-trust-blue' : 'text-gray-400'}`} />
                      <p className="font-medium text-reins-navy text-sm">{label}</p>
                    </div>
                    <p className="text-xs text-gray-400">{description}</p>
                  </button>
                );
              })}
            </div>
          </section>
          <section className="bg-white rounded-xl border border-gray-100 p-6 space-y-3">
            <h2 className="text-xs font-semibold text-gray-500 uppercase tracking-wider">SOUL.md — Edit Instructions</h2>
            <textarea
              value={form.soulMd || ''}
              onChange={(e) => update({ soulMd: e.target.value })}
              className="w-full border border-gray-200 rounded-lg px-3 py-2.5 text-sm font-mono focus:ring-2 focus:ring-trust-blue/20 focus:border-trust-blue transition-all outline-none resize-none"
              rows={14}
              placeholder="Define your agent's personality and instructions..."
            />
          </section>
        </div>
      )}

      {/* Step 4: Deploy (hosted only) */}
      {agentType === 'hosted' && step === 3 && (
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
                    OpenAI API Key <span className="normal-case font-normal text-gray-400">(for Whisper transcription)</span>
                  </label>
                  <input
                    type="password"
                    value={form.openaiApiKey || ''}
                    onChange={(e) => update({ openaiApiKey: e.target.value })}
                    className="w-full border border-gray-200 rounded-lg px-3 py-2.5 text-sm font-mono focus:ring-2 focus:ring-trust-blue/20 focus:border-trust-blue transition-all outline-none"
                    placeholder="sk-..."
                  />
                </div>
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
                  <p className="text-xs text-gray-400 mt-1">Reins proxy is added automatically</p>
                </div>
              </div>
            )}
          </section>
        </div>
      )}

      {/* Manual: Finish step */}
      {agentType === 'manual' && step === 2 && (
        <section className="bg-white rounded-xl border border-gray-100 p-6 space-y-3">
          <h2 className="text-sm font-semibold text-gray-500 uppercase tracking-wider">Ready to Connect</h2>
          <p className="text-sm text-gray-600">
            Clicking <strong>Create Manual Agent</strong> will provision a Reins agent and give you an MCP endpoint URL.
            Paste that URL into any MCP-compatible AI agent — no hosted runtime required.
          </p>
          <ul className="text-sm text-gray-500 space-y-1 list-disc list-inside">
            <li>Works with Claude Desktop, Claude Code, OpenAI, and any MCP client</li>
            <li>Reins enforces policies and manages OAuth credentials</li>
            <li>Add credentials and permissions after creation</li>
          </ul>
        </section>
      )}

      {/* Navigation */}
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
            disabled={createMutation.isPending || createManualMutation.isPending}
            className="flex items-center gap-2 px-6 py-2.5 bg-trust-blue text-white rounded-xl hover:bg-blue-600 transition-colors disabled:opacity-50 text-sm font-medium shadow-sm shadow-trust-blue/20"
          >
            {(createMutation.isPending || createManualMutation.isPending) && <Loader2 className="w-4 h-4 animate-spin" />}
            {agentType === 'manual'
              ? (createManualMutation.isPending ? 'Creating...' : 'Create Manual Agent')
              : (createMutation.isPending ? 'Creating & Deploying...' : 'Create & Deploy')
            }
          </button>
        ) : (
          <button
            type="button"
            onClick={handleNext}
            disabled={!canAdvance()}
            className="px-6 py-2.5 bg-trust-blue text-white rounded-xl hover:bg-blue-600 transition-colors disabled:opacity-50 text-sm font-medium shadow-sm shadow-trust-blue/20"
          >
            Next ({step + 1}/{steps.length})
          </button>
        )}
      </div>
      )}
    </div>
  );
}
