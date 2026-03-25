/**
 * Linear MCP Server Tool Handlers
 *
 * Uses the Linear GraphQL API. Each workspace has its own API key,
 * routed via the `workspace` parameter on each tool.
 */

import type { ServerContext, ToolResult } from '../common/types.js';

const API_BASE = 'https://api.linear.app/graphql';

/**
 * Execute a GraphQL query against the Linear API
 */
async function linearQuery(
  context: ServerContext,
  query: string,
  variables: Record<string, unknown> = {}
): Promise<unknown> {
  const token = context.accessToken;
  if (!token) throw new Error('No Linear API key available');

  const response = await fetch(API_BASE, {
    method: 'POST',
    headers: {
      Authorization: token,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ query, variables }),
  });

  if (!response.ok) {
    const text = await response.text();
    throw new Error(`Linear API error ${response.status}: ${text}`);
  }

  const json = (await response.json()) as { data?: unknown; errors?: Array<{ message: string }> };
  if (json.errors?.length) {
    throw new Error(`Linear GraphQL error: ${json.errors.map((e) => e.message).join(', ')}`);
  }

  return json.data;
}

/**
 * List connected workspaces
 */
export async function handleListWorkspaces(
  _args: Record<string, unknown>,
  context: ServerContext
): Promise<ToolResult> {
  return {
    success: true,
    data: { workspaces: context.linkedAccounts ?? [] },
  };
}

/**
 * List issues with optional filters
 */
export async function handleListIssues(
  args: Record<string, unknown>,
  context: ServerContext
): Promise<ToolResult> {
  const teamId = args.teamId as string | undefined;
  const projectId = args.projectId as string | undefined;
  const assigneeId = args.assigneeId as string | undefined;
  const stateType = args.stateType as string | undefined;
  const first = Math.min((args.limit as number) ?? 25, 50);
  const after = args.cursor as string | undefined;

  const filters: string[] = [];
  if (teamId) filters.push(`team: { id: { eq: "${teamId}" } }`);
  if (projectId) filters.push(`project: { id: { eq: "${projectId}" } }`);
  if (assigneeId) filters.push(`assignee: { id: { eq: "${assigneeId}" } }`);
  if (stateType) filters.push(`state: { type: { eq: "${stateType}" } }`);

  const filterArg = filters.length > 0 ? `filter: { ${filters.join(', ')} }` : '';

  const data = (await linearQuery(context, `
    query ListIssues($first: Int, $after: String) {
      issues(first: $first, after: $after, ${filterArg}, orderBy: updatedAt) {
        nodes {
          id
          identifier
          title
          priority
          priorityLabel
          state { id name type color }
          assignee { id name email }
          team { id name key }
          project { id name }
          labels { nodes { id name color } }
          createdAt
          updatedAt
        }
        pageInfo { hasNextPage endCursor }
      }
    }
  `, { first, after })) as { issues: { nodes: unknown[]; pageInfo: { hasNextPage: boolean; endCursor: string } } };

  return {
    success: true,
    data: {
      issues: data.issues.nodes,
      pageInfo: data.issues.pageInfo,
    },
  };
}

/**
 * Get a single issue by ID or identifier (e.g. "ENG-123")
 */
export async function handleGetIssue(
  args: Record<string, unknown>,
  context: ServerContext
): Promise<ToolResult> {
  const issueId = args.issueId as string;

  const data = (await linearQuery(context, `
    query GetIssue($id: String!) {
      issue(id: $id) {
        id
        identifier
        title
        description
        priority
        priorityLabel
        estimate
        state { id name type color }
        assignee { id name email }
        creator { id name email }
        team { id name key }
        project { id name }
        cycle { id name number }
        parent { id identifier title }
        children { nodes { id identifier title state { name } } }
        labels { nodes { id name color } }
        comments { nodes { id body user { name email } createdAt } }
        relations { nodes { type relatedIssue { id identifier title } } }
        url
        createdAt
        updatedAt
        completedAt
      }
    }
  `, { id: issueId })) as { issue: unknown };

  if (!data.issue) {
    return { success: false, error: `Issue not found: ${issueId}` };
  }

  return { success: true, data: data.issue };
}

/**
 * Search issues by text query
 */
export async function handleSearchIssues(
  args: Record<string, unknown>,
  context: ServerContext
): Promise<ToolResult> {
  const query = args.query as string;
  const first = Math.min((args.limit as number) ?? 20, 50);

  const data = (await linearQuery(context, `
    query SearchIssues($query: String!, $first: Int) {
      searchIssues(query: $query, first: $first) {
        nodes {
          id
          identifier
          title
          priority
          priorityLabel
          state { id name type color }
          assignee { id name email }
          team { id name key }
          project { id name }
          url
          updatedAt
        }
        pageInfo { hasNextPage endCursor }
      }
    }
  `, { query, first })) as { searchIssues: { nodes: unknown[]; pageInfo: unknown } };

  return {
    success: true,
    data: {
      query,
      results: data.searchIssues.nodes,
      pageInfo: data.searchIssues.pageInfo,
    },
  };
}

/**
 * List teams
 */
export async function handleListTeams(
  _args: Record<string, unknown>,
  context: ServerContext
): Promise<ToolResult> {
  const data = (await linearQuery(context, `
    query ListTeams {
      teams {
        nodes {
          id
          name
          key
          description
          color
          icon
          members { nodes { id name email } }
        }
      }
    }
  `)) as { teams: { nodes: unknown[] } };

  return { success: true, data: { teams: data.teams.nodes } };
}

/**
 * List projects
 */
export async function handleListProjects(
  args: Record<string, unknown>,
  context: ServerContext
): Promise<ToolResult> {
  const first = Math.min((args.limit as number) ?? 25, 50);

  const data = (await linearQuery(context, `
    query ListProjects($first: Int) {
      projects(first: $first, orderBy: updatedAt) {
        nodes {
          id
          name
          description
          state
          progress
          startDate
          targetDate
          lead { id name email }
          teams { nodes { id name key } }
          url
          createdAt
          updatedAt
        }
      }
    }
  `, { first })) as { projects: { nodes: unknown[] } };

  return { success: true, data: { projects: data.projects.nodes } };
}

/**
 * Get a single project
 */
export async function handleGetProject(
  args: Record<string, unknown>,
  context: ServerContext
): Promise<ToolResult> {
  const projectId = args.projectId as string;

  const data = (await linearQuery(context, `
    query GetProject($id: String!) {
      project(id: $id) {
        id
        name
        description
        state
        progress
        startDate
        targetDate
        lead { id name email }
        members { nodes { id name email } }
        teams { nodes { id name key } }
        issues { nodes { id identifier title state { name } assignee { name } } }
        url
        createdAt
        updatedAt
      }
    }
  `, { id: projectId })) as { project: unknown };

  if (!data.project) {
    return { success: false, error: `Project not found: ${projectId}` };
  }

  return { success: true, data: data.project };
}

/**
 * List cycles for a team
 */
export async function handleListCycles(
  args: Record<string, unknown>,
  context: ServerContext
): Promise<ToolResult> {
  const teamId = args.teamId as string | undefined;

  const filter = teamId ? `filter: { team: { id: { eq: "${teamId}" } } }` : '';

  const data = (await linearQuery(context, `
    query ListCycles {
      cycles(${filter}, orderBy: createdAt) {
        nodes {
          id
          name
          number
          startsAt
          endsAt
          progress
          completedAt
          team { id name key }
          issues { nodes { id identifier title state { name } } }
        }
      }
    }
  `)) as { cycles: { nodes: unknown[] } };

  return { success: true, data: { cycles: data.cycles.nodes } };
}

/**
 * List labels
 */
export async function handleListLabels(
  _args: Record<string, unknown>,
  context: ServerContext
): Promise<ToolResult> {
  const data = (await linearQuery(context, `
    query ListLabels {
      issueLabels {
        nodes {
          id
          name
          color
          description
          parent { id name }
        }
      }
    }
  `)) as { issueLabels: { nodes: unknown[] } };

  return { success: true, data: { labels: data.issueLabels.nodes } };
}

/**
 * Create a new issue
 */
export async function handleCreateIssue(
  args: Record<string, unknown>,
  context: ServerContext
): Promise<ToolResult> {
  const teamId = args.teamId as string;
  const title = args.title as string;
  const description = args.description as string | undefined;
  const priority = args.priority as number | undefined;
  const assigneeId = args.assigneeId as string | undefined;
  const stateId = args.stateId as string | undefined;
  const projectId = args.projectId as string | undefined;
  const labelIds = args.labelIds as string[] | undefined;
  const parentId = args.parentId as string | undefined;
  const estimate = args.estimate as number | undefined;

  const input: Record<string, unknown> = { teamId, title };
  if (description !== undefined) input.description = description;
  if (priority !== undefined) input.priority = priority;
  if (assigneeId !== undefined) input.assigneeId = assigneeId;
  if (stateId !== undefined) input.stateId = stateId;
  if (projectId !== undefined) input.projectId = projectId;
  if (labelIds !== undefined) input.labelIds = labelIds;
  if (parentId !== undefined) input.parentId = parentId;
  if (estimate !== undefined) input.estimate = estimate;

  const data = (await linearQuery(context, `
    mutation CreateIssue($input: IssueCreateInput!) {
      issueCreate(input: $input) {
        success
        issue {
          id
          identifier
          title
          url
          state { name }
          team { key }
        }
      }
    }
  `, { input })) as { issueCreate: { success: boolean; issue: unknown } };

  if (!data.issueCreate.success) {
    return { success: false, error: 'Failed to create issue' };
  }

  return { success: true, data: data.issueCreate.issue };
}

/**
 * Update an existing issue
 */
export async function handleUpdateIssue(
  args: Record<string, unknown>,
  context: ServerContext
): Promise<ToolResult> {
  const issueId = args.issueId as string;
  const title = args.title as string | undefined;
  const description = args.description as string | undefined;
  const priority = args.priority as number | undefined;
  const assigneeId = args.assigneeId as string | undefined;
  const stateId = args.stateId as string | undefined;
  const projectId = args.projectId as string | undefined;
  const labelIds = args.labelIds as string[] | undefined;
  const estimate = args.estimate as number | undefined;

  const input: Record<string, unknown> = {};
  if (title !== undefined) input.title = title;
  if (description !== undefined) input.description = description;
  if (priority !== undefined) input.priority = priority;
  if (assigneeId !== undefined) input.assigneeId = assigneeId;
  if (stateId !== undefined) input.stateId = stateId;
  if (projectId !== undefined) input.projectId = projectId;
  if (labelIds !== undefined) input.labelIds = labelIds;
  if (estimate !== undefined) input.estimate = estimate;

  const data = (await linearQuery(context, `
    mutation UpdateIssue($id: String!, $input: IssueUpdateInput!) {
      issueUpdate(id: $id, input: $input) {
        success
        issue {
          id
          identifier
          title
          url
          state { name }
        }
      }
    }
  `, { id: issueId, input })) as { issueUpdate: { success: boolean; issue: unknown } };

  if (!data.issueUpdate.success) {
    return { success: false, error: 'Failed to update issue' };
  }

  return { success: true, data: data.issueUpdate.issue };
}

/**
 * Add a comment to an issue
 */
export async function handleCommentOnIssue(
  args: Record<string, unknown>,
  context: ServerContext
): Promise<ToolResult> {
  const issueId = args.issueId as string;
  const body = args.body as string;

  const data = (await linearQuery(context, `
    mutation CommentOnIssue($input: CommentCreateInput!) {
      commentCreate(input: $input) {
        success
        comment {
          id
          body
          user { name email }
          createdAt
        }
      }
    }
  `, { input: { issueId, body } })) as { commentCreate: { success: boolean; comment: unknown } };

  if (!data.commentCreate.success) {
    return { success: false, error: 'Failed to create comment' };
  }

  return { success: true, data: data.commentCreate.comment };
}

/**
 * Delete an issue
 */
export async function handleDeleteIssue(
  args: Record<string, unknown>,
  context: ServerContext
): Promise<ToolResult> {
  const issueId = args.issueId as string;

  const data = (await linearQuery(context, `
    mutation DeleteIssue($id: String!) {
      issueDelete(id: $id) {
        success
      }
    }
  `, { id: issueId })) as { issueDelete: { success: boolean } };

  if (!data.issueDelete.success) {
    return { success: false, error: 'Failed to delete issue' };
  }

  return { success: true, data: { issueId, message: 'Issue deleted' } };
}
