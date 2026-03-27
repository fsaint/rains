import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useMutation } from '@tanstack/react-query';
import { ArrowLeft, Loader2, ChevronDown, ChevronUp } from 'lucide-react';
import { agents, type CreateAndDeployData } from '../api/client';
import { CodexDeviceFlow } from '../components/CodexDeviceFlow';

const DEFAULT_SOUL = `You are a helpful AI assistant. Be concise, friendly, and thoughtful in your responses.`;

export default function AgentNew() {
  const navigate = useNavigate();
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

  const createMutation = useMutation({
    mutationFn: (data: CreateAndDeployData) => agents.createAndDeploy(data),
    onSuccess: (result) => {
      navigate(`/agents/${result.id}`);
    },
    onError: (err) => {
      setError(err instanceof Error ? err.message : 'Failed to create agent');
    },
  });

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    setError('');
    createMutation.mutate({
      ...form,
      telegramUserId: form.telegramUserId || undefined,
      soulMd: form.soulMd || undefined,
      openaiApiKey: form.openaiApiKey || undefined,
      modelCredentials: form.modelCredentials || undefined,
      mcpServers: form.mcpServers || undefined,
      description: form.description || undefined,
    });
  };

  const update = (patch: Partial<CreateAndDeployData>) => setForm((f) => ({ ...f, ...patch }));

  return (
    <div className="p-8 max-w-3xl">
      {/* Header */}
      <div className="flex items-center gap-4 mb-8">
        <button
          onClick={() => navigate('/agents')}
          className="p-2 text-gray-400 hover:text-reins-navy hover:bg-gray-100 rounded-lg transition-all"
        >
          <ArrowLeft className="w-5 h-5" />
        </button>
        <div>
          <h1 className="text-2xl font-semibold text-reins-navy tracking-tight">Create Agent</h1>
          <p className="text-gray-400 text-sm mt-0.5">Configure and deploy a new AI agent</p>
        </div>
      </div>

      {error && (
        <div className="mb-6 p-4 bg-red-50 border border-red-100 rounded-xl text-sm text-red-700">
          {error}
        </div>
      )}

      <form onSubmit={handleSubmit} className="space-y-8">
        {/* Basics */}
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
              required
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
              required
            />
            <p className="text-xs text-gray-400 mt-1">Get this from @BotFather on Telegram</p>
          </div>
          <div>
            <label className="block text-xs font-medium text-gray-500 uppercase tracking-wider mb-1.5">
              Telegram User ID (optional)
            </label>
            <input
              type="text"
              value={form.telegramUserId || ''}
              onChange={(e) => update({ telegramUserId: e.target.value })}
              className="w-full border border-gray-200 rounded-lg px-3 py-2.5 text-sm focus:ring-2 focus:ring-trust-blue/20 focus:border-trust-blue transition-all outline-none"
              placeholder="Restrict to this user ID"
            />
          </div>
        </section>

        {/* Model Provider */}
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
              onClick={() => update({ modelProvider: 'openai-codex', modelName: '' })}
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
            <CodexDeviceFlow
              onComplete={(tokens) => update({ modelCredentials: tokens })}
            />
          )}

          {form.modelProvider === 'anthropic' && (
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
          )}
        </section>

        {/* Personality */}
        <section className="bg-white rounded-xl border border-gray-100 p-6 space-y-4">
          <h2 className="text-sm font-semibold text-gray-500 uppercase tracking-wider">Personality (SOUL.md)</h2>
          <textarea
            value={form.soulMd || ''}
            onChange={(e) => update({ soulMd: e.target.value })}
            className="w-full border border-gray-200 rounded-lg px-3 py-2.5 text-sm font-mono focus:ring-2 focus:ring-trust-blue/20 focus:border-trust-blue transition-all outline-none resize-none"
            rows={6}
            placeholder="Define your agent's personality and instructions..."
          />
        </section>

        {/* Region */}
        <section className="bg-white rounded-xl border border-gray-100 p-6 space-y-4">
          <h2 className="text-sm font-semibold text-gray-500 uppercase tracking-wider">Region</h2>
          <select
            value={form.region}
            onChange={(e) => update({ region: e.target.value })}
            className="w-full border border-gray-200 rounded-lg px-3 py-2.5 text-sm focus:ring-2 focus:ring-trust-blue/20 focus:border-trust-blue transition-all outline-none bg-white"
          >
            <option value="iad">IAD (Virginia)</option>
            <option value="ord">ORD (Chicago)</option>
            <option value="lax">LAX (Los Angeles)</option>
            <option value="sjc">SJC (San Jose)</option>
            <option value="ams">AMS (Amsterdam)</option>
            <option value="lhr">LHR (London)</option>
            <option value="nrt">NRT (Tokyo)</option>
          </select>
        </section>

        {/* Advanced */}
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
                  OpenAI API Key (for Whisper transcription)
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
                  MCP Servers (JSON)
                </label>
                <textarea
                  value={form.mcpServers || ''}
                  onChange={(e) => update({ mcpServers: e.target.value })}
                  className="w-full border border-gray-200 rounded-lg px-3 py-2.5 text-sm font-mono focus:ring-2 focus:ring-trust-blue/20 focus:border-trust-blue transition-all outline-none resize-none"
                  rows={4}
                  placeholder={`[{"name": "server-name", "url": "https://...", "transport": "http"}]`}
                />
                <p className="text-xs text-gray-400 mt-1">Additional MCP servers (Reins proxy is added automatically)</p>
              </div>
            </div>
          )}
        </section>

        {/* Submit */}
        <div className="flex items-center gap-3">
          <button
            type="submit"
            disabled={createMutation.isPending || !form.name.trim() || !form.telegramToken.trim()}
            className="flex items-center gap-2 px-6 py-3 bg-trust-blue text-white rounded-xl hover:bg-blue-600 transition-colors disabled:opacity-50 text-sm font-medium shadow-sm shadow-trust-blue/20"
          >
            {createMutation.isPending && <Loader2 className="w-4 h-4 animate-spin" />}
            {createMutation.isPending ? 'Creating & Deploying...' : 'Create & Deploy'}
          </button>
          <button
            type="button"
            onClick={() => navigate('/agents')}
            className="px-6 py-3 text-sm text-gray-500 hover:text-gray-700 transition-colors"
          >
            Cancel
          </button>
        </div>
      </form>
    </div>
  );
}
