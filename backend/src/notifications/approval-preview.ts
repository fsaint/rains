/**
 * A resolved preview of what an approval would do, for the tools that have no
 * formatter of their own in ./approval-format.ts.
 *
 * Those tools used to reach the owner as the tool name plus the first 200
 * characters of the argument JSON — usually an opaque id. A builder in
 * ./previews/ looks up what the id names and returns an ApprovalPreview; the
 * Telegram message and the dashboard card are both rendered from it.
 *
 * A builder never throws and never blocks an approval: what cannot be looked
 * up is shown as it was given, under a warning.
 */
import type { ApprovalRequest } from '@reins/shared';
import { approveDenyKeyboard, escapeHtml, type FormattedApproval } from './approval-format.js';

export interface PreviewRow {
  label: string;
  value: string;
  /** The value being replaced, when the approval changes this field. */
  was?: string;
}

export interface PreviewItem {
  title: string;
  detail?: string;
}

export interface ApprovalPreview {
  /** Emoji that leads the Telegram heading. */
  icon: string;
  /** What is being decided, in words: "Archive 3 emails". */
  heading: string;
  /** One line on the consequence: "Nothing is deleted." */
  note?: string;
  /** Permanent or outward-facing: rendered as a warning. */
  destructive?: boolean;
  /** Something could not be looked up, so the preview is incomplete. */
  warning?: string;
  rows: PreviewRow[];
  /** The things acted on, when there are several (or one worth a line of its own). */
  items?: { label: string; list: PreviewItem[]; more: number };
  /** Free text being written: a comment, a description, file content. */
  body?: { label?: string; text: string };
}

/** At most this many items are resolved and listed individually. */
export const PREVIEW_ITEM_LIMIT = 10;
/** Telegram caps a message at 4096 characters; the body gets what the rest leaves. */
const PREVIEW_BODY_LIMIT = 2500;
const PREVIEW_VALUE_LIMIT = 300;

const clip = (text: string, limit: number): string =>
  text.length > limit ? `${text.slice(0, limit)}…` : text;

/** Render a resolved preview as a Telegram approval message. */
export function formatPreviewApprovalMessage(
  approval: ApprovalRequest,
  preview: ApprovalPreview
): FormattedApproval {
  const expiresIn = Math.round((approval.expiresAt.getTime() - Date.now()) / 60000);
  const value = (text: string) => escapeHtml(clip(text, PREVIEW_VALUE_LIMIT));

  const lines = [
    `${preview.icon} <b>${escapeHtml(preview.heading)}</b>`,
    preview.note
      ? preview.destructive
        ? `⚠️ <b>${escapeHtml(preview.note)}</b>`
        : `<i>${escapeHtml(preview.note)}</i>`
      : null,
    preview.warning ? `⚠️ <b>${escapeHtml(preview.warning)}</b>` : null,
    ...preview.rows.map(
      (row) =>
        `<b>${escapeHtml(row.label)}:</b> ` +
        (row.was !== undefined ? `<s>${value(row.was || '(empty)')}</s> → ` : '') +
        value(row.value)
    ),
    ...(preview.items
      ? [
          `<b>${escapeHtml(preview.items.label)}:</b>`,
          ...preview.items.list.map(
            (item) => `• ${value(item.title)}` + (item.detail ? ` — <i>${value(item.detail)}</i>` : '')
          ),
          preview.items.more > 0 ? `…and ${preview.items.more} more` : null,
        ]
      : []),
    `<b>Agent:</b> <code>${escapeHtml(approval.agentId)}</code>`,
    approval.context ? `<b>Context:</b> ${value(approval.context)}` : null,
    preview.body?.label ? `<b>${escapeHtml(preview.body.label)}:</b>` : null,
    preview.body
      ? `<blockquote>${escapeHtml(preview.body.text.slice(0, PREVIEW_BODY_LIMIT))}` +
        (preview.body.text.length > PREVIEW_BODY_LIMIT
          ? `\n…(${preview.body.text.length - PREVIEW_BODY_LIMIT} more characters)`
          : '') +
        `</blockquote>`
      : null,
    ``,
    `Expires in ~${expiresIn} min`,
  ].filter((line) => line !== null);

  return { text: lines.join('\n'), keyboard: approveDenyKeyboard(approval.id), parseMode: 'HTML' };
}

type PreviewBuilder = (approval: ApprovalRequest) => Promise<ApprovalPreview | null>;

const builders = new Map<string, PreviewBuilder>();

/** Register one builder for a set of tools. Called by each module in ./previews/. */
export function registerPreview(tools: readonly string[], build: PreviewBuilder): void {
  for (const tool of tools) builders.set(tool, build);
}

export function hasApprovalPreview(tool: string): boolean {
  return builders.has(tool);
}

/** The preview for an approval, or null for a tool with no builder (or a builder that failed). */
export async function resolveApprovalPreview(approval: ApprovalRequest): Promise<ApprovalPreview | null> {
  const build = builders.get(approval.tool);
  if (!build) return null;
  try {
    return await build(approval);
  } catch (err) {
    console.warn(`[approval-preview] ${approval.tool} preview failed:`, err);
    return null;
  }
}

/**
 * A preview made from an already-formatted approval message, for the tools
 * whose Telegram formatter is the only description of them (Helm Admin, skill
 * authoring, threads, Hermeneutix, draft deletes). The dashboard then shows the
 * same words Telegram does instead of the raw arguments.
 */
export function previewFromMessageText(html: string): ApprovalPreview | null {
  const text = (fragment: string) =>
    fragment
      .replace(/<[^>]+>/g, '')
      .replace(/&lt;/g, '<')
      .replace(/&gt;/g, '>')
      .replace(/&amp;/g, '&');

  const lines = html.split('\n').filter((line) => !/^✏️ Revision \d+ of \d+$/.test(line));
  const first = text(lines.shift() ?? '').trim();
  if (!first) return null;

  // "🗑 Delete agent" → icon and heading; a heading with no emoji keeps none.
  const split = /^([^\p{L}\p{N}]+)\s+(.+)$/u.exec(first);
  const body = lines
    .filter((line) => !line.startsWith('<b>Agent:</b>') && !/^Expires in ~/.test(line))
    .map(text)
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();

  return {
    icon: split ? split[1].trim() : '',
    heading: split ? split[2] : first,
    rows: [],
    body: body ? { text: body } : undefined,
  };
}
