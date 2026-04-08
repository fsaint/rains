import { useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { Database, DownloadCloud, RotateCcw, Plus, AlertTriangle, CheckCircle, Loader2 } from 'lucide-react';
import { backups, type BackupMetadata } from '../api/client';

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function formatDate(iso: string): string {
  return new Date(iso).toLocaleString();
}

// ============================================================================
// Restore Confirmation Modal
// ============================================================================

interface RestoreModalProps {
  backup: BackupMetadata;
  onConfirm: () => void;
  onCancel: () => void;
  isPending: boolean;
}

function RestoreModal({ backup, onConfirm, onCancel, isPending }: RestoreModalProps) {
  return (
    <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50">
      <div className="bg-white rounded-xl p-6 w-full max-w-md shadow-xl">
        <div className="flex items-center gap-3 mb-4">
          <div className="w-10 h-10 rounded-full bg-alert-red/10 flex items-center justify-center shrink-0">
            <AlertTriangle className="w-5 h-5 text-alert-red" />
          </div>
          <div>
            <h2 className="font-semibold text-gray-900">Restore from backup?</h2>
            <p className="text-sm text-gray-500">This will replace all current agent data.</p>
          </div>
        </div>

        <div className="bg-gray-50 rounded-lg p-4 mb-4 space-y-1 text-sm">
          <div className="flex justify-between">
            <span className="text-gray-500">Backup date</span>
            <span className="font-medium">{formatDate(backup.createdAt)}</span>
          </div>
          <div className="flex justify-between">
            <span className="text-gray-500">Agents</span>
            <span className="font-medium">{backup.agentCount}</span>
          </div>
          <div className="flex justify-between">
            <span className="text-gray-500">Size</span>
            <span className="font-medium">{formatBytes(backup.sizeBytes)}</span>
          </div>
        </div>

        <p className="text-sm text-gray-600 mb-6">
          A safety backup of the current state will be taken automatically before restoring.
          Running agents will not be interrupted — only database records are affected.
        </p>

        <div className="flex gap-3 justify-end">
          <button
            onClick={onCancel}
            disabled={isPending}
            className="px-4 py-2 text-sm font-medium text-gray-700 bg-gray-100 rounded-lg hover:bg-gray-200 disabled:opacity-50"
          >
            Cancel
          </button>
          <button
            onClick={onConfirm}
            disabled={isPending}
            className="flex items-center gap-2 px-4 py-2 text-sm font-medium text-white bg-alert-red rounded-lg hover:bg-red-700 disabled:opacity-50 transition-colors"
          >
            {isPending ? (
              <><Loader2 className="w-4 h-4 animate-spin" /> Restoring…</>
            ) : (
              <><RotateCcw className="w-4 h-4" /> Restore</>
            )}
          </button>
        </div>
      </div>
    </div>
  );
}

// ============================================================================
// Main Page
// ============================================================================

export default function Backups() {
  const queryClient = useQueryClient();
  const [confirmRestore, setConfirmRestore] = useState<BackupMetadata | null>(null);
  const [lastRestoreResult, setLastRestoreResult] = useState<{ safetyBackupId: string; agentCount: number } | null>(null);

  const { data, isLoading } = useQuery({
    queryKey: ['backups'],
    queryFn: () => backups.list(),
  });

  const createMutation = useMutation({
    mutationFn: () => backups.create(),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['backups'] }),
  });

  const restoreMutation = useMutation({
    mutationFn: (id: string) => backups.restore(id),
    onSuccess: (result, id) => {
      setConfirmRestore(null);
      setLastRestoreResult({
        safetyBackupId: result.safetyBackupId,
        agentCount: result.restored.agents,
      });
      queryClient.invalidateQueries({ queryKey: ['backups'] });
      void id;
    },
  });

  const backupList = data?.backups ?? [];

  return (
    <div className="p-6 max-w-4xl mx-auto">
      {/* Header */}
      <div className="flex items-center justify-between mb-6">
        <div className="flex items-center gap-3">
          <Database className="w-6 h-6 text-trust-blue" />
          <div>
            <h1 className="text-xl font-semibold text-reins-navy">Backups</h1>
            <p className="text-sm text-gray-500">Agent configuration snapshots — auto-taken every 24 hours</p>
          </div>
        </div>
        <button
          onClick={() => createMutation.mutate()}
          disabled={createMutation.isPending}
          className="flex items-center gap-2 px-4 py-2 bg-trust-blue text-white rounded-lg hover:bg-blue-600 disabled:opacity-50 transition-colors text-sm font-medium"
        >
          {createMutation.isPending ? (
            <Loader2 className="w-4 h-4 animate-spin" />
          ) : (
            <Plus className="w-4 h-4" />
          )}
          Create Backup
        </button>
      </div>

      {/* Restore success banner */}
      {lastRestoreResult && (
        <div className="mb-4 flex items-start gap-3 p-4 bg-safe-green/10 border border-safe-green/30 rounded-xl">
          <CheckCircle className="w-5 h-5 text-safe-green shrink-0 mt-0.5" />
          <div className="text-sm">
            <p className="font-medium text-safe-green">Restore complete</p>
            <p className="text-gray-600 mt-0.5">
              Restored {lastRestoreResult.agentCount} agent{lastRestoreResult.agentCount !== 1 ? 's' : ''}.
              Pre-restore safety backup saved as <code className="font-mono text-xs bg-gray-100 px-1 rounded">{lastRestoreResult.safetyBackupId}</code>.
            </p>
          </div>
          <button onClick={() => setLastRestoreResult(null)} className="ml-auto text-gray-400 hover:text-gray-600">✕</button>
        </div>
      )}

      {/* Backup list */}
      {isLoading ? (
        <div className="flex items-center justify-center py-16 text-gray-400">
          <Loader2 className="w-6 h-6 animate-spin" />
        </div>
      ) : backupList.length === 0 ? (
        <div className="text-center py-16 text-gray-400">
          <Database className="w-10 h-10 mx-auto mb-3 opacity-30" />
          <p>No backups yet. Create one to get started.</p>
        </div>
      ) : (
        <div className="bg-white rounded-xl border border-gray-200 overflow-hidden">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-gray-100 bg-gray-50">
                <th className="text-left px-4 py-3 text-xs font-semibold text-gray-500 uppercase tracking-wider">Date</th>
                <th className="text-left px-4 py-3 text-xs font-semibold text-gray-500 uppercase tracking-wider">Agents</th>
                <th className="text-left px-4 py-3 text-xs font-semibold text-gray-500 uppercase tracking-wider">Size</th>
                <th className="text-right px-4 py-3 text-xs font-semibold text-gray-500 uppercase tracking-wider">Actions</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-gray-100">
              {backupList.map((backup) => (
                <tr key={backup.id} className="hover:bg-gray-50 transition-colors">
                  <td className="px-4 py-3 font-medium text-gray-900">
                    {formatDate(backup.createdAt)}
                  </td>
                  <td className="px-4 py-3 text-gray-600">{backup.agentCount}</td>
                  <td className="px-4 py-3 text-gray-600">{formatBytes(backup.sizeBytes)}</td>
                  <td className="px-4 py-3">
                    <div className="flex items-center gap-2 justify-end">
                      <a
                        href={backups.downloadUrl(backup.id)}
                        download={`backup-${backup.id}.json`}
                        className="flex items-center gap-1 px-3 py-1.5 text-xs font-medium text-gray-600 bg-gray-100 rounded-lg hover:bg-gray-200 transition-colors"
                      >
                        <DownloadCloud className="w-3.5 h-3.5" />
                        Download
                      </a>
                      <button
                        onClick={() => setConfirmRestore(backup)}
                        className="flex items-center gap-1 px-3 py-1.5 text-xs font-medium text-alert-red bg-alert-red/10 rounded-lg hover:bg-alert-red/20 transition-colors"
                      >
                        <RotateCcw className="w-3.5 h-3.5" />
                        Restore
                      </button>
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {/* Restore confirmation modal */}
      {confirmRestore && (
        <RestoreModal
          backup={confirmRestore}
          onConfirm={() => restoreMutation.mutate(confirmRestore.id)}
          onCancel={() => setConfirmRestore(null)}
          isPending={restoreMutation.isPending}
        />
      )}
    </div>
  );
}
