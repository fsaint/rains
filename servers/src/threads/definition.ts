import type { ServiceDefinitionWithTools } from '../common/types.js';
import { threadsTools } from './tools.js';

export const definition: ServiceDefinitionWithTools = {
  type: 'threads',
  name: 'Threads',
  description: 'Time-bound focus topics — keep a thread\'s goal, Now/Next, todos, deadlines and reminders current',
  icon: 'Spool',
  category: 'productivity',
  toolPrefix: 'thread_',
  auth: {
    type: 'none',
    required: false,
  },
  tools: threadsTools,
  permissions: {
    read: [
      'thread_list',
      'thread_get_brief',
      'thread_list_candidates',
    ],
    write: [
      'thread_log_event',
      'thread_add_item',
      'thread_update_item',
      'thread_update_now',
      'thread_attach_source',
      'thread_accept_candidate',
      'thread_dismiss_candidate',
      'thread_pause',
      'thread_resume',
      'thread_propose',
      'thread_close',
      'thread_add_watcher',
    ],
    defaultWritePermission: 'allow',
    // These three create or end the user's focus objects and start background
    // scanning of their mail, so they must never run unattended. Like
    // helm-admin's writes, they hold even if a per-agent override or a
    // permission level would otherwise loosen them.
    alwaysApprove: ['thread_propose', 'thread_close', 'thread_add_watcher'],
    blocked: [],
  },
  permissionDescriptions: {
    read: 'List threads and read their briefs and candidates',
    full: 'Log events, add and update items and keep Now/Next current without approval. Proposing or closing a thread and adding a watcher always need approval.',
  },
};
