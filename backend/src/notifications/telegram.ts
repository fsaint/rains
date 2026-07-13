/**
 * Telegram notification transport for approval requests.
 *
 * A single Reins-wide bot (REINS_TELEGRAM_BOT_TOKEN) DMs the agent owner
 * when an approval is needed, with inline Approve / Deny buttons.
 * The bot is distinct from per-agent telegram bots in deployed_agents.
 */

import { client } from '../db/index.js';
import { createMagicLinkToken } from '../auth/index.js';
import { config } from '../config/index.js';
import type { ApprovalRequest } from '@reins/shared';

const PROVIDER_LABELS: Record<string, string> = {
  anthropic: 'Anthropic Claude',
  'openai-codex': 'OpenAI',
  minimax: 'MiniMax',
  fly: 'Fly.io',
  docker: 'Docker',
  gmail: 'Gmail',
  drive: 'Google Drive',
  calendar: 'Google Calendar',
  github: 'GitHub',
  linear: 'Linear',
  notion: 'Notion',
  'outlook-mail': 'Outlook Mail',
  'outlook-calendar': 'Outlook Calendar',
  microsoft: 'Microsoft',
  hermeneutix: 'Hermeneutix',
};

// Providers that use a direct external link for key renewal (not OAuth)
const PROVIDER_KEY_RENEWAL_URL: Record<string, string> = {
  minimax: 'https://platform.minimax.io',
};

// Email-sending tools get a rich To/Cc/Subject/Body preview instead of a
// truncated JSON dump. *_send_draft tools only carry a draftId, so they are
// intentionally excluded and keep the generic branch.
const EMAIL_TOOLS = new Set([
  'gmail_send_message',
  'gmail_create_draft',
  'outlook_mail_send_message',
  'outlook_mail_create_draft',
  'outlook_mail_reply',
]);

// Telegram body preview cap. The Telegram message hard limit is 4096 chars;
// leave generous headroom for the headers, blockquote markup, and buttons.
const EMAIL_BODY_PREVIEW_LIMIT = 3000;

function escapeHtml(value: string): string {
  return value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

/** Best-effort HTML → plain text for previewing an email whose only body is HTML. */
function htmlToText(html: string): string {
  return html
    .replace(/<\s*br\s*\/?\s*>/gi, '\n')
    .replace(/<\s*\/\s*p\s*>/gi, '\n')
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/gi, "'")
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

/** Normalize a recipient field that may be a string[] or a single string. */
function joinRecipients(value: unknown): string {
  if (Array.isArray(value)) return value.map((v) => String(v)).join(', ');
  if (typeof value === 'string') return value;
  return '';
}

/**
 * Rich Telegram preview for email approval requests (gmail_* / outlook_mail_*).
 * Rendered with HTML parse mode — email subjects and bodies routinely contain
 * Markdown-special characters, so HTML escaping (only & < >) is far more robust.
 * Exported for unit testing without a live bot.
 */
export function formatEmailApprovalMessage(approval: ApprovalRequest): {
  text: string;
  keyboard: Array<Array<{ text: string; callback_data?: string; url?: string }>>;
  parseMode: 'HTML';
} {
  const args = approval.arguments as {
    account?: string;
    to?: unknown;
    cc?: unknown;
    bcc?: unknown;
    subject?: string;
    body?: string;
    htmlBody?: string;
    threadId?: string;
    replyTo?: string;
    messageId?: string;
  };

  const isReply =
    approval.tool === 'outlook_mail_reply' ||
    Boolean(args.threadId) ||
    Boolean(args.replyTo);

  let heading: string;
  if (approval.tool === 'gmail_create_draft' || approval.tool === 'outlook_mail_create_draft') {
    heading = '📧 <b>Save draft</b>';
  } else if (isReply) {
    heading = '📧 <b>Reply to email</b>';
  } else {
    heading = '📧 <b>Send email</b>';
  }

  const to = joinRecipients(args.to);
  const cc = joinRecipients(args.cc);
  const bcc = joinRecipients(args.bcc);

  // Prefer plain-text body; fall back to stripping the HTML that would be sent.
  let bodyText = typeof args.body === 'string' && args.body.length > 0
    ? args.body
    : typeof args.htmlBody === 'string'
    ? htmlToText(args.htmlBody)
    : '';
  let truncated = false;
  if (bodyText.length > EMAIL_BODY_PREVIEW_LIMIT) {
    bodyText = bodyText.slice(0, EMAIL_BODY_PREVIEW_LIMIT);
    truncated = true;
  }

  const expiresIn = Math.round((approval.expiresAt.getTime() - Date.now()) / 60000);

  const lines = [
    heading,
    args.account ? `<b>From account:</b> ${escapeHtml(args.account)}` : null,
    to ? `<b>To:</b> ${escapeHtml(to)}` : null,
    cc ? `<b>Cc:</b> ${escapeHtml(cc)}` : null,
    bcc ? `<b>Bcc:</b> ${escapeHtml(bcc)}` : null,
    args.subject ? `<b>Subject:</b> ${escapeHtml(args.subject)}` : null,
    isReply ? `↩︎ <i>Reply</i>` : null,
    `<b>Agent:</b> <code>${escapeHtml(approval.agentId)}</code>`,
    bodyText
      ? `<blockquote>${escapeHtml(bodyText)}${truncated ? '\n…(truncated)' : ''}</blockquote>`
      : null,
    ``,
    `Expires in ~${expiresIn} min`,
  ].filter(Boolean);

  const keyboard = [
    [
      { text: '✅ Approve', callback_data: `ap:${approval.id}:approve` },
      { text: '❌ Deny', callback_data: `ap:${approval.id}:deny` },
    ],
  ];

  return { text: lines.join('\n'), keyboard, parseMode: 'HTML' };
}

const BOT_TOKEN = config.reisTelegramBotToken;
const WEBHOOK_SECRET = config.reisTelegramWebhookSecret;
const WEBHOOK_URL =
  process.env.REINS_TELEGRAM_WEBHOOK_URL ||
  (config.publicUrl ? `${config.publicUrl}/api/webhooks/telegram` : null);

const LINK_CODE_TTL_MS = 10 * 60 * 1000; // 10 minutes
const LINK_CODE_CHARS = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; // unambiguous chars

interface TelegramMessage {
  message_id: number;
  chat: { id: number };
}

interface TelegramUpdate {
  update_id?: number;
  message?: {
    message_id: number;
    from?: { id: number; username?: string };
    chat: { id: number; type: string };
    text?: string;
  };
  callback_query?: {
    id: string;
    from: { id: number; username?: string };
    message?: { message_id: number; chat: { id: number } };
    data?: string;
  };
}

export class TelegramNotifier {
  private botUsername: string | null = null;

  isConfigured(): boolean {
    return !!BOT_TOKEN;
  }

  async init(): Promise<void> {
    if (!this.isConfigured()) return;
    try {
      const me = await this.callApi<{ username: string }>('getMe', {});
      this.botUsername = me.username;
      console.log(`Telegram bot initialized: @${this.botUsername}`);
    } catch (err) {
      console.error('Telegram init failed (bot will be unavailable):', err);
    }
  }

  async setupWebhook(): Promise<void> {
    if (!this.isConfigured()) return;
    if (!WEBHOOK_URL) {
      console.warn('Telegram: no webhook URL configured (set REINS_TELEGRAM_WEBHOOK_URL or REINS_PUBLIC_URL)');
      return;
    }
    try {
      await this.callApi('setWebhook', {
        url: WEBHOOK_URL,
        secret_token: WEBHOOK_SECRET,
        allowed_updates: ['message', 'callback_query'],
      });
      console.log(`Telegram webhook set: ${WEBHOOK_URL}`);
    } catch (err) {
      console.error('Telegram: setWebhook failed:', err);
    }
  }

  async getBotUsername(): Promise<string | null> {
    return this.botUsername;
  }

  // -------------------------------------------------------------------------
  // Approval notifications
  // -------------------------------------------------------------------------

  async notifyApprovalRequest(approval: ApprovalRequest): Promise<void> {
    if (!this.isConfigured()) {
      console.warn(`[telegram] notifyApprovalRequest: bot not configured (REINS_TELEGRAM_BOT_TOKEN missing)`);
      return;
    }

    const owner = await this.getOwner(approval.agentId);
    if (!owner) {
      console.warn(`[telegram] notifyApprovalRequest: no owner found for agent ${approval.agentId} — user may not have linked their Telegram account`);
      return;
    }

    try {
      const magicLinkUrl = approval.tool === 'reauth'
        ? this.buildMagicLinkUrl(owner.userId, approval.id)
        : null;
      const { text, keyboard, parseMode } = this.formatApprovalMessage(approval, magicLinkUrl);
      const sent = await this.sendMessage(owner.chatId, text, {
        parse_mode: parseMode ?? 'Markdown',
        reply_markup: { inline_keyboard: keyboard },
      });

      // Persist telegram_chat_id + telegram_message_id on the approval row
      await client.execute({
        sql: `UPDATE approvals SET telegram_chat_id = ?, telegram_message_id = ? WHERE id = ?`,
        args: [String(sent.chat.id), String(sent.message_id), approval.id],
      });
    } catch (err) {
      console.error(`Telegram: failed to notify approval ${approval.id}:`, err);
    }
  }

  async notifyApprovalResolved(approval: ApprovalRequest): Promise<void> {
    if (!this.isConfigured()) return;
    if (!approval.telegramChatId || !approval.telegramMessageId) return;

    try {
      const text = this.formatResolvedMessage(approval);
      await this.editMessageText(approval.telegramChatId, approval.telegramMessageId, text, {
        parse_mode: 'Markdown',
      });
    } catch (err) {
      // Non-critical — message may have been deleted
      console.error(`Telegram: failed to edit resolved message for approval ${approval.id}:`, err);
    }
  }

  // -------------------------------------------------------------------------
  // Link flow
  // -------------------------------------------------------------------------

  async createLinkCode(userId: string): Promise<{ code: string; url: string }> {
    if (!this.isConfigured()) throw new Error('Telegram bot not configured');

    // Clean up expired codes opportunistically
    await client.execute({
      sql: `DELETE FROM telegram_link_codes WHERE expires_at < ?`,
      args: [new Date().toISOString()],
    });

    // Generate a unique 6-char code
    let code: string;
    let attempts = 0;
    do {
      code = Array.from({ length: 6 }, () =>
        LINK_CODE_CHARS[Math.floor(Math.random() * LINK_CODE_CHARS.length)]
      ).join('');
      attempts++;
      if (attempts > 20) throw new Error('Failed to generate unique link code');
    } while (await this.codeExists(code));

    const now = new Date();
    const expiresAt = new Date(now.getTime() + LINK_CODE_TTL_MS);

    await client.execute({
      sql: `INSERT INTO telegram_link_codes (code, user_id, expires_at, created_at) VALUES (?, ?, ?, ?)`,
      args: [code, userId, expiresAt.toISOString(), now.toISOString()],
    });

    const username = this.botUsername ?? 'reins_notifications_bot';
    return { code, url: `https://t.me/${username}?start=${code}` };
  }

  async redeemLinkCode(code: string, chatId: string): Promise<{ userId: string } | null> {
    const result = await client.execute({
      sql: `SELECT user_id, expires_at FROM telegram_link_codes WHERE code = ?`,
      args: [code],
    });

    if (result.rows.length === 0) return null;
    const row = result.rows[0];

    if (new Date(row.expires_at as string) < new Date()) {
      await client.execute({ sql: `DELETE FROM telegram_link_codes WHERE code = ?`, args: [code] });
      return null;
    }

    const userId = row.user_id as string;

    // Link the chat to the user
    await client.execute({
      sql: `UPDATE users SET telegram_chat_id = ? WHERE id = ?`,
      args: [chatId, userId],
    });

    // Delete used code
    await client.execute({ sql: `DELETE FROM telegram_link_codes WHERE code = ?`, args: [code] });

    return { userId };
  }

  async unlinkUser(userId: string): Promise<void> {
    await client.execute({
      sql: `UPDATE users SET telegram_chat_id = NULL WHERE id = ?`,
      args: [userId],
    });
  }

  // -------------------------------------------------------------------------
  // Webhook dispatch
  // -------------------------------------------------------------------------

  async handleUpdate(update: TelegramUpdate): Promise<void> {
    if (update.message?.text?.startsWith('/start ')) {
      await this.handleStartCommand(update);
    } else if (update.callback_query) {
      await this.handleCallbackQuery(update.callback_query);
    } else if (update.message) {
      await this.handleOnboardingMessage(update.message);
    }
  }

  private async handleOnboardingMessage(
    msg: NonNullable<TelegramUpdate['message']>
  ): Promise<void> {
    const telegramUserId = msg.from?.id;
    if (!telegramUserId) return;

    const chatId = String(msg.chat.id);

    // Check if this user is an onboarding applicant waiting for notify_chat_id
    try {
      const result = await client.execute({
        sql: `SELECT state, notify_chat_id FROM applicants WHERE telegram_user_id = ?`,
        args: [telegramUserId],
      });
      const row = result.rows[0];
      if (!row || row.state !== 'notify_bot' || row.notify_chat_id) return;

      await client.execute({
        sql: `UPDATE applicants SET notify_chat_id = ?, updated_at = NOW() WHERE telegram_user_id = ?`,
        args: [chatId, telegramUserId],
      });
      await this.sendMessage(chatId, `Great. This is where your agent will ask for permissions when it needs a grown-up to review. Go back to @${config.onboardingBotUsername}`, {});
    } catch (err) {
      console.error('[telegram] handleOnboardingMessage error:', err);
    }
  }

  // -------------------------------------------------------------------------
  // Group join confirmation helpers (called by agent-bot-relay via approvals)
  // -------------------------------------------------------------------------

  // -------------------------------------------------------------------------
  // Private helpers
  // -------------------------------------------------------------------------

  private async handleStartCommand(update: TelegramUpdate): Promise<void> {
    const msg = update.message!;
    const chatId = String(msg.chat.id);
    const code = msg.text!.replace('/start ', '').trim();

    if (!code) {
      await this.sendMessage(chatId, 'Send this link from the Reins dashboard to connect your account.', {});
      return;
    }

    const result = await this.redeemLinkCode(code, chatId);
    if (!result) {
      await this.sendMessage(chatId, 'That link has expired or is invalid. Generate a new one from the Reins dashboard.', {});
      return;
    }

    const userResult = await client.execute({
      sql: `SELECT email FROM users WHERE id = ?`,
      args: [result.userId],
    });
    const email = (userResult.rows[0]?.email as string) ?? result.userId;

    await this.sendMessage(chatId, `Connected to Reins as *${email}*.\n\nYou'll now receive approval requests here with inline Approve / Deny buttons.`, {
      parse_mode: 'Markdown',
    });
  }

  private async handleCallbackQuery(
    cb: NonNullable<TelegramUpdate['callback_query']>
  ): Promise<void> {
    const callbackId = cb.id;
    const data = cb.data ?? '';
    const fromChatId = String(cb.from.id);

    // Telegram group behavior: tg:<approvalId>:all|mention|ignore
    const tgMatch = data.match(/^tg:([^:]+):(all|mention|ignore)$/);
    if (tgMatch) {
      const [, approvalId, behavior] = tgMatch;

      // Verify ownership
      const approvalResult = await client.execute({
        sql: `SELECT a.id, ag.user_id, u.telegram_chat_id as owner_chat_id
              FROM approvals a
              JOIN agents ag ON ag.id = a.agent_id
              JOIN users u ON u.id = ag.user_id
              WHERE a.id = ?`,
        args: [approvalId],
      });

      if (approvalResult.rows.length === 0) {
        await this.answerCallbackQuery(callbackId, { text: 'Approval not found.' });
        return;
      }

      const ownerChatId = approvalResult.rows[0].owner_chat_id as string | null;
      if (!ownerChatId || ownerChatId !== fromChatId) {
        await this.answerCallbackQuery(callbackId, { text: 'You are not authorized to configure this agent.' });
        return;
      }

      const { approvalQueue } = await import('../approvals/queue.js');

      if (behavior === 'ignore') {
        await approvalQueue.reject(approvalId, `telegram:${fromChatId}`, 'User chose to ignore this group');
        await this.answerCallbackQuery(callbackId, { text: 'Group ignored.' });
      } else {
        // behavior is 'all' or 'mention' — stored as resolutionComment
        await approvalQueue.approve(approvalId, `telegram:${fromChatId}`, behavior);
        const toast = behavior === 'all' ? 'Bot will respond to all messages' : 'Bot will respond when @mentioned';
        await this.answerCallbackQuery(callbackId, { text: toast });
      }

      // Edit the original message to show the outcome
      if (cb.message) {
        const { approvalQueue: aq } = await import('../approvals/queue.js');
        const updated = await aq.get(approvalId);
        if (updated) {
          const text = this.formatResolvedMessage(updated);
          await this.editMessageText(
            String(cb.message.chat.id),
            String(cb.message.message_id),
            text,
            { parse_mode: 'Markdown' }
          ).catch(() => {});
        }
      }
      return;
    }

    // Expected format: ap:<approvalId>:approve or ap:<approvalId>:deny
    const match = data.match(/^ap:([^:]+):(approve|deny)$/);
    if (!match) {
      await this.answerCallbackQuery(callbackId, { text: 'Unknown action.' });
      return;
    }

    const [, approvalId, action] = match;

    // Load approval + verify ownership
    const approvalResult = await client.execute({
      sql: `SELECT a.*, ag.user_id, u.telegram_chat_id as owner_chat_id
            FROM approvals a
            JOIN agents ag ON ag.id = a.agent_id
            JOIN users u ON u.id = ag.user_id
            WHERE a.id = ?`,
      args: [approvalId],
    });

    if (approvalResult.rows.length === 0) {
      await this.answerCallbackQuery(callbackId, { text: 'Approval not found.' });
      return;
    }

    const row = approvalResult.rows[0];
    const ownerChatId = row.owner_chat_id as string | null;

    // Verify the callback came from the linked user
    if (!ownerChatId || ownerChatId !== fromChatId) {
      await this.answerCallbackQuery(callbackId, { text: 'You are not authorized to resolve this request.' });
      return;
    }

    // Dynamically import to avoid circular dependency
    const { approvalQueue } = await import('../approvals/queue.js');

    let resolved: boolean;
    if (action === 'approve') {
      resolved = await approvalQueue.approve(approvalId, `telegram:${fromChatId}`);
    } else {
      resolved = await approvalQueue.reject(approvalId, `telegram:${fromChatId}`, 'Denied via Telegram');
    }

    if (!resolved) {
      // Already handled by another surface
      const currentApproval = await approvalQueue.get(approvalId);
      if (currentApproval && cb.message) {
        const text = this.formatResolvedMessage(currentApproval);
        await this.editMessageText(
          String(cb.message.chat.id),
          String(cb.message.message_id),
          text,
          { parse_mode: 'Markdown' }
        );
      }
      await this.answerCallbackQuery(callbackId, { text: 'Already handled.' });
      return;
    }

    // Edit message to show outcome
    if (cb.message) {
      const currentApproval = await approvalQueue.get(approvalId);
      if (currentApproval) {
        const text = this.formatResolvedMessage(currentApproval);
        await this.editMessageText(
          String(cb.message.chat.id),
          String(cb.message.message_id),
          text,
          { parse_mode: 'Markdown' }
        );
      }
    }

    const toast = action === 'approve' ? 'Approved' : 'Denied';
    await this.answerCallbackQuery(callbackId, { text: toast });
  }

  private formatApprovalMessage(approval: ApprovalRequest, magicLinkUrl: string | null): {
    text: string;
    keyboard: Array<Array<{ text: string; callback_data?: string; url?: string }>>;
    parseMode?: 'Markdown' | 'HTML';
  } {
    if (approval.tool === 'reauth') {
      return this.formatReauthMessage(approval, magicLinkUrl);
    }

    if (approval.tool === 'telegram_group') {
      return this.formatGroupApprovalMessage(approval);
    }

    if (EMAIL_TOOLS.has(approval.tool)) {
      return formatEmailApprovalMessage(approval);
    }

    const argsPreview = JSON.stringify(approval.arguments);
    const truncated = argsPreview.length > 200 ? argsPreview.slice(0, 197) + '...' : argsPreview;
    const expiresIn = Math.round((approval.expiresAt.getTime() - Date.now()) / 60000);

    const text = [
      `*Approval Required*`,
      ``,
      `*Tool:* \`${approval.tool}\``,
      `*Agent:* \`${approval.agentId}\``,
      `*Args:* \`${truncated}\``,
      approval.context ? `*Context:* ${approval.context}` : null,
      ``,
      `Expires in ~${expiresIn} min`,
    ]
      .filter(Boolean)
      .join('\n');

    const keyboard = [
      [
        { text: '✅ Approve', callback_data: `ap:${approval.id}:approve` },
        { text: '❌ Deny', callback_data: `ap:${approval.id}:deny` },
      ],
    ];

    return { text, keyboard };
  }

  private formatGroupApprovalMessage(approval: ApprovalRequest): {
    text: string;
    keyboard: Array<Array<{ text: string; callback_data: string }>>;
  } {
    const { chatTitle, chatType, addedBy } = approval.arguments as {
      chatTitle?: string;
      chatType?: string;
      addedBy?: string;
    };

    const groupLabel = chatType === 'supergroup' ? 'supergroup' : 'group';
    const title = chatTitle ?? 'Unknown group';

    const text = [
      `📋 *Group Configuration*`,
      ``,
      `Your bot was added to the ${groupLabel} *"${title}"*`,
      addedBy ? `*Added by:* ${addedBy}` : null,
      `*Agent:* \`${approval.agentId}\``,
      ``,
      `How should the bot behave in this group?`,
    ]
      .filter(Boolean)
      .join('\n');

    const keyboard = [
      [
        { text: '💬 All messages', callback_data: `tg:${approval.id}:all` },
        { text: '@Mention only', callback_data: `tg:${approval.id}:mention` },
      ],
      [
        { text: '🚫 Ignore group', callback_data: `tg:${approval.id}:ignore` },
      ],
    ];

    return { text, keyboard };
  }

  private formatReauthMessage(approval: ApprovalRequest, magicLinkUrl: string | null): {
    text: string;
    keyboard: Array<Array<{ text: string; url: string }>>;
  } {
    const provider = (approval.arguments.provider as string) ?? 'unknown';
    const providerLabel = PROVIDER_LABELS[provider] ?? provider;
    const source = approval.arguments.source as string | undefined;
    const renewalUrl = PROVIDER_KEY_RENEWAL_URL[provider];

    const sourceNote = source === 'mcp_tool_call'
      ? 'Credentials expired during a tool call'
      : source === 'token_monitor' || source === 'health_monitor'
      ? 'Token expired — agent unable to start'
      : source === 'minimax_monitor'
      ? 'API key is invalid or expired'
      : 'Credentials required';

    const text = [
      `🔑 *Re-authentication Required*`,
      ``,
      `*Service:* ${providerLabel}`,
      `*Agent:* \`${approval.agentId}\``,
      `*Reason:* ${sourceNote}`,
      approval.context ? `\n${approval.context}` : null,
      renewalUrl ? null : `\nLink expires in 24h`,
    ]
      .filter(Boolean)
      .join('\n');

    const dashboardUrl = config.dashboardUrl;
    const keyboard: Array<Array<{ text: string; url: string }>> = renewalUrl
      ? [
          [{ text: '🔑 Get new API key', url: renewalUrl }],
          [{ text: '⚙️ Update in dashboard', url: magicLinkUrl ?? `${dashboardUrl}/approvals?id=${approval.id}` }],
        ]
      : [
          [{ text: '🔑 Re-authenticate', url: magicLinkUrl ?? `${dashboardUrl}/approvals?id=${approval.id}` }],
        ];

    return { text, keyboard };
  }

  private formatResolvedMessage(approval: ApprovalRequest): string {
    const time = approval.resolvedAt
      ? approval.resolvedAt.toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit' })
      : '';

    if (approval.tool === 'reauth') {
      if (approval.status === 'approved') {
        return `🔑 *Re-authenticated* — ${approval.resolvedBy ?? 'user'} connected the service at ${time}`;
      } else if (approval.status === 'rejected') {
        return `❌ *Re-authentication skipped* at ${time}`;
      } else {
        return `⏱ *Re-authentication expired* — link timed out`;
      }
    }

    if (approval.tool === 'telegram_group') {
      const { chatTitle } = approval.arguments as { chatTitle?: string };
      const title = chatTitle ? `"${chatTitle}"` : 'the group';
      if (approval.status === 'approved') {
        const behavior = approval.resolutionComment;
        if (behavior === 'all') {
          return `✅ *Bot will respond to all messages* in ${title}`;
        } else {
          return `✅ *Bot will respond only when @mentioned* in ${title}`;
        }
      } else if (approval.status === 'rejected') {
        return `🚫 *Group ignored* — bot will not respond in ${title}`;
      } else {
        return `⏱ *Group configuration expired* for ${title}`;
      }
    }

    if (approval.status === 'approved') {
      return `✅ *Approved* by ${approval.resolvedBy ?? 'unknown'} at ${time}`;
    } else if (approval.status === 'rejected') {
      const reason = approval.resolutionComment ? `: ${approval.resolutionComment}` : '';
      return `❌ *Denied* by ${approval.resolvedBy ?? 'unknown'} at ${time}${reason}`;
    } else {
      return `⏱ *Expired* — approval request timed out`;
    }
  }

  // -------------------------------------------------------------------------
  // Broadcast
  // -------------------------------------------------------------------------

  async broadcast(message: string, parseMode?: 'Markdown' | 'HTML'): Promise<{
    sent: number;
    failed: number;
    skipped: number;
    errors: Array<{ chatId: string; email: string; error: string }>;
  }> {
    const result = await client.execute(
      `SELECT id, email, telegram_chat_id FROM users WHERE status = 'active' AND telegram_chat_id IS NOT NULL`
    );

    let sent = 0;
    let failed = 0;
    let skipped = 0;
    const errors: Array<{ chatId: string; email: string; error: string }> = [];

    for (const row of result.rows) {
      const chatId = row.telegram_chat_id as string | null;
      const email = row.email as string;

      if (!chatId) { skipped++; continue; }

      try {
        await this.sendMessage(chatId, message, parseMode ? { parse_mode: parseMode } : {});
        sent++;
      } catch (err) {
        failed++;
        errors.push({ chatId, email, error: err instanceof Error ? err.message : String(err) });
        console.error(`[broadcast] failed to send to ${email} (${chatId}):`, err);
      }
    }

    console.log(`[broadcast] done: ${sent} sent, ${failed} failed, ${skipped} skipped`);
    return { sent, failed, skipped, errors };
  }

  private async getOwner(agentId: string): Promise<{ chatId: string; userId: string } | null> {
    const result = await client.execute({
      sql: `SELECT u.telegram_chat_id, u.id as user_id FROM users u JOIN agents a ON a.user_id = u.id WHERE a.id = ?`,
      args: [agentId],
    });
    if (result.rows.length === 0) {
      console.warn(`[telegram] getOwner: no user found for agent ${agentId}`);
      return null;
    }
    const row = result.rows[0];
    const chatId = row.telegram_chat_id as string | null;
    if (!chatId) {
      console.warn(`[telegram] getOwner: user ${row.user_id} has no telegram_chat_id — they need to link their account via Settings → Connect Telegram`);
      return null;
    }
    return { chatId, userId: row.user_id as string };
  }

  private buildMagicLinkUrl(userId: string, approvalId: string): string {
    const token = createMagicLinkToken(userId, approvalId);
    const dashboardUrl = config.dashboardUrl;
    return `${dashboardUrl}/api/auth/magic?t=${token}`;
  }

  private async codeExists(code: string): Promise<boolean> {
    const result = await client.execute({
      sql: `SELECT 1 FROM telegram_link_codes WHERE code = ? AND expires_at > ?`,
      args: [code, new Date().toISOString()],
    });
    return result.rows.length > 0;
  }

  private async sendMessage(
    chatId: string,
    text: string,
    opts: Record<string, unknown>
  ): Promise<TelegramMessage> {
    return this.callApi<TelegramMessage>('sendMessage', { chat_id: chatId, text, ...opts });
  }

  private async editMessageText(
    chatId: string,
    messageId: string,
    text: string,
    opts: Record<string, unknown>
  ): Promise<void> {
    await this.callApi('editMessageText', {
      chat_id: chatId,
      message_id: Number(messageId),
      text,
      reply_markup: { inline_keyboard: [] },
      ...opts,
    });
  }

  private async answerCallbackQuery(
    callbackQueryId: string,
    opts: { text?: string; show_alert?: boolean }
  ): Promise<void> {
    await this.callApi('answerCallbackQuery', { callback_query_id: callbackQueryId, ...opts });
  }

  private async callApi<T = unknown>(method: string, body: Record<string, unknown>): Promise<T> {
    if (!BOT_TOKEN) throw new Error('Telegram bot not configured');

    const res = await fetch(`https://api.telegram.org/bot${BOT_TOKEN}/${method}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });

    const data = (await res.json()) as { ok: boolean; result?: T; description?: string };
    if (!data.ok) {
      throw new Error(`Telegram API error (${method}): ${data.description}`);
    }
    return data.result as T;
  }
}

export const telegramNotifier = new TelegramNotifier();
