/**
 * Drive path-rule validation and folder-id normalisation.
 *
 * Kept as its own small module so the dashboard can mirror the exact rules:
 * the frontend normalises what the owner pastes for immediate feedback, and
 * this is the authority the route enforces on save.
 */

import type { DrivePathConfig, DrivePathRuleEntry } from './permissions.js';

export const DRIVE_PERMISSION_LEVELS = ['read', 'write', 'blocked'] as const;
export type DrivePermissionLevel = (typeof DRIVE_PERMISSION_LEVELS)[number];

/** Characters Google issues in Drive ids. `root` (the My Drive alias) also matches. */
const FOLDER_ID_RE = /^[A-Za-z0-9_-]+$/;
const URL_FOLDERS_RE = /\/folders\/([A-Za-z0-9_-]+)/;
const URL_FILE_RE = /\/file\/d\/([A-Za-z0-9_-]+)/;

/**
 * Reduce what an owner pasted to a bare Drive folder id, or null if it is
 * neither an id nor a Drive URL an id can be read from.
 *
 * Rules, in order:
 *  1. Trim whitespace. Empty → null.
 *  2. If the value contains `://` or starts with `drive.google.com`, treat it
 *     as a URL (a bare `drive.google.com/...` gets `https://` prepended):
 *     a. a path segment `/folders/<id>` wins — this covers
 *        `/drive/folders/<id>`, `/drive/u/<n>/folders/<id>`, and any other
 *        prefix Drive puts before it;
 *     b. else a path segment `/file/d/<id>`;
 *     c. else the `id` query parameter (`/open?id=<id>`, `/uc?id=<id>`);
 *     d. else null. Query strings and fragments after the id are dropped.
 *  3. Otherwise the value itself must be an id: only `A-Z a-z 0-9 _ -`.
 *     Anything else → null.
 */
export function normalizeDriveFolderId(input: string): string | null {
  const value = input.trim();
  if (!value) return null;

  const looksLikeUrl = value.includes('://') || /^drive\.google\.com\//i.test(value);
  if (!looksLikeUrl) {
    return FOLDER_ID_RE.test(value) ? value : null;
  }

  let url: URL;
  try {
    url = new URL(value.includes('://') ? value : `https://${value}`);
  } catch {
    return null;
  }

  const fromFolders = URL_FOLDERS_RE.exec(url.pathname);
  if (fromFolders) return fromFolders[1];
  const fromFile = URL_FILE_RE.exec(url.pathname);
  if (fromFile) return fromFile[1];
  const fromQuery = url.searchParams.get('id');
  if (fromQuery && FOLDER_ID_RE.test(fromQuery)) return fromQuery;
  return null;
}

export class DrivePathRuleValidationError extends Error {
  readonly code = 'VALIDATION_ERROR';
  constructor(message: string) {
    super(message);
    this.name = 'DrivePathRuleValidationError';
  }
}

/**
 * Validate and normalise the `rules` half of a Drive path config.
 *
 * Every rule must be `{ folderId: non-empty string (id or Drive URL),
 * label?: string, permission: read | write | blocked }`. Folder ids are
 * normalised before the duplicate check, so the same folder pasted once as an
 * id and once as a URL is rejected. Throws DrivePathRuleValidationError with a
 * message that names the offending rule by index.
 */
export function validateDrivePathRules(input: unknown): DrivePathRuleEntry[] {
  if (input === undefined || input === null) return [];
  if (!Array.isArray(input)) {
    throw new DrivePathRuleValidationError('rules must be an array');
  }

  const seen = new Map<string, number>();
  return input.map((raw, i) => {
    const at = `rules[${i}]`;
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
      throw new DrivePathRuleValidationError(`${at} must be an object with folderId and permission`);
    }
    const rule = raw as Record<string, unknown>;

    if (typeof rule.folderId !== 'string' || !rule.folderId.trim()) {
      throw new DrivePathRuleValidationError(`${at}.folderId must be a non-empty string`);
    }
    const folderId = normalizeDriveFolderId(rule.folderId);
    if (!folderId) {
      throw new DrivePathRuleValidationError(
        `${at}.folderId is not a Drive folder id or folder URL: ${JSON.stringify(rule.folderId.trim())}`
      );
    }

    if (rule.label !== undefined && rule.label !== null && typeof rule.label !== 'string') {
      throw new DrivePathRuleValidationError(`${at}.label must be a string`);
    }

    if (typeof rule.permission !== 'string' || !(DRIVE_PERMISSION_LEVELS as readonly string[]).includes(rule.permission)) {
      throw new DrivePathRuleValidationError(`${at}.permission must be read, write, or blocked`);
    }

    const first = seen.get(folderId);
    if (first !== undefined) {
      throw new DrivePathRuleValidationError(`${at} duplicates folder ${folderId} already used by rules[${first}]`);
    }
    seen.set(folderId, i);

    const entry: DrivePathRuleEntry = { folderId, permission: rule.permission as DrivePermissionLevel };
    if (typeof rule.label === 'string') entry.label = rule.label;
    return entry;
  });
}

export function isDrivePermissionLevel(value: unknown): value is DrivePathConfig['defaultLevel'] {
  return typeof value === 'string' && (DRIVE_PERMISSION_LEVELS as readonly string[]).includes(value);
}
