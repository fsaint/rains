import { useState } from 'react';
import { Link } from 'react-router-dom';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { AlertCircle } from 'lucide-react';
import { skills as skillsApi, permissions, type Skill } from '../api/client';

/**
 * On/off switch per skill for one agent. Lives inside the Skills service
 * detail, so an owner can activate or deactivate what the agent can reach
 * without leaving the agent's permissions view. Authoring stays on /skills.
 *
 * The assignment API replaces the agent's whole set, so each toggle sends the
 * full next set — the same shape Skills.tsx builds.
 */
export default function AgentSkillToggles({ agentId }: { agentId: string }) {
  const queryClient = useQueryClient();
  const [error, setError] = useState('');

  const { data: skillList = [], isLoading } = useQuery({
    queryKey: ['skills'],
    queryFn: skillsApi.list,
  });

  // Same key as Skills.tsx so both views share one cache entry.
  const { data: agentPermissions } = useQuery({
    queryKey: ['agent-permissions'],
    queryFn: permissions.getAgentPermissions,
  });

  const agent = agentPermissions?.agents.find((a) => a.id === agentId);
  const connected = (agent?.instances ?? [])
    .filter((i) => i.enabled && i.credentialStatus === 'connected')
    .map((i) => i.serviceType);
  const availableServices = agentPermissions?.availableServices ?? [];
  const serviceName = (type: string) => availableServices.find((s) => s.type === type)?.name ?? type;

  const assignMutation = useMutation({
    mutationFn: (skillIds: string[]) => skillsApi.setForAgent(agentId, skillIds),
    onSuccess: () => {
      setError('');
      queryClient.invalidateQueries({ queryKey: ['skills'] });
      queryClient.invalidateQueries({ queryKey: ['agent-skills', agentId] });
      queryClient.invalidateQueries({ queryKey: ['agent-permissions'] });
    },
    onError: (err: any) => setError(err?.message || 'Could not update skills'),
  });

  const isAssigned = (skill: Skill) => (skill.assignedAgentIds ?? []).includes(agentId);
  const missingFor = (skill: Skill) => skill.requiredServices.filter((s) => !connected.includes(s));

  function toggle(skill: Skill) {
    const current = skillList.filter(isAssigned).map((s) => s.id);
    const next = isAssigned(skill)
      ? current.filter((id) => id !== skill.id)
      : [...current, skill.id];
    assignMutation.mutate(next);
  }

  const visible = skillList.filter((s) => s.enabled);

  return (
    <div className="p-4 bg-gray-50 rounded-lg">
      <div className="flex items-center justify-between mb-3">
        <div>
          <div className="font-medium text-reins-navy">Skills</div>
          <div className="text-sm text-gray-500">Which skills can this agent use?</div>
        </div>
        <Link to="/skills" className="text-xs text-trust-blue hover:underline">
          Manage skills →
        </Link>
      </div>

      {isLoading && <p className="text-sm text-gray-400">Loading skills…</p>}
      {!isLoading && visible.length === 0 && (
        <p className="text-sm text-gray-400">
          No skills yet. Create one on the <Link to="/skills" className="text-trust-blue hover:underline">Skills</Link> page.
        </p>
      )}

      <div className="space-y-2">
        {visible.map((skill) => {
          const on = isAssigned(skill);
          const missing = missingFor(skill);
          // Blocked only when turning it on — an already-assigned skill whose
          // service dropped stays toggleable so it can be removed.
          const blocked = !on && missing.length > 0;
          return (
            <div
              key={skill.id}
              className="flex items-center gap-3 p-3 bg-white rounded-lg border border-gray-200"
            >
              <div className="flex-1 min-w-0">
                <div className="font-medium text-sm text-reins-navy truncate">{skill.name}</div>
                {skill.description && (
                  <div className="text-xs text-gray-400 truncate">{skill.description}</div>
                )}
                {missing.length > 0 && (
                  <div className="flex items-center gap-1 text-xs text-caution-amber mt-0.5">
                    <AlertCircle className="w-3 h-3 shrink-0" />
                    Needs {missing.map(serviceName).join(', ')}
                  </div>
                )}
              </div>
              <button
                type="button"
                role="switch"
                aria-checked={on}
                aria-label={skill.name}
                disabled={blocked || assignMutation.isPending}
                onClick={() => toggle(skill)}
                className={`relative inline-flex h-6 w-11 shrink-0 items-center rounded-full transition-colors disabled:opacity-50 disabled:cursor-not-allowed ${
                  on ? 'bg-trust-blue' : 'bg-gray-300'
                }`}
              >
                <span
                  className={`inline-block h-4 w-4 transform rounded-full bg-white transition-transform ${
                    on ? 'translate-x-6' : 'translate-x-1'
                  }`}
                />
              </button>
            </div>
          );
        })}
      </div>

      {error && <p className="text-xs text-alert-red mt-2">{error}</p>}
    </div>
  );
}
