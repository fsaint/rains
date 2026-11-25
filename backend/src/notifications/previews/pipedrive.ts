/**
 * Previews for Pipedrive writes — about fifty tools, handled by one builder.
 *
 * Every tool is "<verb> a <record>", named in its arguments by numeric ids. The
 * record is read and shown by name; each other id in the arguments (person,
 * organization, stage, owner…) is shown by name too; and an update shows each
 * field beside the value it replaces.
 */
import type { ApprovalRequest } from '@reins/shared';
import { registerPreview, type ApprovalPreview, type PreviewRow } from '../approval-preview.js';
import { argsOf, connectionFor, fetchJson, humanize, idOf, plain, str, type Args } from './shared.js';

/** A record type: where it is read from and which field names it. */
interface RecordType {
  label: string;
  path: string;
  nameField: string;
}

const TYPES: Record<string, RecordType> = {
  deal: { label: 'deal', path: 'deals', nameField: 'title' },
  person: { label: 'person', path: 'persons', nameField: 'name' },
  organization: { label: 'organization', path: 'organizations', nameField: 'name' },
  lead: { label: 'lead', path: 'leads', nameField: 'title' },
  activity: { label: 'activity', path: 'activities', nameField: 'subject' },
  note: { label: 'note', path: 'notes', nameField: 'content' },
  pipeline: { label: 'pipeline', path: 'pipelines', nameField: 'name' },
  stage: { label: 'stage', path: 'stages', nameField: 'name' },
  product: { label: 'product', path: 'products', nameField: 'name' },
  project: { label: 'project', path: 'projects', nameField: 'title' },
  task: { label: 'task', path: 'tasks', nameField: 'title' },
  filter: { label: 'filter', path: 'filters', nameField: 'name' },
  file: { label: 'file', path: 'files', nameField: 'name' },
  user: { label: 'user', path: 'users', nameField: 'name' },
};

/** Argument keys that hold another record's id, and the type they point at. */
const REFERENCES: Record<string, string> = {
  deal_id: 'deal',
  person_id: 'person',
  org_id: 'organization',
  lead_id: 'lead',
  activity_id: 'activity',
  note_id: 'note',
  pipeline_id: 'pipeline',
  stage_id: 'stage',
  product_id: 'product',
  project_id: 'project',
  task_id: 'task',
  filter_id: 'filter',
  file_id: 'file',
  owner_id: 'user',
  user_id: 'user',
  assignee_id: 'user',
};

/** The record each tool acts on: its type and the argument holding its id. */
const SUBJECTS: Record<string, [type: string, idKey: string]> = {
  organization: ['organization', 'org_id'],
  org_relationship: ['organization relationship', 'relationship_id'],
  deal_participant: ['deal', 'deal_id'],
  deal_product: ['deal', 'deal_id'],
  goal: ['goal', 'goal_id'],
  webhook: ['webhook', 'webhook_id'],
};

/** Free-text fields shown in full below the rows rather than on one line. */
const BODY_FIELDS = ['content', 'note', 'description', 'public_description'];

const VERBS: Record<string, string> = { create: 'Create', update: 'Update', delete: 'Delete', add: 'Add to', convert: 'Convert' };

type Json = Record<string, unknown>;

function htmlToPlain(text: string): string {
  return text.replace(/<\s*br\s*\/?>/gi, '\n').replace(/<[^>]+>/g, '').trim();
}

/** A field of a Pipedrive record as text. Linked records come back as objects. */
function recordValue(value: unknown): string {
  if (value && typeof value === 'object' && !Array.isArray(value)) {
    const linked = value as Json;
    return plain(linked.name ?? linked.title ?? linked.value ?? '');
  }
  // Emails and phones are lists of { value, primary }.
  if (Array.isArray(value)) return value.map(recordValue).filter(Boolean).join(', ');
  return plain(value);
}

async function buildPipedrivePreview(approval: ApprovalRequest): Promise<ApprovalPreview | null> {
  const match = /^pipedrive_(create|update|delete|add|convert)_(.+)$/.exec(approval.tool);
  if (!match) return null;
  const [, verb, noun] = match;
  const args = argsOf(approval);

  const connection = await connectionFor(approval, 'pipedrive');
  const domain = str(connection?.data.companydomain);
  // The domain becomes part of the host name, so it must be a bare label.
  const usable = connection && domain && /^[a-z0-9-]+$/i.test(domain);
  const cache = new Map<string, Promise<Json | null>>();
  const read = (type: string, id: string): Promise<Json | null> => {
    const spec = TYPES[type];
    if (!usable || !spec) return Promise.resolve(null);
    const key = `${type}:${id}`;
    if (!cache.has(key)) {
      cache.set(
        key,
        fetchJson<{ data?: Json }>(
          `https://${domain}.pipedrive.com/api/v1/${spec.path}/${encodeURIComponent(id)}`,
          { headers: { 'x-api-token': connection.token } }
        ).then((response) => response?.data ?? null)
      );
    }
    return cache.get(key)!;
  };
  const nameOf = async (type: string, id: string): Promise<string | undefined> => {
    const record = await read(type, id);
    const name = record ? recordValue(record[TYPES[type].nameField]) : '';
    return name ? htmlToPlain(name).slice(0, 120) : undefined;
  };

  const [subjectType, subjectKey] = SUBJECTS[noun] ?? [noun, `${noun}_id`];
  const subjectId = verb === 'create' ? undefined : idOf(args[subjectKey]);
  const subject = subjectId && TYPES[subjectType] ? await read(subjectType, subjectId) : null;
  const subjectName = subjectId && TYPES[subjectType] ? await nameOf(subjectType, subjectId) : undefined;
  const label = TYPES[subjectType]?.label ?? subjectType;
  const thing = noun.replace(/_/g, ' ');

  const rows: PreviewRow[] = [];
  if (subjectId) {
    rows.push({ label: humanize(label), value: subjectName ?? `#${subjectId}` });
  }

  let body: ApprovalPreview['body'];
  const fields: Args = { ...args, ...((args.custom_fields && typeof args.custom_fields === 'object' ? args.custom_fields : {}) as Args) };
  delete fields.custom_fields;
  delete fields.account;

  for (const [key, raw] of Object.entries(fields)) {
    if (key === subjectKey && verb !== 'create') continue;
    if (raw === undefined || raw === null || raw === '') continue;

    if (BODY_FIELDS.includes(key) && typeof raw === 'string' && !body) {
      body = { label: verb === 'update' ? `New ${humanize(key).toLowerCase()}` : humanize(key), text: htmlToPlain(raw) };
      continue;
    }

    const refType = REFERENCES[key];
    const id = idOf(raw);
    const value = refType && id ? (await nameOf(refType, id)) ?? `#${id}` : plain(raw);
    const rowLabel = refType ? humanize(TYPES[refType].label === 'user' ? key.replace(/_id$/, '') : TYPES[refType].label) : humanize(key);

    // An update shows what each field replaces, and skips what would not change.
    if (verb === 'update' && subject && key in subject && TYPES[subjectType] && noun === subjectType) {
      const current = subject[key];
      const linkedId = current && typeof current === 'object' && !Array.isArray(current) ? idOf((current as Json).value ?? (current as Json).id) : idOf(current);
      if (refType ? linkedId === id : recordValue(current) === value) continue;
      // A linked record that comes back as a bare id is named like the new one.
      const was =
        refType && linkedId && !(current && typeof current === 'object')
          ? (await nameOf(refType, linkedId)) ?? `#${linkedId}`
          : recordValue(current);
      rows.push({ label: rowLabel, value, was });
    } else {
      rows.push({ label: rowLabel, value });
    }
  }

  const preview: ApprovalPreview = {
    icon: verb === 'delete' ? '🗑' : verb === 'create' ? '🆕' : '✏️',
    heading:
      verb === 'add'
        ? `Add ${noun.replace(/^deal_/, '')} to deal`
        : verb === 'convert'
        ? 'Convert lead to a deal'
        : `${VERBS[verb]} Pipedrive ${thing}`,
    rows,
    body,
  };

  if (subjectId && TYPES[subjectType] && !subject) {
    preview.warning = `Could not load this ${label}. Approve only if you recognise its id.`;
  }

  if (verb === 'delete') {
    preview.destructive = true;
    preview.note =
      noun === 'pipeline'
        ? 'Deleting a pipeline deletes its stages; its deals are left without one.'
        : noun === 'stage'
        ? 'Deals in this stage are left without a stage.'
        : `Removes this ${thing} from Pipedrive.`;
    // The record's own facts, so a delete is recognisable beyond its name.
    for (const key of ['value', 'status', 'org_id', 'person_id', 'email', 'due_date']) {
      const fact = subject ? recordValue(subject[key]) : '';
      if (fact) rows.push({ label: REFERENCES[key] ? humanize(TYPES[REFERENCES[key]].label) : humanize(key), value: fact });
    }
  } else if (verb === 'update' && subject && noun === subjectType && rows.length === 1 && !body) {
    preview.note = 'Nothing shown here changes.';
  } else if (verb === 'create' && noun === 'webhook') {
    preview.note = 'Pipedrive will send your CRM events to this address from now on.';
    preview.destructive = true;
  }

  return preview;
}

const WRITES = [
  'create_deal', 'update_deal', 'add_deal_participant', 'add_deal_product', 'update_deal_product',
  'create_person', 'update_person', 'create_organization', 'update_organization', 'create_org_relationship',
  'create_lead', 'update_lead', 'convert_lead', 'create_activity', 'update_activity', 'create_note', 'update_note',
  'create_pipeline', 'update_pipeline', 'create_stage', 'update_stage', 'create_product', 'update_product',
  'create_goal', 'update_goal', 'create_project', 'update_project', 'create_task', 'update_task', 'create_webhook',
  'delete_deal', 'delete_person', 'delete_organization', 'delete_lead', 'delete_activity', 'delete_note',
  'delete_pipeline', 'delete_stage', 'delete_product', 'delete_deal_participant', 'delete_deal_product',
  'delete_filter', 'delete_goal', 'delete_project', 'delete_task', 'delete_webhook', 'delete_org_relationship',
  'delete_file',
];

registerPreview(WRITES.map((name) => `pipedrive_${name}`), buildPipedrivePreview);
