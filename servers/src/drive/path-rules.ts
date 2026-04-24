/**
 * Drive path-based permission resolution
 *
 * Resolves the effective permission level for a Drive operation given:
 * - A target folderId (the folder being accessed or the parent of a file being created)
 * - A default permission level
 * - A list of path rules (folder-ID → permission overrides)
 *
 * Matching is exact folderId equality. If multiple rules match (shouldn't happen
 * in practice), the first one wins. The default level applies when no rule matches.
 */

import type { DrivePathRule } from '../common/types.js';

export type PermissionLevel = 'read' | 'write' | 'blocked';

/**
 * Resolve the effective permission for a given folderId.
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
