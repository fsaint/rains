/**
 * Drive path-rule resolution — ancestry-aware.
 *
 * A rule on a folder covers that folder and everything beneath it. The tree
 * used throughout:
 *
 *   root
 *   ├── proj            (rule: write)
 *   │   └── sub
 *   │       └── file
 *   ├── sibling         (no rule)
 *   │   └── other
 *   ├── secret          (rule: blocked)
 *   │   └── deep
 *   │       └── leaf
 *   └── shared          (rule: read)
 *       └── linked      (also parented under secret/deep — a multi-parent file)
 */

import { describe, it, expect, vi } from 'vitest';
import type { DrivePathRule } from '../common/types.js';
import {
  resolvePermission,
  resolveFilePermission,
  createParentResolver,
} from './path-rules.js';

const TREE: Record<string, string[]> = {
  root: [],
  proj: ['root'],
  sub: ['proj'],
  file: ['sub'],
  sibling: ['root'],
  other: ['sibling'],
  secret: ['root'],
  deep: ['secret'],
  leaf: ['deep'],
  shared: ['root'],
  linked: ['shared', 'deep'],
};

const RULES: DrivePathRule[] = [
  { folderId: 'proj', permission: 'write', label: '/proj' },
  { folderId: 'secret', permission: 'blocked', label: '/secret' },
  { folderId: 'shared', permission: 'read', label: '/shared' },
];

function lookup() {
  return vi.fn(async (id: string) => TREE[id] ?? []);
}

describe('resolvePermission (exact match)', () => {
  it('matches a folder id exactly', () => {
    expect(resolvePermission('proj', RULES, 'read')).toBe('write');
  });

  it('falls back to the default when no rule matches', () => {
    expect(resolvePermission('sibling', RULES, 'read')).toBe('read');
  });
});

describe('resolveFilePermission (ancestry)', () => {
  it('exact match: the rule folder itself resolves to its rule', async () => {
    expect(await resolveFilePermission('proj', RULES, 'blocked', lookup())).toBe('write');
  });

  it('a descendant two levels down inherits the rule', async () => {
    expect(await resolveFilePermission('file', RULES, 'blocked', lookup())).toBe('write');
  });

  it('the nearest rule beats a farther one', async () => {
    const rules: DrivePathRule[] = [
      ...RULES,
      { folderId: 'sub', permission: 'read' },
    ];
    expect(await resolveFilePermission('file', rules, 'blocked', lookup())).toBe('read');
  });

  it('blocked on any parent chain vetoes a grant on another', async () => {
    // linked sits under shared (read) and under secret/deep (blocked).
    expect(await resolveFilePermission('linked', RULES, 'write', lookup())).toBe('blocked');
  });

  it('with several granted chains the highest level wins', async () => {
    const tree: Record<string, string[]> = { ...TREE, both: ['shared', 'sub'] };
    const getParents = vi.fn(async (id: string) => tree[id] ?? []);
    expect(await resolveFilePermission('both', RULES, 'blocked', getParents)).toBe('write');
  });

  it('no rule on the way to the root → default', async () => {
    expect(await resolveFilePermission('other', RULES, 'read', lookup())).toBe('read');
    expect(await resolveFilePermission('other', RULES, 'blocked', lookup())).toBe('blocked');
  });

  it('undefined or empty id → default, without any lookup', async () => {
    const getParents = lookup();
    expect(await resolveFilePermission(undefined, RULES, 'read', getParents)).toBe('read');
    expect(await resolveFilePermission('', RULES, 'write', getParents)).toBe('write');
    expect(getParents).not.toHaveBeenCalled();
  });

  it('no rules → default, without any lookup', async () => {
    const getParents = lookup();
    expect(await resolveFilePermission('file', [], 'read', getParents)).toBe('read');
    expect(await resolveFilePermission('file', undefined, 'write', getParents)).toBe('write');
    expect(getParents).not.toHaveBeenCalled();
  });

  it('stops walking at the depth cap and refuses what it could not verify', async () => {
    // An endless chain: every node's parent is a fresh node. Without a cap
    // this would never terminate; with it, the chain is treated as unverified.
    let calls = 0;
    const getParents = vi.fn(async (id: string) => {
      calls += 1;
      return [`${id}/p`];
    });
    const level = await resolveFilePermission('x', RULES, 'write', getParents);
    expect(level).toBe('blocked');
    expect(calls).toBeLessThanOrEqual(33);
  });
});

describe('createParentResolver', () => {
  function makeDrive() {
    const get = vi.fn(async ({ fileId }: { fileId: string }) => ({
      data: { id: fileId, parents: TREE[fileId] ?? [] },
    }));
    return { drive: { files: { get } } as never, get };
  }

  it('fetches parents with the minimal field set', async () => {
    const { drive, get } = makeDrive();
    const getParents = createParentResolver(drive);
    expect(await getParents('file')).toEqual(['sub']);
    expect(get).toHaveBeenCalledWith(
      expect.objectContaining({ fileId: 'file', fields: 'id, parents', supportsAllDrives: true })
    );
  });

  it('fetches each id once across several resolutions', async () => {
    const { drive, get } = makeDrive();
    const getParents = createParentResolver(drive);
    await resolveFilePermission('file', RULES, 'blocked', getParents);
    await resolveFilePermission('sub', RULES, 'blocked', getParents);
    await resolveFilePermission('file', RULES, 'blocked', getParents);
    const ids = get.mock.calls.map((c) => (c[0] as { fileId: string }).fileId);
    expect(ids.length).toBe(new Set(ids).size);
  });

  it('can be primed with parents already fetched by the caller', async () => {
    const { drive, get } = makeDrive();
    const getParents = createParentResolver(drive);
    getParents.prime('file', ['sub']);
    await resolveFilePermission('file', RULES, 'blocked', getParents);
    const ids = get.mock.calls.map((c) => (c[0] as { fileId: string }).fileId);
    expect(ids).not.toContain('file');
    expect(ids).toContain('sub');
  });

  it('treats a parent the account cannot see as the end of that chain', async () => {
    const get = vi.fn(async ({ fileId }: { fileId: string }) => {
      if (fileId === 'ghost') throw Object.assign(new Error('File not found: ghost.'), { code: 404 });
      return { data: { id: fileId, parents: fileId === 'orphan' ? ['ghost'] : [] } };
    });
    const getParents = createParentResolver({ files: { get } } as never);
    expect(await resolveFilePermission('orphan', RULES, 'read', getParents)).toBe('read');
  });
});
