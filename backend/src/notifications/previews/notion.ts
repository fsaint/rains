/**
 * Previews for Notion writes. A page is shown by its title and database, and
 * each property being written as plain text beside what it replaces.
 */
import type { ApprovalRequest } from '@reins/shared';
import { registerPreview, type ApprovalPreview, type PreviewRow } from '../approval-preview.js';
import { argsOf, fetchJson, plural, shortDate, str, tokenFor } from './shared.js';

const NOTION_API = 'https://api.notion.com/v1';
const NOTION_VERSION = '2022-06-28';

type Json = Record<string, unknown>;
const obj = (v: unknown): Json | undefined => (v && typeof v === 'object' && !Array.isArray(v) ? (v as Json) : undefined);
const richText = (v: unknown): string =>
  Array.isArray(v)
    ? v.map((part) => str(obj(part)?.plain_text) ?? str(obj(obj(part)?.text)?.content) ?? '').join('')
    : '';

/**
 * A Notion property value as text. The same shapes come back from the API and
 * go in as arguments, so one reader serves both sides of a change.
 */
export function notionValue(property: unknown): string {
  const p = obj(property);
  if (!p) return typeof property === 'string' || typeof property === 'number' ? String(property) : '';
  const named = (v: unknown) => str(obj(v)?.name) ?? '';
  if ('title' in p) return richText(p.title);
  if ('rich_text' in p) return richText(p.rich_text);
  if ('select' in p) return named(p.select);
  if ('status' in p) return named(p.status);
  if ('multi_select' in p) return Array.isArray(p.multi_select) ? p.multi_select.map(named).join(', ') : '';
  if ('number' in p) return p.number === null || p.number === undefined ? '' : String(p.number);
  if ('checkbox' in p) return p.checkbox ? 'Yes' : 'No';
  if ('url' in p) return str(p.url) ?? '';
  if ('email' in p) return str(p.email) ?? '';
  if ('phone_number' in p) return str(p.phone_number) ?? '';
  if ('date' in p) {
    const date = obj(p.date);
    if (!date) return '';
    const day = (v: unknown) => (str(v) && str(v)!.length <= 10 ? shortDate(str(v)) ?? str(v) : str(v));
    return [day(date.start), day(date.end)].filter(Boolean).join(' → ');
  }
  if ('people' in p) {
    return Array.isArray(p.people)
      ? p.people.map((person) => named(person) || str(obj(person)?.id) || '').join(', ')
      : '';
  }
  if ('relation' in p) return Array.isArray(p.relation) ? plural(p.relation.length, 'linked page') : '';
  return JSON.stringify(property);
}

const headers = (token: string) => ({ Authorization: `Bearer ${token}`, 'Notion-Version': NOTION_VERSION });

function pageTitle(page: Json | null): string | undefined {
  const properties = obj(page?.properties) ?? {};
  const title = Object.values(properties).find((property) => obj(property)?.type === 'title');
  return title ? notionValue(title) || undefined : undefined;
}

async function databaseName(token: string | null, id: string | undefined): Promise<string | undefined> {
  if (!token || !id) return undefined;
  const database = await fetchJson<Json>(`${NOTION_API}/databases/${encodeURIComponent(id)}`, {
    headers: headers(token),
  });
  return database ? richText(database.title) || undefined : undefined;
}

async function buildNotionPreview(approval: ApprovalRequest): Promise<ApprovalPreview | null> {
  const args = argsOf(approval);
  const token = await tokenFor(approval, 'notion');
  const properties = obj(args.properties) ?? {};

  if (approval.tool === 'notion_create_page') {
    const databaseId = str(args.databaseId);
    const blocks = Array.isArray(args.children) ? args.children.length : 0;
    const rows: PreviewRow[] = [
      { label: 'Database', value: (await databaseName(token, databaseId)) ?? databaseId ?? '(none given)' },
      ...Object.entries(properties).map(([name, value]) => ({ label: name, value: notionValue(value) || '(empty)' })),
    ];
    if (blocks > 0) rows.push({ label: 'Page content', value: plural(blocks, 'block') });
    return { icon: '📝', heading: 'Create Notion page', rows };
  }

  const pageId = str(args.pageId);
  if (!pageId) return null;
  const page = token
    ? await fetchJson<Json>(`${NOTION_API}/pages/${encodeURIComponent(pageId)}`, { headers: headers(token) })
    : null;
  const existing = obj(page?.properties) ?? {};
  const database = await databaseName(token, str(obj(page?.parent)?.database_id));

  const rows: PreviewRow[] = [{ label: 'Page', value: pageTitle(page) ?? pageId }];
  if (database) rows.push({ label: 'Database', value: database });
  const warning = page ? undefined : 'Could not load this page. Approve only if you recognise its id.';

  if (approval.tool === 'notion_archive_page') {
    return {
      icon: '🗑',
      heading: 'Archive Notion page',
      note: "The page moves to Notion's trash, where it can be restored for 30 days.",
      rows,
      warning,
    };
  }

  let changed = 0;
  for (const [name, value] of Object.entries(properties)) {
    const next = notionValue(value) || '(empty)';
    if (!page) {
      rows.push({ label: name, value: next });
      continue;
    }
    const was = notionValue(existing[name]) || '(empty)';
    if (next !== was) {
      rows.push({ label: name, value: next, was });
      changed++;
    }
  }

  return {
    icon: '✏️',
    heading: 'Update Notion page',
    note: page && changed === 0 ? 'Nothing shown here changes.' : undefined,
    rows,
    warning,
  };
}

registerPreview(['notion_create_page', 'notion_update_page', 'notion_archive_page'], buildNotionPreview);
