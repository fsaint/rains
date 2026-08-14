import { useState, useEffect } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { Link, useNavigate, useSearchParams } from 'react-router-dom';
import {
  Brain,
  Plus,
  Search,
  ChevronRight,
  ChevronDown,
  User,
  Building2,
  Folder,
  FileText,
  Hash,
  X,
  Layers,
  Check,
  Archive,
} from 'lucide-react';
import { memory, memoryScopes } from '../api/client';
import type { MemoryEntryType, MemoryTreeNode, MemoryScope } from '../api/client';

/** Sentinel for "don't narrow" — distinct from a real slug. */
const ALL_SCOPES = '';

const TYPE_ICONS: Record<MemoryEntryType, React.ElementType> = {
  note: FileText,
  person: User,
  company: Building2,
  project: Folder,
  index: Hash,
};

const TYPE_LABELS: Record<MemoryEntryType, string> = {
  note: 'Notes',
  person: 'People',
  company: 'Companies',
  project: 'Projects',
  index: 'Index',
};

const TYPE_COLORS: Record<MemoryEntryType, string> = {
  note: 'text-gray-400',
  person: 'text-blue-400',
  company: 'text-purple-400',
  project: 'text-green-400',
  index: 'text-yellow-400',
};

function buildTree(nodes: MemoryTreeNode[]): Map<string | null, MemoryTreeNode[]> {
  const map = new Map<string | null, MemoryTreeNode[]>();
  for (const node of nodes) {
    const parent = node.parent_entry_id ?? null;
    if (!map.has(parent)) map.set(parent, []);
    map.get(parent)!.push(node);
  }
  return map;
}

function TreeNode({
  node,
  tree,
  depth,
}: {
  node: MemoryTreeNode;
  tree: Map<string | null, MemoryTreeNode[]>;
  depth: number;
}) {
  const [expanded, setExpanded] = useState(node.is_expanded || depth === 0);
  const children = tree.get(node.id) ?? [];
  const Icon = TYPE_ICONS[node.type] ?? FileText;
  const colorClass = TYPE_COLORS[node.type] ?? 'text-gray-400';

  return (
    <div>
      <div
        className="flex items-center gap-1 px-2 py-1 rounded hover:bg-white/5 cursor-pointer group"
        style={{ paddingLeft: `${8 + depth * 16}px` }}
        onClick={() => setExpanded((e) => !e)}
      >
        {children.length > 0 ? (
          <span className="w-4 h-4 flex items-center justify-center text-gray-500">
            {expanded ? <ChevronDown className="w-3 h-3" /> : <ChevronRight className="w-3 h-3" />}
          </span>
        ) : (
          <span className="w-4" />
        )}
        <Icon className={`w-3.5 h-3.5 shrink-0 ${colorClass}`} />
        <Link
          to={`/memory/${node.id}`}
          className="text-sm text-gray-300 hover:text-white truncate flex-1"
          onClick={(e) => e.stopPropagation()}
        >
          {node.title}
        </Link>
      </div>
      {expanded && children.length > 0 && (
        <div>
          {children.map((child) => (
            <TreeNode key={child.id} node={child} tree={tree} depth={depth + 1} />
          ))}
        </div>
      )}
    </div>
  );
}

/** A small chip naming an entry's scope, shown only when the view spans several. */
function ScopeChip({ scope }: { scope?: string }) {
  if (!scope) return null;
  return (
    <span className="px-1.5 py-0.5 rounded bg-trust-blue/15 text-trust-blue text-[10px] font-medium">
      {scope}
    </span>
  );
}

function ScopeSwitcher({
  scopes,
  active,
  onChange,
  onManage,
}: {
  scopes: MemoryScope[];
  active: string;
  onChange: (slug: string) => void;
  onManage: () => void;
}) {
  const [open, setOpen] = useState(false);
  // With one scope there is nothing to switch between, so the control would be
  // noise. It appears the moment a second scope exists.
  if (scopes.length < 2) return null;

  const label = active === ALL_SCOPES ? 'All scopes' : scopes.find((s) => s.slug === active)?.name ?? active;

  return (
    <div className="relative px-4 py-2 border-b border-white/10">
      <button
        onClick={() => setOpen((o) => !o)}
        className="w-full flex items-center justify-between gap-2 px-2 py-1.5 rounded hover:bg-white/5 text-left"
      >
        <span className="flex items-center gap-2 min-w-0">
          <Layers className="w-3.5 h-3.5 text-gray-400 shrink-0" />
          <span className="text-sm text-white truncate">{label}</span>
        </span>
        <ChevronDown className="w-3.5 h-3.5 text-gray-500 shrink-0" />
      </button>

      {open && (
        <div className="absolute left-4 right-4 mt-1 z-20 rounded-lg bg-reins-navy border border-white/15 shadow-xl py-1">
          <button
            onClick={() => { onChange(ALL_SCOPES); setOpen(false); }}
            className="w-full flex items-center justify-between px-3 py-1.5 text-sm text-gray-300 hover:bg-white/5"
          >
            All scopes
            {active === ALL_SCOPES && <Check className="w-3.5 h-3.5 text-trust-blue" />}
          </button>
          <div className="my-1 border-t border-white/10" />
          {scopes.map((s) => (
            <button
              key={s.id}
              onClick={() => { onChange(s.slug); setOpen(false); }}
              className="w-full flex items-center justify-between px-3 py-1.5 text-sm text-gray-300 hover:bg-white/5"
            >
              <span className="flex items-center gap-2 min-w-0">
                <span className="truncate">{s.name}</span>
                <span className="text-[10px] text-gray-500">{s.entry_count}</span>
              </span>
              {active === s.slug && <Check className="w-3.5 h-3.5 text-trust-blue" />}
            </button>
          ))}
          <div className="my-1 border-t border-white/10" />
          <button
            onClick={() => { onManage(); setOpen(false); }}
            className="w-full text-left px-3 py-1.5 text-sm text-gray-400 hover:bg-white/5"
          >
            Manage scopes…
          </button>
        </div>
      )}
    </div>
  );
}

function ManageScopesModal({ scopes, onClose }: { scopes: MemoryScope[]; onClose: () => void }) {
  const queryClient = useQueryClient();
  const [name, setName] = useState('');
  const [error, setError] = useState<string | null>(null);

  const invalidate = () => {
    queryClient.invalidateQueries({ queryKey: ['memory-scopes'] });
    queryClient.invalidateQueries({ queryKey: ['memory-tree'] });
    queryClient.invalidateQueries({ queryKey: ['memory-entries'] });
  };

  const create = useMutation({
    mutationFn: () => memoryScopes.create({ name: name.trim() }),
    onSuccess: () => { setName(''); setError(null); invalidate(); },
    onError: (e: Error) => setError(e.message),
  });

  const archive = useMutation({
    mutationFn: (id: string) => memoryScopes.remove(id, { archive: true }),
    onSuccess: () => { setError(null); invalidate(); },
    onError: (e: Error) => setError(e.message),
  });

  const makeDefault = useMutation({
    mutationFn: (id: string) => memoryScopes.update(id, { is_default: true }),
    onSuccess: () => { setError(null); invalidate(); },
    onError: (e: Error) => setError(e.message),
  });

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4" onClick={onClose}>
      <div
        className="w-full max-w-lg rounded-xl bg-reins-navy border border-white/15 p-5"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between mb-1">
          <h2 className="text-white font-semibold">Memory scopes</h2>
          <button onClick={onClose} className="p-1 rounded hover:bg-white/10 text-gray-400">
            <X className="w-4 h-4" />
          </button>
        </div>
        <p className="text-xs text-gray-500 mb-4">
          Separate compartments of your vault. Entries, links and relations never cross
          between them, and an entry cannot be linked to one in another scope.
        </p>

        {error && (
          <div className="mb-3 px-3 py-2 rounded bg-red-500/10 border border-red-500/30 text-xs text-red-300">
            {error}
          </div>
        )}

        <div className="space-y-1 mb-4">
          {scopes.map((s) => (
            <div key={s.id} className="flex items-center justify-between px-3 py-2 rounded bg-white/5">
              <div className="min-w-0">
                <div className="flex items-center gap-2">
                  <span className="text-sm text-white truncate">{s.name}</span>
                  <span className="text-[10px] text-gray-500">{s.slug}</span>
                  {s.is_default && (
                    <span className="px-1.5 py-0.5 rounded bg-trust-blue/15 text-trust-blue text-[10px]">
                      default
                    </span>
                  )}
                </div>
                <div className="text-[11px] text-gray-500">{s.entry_count} entries</div>
              </div>
              <div className="flex items-center gap-1 shrink-0">
                {!s.is_default && (
                  <button
                    onClick={() => makeDefault.mutate(s.id)}
                    className="px-2 py-1 rounded text-[11px] text-gray-400 hover:bg-white/10 hover:text-white"
                    title="Make this the scope new entries go to"
                  >
                    Make default
                  </button>
                )}
                {/* Archive rather than delete: archiving keeps the entries and is
                    reversible, where deleting a non-empty scope is refused outright. */}
                {!s.is_default && (
                  <button
                    onClick={() => archive.mutate(s.id)}
                    className="p-1.5 rounded text-gray-400 hover:bg-white/10 hover:text-white"
                    title="Archive — hides the scope and its entries from agents, keeps everything"
                  >
                    <Archive className="w-3.5 h-3.5" />
                  </button>
                )}
              </div>
            </div>
          ))}
        </div>

        <div className="flex gap-2">
          <input
            value={name}
            onChange={(e) => setName(e.target.value)}
            onKeyDown={(e) => { if (e.key === 'Enter' && name.trim()) create.mutate(); }}
            placeholder="New scope name, e.g. Acme Engagement"
            className="flex-1 px-3 py-2 rounded bg-white/5 border border-white/10 text-sm text-white placeholder:text-gray-600 focus:outline-none focus:border-trust-blue/50"
          />
          <button
            onClick={() => create.mutate()}
            disabled={!name.trim() || create.isPending}
            className="px-3 py-2 rounded bg-trust-blue/20 text-trust-blue text-sm hover:bg-trust-blue/30 disabled:opacity-40"
          >
            Create
          </button>
        </div>
      </div>
    </div>
  );
}

export default function Memory() {
  const navigate = useNavigate();
  const [searchParams, setSearchParams] = useSearchParams();
  const [searchQuery, setSearchQuery] = useState('');
  const [activeType, setActiveType] = useState<MemoryEntryType | ''>(
    (searchParams.get('type') as MemoryEntryType) ?? ''
  );
  const [activeTag, setActiveTag] = useState<string>(searchParams.get('tag') ?? '');
  const [activeScope, setActiveScope] = useState<string>(searchParams.get('scope') ?? ALL_SCOPES);
  const [managingScopes, setManagingScopes] = useState(false);

  // Keep activeType, activeTag and activeScope in sync when URL changes (e.g. navigating from index section headings)
  useEffect(() => {
    const t = (searchParams.get('type') as MemoryEntryType) ?? '';
    setActiveType(t);
    setActiveTag(searchParams.get('tag') ?? '');
    setActiveScope(searchParams.get('scope') ?? ALL_SCOPES);
  }, [searchParams]);

  const { data: scopes = [] } = useQuery({
    queryKey: ['memory-scopes'],
    queryFn: () => memoryScopes.list(),
    staleTime: 60_000,
  });

  const scopeParam = activeScope || undefined;
  // Only worth labelling rows when the view actually spans more than one scope.
  const spanning = activeScope === ALL_SCOPES && scopes.length > 1;

  const { data: treeNodes = [], isLoading: treeLoading } = useQuery({
    queryKey: ['memory-tree', activeScope],
    queryFn: () => memory.getTree(scopeParam),
  });

  const { data: entries = [], isLoading: entriesLoading } = useQuery({
    queryKey: ['memory-entries', searchQuery, activeType, activeTag, activeScope],
    queryFn: () =>
      memory.listEntries({
        q: searchQuery || undefined,
        type: (activeType as MemoryEntryType) || undefined,
        tag: activeTag || undefined,
        scope: scopeParam,
        limit: 100,
      }),
    staleTime: 30_000,
  });

  const treeMap = buildTree(treeNodes);
  const roots = treeMap.get(null) ?? [];

  const changeScope = (slug: string) => {
    const next = new URLSearchParams(searchParams);
    if (slug) next.set('scope', slug);
    else next.delete('scope');
    setSearchParams(next);
  };

  const handleNewEntry = async () => {
    const title = window.prompt('Entry title:');
    if (!title?.trim()) return;
    // With "All scopes" selected there is no obvious target, so fall through to
    // the backend's default rather than guessing on the user's behalf.
    const entry = await memory.createEntry({
      title: title.trim(),
      type: 'note',
      scope: scopeParam,
    });
    navigate(`/memory/${entry.id}`);
  };

  const typeFilters: Array<{ value: MemoryEntryType | ''; label: string }> = [
    { value: '', label: 'All' },
    { value: 'person', label: 'People' },
    { value: 'company', label: 'Companies' },
    { value: 'project', label: 'Projects' },
    { value: 'note', label: 'Notes' },
  ];

  return (
    <div className="flex h-full">
      {/* Sidebar */}
      <aside className="w-64 shrink-0 bg-reins-navy border-r border-white/10 flex flex-col overflow-hidden">
        <div className="p-4 border-b border-white/10 flex items-center justify-between">
          <div className="flex items-center gap-2">
            <Brain className="w-5 h-5 text-trust-blue" />
            <span className="font-semibold text-white">Memory</span>
          </div>
          <button
            onClick={handleNewEntry}
            className="p-1.5 rounded hover:bg-white/10 text-gray-400 hover:text-white transition-colors"
            title="New entry"
          >
            <Plus className="w-4 h-4" />
          </button>
        </div>

        <ScopeSwitcher
          scopes={scopes}
          active={activeScope}
          onChange={changeScope}
          onManage={() => setManagingScopes(true)}
        />

        <div className="flex-1 overflow-y-auto py-2">
          {treeLoading ? (
            <div className="px-4 text-xs text-gray-500">Loading…</div>
          ) : roots.length === 0 ? (
            <div className="px-4 text-xs text-gray-500">No entries yet</div>
          ) : (
            roots.map((root) => (
              <TreeNode key={root.id} node={root} tree={treeMap} depth={0} />
            ))
          )}
        </div>
      </aside>

      {/* Main content */}
      <div className="flex-1 overflow-auto bg-reins-navy">
        <div className="p-6">
          {/* Header */}
          <div className="flex items-center justify-between mb-6">
            <h1 className="text-2xl font-bold text-white flex items-center gap-2">
              <Brain className="w-7 h-7 text-trust-blue" />
              Memory Vault
            </h1>
            <button
              onClick={handleNewEntry}
              className="flex items-center gap-2 px-4 py-2 bg-trust-blue text-white rounded-lg hover:bg-trust-blue/90 transition-colors text-sm font-medium"
            >
              <Plus className="w-4 h-4" />
              New Entry
            </button>
          </div>

          {/* Search + type filters */}
          <div className="flex gap-3 mb-6">
            <div className="relative flex-1">
              <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-gray-400" />
              <input
                type="text"
                value={searchQuery}
                onChange={(e) => setSearchQuery(e.target.value)}
                placeholder="Search entries…"
                className="w-full pl-9 pr-4 py-2 bg-white/5 border border-white/10 rounded-lg text-sm text-white placeholder-gray-500 focus:outline-none focus:border-trust-blue"
              />
            </div>
            <div className="flex gap-1">
              {typeFilters.map((f) => (
                <button
                  key={f.value}
                  onClick={() => {
                    setActiveType(f.value);
                    setSearchParams(f.value ? { type: f.value } : {});
                  }}
                  className={`px-3 py-1.5 rounded text-xs font-medium transition-colors ${
                    activeType === f.value
                      ? 'bg-trust-blue text-white'
                      : 'bg-white/5 text-gray-400 hover:bg-white/10 hover:text-white'
                  }`}
                >
                  {f.label}
                </button>
              ))}
            </div>
          </div>

          {/* Active tag chip */}
          {activeTag && (
            <div className="mb-4 flex items-center gap-2">
              <span className="text-sm text-gray-400">Tagged:</span>
              <span className="inline-flex items-center gap-1 px-2 py-0.5 bg-trust-blue/10 border border-trust-blue/20 rounded-full text-xs text-trust-blue">
                #{activeTag}
                <button onClick={() => { setActiveTag(''); setSearchParams(activeType ? { type: activeType } : {}); }}>
                  <X className="w-3 h-3" />
                </button>
              </span>
            </div>
          )}

          {/* Entry grid */}
          {entriesLoading ? (
            <div className="text-gray-500 text-sm">Loading…</div>
          ) : entries.length === 0 ? (
            <div className="text-center py-16">
              <Brain className="w-12 h-12 text-gray-600 mx-auto mb-3" />
              <p className="text-gray-400 text-sm">
                {searchQuery ? 'No entries match your search.' : 'No memory entries yet.'}
              </p>
              {!searchQuery && (
                <button
                  onClick={handleNewEntry}
                  className="mt-4 px-4 py-2 bg-trust-blue text-white text-sm rounded-lg hover:bg-trust-blue/90 transition-colors"
                >
                  Create your first entry
                </button>
              )}
            </div>
          ) : (
            <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4">
              {entries.map((entry) => {
                const Icon = TYPE_ICONS[entry.type] ?? FileText;
                const colorClass = TYPE_COLORS[entry.type] ?? 'text-gray-400';
                const preview = entry.content?.replace(/#+\s/g, '').replace(/\[\[|\]\]/g, '').slice(0, 120);
                return (
                  <Link
                    key={entry.id}
                    to={`/memory/${entry.id}`}
                    className="block bg-white/5 rounded-xl p-4 border border-white/10 hover:border-trust-blue/50 hover:bg-white/8 transition-all group"
                  >
                    <div className="flex items-start gap-3">
                      <Icon className={`w-5 h-5 shrink-0 mt-0.5 ${colorClass}`} />
                      <div className="min-w-0 flex-1">
                        <p className="font-medium text-white truncate group-hover:text-trust-blue transition-colors">
                          {entry.title}
                        </p>
                        <p className="text-xs text-gray-500 mt-0.5 flex items-center gap-1.5">
                          {TYPE_LABELS[entry.type]}
                          {spanning && <ScopeChip scope={entry.scope} />}
                        </p>
                        {preview && (
                          <p className="text-xs text-gray-400 mt-2 line-clamp-2">{preview}</p>
                        )}
                      </div>
                    </div>
                    <p className="text-xs text-gray-600 mt-3">
                      {new Date(entry.updated_at).toLocaleDateString()}
                    </p>
                  </Link>
                );
              })}
            </div>
          )}
        </div>
      </div>

      {managingScopes && (
        <ManageScopesModal scopes={scopes} onClose={() => setManagingScopes(false)} />
      )}
    </div>
  );
}
