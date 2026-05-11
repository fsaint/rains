import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Link, useNavigate } from 'react-router-dom';
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
} from 'lucide-react';
import { memory } from '../api/client';
import type { MemoryEntryType, MemoryTreeNode } from '../api/client';

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

export default function Memory() {
  const navigate = useNavigate();
  const [searchQuery, setSearchQuery] = useState('');
  const [activeType, setActiveType] = useState<MemoryEntryType | ''>('');

  const { data: treeNodes = [], isLoading: treeLoading } = useQuery({
    queryKey: ['memory-tree'],
    queryFn: memory.getTree,
  });

  const { data: entries = [], isLoading: entriesLoading } = useQuery({
    queryKey: ['memory-entries', searchQuery, activeType],
    queryFn: () =>
      memory.listEntries({
        q: searchQuery || undefined,
        type: (activeType as MemoryEntryType) || undefined,
        limit: 100,
      }),
    staleTime: 30_000,
  });

  const treeMap = buildTree(treeNodes);
  const roots = treeMap.get(null) ?? [];

  const handleNewEntry = async () => {
    const title = window.prompt('Entry title:');
    if (!title?.trim()) return;
    const entry = await memory.createEntry({ title: title.trim(), type: 'note' });
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
      <div className="flex-1 overflow-auto">
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
                  onClick={() => setActiveType(f.value)}
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
                        <p className="text-xs text-gray-500 mt-0.5">
                          {TYPE_LABELS[entry.type]}
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
    </div>
  );
}
