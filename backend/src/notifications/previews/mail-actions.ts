/**
 * Previews for the tools that act on existing emails by id: archive, mark
 * read, label, move, delete. Each email is shown by subject, sender and date,
 * and each label or folder by name.
 */
import type { ApprovalRequest } from '@reins/shared';
import { PREVIEW_ITEM_LIMIT, registerPreview, type ApprovalPreview, type PreviewItem } from '../approval-preview.js';
import { argsOf, bearer, fetchJson, plural, shortDate, str, strList, tokenFor } from './shared.js';

const GMAIL_API = 'https://gmail.googleapis.com/gmail/v1/users/me';
const GRAPH_API = 'https://graph.microsoft.com/v1.0';

const GMAIL_SYSTEM_LABELS: Record<string, string> = {
  INBOX: 'Inbox',
  UNREAD: 'Unread',
  STARRED: 'Starred',
  IMPORTANT: 'Important',
  SPAM: 'Spam',
  TRASH: 'Trash',
  SENT: 'Sent',
  DRAFT: 'Drafts',
  CATEGORY_PERSONAL: 'Primary',
  CATEGORY_SOCIAL: 'Social',
  CATEGORY_PROMOTIONS: 'Promotions',
  CATEGORY_UPDATES: 'Updates',
  CATEGORY_FORUMS: 'Forums',
};

const OUTLOOK_FOLDERS: Record<string, string> = {
  inbox: 'Inbox',
  drafts: 'Drafts',
  sentitems: 'Sent Items',
  deleteditems: 'Deleted Items',
  junkemail: 'Junk Email',
  archive: 'Archive',
};

function messageIds(approval: ApprovalRequest): string[] {
  const args = argsOf(approval);
  const many = strList(args.messageIds);
  if (many.length > 0) return many;
  const one = str(args.messageId);
  return one ? [one] : [];
}

const describe = (subject: string | undefined, from: string | undefined, date: string | undefined): PreviewItem => ({
  title: subject || '(no subject)',
  detail: [from, shortDate(date)].filter(Boolean).join(' · ') || undefined,
});

const unloaded = (id: string): PreviewItem => ({ title: 'Could not load this email', detail: id });

async function gmailItems(token: string | null, ids: string[]): Promise<PreviewItem[]> {
  return Promise.all(
    ids.map(async (id) => {
      if (!token) return unloaded(id);
      const message = await fetchJson<{ payload?: { headers?: Array<{ name: string; value: string }> } }>(
        `${GMAIL_API}/messages/${encodeURIComponent(id)}?format=metadata` +
          `&metadataHeaders=From&metadataHeaders=Subject&metadataHeaders=Date`,
        { headers: bearer(token) }
      );
      if (!message) return unloaded(id);
      const header = (name: string) =>
        message.payload?.headers?.find((h) => h.name.toLowerCase() === name)?.value;
      return describe(header('subject'), header('from'), header('date'));
    })
  );
}

async function gmailLabelNames(token: string | null, ids: string[]): Promise<string[]> {
  const custom = ids.some((id) => !(id in GMAIL_SYSTEM_LABELS));
  const listed =
    custom && token
      ? await fetchJson<{ labels?: Array<{ id: string; name: string }> }>(`${GMAIL_API}/labels`, {
          headers: bearer(token),
        })
      : null;
  const names = new Map((listed?.labels ?? []).map((label) => [label.id, label.name]));
  // An id that resolves to nothing is shown as given, never dropped.
  return ids.map((id) => GMAIL_SYSTEM_LABELS[id] ?? names.get(id) ?? id);
}

async function outlookItems(token: string | null, ids: string[]): Promise<PreviewItem[]> {
  return Promise.all(
    ids.map(async (id) => {
      if (!token) return unloaded(id);
      const message = await fetchJson<{
        subject?: string;
        from?: { emailAddress?: { name?: string; address?: string } };
        receivedDateTime?: string;
      }>(`${GRAPH_API}/me/messages/${encodeURIComponent(id)}?$select=subject,from,receivedDateTime`, {
        headers: bearer(token),
      });
      if (!message) return unloaded(id);
      const { name, address } = message.from?.emailAddress ?? {};
      const from = name && address && name !== address ? `${name} <${address}>` : address ?? name;
      return describe(message.subject, from, message.receivedDateTime);
    })
  );
}

async function buildMailActionPreview(approval: ApprovalRequest): Promise<ApprovalPreview | null> {
  const args = argsOf(approval);
  const ids = messageIds(approval);
  if (ids.length === 0) return null;

  const outlook = approval.tool.startsWith('outlook_mail_');
  const token = await tokenFor(approval, outlook ? 'outlook_mail' : 'gmail');
  const shown = ids.slice(0, PREVIEW_ITEM_LIMIT);
  const list = outlook ? await outlookItems(token, shown) : await gmailItems(token, shown);
  const emails = plural(ids.length, 'email');
  const anEmail = ids.length === 1 ? 'email' : emails;

  const preview: ApprovalPreview = {
    icon: '📧',
    heading: `Change ${anEmail}`,
    rows: [],
    items: { label: ids.length === 1 ? 'Email' : 'Emails', list, more: ids.length - shown.length },
    warning: list.every((item) => item.title === 'Could not load this email')
      ? `Could not load ${ids.length === 1 ? 'this email' : 'these emails'}. Approve only if you recognise ${ids.length === 1 ? 'it' : 'them'}.`
      : undefined,
  };
  if (str(args.account)) preview.rows.push({ label: 'Account', value: str(args.account)! });

  switch (approval.tool) {
    case 'gmail_archive':
      preview.icon = '🗄';
      preview.heading = `Archive ${anEmail}`;
      preview.note = 'Removed from the inbox. Nothing is deleted.';
      break;
    case 'gmail_mark_read':
      preview.icon = '✉️';
      preview.heading = `Mark ${anEmail} as ${args.unread === true ? 'unread' : 'read'}`;
      break;
    case 'gmail_label_message': {
      const [label] = await gmailLabelNames(token, [str(args.labelId) ?? '']);
      preview.icon = '🏷';
      preview.heading = `Label ${anEmail}`;
      preview.rows.push({ label: 'Label', value: label || '(none given)' });
      break;
    }
    case 'gmail_modify_labels': {
      const add = strList(args.addLabelIds);
      const remove = strList(args.removeLabelIds);
      const names = await gmailLabelNames(token, [...add, ...remove]);
      preview.icon = '🏷';
      preview.heading = `Change labels on ${anEmail}`;
      if (add.length > 0) preview.rows.push({ label: 'Add', value: names.slice(0, add.length).join(', ') });
      if (remove.length > 0) preview.rows.push({ label: 'Remove', value: names.slice(add.length).join(', ') });
      if (add.includes('TRASH')) preview.note = 'Moves to Trash, where Gmail deletes it after 30 days.';
      break;
    }
    case 'gmail_delete_message':
      preview.icon = '🗑';
      preview.heading = 'Delete email permanently';
      preview.note = 'This skips the Trash and cannot be undone.';
      preview.destructive = true;
      break;
    case 'outlook_mail_delete_message':
      preview.icon = '🗑';
      preview.heading = 'Delete email';
      preview.note = 'Removes the email from its folder.';
      preview.destructive = true;
      break;
    case 'outlook_mail_move_message': {
      const destination = str(args.destinationFolder) ?? '';
      const known = OUTLOOK_FOLDERS[destination.toLowerCase()];
      const folder =
        known ??
        (token && destination
          ? (
              await fetchJson<{ displayName?: string }>(
                `${GRAPH_API}/me/mailFolders/${encodeURIComponent(destination)}?$select=displayName`,
                { headers: bearer(token) }
              )
            )?.displayName
          : undefined);
      preview.icon = '📂';
      preview.heading = 'Move email';
      preview.rows.push({ label: 'To folder', value: folder ?? (destination || '(none given)') });
      if (!folder && destination) preview.warning ??= 'Could not load the destination folder; its id is shown.';
      break;
    }
    default:
      return null;
  }

  return preview;
}

registerPreview(
  [
    'gmail_archive',
    'gmail_mark_read',
    'gmail_label_message',
    'gmail_modify_labels',
    'gmail_delete_message',
    'outlook_mail_delete_message',
    'outlook_mail_move_message',
  ],
  buildMailActionPreview
);
