/**
 * Drive path-based permission resolution
 *
 * A rule on a folder covers that folder and everything beneath it. The
 * effective permission for a file is found by walking its `parents` upward
 * until a folder with a rule is met — the nearest rule wins. When the walk
 * reaches the root (or a folder the account cannot see) without meeting a
 * rule, the agent's default level applies.
 *
 * Drive files may have several parents. Each parent chain is resolved on its
 * own: 'blocked' on any chain vetoes; otherwise the highest granted level wins.
 *
 * `resolvePermission` is the exact-match form, kept for callers that only
 * have a folder id and no way to look up ancestry.
 */

import type { drive_v3 } from 'googleapis';
import type { DrivePathRule } from '../common/types.js';

export type PermissionLevel = 'read' | 'write' | 'blocked';

/** How many ancestors a chain may be walked before it is treated as unverifiable. */
export const MAX_ANCESTRY_DEPTH = 32;

/**
 * Resolve the effective permission for a given folderId by exact match only.
 *
 * @param folderId   The Drive folder ID to check (undefined = root / unknown)
 * @param rules      Path rules configured for this agent
 * @param defaultLevel  Default permission when no rule matches
 */
export function resolvePermission(
  folderId: string | undefined,
  rules: DrivePathRule[] | undefined,
  defaultLevel: PermissionLevel
): PermissionLevel {
  if (!rules || rules.length === 0 || !folderId) {
    return defaultLevel;
  }

  const match = rules.find((r) => r.folderId === folderId);
  return match ? match.permission : defaultLevel;
}

/** Looks up the parent ids of one Drive file or folder. */
export type ParentsLookup = (id: string) => Promise<string[]>;

/**
 * A ParentsLookup backed by the Drive API that also lets a caller feed in
 * parents it already fetched, so a file's own metadata call is not repeated.
 */
export interface ParentResolver extends ParentsLookup {
  prime(id: string, parents: string[]): void;
}

const RANK: Record<PermissionLevel, number> = { blocked: 0, read: 1, write: 2 };

/**
 * Resolve the effective permission for a file or folder by walking its
 * ancestry. See the module comment for the semantics.
 *
 * @param fileId       The file or folder to check (undefined / '' = default)
 * @param rules        Path rules configured for this agent
 * @param defaultLevel Default permission when no rule is met before the root
 * @param getParents   Parent lookup — use createParentResolver() for the real API
 */
export async function resolveFilePermission(
  fileId: string | undefined,
  rules: DrivePathRule[] | undefined,
  defaultLevel: PermissionLevel,
  getParents: ParentsLookup
): Promise<PermissionLevel> {
  if (!rules || rules.length === 0 || !fileId) {
    return defaultLevel;
  }

  const byFolder = new Map(rules.map((r) => [r.folderId, r.permission] as const));
  // Chains are memoised per call so a diamond (two parents sharing an
  // ancestor) walks the shared part once.
  const chains = new Map<string, Promise<PermissionLevel>>();

  const resolveChain = (id: string, depth: number): Promise<PermissionLevel> => {
    const cached = chains.get(id);
    if (cached) return cached;
    const pending = (async (): Promise<PermissionLevel> => {
      const rule = byFolder.get(id);
      if (rule) return rule;
      // A chain deeper than the cap cannot be verified against the rules, so
      // it is refused rather than let through on the default.
      if (depth >= MAX_ANCESTRY_DEPTH) return 'blocked';
      const parents = await getParents(id);
      if (parents.length === 0) return defaultLevel;
      const levels = await Promise.all(parents.map((p) => resolveChain(p, depth + 1)));
      return combine(levels);
    })();
    chains.set(id, pending);
    return pending;
  };

  return resolveChain(fileId, 0);
}

/** Blocked on any chain vetoes; otherwise the highest granted level wins. */
function combine(levels: PermissionLevel[]): PermissionLevel {
  if (levels.includes('blocked')) return 'blocked';
  return levels.reduce((best, level) => (RANK[level] > RANK[best] ? level : best), 'read');
}

/**
 * Build a memoised parent lookup over a Drive client. Each id is fetched at
 * most once for the resolver's lifetime — create one per tool call.
 *
 * A parent the account cannot see (404) ends that chain: it cannot be one of
 * the owner's rule folders, since the rules are the owner's own folders.
 */
export function createParentResolver(drive: drive_v3.Drive): ParentResolver {
  const memo = new Map<string, Promise<string[]>>();

  const lookup = ((id: string): Promise<string[]> => {
    const cached = memo.get(id);
    if (cached) return cached;
    const pending = drive.files
      .get({ fileId: id, fields: 'id, parents', supportsAllDrives: true })
      .then((response) => response.data.parents ?? [])
      .catch((error: unknown) => {
        if (isNotFound(error)) return [];
        memo.delete(id);
        throw error;
      });
    memo.set(id, pending);
    return pending;
  }) as ParentResolver;

  lookup.prime = (id: string, parents: string[]) => {
    memo.set(id, Promise.resolve(parents));
  };

  return lookup;
}

function isNotFound(error: unknown): boolean {
  const e = error as { code?: number | string; status?: number; message?: string } | null;
  return e?.code === 404 || e?.code === '404' || e?.status === 404 || /File not found/i.test(e?.message ?? '');
}

/**
 * Check if a permission level allows read operations.
 */
export function canRead(level: PermissionLevel): boolean {
  return level === 'read' || level === 'write';
}

/**
 * Check if a permission level allows write operations.
 */
export function canWrite(level: PermissionLevel): boolean {
  return level === 'write';
}
