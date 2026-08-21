import { useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { BookOpen, Plus, Pencil, Trash2, AlertTriangle, Lock, X } from 'lucide-react';
import { skills as skillsApi, permissions, auth, type Skill, type SkillInput } from '../api/client';

export default function Skills() {
  const queryClient = useQueryClient();
  const [editing, setEditing] = useState<Skill | null>(null);
  const [creating, setCreating] = useState<null | 'user' | 'system'>(null);
  const [tab, setTab] = useState<'mine' | 'helm'>('mine');
  const [error, setError] = useState('');

  const { data: skillList = [], isLoading } = useQuery({
    queryKey: ['skills'],
    queryFn: skillsApi.list,
  });

  // Shared ['session'] key — already cached by whichever page loaded first.
  const { data: session } = useQuery({ queryKey: ['session'], queryFn: () => auth.session() });
  const isAdmin = session?.user?.role === 'admin';

  // One call gives both the agent list and each agent's connected services,
  // which is what drives the disabled state on the assignment chips.
  const { data: agentPermissions } = useQuery({
    queryKey: ['agent-permissions'],
    queryFn: permissions.getAgentPermissions,
  });

  const agentList = agentPermissions?.agents ?? [];
  const availableServices = agentPermissions?.availableServices ?? [];

  const satisfied: Record<string, string[]> = Object.fromEntries(
    agentList.map((agent) => [
      agent.id,
      agent.instances.filter((i) => i.enabled && i.credentialStatus === 'connected').map((i) => i.serviceType),
    ])
  );

  const deleteMutation = useMutation({
    mutationFn: skillsApi.remove,
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['skills'] }),
  });

  const assignMutation = useMutation({
    mutationFn: ({ agentId, skillIds }: { agentId: string; skillIds: string[] }) =>
      skillsApi.setForAgent(agentId, skillIds),
    onSuccess: () => {
      setError('');
      queryClient.invalidateQueries({ queryKey: ['skills'] });
      queryClient.invalidateQueries({ queryKey: ['agent-permissions'] });
    },
    onError: (err: any) => setError(err?.message || 'Could not update assignment'),
  });

  const mySkills = skillList.filter((s) => !s.isSystem);
  const systemSkills = skillList.filter((s) => s.isSystem);

  function missingFor(skill: Skill, agentId: string): string[] {
    const have = satisfied[agentId] ?? [];
    return skill.requiredServices.filter((s) => !have.includes(s));
  }

  function toggleAssignment(skill: Skill, agentId: string) {
    const assigned = skill.assignedAgentIds ?? [];
    const isOn = assigned.includes(agentId);

    // Build the agent's full new set — the API replaces wholesale.
    const current = skillList
      .filter((s) => (s.assignedAgentIds ?? []).includes(agentId))
      .map((s) => s.id);
    const next = isOn ? current.filter((id) => id !== skill.id) : [...current, skill.id];

    assignMutation.mutate({ agentId, skillIds: next });
  }

  function serviceName(type: string): string {
    return availableServices.find((s) => s.type === type)?.name ?? type;
  }

  const renderCard = (skill: Skill, readOnly: boolean) => (
    <div key={skill.id} className="border border-gray-200 rounded-xl p-5 bg-white">
      <div className="flex items-start justify-between gap-4">
        <div className="min-w-0">
          <div className="flex items-center gap-2">
            <h3 className="font-medium text-reins-navy truncate">{skill.name}</h3>
            {skill.isSystem && (
              <span className="inline-flex items-center gap-1 text-xs px-2 py-0.5 rounded-full bg-gray-100 text-gray-600">
                <Lock className="w-3 h-3" /> Helm
              </span>
            )}
            {/* The only place the source rule becomes visible to the person it
                affects — without it an admin edits a template skill and quietly
                stops receiving upstream fixes with nothing on screen saying so. */}
            {skill.isSystem && isAdmin && skill.source === 'admin' && (
              <span
                className="text-xs px-2 py-0.5 rounded-full bg-caution-amber/10 text-caution-amber"
                title="Customised here — Helm template updates no longer overwrite it."
              >
                Edited
              </span>
            )}
          </div>
          <p className="text-sm text-gray-500 mt-1">{skill.description}</p>
          <code className="text-xs text-gray-400">{skill.slug}</code>
        </div>
        {!readOnly && (
          <div className="flex items-center gap-1 shrink-0">
            <button
              onClick={() => setEditing(skill)}
              className="p-2 text-gray-400 hover:text-trust-blue transition-colors"
              aria-label={`Edit ${skill.name}`}
            >
              <Pencil className="w-4 h-4" />
            </button>
            <button
              onClick={() => {
                const message = skill.isSystem
                  ? `Delete "${skill.name}"? It is removed from every agent on every account. If it ships as a Helm template it will return on the next deploy.`
                  : `Delete "${skill.name}"? This also removes it from every agent.`;
                if (confirm(message)) {
                  deleteMutation.mutate(skill.id);
                }
              }}
              className="p-2 text-gray-400 hover:text-alert-red transition-colors"
              aria-label={`Delete ${skill.name}`}
            >
              <Trash2 className="w-4 h-4" />
            </button>
          </div>
        )}
      </div>

      {skill.requiredServices.length > 0 && (
        <div className="mt-3 flex flex-wrap items-center gap-1.5">
          <span className="text-xs text-gray-400 uppercase tracking-wider">Requires</span>
          {skill.requiredServices.map((s) => (
            <span key={s} className="text-xs px-2 py-0.5 rounded-full bg-trust-blue/10 text-trust-blue">
              {serviceName(s)}
            </span>
          ))}
        </div>
      )}

      <div className="mt-4 pt-4 border-t border-gray-100">
        <div className="text-xs text-gray-400 uppercase tracking-wider mb-2">Agents</div>
        {agentList.length === 0 ? (
          <p className="text-sm text-gray-400">No agents yet.</p>
        ) : (
          <div className="flex flex-wrap gap-2">
            {agentList.map((agent) => {
              const assigned = (skill.assignedAgentIds ?? []).includes(agent.id);
              const missing = missingFor(skill, agent.id);
              // Blocked only when turning it ON — an already-assigned skill
              // whose service dropped stays toggleable so it can be removed.
              const blocked = !assigned && missing.length > 0;
              return (
                <button
                  key={agent.id}
                  disabled={blocked || assignMutation.isPending}
                  onClick={() => toggleAssignment(skill, agent.id)}
                  title={
                    blocked
                      ? `Connect ${missing.map(serviceName).join(', ')} on ${agent.name} first`
                      : assigned
                        ? `Remove from ${agent.name}`
                        : `Assign to ${agent.name}`
                  }
                  className={`inline-flex items-center gap-1.5 text-sm px-3 py-1.5 rounded-lg border transition-all ${
                    assigned
                      ? 'bg-trust-blue text-white border-trust-blue'
                      : blocked
                        ? 'bg-gray-50 text-gray-300 border-gray-200 cursor-not-allowed'
                        : 'bg-white text-gray-600 border-gray-200 hover:border-trust-blue'
                  }`}
                >
                  {agent.name}
                  {assigned && missing.length > 0 && (
                    <AlertTriangle className="w-3.5 h-3.5 text-caution-amber" />
                  )}
                  {blocked && <Lock className="w-3.5 h-3.5" />}
                </button>
              );
            })}
          </div>
        )}
        {agentList.some((a) => (skill.assignedAgentIds ?? []).includes(a.id) && missingFor(skill, a.id).length > 0) && (
          <p className="text-xs text-caution-amber mt-2 flex items-start gap-1.5">
            <AlertTriangle className="w-3.5 h-3.5 shrink-0 mt-0.5" />
            Assigned to an agent that is missing a required service. The agent will report it as
            unavailable until the service is reconnected.
          </p>
        )}
      </div>
    </div>
  );

  if (isLoading) return <div className="p-6 text-gray-400">Loading skills…</div>;

  return (
    <div className="p-6 max-w-5xl">
      <div className="flex items-start justify-between mb-6">
        <div>
          <h1 className="text-2xl font-semibold text-reins-navy flex items-center gap-2">
            <BookOpen className="w-6 h-6" /> Skills
          </h1>
          <p className="text-sm text-gray-500 mt-1">
            Reusable playbooks your agents load on demand. Edits take effect immediately — no redeploy.
          </p>
        </div>
        {/* Hidden outright on the Helm tab for non-admins — a button that can
            never become enabled is worse than no button. */}
        {(tab === 'mine' || isAdmin) && (
          <button
            onClick={() => setCreating(tab === 'helm' ? 'system' : 'user')}
            className="flex items-center gap-2 px-4 py-2 bg-trust-blue text-white rounded-lg text-sm font-medium hover:bg-blue-600 transition-all shadow-sm shadow-trust-blue/20"
          >
            <Plus className="w-4 h-4" /> {tab === 'helm' ? 'New Helm skill' : 'New skill'}
          </button>
        )}
      </div>

      {error && (
        <div className="mb-4 flex items-center gap-2 text-sm text-alert-red bg-alert-red/5 px-3 py-2 rounded-lg">
          <AlertTriangle className="w-4 h-4 shrink-0" />
          {error}
        </div>
      )}

      <div className="flex gap-2 mb-6">
        {([
          ['mine', 'My Skills', mySkills.length],
          ['helm', 'Helm Skills', systemSkills.length],
        ] as const).map(([key, label, count]) => (
          <button
            key={key}
            onClick={() => setTab(key)}
            className={`px-4 py-2 rounded-lg border text-sm font-medium transition-all ${
              tab === key
                ? 'bg-trust-blue text-white border-trust-blue'
                : 'bg-white text-gray-600 border-gray-200 hover:border-trust-blue'
            }`}
          >
            {label} <span className="opacity-60">{count}</span>
          </button>
        ))}
      </div>

      {tab === 'mine' ? (
        mySkills.length === 0 ? (
          <div className="border border-dashed border-gray-200 rounded-xl p-8 text-center text-gray-400">
            No skills yet. Create one to teach your agents a repeatable task.
          </div>
        ) : (
          <div className="space-y-3">{mySkills.map((s) => renderCard(s, false))}</div>
        )
      ) : systemSkills.length === 0 ? (
        <div className="border border-dashed border-gray-200 rounded-xl p-8 text-center text-gray-400">
          {isAdmin
            ? 'No Helm skills yet. Create one to publish a playbook to every account on the platform.'
            : 'No platform skills are published yet.'}
        </div>
      ) : (
        <div className="space-y-3">{systemSkills.map((s) => renderCard(s, !isAdmin))}</div>
      )}

      {(creating || editing) && (
        <SkillEditor
          skill={editing}
          isSystem={creating === 'system' || Boolean(editing?.isSystem)}
          availableServices={availableServices}
          onClose={() => {
            setCreating(null);
            setEditing(null);
          }}
          onSaved={() => {
            setCreating(null);
            setEditing(null);
            queryClient.invalidateQueries({ queryKey: ['skills'] });
          }}
        />
      )}
    </div>
  );
}

function SkillEditor({
  skill,
  isSystem,
  availableServices,
  onClose,
  onSaved,
}: {
  skill: Skill | null;
  isSystem: boolean;
  availableServices: Array<{ type: string; name: string; icon: string }>;
  onClose: () => void;
  onSaved: () => void;
}) {
  const [name, setName] = useState(skill?.name ?? '');
  const [description, setDescription] = useState(skill?.description ?? '');
  const [body, setBody] = useState(skill?.body ?? '');
  const [slug, setSlug] = useState(skill?.slug ?? '');
  const [required, setRequired] = useState<string[]>(skill?.requiredServices ?? []);
  const [error, setError] = useState('');

  const save = useMutation({
    mutationFn: (data: SkillInput) =>
      skill ? skillsApi.update(skill.id, data) : skillsApi.create(data),
    onSuccess: onSaved,
    onError: (err: any) => setError(err?.message || 'Could not save'),
  });

  return (
    <div className="fixed inset-0 bg-black/40 flex items-center justify-center p-4 z-50">
      <div className="bg-white rounded-xl w-full max-w-2xl max-h-[90vh] overflow-y-auto">
        <div className="flex items-center justify-between px-6 py-4 border-b border-gray-100">
          <h2 className="font-medium text-reins-navy">
            {skill ? 'Edit' : 'New'} {isSystem ? 'Helm skill' : 'skill'}
          </h2>
          <button onClick={onClose} className="p-1 text-gray-400 hover:text-gray-600" aria-label="Close">
            <X className="w-5 h-5" />
          </button>
        </div>

        <div className="p-6 space-y-4">
          {isSystem && (
            <div className="flex items-start gap-2 text-sm text-caution-amber bg-caution-amber/5 px-3 py-2 rounded-lg">
              <AlertTriangle className="w-4 h-4 shrink-0 mt-0.5" />
              <span>
                Helm skill — published to every account on the platform. Editing one that ships as
                a repo template detaches it from future template updates.
              </span>
            </div>
          )}

          <div>
            <label className="block text-xs font-medium text-gray-500 uppercase tracking-wider mb-1.5">
              Name
            </label>
            <input
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="Inbox triage"
              className="w-full border border-gray-200 rounded-lg px-3 py-2.5 text-sm focus:ring-2 focus:ring-trust-blue/20 focus:border-trust-blue transition-all outline-none"
            />
          </div>

          <div>
            <label className="block text-xs font-medium text-gray-500 uppercase tracking-wider mb-1.5">
              When should the agent use this?
            </label>
            <textarea
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              rows={2}
              placeholder="Use when the user asks to clean up or summarise their inbox."
              className="w-full border border-gray-200 rounded-lg px-3 py-2.5 text-sm focus:ring-2 focus:ring-trust-blue/20 focus:border-trust-blue transition-all outline-none"
            />
            <p className="text-xs text-gray-400 mt-1">
              This is the only part the agent sees before deciding to load the skill. Make it specific.
            </p>
          </div>

          {isSystem && (
            <div>
              <label className="block text-xs font-medium text-gray-500 uppercase tracking-wider mb-1.5">
                Slug
              </label>
              <input
                value={slug}
                onChange={(e) => setSlug(e.target.value)}
                disabled={Boolean(skill)}
                placeholder="inbox-triage"
                className="w-full border border-gray-200 rounded-lg px-3 py-2.5 text-sm font-mono focus:ring-2 focus:ring-trust-blue/20 focus:border-trust-blue transition-all outline-none disabled:bg-gray-50 disabled:text-gray-400"
              />
              <p className="text-xs text-gray-400 mt-1">
                A Helm skill&apos;s id <em>is</em> its slug — the permanent address the repo
                templates and every <code className="font-mono">{'{{skill:…}}'}</code> reference
                use. It cannot be changed afterwards. Note that a user&apos;s own skill with the
                same slug takes precedence for that user.
              </p>
            </div>
          )}

          <div>
            <label className="block text-xs font-medium text-gray-500 uppercase tracking-wider mb-1.5">
              Required services
            </label>
            <div className="flex flex-wrap gap-2">
              {availableServices.map((svc) => {
                const on = required.includes(svc.type);
                return (
                  <button
                    key={svc.type}
                    type="button"
                    onClick={() =>
                      setRequired(on ? required.filter((s) => s !== svc.type) : [...required, svc.type])
                    }
                    className={`text-sm px-3 py-1.5 rounded-lg border transition-all ${
                      on
                        ? 'bg-trust-blue text-white border-trust-blue'
                        : 'bg-white text-gray-600 border-gray-200 hover:border-trust-blue'
                    }`}
                  >
                    {svc.name}
                  </button>
                );
              })}
            </div>
            <p className="text-xs text-gray-400 mt-1.5">
              An agent can only be assigned this skill once these are connected.
            </p>
          </div>

          <div>
            <label className="block text-xs font-medium text-gray-500 uppercase tracking-wider mb-1.5">
              Instructions (Markdown)
            </label>
            <textarea
              value={body}
              onChange={(e) => setBody(e.target.value)}
              rows={14}
              placeholder={'## Procedure\n\n1. Call {{tool:gmail_search}} to find the thread\n2. For a deeper dig, follow {{skill:deep-research}}\n3. …'}
              className="w-full border border-gray-200 rounded-lg px-3 py-2.5 text-sm font-mono focus:ring-2 focus:ring-trust-blue/20 focus:border-trust-blue transition-all outline-none"
            />
            <p className="mt-1.5 text-xs text-gray-500">
              To name a tool, write <code className="font-mono">{'{{tool:gmail_search}}'}</code> rather
              than the tool name directly — it is rendered into the exact name each agent sees, which
              differs between agent runtimes.
            </p>
            <p className="mt-1.5 text-xs text-gray-500">
              To point at another skill, write <code className="font-mono">{'{{skill:its-slug}}'}</code>.
              Referencing a skill also lets the agent open it, even when that skill isn&apos;t assigned
              directly — so it is a way to compose skills, not just to link them.
            </p>
          </div>

          {error && (
            <div className="flex items-center gap-2 text-sm text-alert-red bg-alert-red/5 px-3 py-2 rounded-lg">
              <AlertTriangle className="w-4 h-4 shrink-0" />
              {error}
            </div>
          )}
        </div>

        <div className="flex justify-end gap-2 px-6 py-4 border-t border-gray-100">
          <button onClick={onClose} className="px-4 py-2 text-sm text-gray-500 hover:text-gray-700 transition-colors">
            Cancel
          </button>
          <button
            onClick={() =>
              save.mutate({
                name,
                description,
                body,
                requiredServices: required,
                // Only ever sent on create: PUT /api/skills/:id does not read
                // isSystem, and the row's user_id already decides.
                ...(isSystem && !skill ? { isSystem: true, slug } : {}),
              })
            }
            disabled={!name || !body || (isSystem && !skill && !slug) || save.isPending}
            className="px-4 py-2 text-sm bg-trust-blue text-white rounded-lg hover:bg-blue-600 disabled:opacity-40 transition-all shadow-sm shadow-trust-blue/20"
          >
            {save.isPending ? 'Saving…' : 'Save'}
          </button>
        </div>
      </div>
    </div>
  );
}
