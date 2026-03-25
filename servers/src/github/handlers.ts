/**
 * GitHub MCP Server Tool Handlers
 *
 * Uses the GitHub REST API with a Personal Access Token.
 */

import type { ServerContext, ToolResult } from '../common/types.js';

const GITHUB_API = 'https://api.github.com';

/**
 * Make an authenticated GitHub API request
 */
async function githubRequest(
  context: ServerContext,
  path: string,
  options: RequestInit = {}
): Promise<Response> {
  const token = context.accessToken;
  if (!token) {
    throw new Error('No GitHub access token available');
  }

  const headers: Record<string, string> = {
    Authorization: `Bearer ${token}`,
    Accept: 'application/vnd.github+json',
    'X-GitHub-Api-Version': '2022-11-28',
    ...(options.headers as Record<string, string> ?? {}),
  };

  if (options.body) {
    headers['Content-Type'] = 'application/json';
  }

  return fetch(`${GITHUB_API}${path}`, {
    ...options,
    headers,
  });
}

async function handleError(response: Response): Promise<ToolResult> {
  const body = await response.json().catch(() => ({ message: response.statusText }));
  return { success: false, error: `GitHub API error (${response.status}): ${body.message || response.statusText}` };
}

// ============================================================================
// Repo tools
// ============================================================================

export async function handleListRepos(
  args: Record<string, unknown>,
  context: ServerContext
): Promise<ToolResult> {
  const sort = (args.sort as string) || 'updated';
  const perPage = Math.min((args.perPage as number) || 30, 100);
  const page = (args.page as number) || 1;
  const type = (args.type as string) || 'all';

  const params = new URLSearchParams({ sort, per_page: String(perPage), page: String(page), type });
  const response = await githubRequest(context, `/user/repos?${params}`);

  if (!response.ok) return handleError(response);

  const repos = await response.json();
  return {
    success: true,
    data: repos.map((r: any) => ({
      full_name: r.full_name,
      description: r.description,
      private: r.private,
      language: r.language,
      stargazers_count: r.stargazers_count,
      updated_at: r.updated_at,
      html_url: r.html_url,
    })),
  };
}

export async function handleGetRepo(
  args: Record<string, unknown>,
  context: ServerContext
): Promise<ToolResult> {
  const owner = args.owner as string;
  const repo = args.repo as string;

  const response = await githubRequest(context, `/repos/${owner}/${repo}`);
  if (!response.ok) return handleError(response);

  const data = await response.json();
  return { success: true, data };
}

// ============================================================================
// Issue tools
// ============================================================================

export async function handleListIssues(
  args: Record<string, unknown>,
  context: ServerContext
): Promise<ToolResult> {
  const owner = args.owner as string;
  const repo = args.repo as string;
  const state = (args.state as string) || 'open';
  const perPage = Math.min((args.perPage as number) || 30, 100);
  const labels = args.labels as string | undefined;

  const params = new URLSearchParams({ state, per_page: String(perPage) });
  if (labels) params.set('labels', labels);

  const response = await githubRequest(context, `/repos/${owner}/${repo}/issues?${params}`);
  if (!response.ok) return handleError(response);

  const issues = await response.json();
  return {
    success: true,
    data: issues.map((i: any) => ({
      number: i.number,
      title: i.title,
      state: i.state,
      user: i.user?.login,
      labels: i.labels?.map((l: any) => l.name),
      created_at: i.created_at,
      updated_at: i.updated_at,
      html_url: i.html_url,
    })),
  };
}

export async function handleGetIssue(
  args: Record<string, unknown>,
  context: ServerContext
): Promise<ToolResult> {
  const owner = args.owner as string;
  const repo = args.repo as string;
  const issueNumber = args.issueNumber as number;

  const response = await githubRequest(context, `/repos/${owner}/${repo}/issues/${issueNumber}`);
  if (!response.ok) return handleError(response);

  const data = await response.json();
  return { success: true, data };
}

export async function handleCreateIssue(
  args: Record<string, unknown>,
  context: ServerContext
): Promise<ToolResult> {
  const owner = args.owner as string;
  const repo = args.repo as string;

  const body: any = { title: args.title };
  if (args.body) body.body = args.body;
  if (args.labels) body.labels = args.labels;
  if (args.assignees) body.assignees = args.assignees;

  const response = await githubRequest(context, `/repos/${owner}/${repo}/issues`, {
    method: 'POST',
    body: JSON.stringify(body),
  });
  if (!response.ok) return handleError(response);

  const data = await response.json();
  return {
    success: true,
    data: { number: data.number, title: data.title, html_url: data.html_url },
  };
}

export async function handleCommentOnIssue(
  args: Record<string, unknown>,
  context: ServerContext
): Promise<ToolResult> {
  const owner = args.owner as string;
  const repo = args.repo as string;
  const issueNumber = args.issueNumber as number;

  const response = await githubRequest(context, `/repos/${owner}/${repo}/issues/${issueNumber}/comments`, {
    method: 'POST',
    body: JSON.stringify({ body: args.body }),
  });
  if (!response.ok) return handleError(response);

  const data = await response.json();
  return { success: true, data: { id: data.id, html_url: data.html_url } };
}

// ============================================================================
// Pull Request tools
// ============================================================================

export async function handleListPullRequests(
  args: Record<string, unknown>,
  context: ServerContext
): Promise<ToolResult> {
  const owner = args.owner as string;
  const repo = args.repo as string;
  const state = (args.state as string) || 'open';
  const perPage = Math.min((args.perPage as number) || 30, 100);

  const params = new URLSearchParams({ state, per_page: String(perPage) });

  const response = await githubRequest(context, `/repos/${owner}/${repo}/pulls?${params}`);
  if (!response.ok) return handleError(response);

  const prs = await response.json();
  return {
    success: true,
    data: prs.map((p: any) => ({
      number: p.number,
      title: p.title,
      state: p.state,
      user: p.user?.login,
      head: p.head?.ref,
      base: p.base?.ref,
      created_at: p.created_at,
      html_url: p.html_url,
    })),
  };
}

export async function handleGetPullRequest(
  args: Record<string, unknown>,
  context: ServerContext
): Promise<ToolResult> {
  const owner = args.owner as string;
  const repo = args.repo as string;
  const prNumber = args.prNumber as number;

  const response = await githubRequest(context, `/repos/${owner}/${repo}/pulls/${prNumber}`);
  if (!response.ok) return handleError(response);

  const data = await response.json();
  return { success: true, data };
}

export async function handleGetPullRequestDiff(
  args: Record<string, unknown>,
  context: ServerContext
): Promise<ToolResult> {
  const owner = args.owner as string;
  const repo = args.repo as string;
  const prNumber = args.prNumber as number;

  const token = context.accessToken;
  if (!token) return { success: false, error: 'No access token' };

  const response = await fetch(`${GITHUB_API}/repos/${owner}/${repo}/pulls/${prNumber}`, {
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: 'application/vnd.github.diff',
      'X-GitHub-Api-Version': '2022-11-28',
    },
  });
  if (!response.ok) return handleError(response);

  const diff = await response.text();
  return { success: true, data: diff };
}

// ============================================================================
// File/content tools
// ============================================================================

export async function handleGetFileContent(
  args: Record<string, unknown>,
  context: ServerContext
): Promise<ToolResult> {
  const owner = args.owner as string;
  const repo = args.repo as string;
  const path = args.path as string;
  const ref = args.ref as string | undefined;

  const params = ref ? `?ref=${ref}` : '';
  const response = await githubRequest(context, `/repos/${owner}/${repo}/contents/${path}${params}`);
  if (!response.ok) return handleError(response);

  const data = await response.json();
  if (data.type === 'file' && data.content) {
    const content = Buffer.from(data.content, 'base64').toString('utf-8');
    return { success: true, data: { path: data.path, size: data.size, content } };
  }

  // Directory listing
  if (Array.isArray(data)) {
    return {
      success: true,
      data: data.map((f: any) => ({ name: f.name, type: f.type, path: f.path, size: f.size })),
    };
  }

  return { success: true, data };
}

export async function handleSearchCode(
  args: Record<string, unknown>,
  context: ServerContext
): Promise<ToolResult> {
  const query = args.query as string;
  const perPage = Math.min((args.perPage as number) || 20, 100);

  const params = new URLSearchParams({ q: query, per_page: String(perPage) });
  const response = await githubRequest(context, `/search/code?${params}`);
  if (!response.ok) return handleError(response);

  const data = await response.json();
  return {
    success: true,
    data: {
      total_count: data.total_count,
      items: data.items?.map((i: any) => ({
        name: i.name,
        path: i.path,
        repository: i.repository?.full_name,
        html_url: i.html_url,
      })),
    },
  };
}

// ============================================================================
// User tools
// ============================================================================

export async function handleGetUser(
  _args: Record<string, unknown>,
  context: ServerContext
): Promise<ToolResult> {
  const response = await githubRequest(context, '/user');
  if (!response.ok) return handleError(response);

  const data = await response.json();
  return {
    success: true,
    data: {
      login: data.login,
      name: data.name,
      email: data.email,
      bio: data.bio,
      public_repos: data.public_repos,
      followers: data.followers,
      html_url: data.html_url,
    },
  };
}

/**
 * Validate a GitHub PAT and return its scopes.
 * Called during credential setup, not as an MCP tool.
 */
export async function validateToken(token: string): Promise<{
  valid: boolean;
  scopes: string[];
  login?: string;
  error?: string;
}> {
  try {
    const response = await fetch(`${GITHUB_API}/user`, {
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: 'application/vnd.github+json',
        'X-GitHub-Api-Version': '2022-11-28',
      },
    });

    if (!response.ok) {
      return { valid: false, scopes: [], error: `Authentication failed (${response.status})` };
    }

    const scopeHeader = response.headers.get('X-OAuth-Scopes') || '';
    const scopes = scopeHeader.split(',').map((s) => s.trim()).filter(Boolean);
    const data = await response.json();

    return { valid: true, scopes, login: data.login };
  } catch (error) {
    return { valid: false, scopes: [], error: String(error) };
  }
}
