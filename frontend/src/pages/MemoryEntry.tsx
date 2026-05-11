import { useState, useEffect } from 'react';
import { useParams, useNavigate, Link } from 'react-router-dom';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import {
  ArrowLeft,
  Save,
  Trash2,
  Plus,
  X,
  User,
  Building2,
  Folder,
  FileText,
  Hash,
  Link as LinkIcon,
  Tag,
} from 'lucide-react';
import { memory } from '../api/client';
import type { MemoryEntryType, MemoryAttribute } from '../api/client';

const TYPE_ICONS: Record<MemoryEntryType, React.ElementType> = {
  note: FileText,
  person: User,
  company: Building2,
  project: Folder,
  index: Hash,
};

const TYPE_OPTIONS: MemoryEntryType[] = ['note', 'person', 'company', 'project'];

/** Simple Markdown renderer (subset) */
function renderMarkdown(md: string): string {
  return md
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/^### (.+)$/gm, '<h3 class="text-lg font-semibold text-white mt-4 mb-1">$1</h3>')
    .replace(/^## (.+)$/gm, '<h2 class="text-xl font-semibold text-white mt-6 mb-2">$1</h2>')
    .replace(/^# (.+)$/gm, '<h1 class="text-2xl font-bold text-white mt-6 mb-3">$1</h1>')
    .replace(/\*\*(.+?)\*\*/g, '<strong class="text-white font-semibold">$1</strong>')
    .replace(/\*(.+?)\*/g, '<em class="italic">$1</em>')
    .replace(/`(.+?)`/g, '<code class="bg-white/10 rounded px-1 text-sm font-mono text-green-300">$1</code>')
    .replace(/\[\[([^\]]+)\]\]/g, '<span class="text-trust-blue underline cursor-pointer">$1</span>')
    .replace(/\[([^\]]+)\]\(([^)]+)\)/g, '<a href="$2" class="text-trust-blue underline" target="_blank" rel="noopener">$1</a>')
    .replace(/^- (.+)$/gm, '<li class="ml-4 list-disc text-gray-300">$1</li>')
    .replace(/\n{2,}/g, '</p><p class="mb-2">')
    .replace(/\n/g, '<br/>');
}

function AttributeRow({
  attr,
  onDelete,
}: {
  attr: MemoryAttribute;
  onDelete: (id: string) => void;
}) {
  return (
    <div className="flex items-center gap-2 py-1.5 border-b border-white/5 group">
      {attr.type === 'label' ? (
        <Tag className="w-3.5 h-3.5 text-gray-500 shrink-0" />
      ) : (
        <LinkIcon className="w-3.5 h-3.5 text-blue-400 shrink-0" />
      )}
      <span className="text-xs text-gray-400 w-24 shrink-0">{attr.name}</span>
      <span className="text-sm text-gray-200 flex-1 truncate">{attr.value}</span>
      <button
        onClick={() => onDelete(attr.id)}
        className="opacity-0 group-hover:opacity-100 transition-opacity p-0.5 text-gray-600 hover:text-alert-red"
      >
        <X className="w-3 h-3" />
      </button>
    </div>
  );
}

export default function MemoryEntry() {
  const { id } = useParams<{ id: string }>();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const [editing, setEditing] = useState(false);
  const [draftTitle, setDraftTitle] = useState('');
  const [draftContent, setDraftContent] = useState('');
  const [draftType, setDraftType] = useState<MemoryEntryType>('note');
  const [showAddAttr, setShowAddAttr] = useState(false);
  const [newAttrType, setNewAttrType] = useState<'label' | 'relation'>('label');
  const [newAttrName, setNewAttrName] = useState('');
  const [newAttrValue, setNewAttrValue] = useState('');

  const { data: entry, isLoading } = useQuery({
    queryKey: ['memory-entry', id],
    queryFn: () => memory.getEntry(id!),
    enabled: !!id,
  });

  useEffect(() => {
    if (entry) {
      setDraftTitle(entry.title);
      setDraftContent(entry.content ?? '');
      setDraftType(entry.type);
    }
  }, [entry]);

  const updateMutation = useMutation({
    mutationFn: (data: { title?: string; content?: string; type?: MemoryEntryType }) =>
      memory.updateEntry(id!, data),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['memory-entry', id] });
      queryClient.invalidateQueries({ queryKey: ['memory-entries'] });
      queryClient.invalidateQueries({ queryKey: ['memory-tree'] });
      setEditing(false);
    },
  });

  const deleteMutation = useMutation({
    mutationFn: () => memory.deleteEntry(id!),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['memory-entries'] });
      queryClient.invalidateQueries({ queryKey: ['memory-tree'] });
      navigate('/memory');
    },
  });

  const addAttrMutation = useMutation({
    mutationFn: (attr: { type: 'label' | 'relation'; name: string; value: string }) =>
      memory.addAttribute(id!, attr),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['memory-entry', id] });
      setShowAddAttr(false);
      setNewAttrName('');
      setNewAttrValue('');
    },
  });

  const removeAttrMutation = useMutation({
    mutationFn: (attrId: string) => memory.removeAttribute(attrId),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['memory-entry', id] });
    },
  });

  const handleSave = () => {
    updateMutation.mutate({
      title: draftTitle,
      content: draftContent,
      type: draftType,
    });
  };

  const handleDelete = () => {
    if (window.confirm(`Delete "${entry?.title}"?`)) {
      deleteMutation.mutate();
    }
  };

  const handleAddAttr = () => {
    if (!newAttrName.trim() || !newAttrValue.trim()) return;
    addAttrMutation.mutate({ type: newAttrType, name: newAttrName.trim(), value: newAttrValue.trim() });
  };

  if (isLoading) {
    return (
      <div className="p-8 text-gray-400 text-sm">Loading…</div>
    );
  }

  if (!entry) {
    return (
      <div className="p-8">
        <p className="text-gray-400">Entry not found.</p>
        <Link to="/memory" className="text-trust-blue text-sm mt-2 block">← Back to Memory</Link>
      </div>
    );
  }

  const Icon = TYPE_ICONS[entry.type] ?? FileText;

  return (
    <div className="flex h-full">
      {/* Main editor area */}
      <div className="flex-1 overflow-auto">
        <div className="max-w-3xl mx-auto p-6">
          {/* Breadcrumb */}
          <div className="flex items-center gap-2 mb-4">
            <Link to="/memory" className="flex items-center gap-1 text-sm text-gray-400 hover:text-white transition-colors">
              <ArrowLeft className="w-4 h-4" />
              Memory
            </Link>
            <span className="text-gray-600">/</span>
            <span className="text-sm text-gray-300">{entry.title}</span>
          </div>

          {/* Title row */}
          <div className="flex items-start gap-3 mb-4">
            <Icon className="w-7 h-7 text-trust-blue shrink-0 mt-1" />
            <div className="flex-1">
              {editing ? (
                <div className="space-y-2">
                  <input
                    value={draftTitle}
                    onChange={(e) => setDraftTitle(e.target.value)}
                    className="w-full text-2xl font-bold bg-transparent text-white border-b border-trust-blue focus:outline-none py-1"
                  />
                  <select
                    value={draftType}
                    onChange={(e) => setDraftType(e.target.value as MemoryEntryType)}
                    className="text-xs bg-white/10 text-gray-300 rounded px-2 py-1 border border-white/10 focus:outline-none"
                  >
                    {TYPE_OPTIONS.map((t) => (
                      <option key={t} value={t}>{t}</option>
                    ))}
                  </select>
                </div>
              ) : (
                <h1 className="text-2xl font-bold text-white">{entry.title}</h1>
              )}
            </div>

            {/* Action buttons */}
            <div className="flex items-center gap-2 shrink-0">
              {editing ? (
                <>
                  <button
                    onClick={handleSave}
                    disabled={updateMutation.isPending}
                    className="flex items-center gap-1.5 px-3 py-1.5 bg-trust-blue text-white rounded text-sm font-medium hover:bg-trust-blue/90 disabled:opacity-50 transition-colors"
                  >
                    <Save className="w-3.5 h-3.5" />
                    Save
                  </button>
                  <button
                    onClick={() => {
                      setEditing(false);
                      setDraftTitle(entry.title);
                      setDraftContent(entry.content ?? '');
                      setDraftType(entry.type);
                    }}
                    className="px-3 py-1.5 text-gray-400 hover:text-white text-sm rounded border border-white/10 hover:border-white/30 transition-colors"
                  >
                    Cancel
                  </button>
                </>
              ) : (
                <>
                  <button
                    onClick={() => setEditing(true)}
                    className="px-3 py-1.5 text-gray-400 hover:text-white text-sm rounded border border-white/10 hover:border-white/30 transition-colors"
                  >
                    Edit
                  </button>
                  <button
                    onClick={handleDelete}
                    className="p-1.5 text-gray-500 hover:text-alert-red transition-colors"
                    title="Delete entry"
                  >
                    <Trash2 className="w-4 h-4" />
                  </button>
                </>
              )}
            </div>
          </div>

          {/* Content */}
          {editing ? (
            <textarea
              value={draftContent}
              onChange={(e) => setDraftContent(e.target.value)}
              className="w-full h-96 bg-white/5 border border-white/10 rounded-lg p-4 text-sm text-gray-200 font-mono focus:outline-none focus:border-trust-blue resize-y"
              placeholder="Write in Markdown. Use [[Title]] to link to other entries."
            />
          ) : (
            <div
              className="prose prose-invert prose-sm max-w-none text-gray-300 leading-relaxed min-h-32"
              dangerouslySetInnerHTML={{
                __html: entry.content
                  ? `<p class="mb-2">${renderMarkdown(entry.content)}</p>`
                  : '<p class="text-gray-600 italic">No content yet. Click Edit to add some.</p>',
              }}
            />
          )}

          {/* Metadata */}
          <p className="text-xs text-gray-600 mt-6 pt-4 border-t border-white/5">
            Created {new Date(entry.created_at).toLocaleString()} · Updated {new Date(entry.updated_at).toLocaleString()}
          </p>
        </div>
      </div>

      {/* Right sidebar: attributes + backlinks */}
      <aside className="w-72 shrink-0 border-l border-white/10 overflow-y-auto p-4 space-y-6">
        {/* Attributes */}
        <div>
          <div className="flex items-center justify-between mb-2">
            <h3 className="text-xs font-semibold text-gray-500 uppercase tracking-wider">Properties</h3>
            <button
              onClick={() => setShowAddAttr((v) => !v)}
              className="p-1 text-gray-500 hover:text-white transition-colors"
              title="Add property"
            >
              <Plus className="w-3.5 h-3.5" />
            </button>
          </div>

          {entry.attributes.length === 0 && !showAddAttr && (
            <p className="text-xs text-gray-600">No properties</p>
          )}

          {entry.attributes.map((attr) => (
            <AttributeRow
              key={attr.id}
              attr={attr}
              onDelete={(attrId) => removeAttrMutation.mutate(attrId)}
            />
          ))}

          {showAddAttr && (
            <div className="mt-2 space-y-2 p-2 bg-white/5 rounded-lg border border-white/10">
              <select
                value={newAttrType}
                onChange={(e) => setNewAttrType(e.target.value as 'label' | 'relation')}
                className="w-full text-xs bg-white/10 text-gray-300 rounded px-2 py-1 border border-white/10 focus:outline-none"
              >
                <option value="label">Label (key-value)</option>
                <option value="relation">Relation (links to entry)</option>
              </select>
              <input
                value={newAttrName}
                onChange={(e) => setNewAttrName(e.target.value)}
                placeholder={newAttrType === 'label' ? 'Property name (e.g. email)' : 'Relation (e.g. works_at)'}
                className="w-full text-xs bg-transparent border-b border-white/20 text-gray-200 focus:outline-none focus:border-trust-blue py-1"
              />
              <input
                value={newAttrValue}
                onChange={(e) => setNewAttrValue(e.target.value)}
                placeholder={newAttrType === 'label' ? 'Value' : 'Target entry ID or title'}
                className="w-full text-xs bg-transparent border-b border-white/20 text-gray-200 focus:outline-none focus:border-trust-blue py-1"
              />
              <div className="flex gap-2">
                <button
                  onClick={handleAddAttr}
                  disabled={addAttrMutation.isPending}
                  className="flex-1 py-1 bg-trust-blue text-white rounded text-xs hover:bg-trust-blue/90 disabled:opacity-50"
                >
                  Add
                </button>
                <button
                  onClick={() => setShowAddAttr(false)}
                  className="flex-1 py-1 text-gray-400 rounded text-xs border border-white/10 hover:border-white/30"
                >
                  Cancel
                </button>
              </div>
            </div>
          )}
        </div>

        {/* Backlinks */}
        {entry.backlinks.length > 0 && (
          <div>
            <h3 className="text-xs font-semibold text-gray-500 uppercase tracking-wider mb-2">
              Backlinks ({entry.backlinks.length})
            </h3>
            <div className="space-y-1">
              {entry.backlinks.map((bl) => {
                const BlIcon = TYPE_ICONS[bl.type] ?? FileText;
                return (
                  <Link
                    key={bl.id}
                    to={`/memory/${bl.id}`}
                    className="flex items-start gap-2 py-1.5 px-2 rounded hover:bg-white/5 group"
                  >
                    <BlIcon className="w-3.5 h-3.5 text-gray-500 shrink-0 mt-0.5" />
                    <div className="min-w-0">
                      <p className="text-sm text-gray-300 group-hover:text-white truncate">{bl.title}</p>
                      {bl.context && (
                        <p className="text-xs text-gray-600 truncate">{bl.context}</p>
                      )}
                    </div>
                  </Link>
                );
              })}
            </div>
          </div>
        )}
      </aside>
    </div>
  );
}
