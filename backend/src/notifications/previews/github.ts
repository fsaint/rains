/**
 * Previews for GitHub writes. These arguments are mostly readable already; the
 * generic message failed them by cutting everything at 200 characters, which
 * hid the code being written and the branch being moved.
 */
import type { ApprovalRequest } from '@reins/shared';
import { PREVIEW_ITEM_LIMIT, registerPreview, type ApprovalPreview, type PreviewRow } from '../approval-preview.js';
import { argsOf, bearer, byteSize, fetchJson, idOf, plural, str, strList, tokenFor } from './shared.js';

const GITHUB_API = 'https://api.github.com';

const shortSha = (sha: string | undefined) => (sha && /^[0-9a-f]{12,}$/i.test(sha) ? sha.slice(0, 7) : sha ?? '');

async function buildGitHubPreview(approval: ApprovalRequest): Promise<ApprovalPreview | null> {
  const args = argsOf(approval);
  const owner = str(args.owner);
  const repo = str(args.repo);
  if (!owner || !repo) return null;
  const repoPath = `${GITHUB_API}/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}`;
  const rows: PreviewRow[] = [{ label: 'Repository', value: `${owner}/${repo}` }];
  const body = str(args.body);

  const get = async <T>(path: string): Promise<T | null> => {
    const token = await tokenFor(approval, 'github');
    return token
      ? fetchJson<T>(`${repoPath}${path}`, {
          headers: { ...bearer(token), Accept: 'application/vnd.github+json' },
        })
      : null;
  };

  switch (approval.tool) {
    case 'github_create_issue': {
      rows.push({ label: 'Title', value: str(args.title) ?? '(none)' });
      if (strList(args.labels).length > 0) rows.push({ label: 'Labels', value: strList(args.labels).join(', ') });
      if (strList(args.assignees).length > 0) rows.push({ label: 'Assignees', value: strList(args.assignees).join(', ') });
      return {
        icon: '🐙',
        heading: 'Open GitHub issue',
        rows,
        body: body ? { label: 'Description', text: body } : undefined,
      };
    }

    case 'github_comment_on_issue': {
      const number = idOf(args.issueNumber);
      const issue = number
        ? await get<{ title?: string; pull_request?: unknown; state?: string }>(`/issues/${encodeURIComponent(number)}`)
        : null;
      const kind = issue?.pull_request ? 'Pull request' : 'Issue';
      rows.push({ label: kind, value: issue?.title ? `#${number} ${issue.title}` : `#${number ?? '?'}` });
      if (issue?.state === 'closed') rows.push({ label: 'State', value: 'Closed' });
      return {
        icon: '💬',
        heading: `Comment on ${kind.toLowerCase()} #${number ?? '?'}`,
        note: 'The comment is posted under your GitHub account.',
        rows,
        warning: issue ? undefined : 'Could not load this issue; only its number is shown.',
        body: body ? { label: 'Comment', text: body } : undefined,
      };
    }

    case 'github_create_branch':
      rows.push({ label: 'New branch', value: str(args.branch) ?? '' });
      rows.push({ label: 'Starting from', value: str(args.fromBranch) ?? 'the default branch' });
      return { icon: '🌿', heading: 'Create branch', rows };

    case 'github_create_or_update_file': {
      const content = str(args.content) ?? '';
      rows.push({ label: 'File', value: str(args.path) ?? '' });
      rows.push({ label: 'Branch', value: str(args.branch) ?? 'the default branch' });
      rows.push({ label: 'Commit message', value: str(args.message) ?? '' });
      return {
        icon: '📄',
        heading: str(args.sha) ? 'Replace a file on GitHub' : 'Write a file on GitHub',
        note: 'This commits straight to the branch.',
        rows,
        body: content ? { label: `File content (${byteSize(Buffer.byteLength(content))})`, text: content } : undefined,
      };
    }

    case 'github_create_tree': {
      const files = Array.isArray(args.files) ? (args.files as Array<Record<string, unknown>>) : [];
      if (str(args.baseTree)) rows.push({ label: 'On top of tree', value: shortSha(str(args.baseTree)) });
      return {
        icon: '🌳',
        heading: `Stage ${plural(files.length, 'file')} for a commit`,
        note: 'Nothing changes on any branch until a commit uses this tree and a branch is moved to it.',
        rows,
        items: {
          label: 'Files',
          list: files.slice(0, PREVIEW_ITEM_LIMIT).map((file) => ({
            title: str(file.path) ?? '(no path)',
            detail: typeof file.content === 'string' ? byteSize(Buffer.byteLength(file.content)) : undefined,
          })),
          more: Math.max(0, files.length - PREVIEW_ITEM_LIMIT),
        },
      };
    }

    case 'github_create_commit':
      rows.push({ label: 'Message', value: str(args.message) ?? '' });
      rows.push({ label: 'Tree', value: shortSha(str(args.tree)) });
      rows.push({ label: 'Parents', value: strList(args.parents).map(shortSha).join(', ') || '(none — a root commit)' });
      return {
        icon: '📦',
        heading: 'Create commit',
        note: 'The commit is not on any branch until a branch is moved to it.',
        rows,
      };

    case 'github_update_ref': {
      const sha = str(args.sha);
      const ref = (str(args.ref) ?? '').replace(/^refs\//, '');
      const branch = ref.replace(/^heads\//, '');
      const commit = sha
        ? await get<{ commit?: { message?: string; author?: { name?: string } } }>(`/commits/${encodeURIComponent(sha)}`)
        : null;
      const subject = commit?.commit?.message?.split('\n')[0];
      const force = args.force === true;
      rows.push({ label: ref.startsWith('tags/') ? 'Tag' : 'Branch', value: branch.replace(/^tags\//, '') });
      rows.push({ label: 'Move to', value: [shortSha(sha), subject].filter(Boolean).join(' — ') });
      if (commit?.commit?.author?.name) rows.push({ label: 'Commit by', value: commit.commit.author.name });
      return {
        icon: force ? '⚠️' : '🔀',
        heading: force ? `Force-move ${branch}` : `Move ${branch} to a new commit`,
        note: force
          ? 'Forced: commits on this branch that the new commit does not include are discarded.'
          : 'Everything in the new commit becomes the content of this branch.',
        destructive: force || undefined,
        rows,
        warning: sha && !commit ? 'Could not load the commit; only its id is shown.' : undefined,
      };
    }

    case 'github_create_pull_request':
      rows.push({ label: 'Title', value: str(args.title) ?? '(none)' });
      rows.push({ label: 'Merge', value: `${str(args.head) ?? '?'} → ${str(args.base) ?? '?'}` });
      if (args.draft === true) rows.push({ label: 'Draft', value: 'Yes' });
      return {
        icon: '🔀',
        heading: 'Open pull request',
        rows,
        body: body ? { label: 'Description', text: body } : undefined,
      };

    default:
      return null;
  }
}

registerPreview(
  [
    'github_create_issue',
    'github_comment_on_issue',
    'github_create_branch',
    'github_create_or_update_file',
    'github_create_tree',
    'github_create_commit',
    'github_update_ref',
    'github_create_pull_request',
  ],
  buildGitHubPreview
);
