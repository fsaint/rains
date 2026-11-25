/**
 * Previews for Linear writes. The issue is shown by its key and title, and
 * every id in the arguments (state, assignee, project, team, labels) by name.
 */
import type { ApprovalRequest } from '@reins/shared';
import { registerPreview, type ApprovalPreview, type PreviewRow } from '../approval-preview.js';
import { argsOf, str, strList, tokenFor } from './shared.js';

const LINEAR_API = 'https://api.linear.app/graphql';
const LOOKUP_TIMEOUT_MS = 5000;

const PRIORITIES = ['No priority', 'Urgent', 'High', 'Medium', 'Low'];

interface Named {
  name?: string;
}

interface LinearIssue {
  identifier?: string;
  title?: string;
  priority?: number;
  estimate?: number | null;
  state?: Named | null;
  assignee?: Named | null;
  project?: Named | null;
  team?: Named | null;
  labels?: { nodes?: Named[] };
}

type Lookup = Record<string, (LinearIssue & Named) | null>;

/**
 * One GraphQL request for everything the preview names. Each lookup is its own
 * aliased field; ids travel as variables, never inside the query text.
 */
async function lookup(token: string | null, wanted: Array<[alias: string, field: string, id: string]>): Promise<Lookup> {
  if (!token || wanted.length === 0) return {};
  const issueFields =
    'identifier title priority estimate state { name } assignee { name } project { name } team { name } labels { nodes { name } }';
  const query =
    `query(${wanted.map(([alias]) => `$${alias}: String!`).join(', ')}) { ` +
    wanted
      .map(([alias, field]) => `${alias}: ${field}(id: $${alias}) { ${field === 'issue' ? issueFields : 'name'} }`)
      .join(' ') +
    ' }';
  try {
    const res = await fetch(LINEAR_API, {
      method: 'POST',
      // Linear takes the API key bare, without a "Bearer" prefix.
      headers: { Authorization: token, 'Content-Type': 'application/json' },
      body: JSON.stringify({ query, variables: Object.fromEntries(wanted.map(([alias, , id]) => [alias, id])) }),
      signal: AbortSignal.timeout(LOOKUP_TIMEOUT_MS),
    });
    // A partial failure still returns `data` for the lookups that worked.
    return ((await res.json()) as { data?: Lookup }).data ?? {};
  } catch {
    return {};
  }
}

async function buildLinearPreview(approval: ApprovalRequest): Promise<ApprovalPreview | null> {
  const args = argsOf(approval);
  const token = await tokenFor(approval, 'linear');
  const issueId = str(args.issueId);
  const labelIds = Array.isArray(args.labelIds) ? strList(args.labelIds) : undefined;

  const wanted: Array<[string, string, string]> = [];
  const want = (alias: string, field: string, id: string | undefined) => {
    if (id) wanted.push([alias, field, id]);
  };
  want('issue', 'issue', issueId);
  want('team', 'team', str(args.teamId));
  want('state', 'workflowState', str(args.stateId));
  want('assignee', 'user', str(args.assigneeId));
  want('project', 'project', str(args.projectId));
  want('parent', 'issue', str(args.parentId));
  (labelIds ?? []).forEach((id, i) => want(`label${i}`, 'issueLabel', id));

  const found = await lookup(token, wanted);
  const name = (alias: string, id: string | undefined) => found[alias]?.name ?? id;
  const issue = found.issue ?? null;
  const issueLabel = issue ? `${issue.identifier} ${issue.title}` : issueId ?? '';
  const missing = issueId && !issue ? 'Could not load this issue. Approve only if you recognise its id.' : undefined;
  const description = str(args.description);
  const isUpdate = approval.tool === 'linear_update_issue';

  if (approval.tool === 'linear_comment_on_issue') {
    return {
      icon: '💬',
      heading: `Comment on ${issue?.identifier ?? 'Linear issue'}`,
      rows: [{ label: 'Issue', value: issueLabel }],
      warning: missing,
      body: str(args.body) ? { label: 'Comment', text: str(args.body)! } : undefined,
    };
  }

  if (approval.tool === 'linear_delete_issue') {
    const rows: PreviewRow[] = [{ label: 'Issue', value: issueLabel }];
    if (issue?.team?.name) rows.push({ label: 'Team', value: issue.team.name });
    if (issue?.state?.name) rows.push({ label: 'Status', value: issue.state.name });
    if (issue?.assignee?.name) rows.push({ label: 'Assignee', value: issue.assignee.name });
    return {
      icon: '🗑',
      heading: `Delete ${issue?.identifier ?? 'Linear issue'}`,
      note: 'The issue goes to the Linear trash and is removed for good after 30 days.',
      destructive: true,
      rows,
      warning: missing,
    };
  }

  // Create and update share their fields; an update shows what each replaces.
  const rows: PreviewRow[] = [];
  const field = (label: string, value: string | undefined, was: string | undefined) => {
    if (value === undefined) return;
    if (!isUpdate || !issue) rows.push({ label, value });
    else if (value !== was) rows.push({ label, value, was: was ?? '' });
  };

  if (isUpdate) rows.push({ label: 'Issue', value: issueLabel });
  else field('Team', name('team', str(args.teamId)), undefined);
  field('Title', str(args.title), issue?.title);
  field('Status', name('state', str(args.stateId)), issue?.state?.name);
  field('Assignee', name('assignee', str(args.assigneeId)), issue?.assignee?.name);
  field(
    'Priority',
    typeof args.priority === 'number' ? PRIORITIES[args.priority] ?? String(args.priority) : undefined,
    issue?.priority !== undefined ? PRIORITIES[issue.priority] : undefined
  );
  field('Project', name('project', str(args.projectId)), issue?.project?.name);
  field(
    'Labels',
    labelIds ? labelIds.map((id, i) => name(`label${i}`, id)).join(', ') || '(none)' : undefined,
    issue ? (issue.labels?.nodes ?? []).map((l) => l.name).join(', ') || '(none)' : undefined
  );
  field(
    'Estimate',
    typeof args.estimate === 'number' ? String(args.estimate) : undefined,
    issue?.estimate != null ? String(issue.estimate) : undefined
  );
  if (!isUpdate && str(args.parentId)) {
    const parent = found.parent;
    rows.push({ label: 'Sub-issue of', value: parent ? `${parent.identifier} ${parent.title}` : str(args.parentId)! });
  }

  return {
    icon: isUpdate ? '✏️' : '🆕',
    heading: isUpdate ? `Update ${issue?.identifier ?? 'Linear issue'}` : 'Create Linear issue',
    note: isUpdate && issue && rows.length === 1 && !description ? 'Nothing shown here changes.' : undefined,
    rows,
    warning: missing,
    body: description ? { label: isUpdate ? 'New description' : 'Description', text: description } : undefined,
  };
}

registerPreview(
  ['linear_create_issue', 'linear_update_issue', 'linear_comment_on_issue', 'linear_delete_issue'],
  buildLinearPreview
);
