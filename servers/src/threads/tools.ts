/**
 * Threads MCP Server Tool Definitions
 */

import type { ToolDefinition } from '../common/base-server.js';
import {
  handleList,
  handleGetBrief,
  handleListCandidates,
  handleLogEvent,
  handleAddItem,
  handleUpdateItem,
  handleUpdateNow,
  handleAttachSource,
  handleAcceptCandidate,
  handleDismissCandidate,
  handlePause,
  handleResume,
  handlePropose,
  handleClose,
  handleAddWatcher,
} from './handlers.js';

/**
 * The `scope` argument, defined once so its wording cannot drift between tools.
 * Same wording as memory's: a thread lives in a memory scope.
 */
const SCOPE_ARG = {
  type: 'string' as const,
  description:
    'Scope slug (e.g. "work"). Scopes are separate compartments of the vault that never ' +
    'mix — entries, links and relations cannot cross between them. Omit to use your ' +
    'default scope for writes, or to span every scope you can reach for reads. ' +
    'Call memory_list_scopes to see what is available.',
};

const THREAD_ID_ARG = {
  type: 'string' as const,
  description: 'The thread id, from thread_list.',
};

const DATE_NOTE = 'ISO 8601 date or datetime (e.g. "2026-11-01" or "2026-11-01T09:00:00Z").';

const WATCHER_FIELDS = {
  kind: {
    type: 'string' as const,
    enum: ['gmail_thread', 'gmail_query', 'gmail_sender', 'hx_project', 'hx_meeting'],
    description:
      'What to watch: gmail_thread (new messages in one Gmail thread), gmail_query (mail matching a ' +
      'Gmail search), gmail_sender (mail from one address), hx_project (new sessions in your pinned ' +
      'Hermeneutix project), hx_meeting (new sessions of one Hermeneutix meeting). You can only watch ' +
      'a source you can already read without approval.',
  },
  value: {
    type: 'string' as const,
    description: 'The Gmail thread id, search query, sender address, Hermeneutix project id or meeting id.',
  },
  account: {
    type: 'string' as const,
    description: 'Which connected account to watch, when more than one is linked.',
  },
};

export const threadListTool: ToolDefinition = {
  name: 'thread_list',
  description:
    'List the user\'s threads — time-bound focus topics (a launch, a move, a hiring round) that ' +
    'each carry a goal, a Now/Next view, todos, deadlines and reminders. Call this to find the ' +
    'thread a request belongs to before logging anything.',
  inputSchema: {
    type: 'object',
    properties: {
      status: { type: 'string', enum: ['active', 'paused', 'closed'], description: 'Only threads with this status.' },
      scope: SCOPE_ARG,
    },
  },
  handler: handleList,
};

export const threadGetBriefTool: ToolDefinition = {
  name: 'thread_get_brief',
  description:
    'Get a thread\'s brief as text: its goal and Now/Next, then what is due now, what is upcoming, ' +
    'open todos, recent events and new candidates found by watchers. Read this before working on a thread.',
  inputSchema: {
    type: 'object',
    properties: { thread_id: THREAD_ID_ARG },
    required: ['thread_id'],
  },
  handler: handleGetBrief,
};

export const threadListCandidatesTool: ToolDefinition = {
  name: 'thread_list_candidates',
  description:
    'List items watchers found that might belong to a thread (for example an email) and have not ' +
    'been accepted or dismissed yet.',
  inputSchema: {
    type: 'object',
    properties: { thread_id: THREAD_ID_ARG },
    required: ['thread_id'],
  },
  handler: handleListCandidates,
};

export const threadLogEventTool: ToolDefinition = {
  name: 'thread_log_event',
  description:
    'Record something that happened on a thread (a call, a decision, a delivery). Events are the ' +
    'thread\'s timeline; use thread_add_item for things still to be done.',
  inputSchema: {
    type: 'object',
    properties: {
      thread_id: THREAD_ID_ARG,
      title: { type: 'string', description: 'One line saying what happened.' },
      body: { type: 'string', description: 'Details.' },
      occurred_at: { type: 'string', description: `When it happened. ${DATE_NOTE} Defaults to now.` },
      source_type: { type: 'string', enum: ['gmail', 'hermeneutix', 'memory', 'manual'], description: 'Where this came from.' },
      source_ref: { type: 'string', description: 'The id of the source (message id, meeting id, memory entry id).' },
    },
    required: ['thread_id', 'title'],
  },
  handler: handleLogEvent,
};

export const threadAddItemTool: ToolDefinition = {
  name: 'thread_add_item',
  description:
    'Add something still to be done to a thread: a todo, a deadline, a reminder or a milestone. ' +
    'Give due_at for a deadline and remind_at for when the user should be nudged.',
  inputSchema: {
    type: 'object',
    properties: {
      thread_id: THREAD_ID_ARG,
      kind: { type: 'string', enum: ['todo', 'deadline', 'reminder', 'milestone'], description: 'What sort of item.' },
      title: { type: 'string', description: 'One line describing the item.' },
      body: { type: 'string', description: 'Details.' },
      due_at: { type: 'string', description: `When it is due. ${DATE_NOTE}` },
      remind_at: { type: 'string', description: `When to nudge the user. ${DATE_NOTE}` },
    },
    required: ['thread_id', 'kind', 'title'],
  },
  handler: handleAddItem,
};

export const threadUpdateItemTool: ToolDefinition = {
  name: 'thread_update_item',
  description:
    'Change a thread item: retitle it, move its dates, or set its status to done or cancelled. ' +
    'Item ids are in thread_get_brief.',
  inputSchema: {
    type: 'object',
    properties: {
      thread_id: THREAD_ID_ARG,
      item_id: { type: 'string', description: 'The item id, from thread_get_brief.' },
      title: { type: 'string', description: 'New title.' },
      body: { type: 'string', description: 'New details.' },
      due_at: { type: 'string', description: `New due date. ${DATE_NOTE}` },
      remind_at: { type: 'string', description: `New reminder time. ${DATE_NOTE}` },
      status: { type: 'string', enum: ['open', 'done', 'cancelled'], description: 'New status.' },
    },
    required: ['thread_id', 'item_id'],
  },
  handler: handleUpdateItem,
};

export const threadUpdateNowTool: ToolDefinition = {
  name: 'thread_update_now',
  description:
    'Keep a thread\'s narrative current. now and next REPLACE those sections; past_append ADDS to ' +
    'the Past section without touching what is there. Provide at least one.',
  inputSchema: {
    type: 'object',
    properties: {
      thread_id: THREAD_ID_ARG,
      now: { type: 'string', description: 'What is happening right now. Replaces the Now section.' },
      next: { type: 'string', description: 'What comes next. Replaces the Next section.' },
      past_append: { type: 'string', description: 'Text to append to the Past section.' },
    },
    required: ['thread_id'],
  },
  handler: handleUpdateNow,
};

export const threadAttachSourceTool: ToolDefinition = {
  name: 'thread_attach_source',
  description:
    'Attach an email, meeting or memory entry to a thread\'s timeline so it can be found from the thread.',
  inputSchema: {
    type: 'object',
    properties: {
      thread_id: THREAD_ID_ARG,
      source_type: { type: 'string', enum: ['gmail', 'hermeneutix', 'memory'], description: 'What kind of source.' },
      source_ref: { type: 'string', description: 'The id of the source (message id, meeting id, memory entry id).' },
      title: { type: 'string', description: 'One line describing the source.' },
      memory_entry_id: { type: 'string', description: 'A memory entry that holds the details, if one exists.' },
    },
    required: ['thread_id', 'source_type', 'source_ref', 'title'],
  },
  handler: handleAttachSource,
};

export const threadAcceptCandidateTool: ToolDefinition = {
  name: 'thread_accept_candidate',
  description: 'Accept a candidate a watcher found: it joins the thread\'s timeline.',
  inputSchema: {
    type: 'object',
    properties: {
      thread_id: THREAD_ID_ARG,
      candidate_id: { type: 'string', description: 'The candidate id, from thread_list_candidates.' },
    },
    required: ['thread_id', 'candidate_id'],
  },
  handler: handleAcceptCandidate,
};

export const threadDismissCandidateTool: ToolDefinition = {
  name: 'thread_dismiss_candidate',
  description: 'Dismiss a candidate a watcher found that does not belong to the thread.',
  inputSchema: {
    type: 'object',
    properties: {
      thread_id: THREAD_ID_ARG,
      candidate_id: { type: 'string', description: 'The candidate id, from thread_list_candidates.' },
    },
    required: ['thread_id', 'candidate_id'],
  },
  handler: handleDismissCandidate,
};

export const threadPauseTool: ToolDefinition = {
  name: 'thread_pause',
  description: 'Pause a thread: its reminders and watchers stop until it is resumed.',
  inputSchema: {
    type: 'object',
    properties: { thread_id: THREAD_ID_ARG },
    required: ['thread_id'],
  },
  handler: handlePause,
};

export const threadResumeTool: ToolDefinition = {
  name: 'thread_resume',
  description: 'Resume a paused thread.',
  inputSchema: {
    type: 'object',
    properties: { thread_id: THREAD_ID_ARG },
    required: ['thread_id'],
  },
  handler: handleResume,
};

export const threadProposeTool: ToolDefinition = {
  name: 'thread_propose',
  description:
    'Propose a new thread. The user is asked to approve it on their phone; nothing is created until ' +
    'they do. Propose one only when a topic has a goal and will take real attention over days or weeks.',
  inputSchema: {
    type: 'object',
    properties: {
      title: { type: 'string', description: 'Short name for the thread.' },
      goal: { type: 'string', description: 'What done looks like.' },
      scope: SCOPE_ARG,
      target_date: { type: 'string', description: `When the goal should be met. ${DATE_NOTE}` },
      past: { type: 'string', description: 'Background: what has already happened.' },
      now: { type: 'string', description: 'What is happening right now.' },
      next: { type: 'string', description: 'What comes next.' },
      watchers: {
        type: 'array',
        description: 'Sources to scan in the background for things that belong to this thread.',
        items: {
          type: 'object',
          properties: WATCHER_FIELDS,
          required: ['kind', 'value'],
        },
      },
    },
    required: ['title', 'goal'],
  },
  handler: handlePropose,
};

export const threadCloseTool: ToolDefinition = {
  name: 'thread_close',
  description:
    'Close a thread with a retrospective. The user is asked to approve it on their phone. Every open ' +
    'item needs a decision: cancel it, or carry it to a successor thread.',
  inputSchema: {
    type: 'object',
    properties: {
      thread_id: THREAD_ID_ARG,
      retrospective: { type: 'string', description: 'What happened, what worked, what to remember.' },
      decisions: {
        type: 'array',
        description: 'One decision for each open item.',
        items: {
          type: 'object',
          properties: {
            item_id: { type: 'string', description: 'The open item.' },
            action: { type: 'string', enum: ['cancel', 'carry'], description: 'Drop it, or move it to another thread.' },
            successor_thread_id: { type: 'string', description: 'The thread to carry it to. Required when action is carry.' },
          },
          required: ['item_id', 'action'],
        },
      },
    },
    required: ['thread_id', 'retrospective', 'decisions'],
  },
  handler: handleClose,
};

export const threadAddWatcherTool: ToolDefinition = {
  name: 'thread_add_watcher',
  description:
    'Start watching a source for things that belong to a thread, such as a Gmail thread, search or sender, or a Hermeneutix project or meeting. ' +
    'The user is asked to approve it on their phone, because it scans their mail in the background.',
  inputSchema: {
    type: 'object',
    properties: {
      thread_id: THREAD_ID_ARG,
      ...WATCHER_FIELDS,
    },
    required: ['thread_id', 'kind', 'value'],
  },
  handler: handleAddWatcher,
};

export const threadsTools: ToolDefinition[] = [
  threadListTool,
  threadGetBriefTool,
  threadListCandidatesTool,
  threadLogEventTool,
  threadAddItemTool,
  threadUpdateItemTool,
  threadUpdateNowTool,
  threadAttachSourceTool,
  threadAcceptCandidateTool,
  threadDismissCandidateTool,
  threadPauseTool,
  threadResumeTool,
  threadProposeTool,
  threadCloseTool,
  threadAddWatcherTool,
];
