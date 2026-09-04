import { createFileRoute } from '@tanstack/react-router'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { IconArchive } from '@tabler/icons-react'
import {
  ActionLink,
  EmptyState,
  GhostButton,
  PageHeader,
  Panel,
  PrimaryButton,
  Skeleton,
  tableCls,
  tableWrapCls,
  tdCls,
  thCls,
} from '../../lib/ui'

interface BackupList {
  backups: string[]
}

export const Route = createFileRoute('/_authenticated/backups')({
  component: BackupsPage,
})

const auth = { Authorization: localStorage.getItem('token')! }

// "wgconsole_backup_20260903_120405.sql.gz" → "2026-09-03 12:04"
function backupLabel(name: string): string {
  const m = name.match(/wgconsole_backup_(\d{4})(\d{2})(\d{2})_(\d{2})(\d{2})(\d{2})/)
  if (!m) return name
  const [, y, mo, d, h, mi] = m
  return `${y}-${mo}-${d} ${h}:${mi}`
}

function BackupsPage() {
  const queryClient = useQueryClient()

  const { data, isLoading } = useQuery<BackupList>({
    queryKey: ['backups'],
    queryFn: async () => {
      const res = await fetch('/api/backup/list', { headers: auth })
      if (!res.ok) throw new Error('Failed to load backups')
      return res.json()
    },
  })

  const createMutation = useMutation({
    mutationFn: async () => {
      const res = await fetch('/api/backup/create', { method: 'POST', headers: auth })
      if (!res.ok) {
        const err = await res.json().catch(() => ({}))
        throw new Error(err.error || 'Failed to create backup')
      }
      return res.json()
    },
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['backups'] }),
  })

  const restoreMutation = useMutation({
    mutationFn: async (filename: string) => {
      const res = await fetch('/api/backup/restore', {
        method: 'POST',
        headers: { ...auth, 'Content-Type': 'application/json' },
        body: JSON.stringify({ filename }),
      })
      if (!res.ok) {
        const err = await res.json().catch(() => ({}))
        throw new Error(err.error || 'Failed to restore backup')
      }
      return res.json()
    },
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['backups'] }),
  })

  const deleteMutation = useMutation({
    mutationFn: async (filename: string) => {
      const res = await fetch('/api/backup/delete', {
        method: 'POST',
        headers: { ...auth, 'Content-Type': 'application/json' },
        body: JSON.stringify({ filename }),
      })
      if (!res.ok) {
        const err = await res.json().catch(() => ({}))
        throw new Error(err.error || 'Failed to delete backup')
      }
      return res.json()
    },
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['backups'] }),
  })

  const backups = data?.backups ?? []
  const newest = backups[backups.length - 1] ?? ''

  const doRestore = (name: string) => {
    if (
      confirm(
        `Restore backup "${name}"?\n\nThe current database will be replaced with this backup. This cannot be undone — create a fresh backup first if you are unsure.`,
      )
    ) {
      restoreMutation.mutate(name)
    }
  }

  return (
    <div>
      <PageHeader
        title="Backups"
        description="One-click database backups live on the console server (Docker volume, /var/backups/wgconsole). Creating one runs pg_dump; restoring replaces the current database with a saved copy."
        actions={
          <PrimaryButton onClick={() => createMutation.mutate()} disabled={createMutation.isPending}>
            <IconArchive size={16} stroke={1.6} aria-hidden="true" />
            {createMutation.isPending ? 'Creating…' : 'Create backup now'}
          </PrimaryButton>
        }
      />

      {(createMutation.isError || restoreMutation.isError || deleteMutation.isError) && (
        <p className="text-red-400 text-sm mb-3">
          {createMutation.error?.message || restoreMutation.error?.message || deleteMutation.error?.message}
        </p>
      )}
      {createMutation.isSuccess && (
        <p className="text-teal-400 text-sm mb-3">Backup created — {newest || ''}</p>
      )}
      {restoreMutation.isSuccess && (
        <p className="text-teal-400 text-sm mb-3">
          Backup restored. The API restarts with the reloaded data; you may need to refresh.
        </p>
      )}

      <Panel title={`Saved backups (${backups.length})`}>
        {isLoading ? (
          <div className="p-5 space-y-3">
            <Skeleton className="h-10 w-full" />
            <Skeleton className="h-10 w-full" />
          </div>
        ) : backups.length === 0 ? (
          <EmptyState
            title="No backups yet"
            hint="Create your first backup with the button above. Backups are stored inside the api container's persistent volume."
            action={
              <PrimaryButton onClick={() => createMutation.mutate()} disabled={createMutation.isPending}>
                <IconArchive size={16} stroke={1.6} aria-hidden="true" />
                Create backup now
              </PrimaryButton>
            }
          />
        ) : (
          <div className="overflow-x-auto">
            <table className={tableCls}>
              <thead>
                <tr className="text-left text-[11px] uppercase tracking-wider text-zinc-500">
                  <th className={thCls}>Created</th>
                  <th className={thCls}>Filename</th>
                  <th className={thCls + ' text-right'}>Actions</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-zinc-800/60">
                {[...backups].reverse().map((name) => (
                  <tr key={name} className="hover:bg-zinc-800/30 transition-colors">
                    <td className={tdCls + ' font-mono tabular-nums'}>{backupLabel(name)}</td>
                    <td className={tdCls + ' font-mono text-zinc-200'}>{name}</td>
                    <td className="px-5 py-3.5 text-right">
                      <div className="flex justify-end gap-1">
                        <GhostButton disabled={restoreMutation.isPending} onClick={() => doRestore(name)}>
                          {restoreMutation.isPending ? 'Restoring…' : 'Restore'}
                        </GhostButton>
                        <ActionLink
                          tone="danger"
                          onClick={() => {
                            if (
                              confirm(
                                `Delete backup "${name}"?\n\nThis permanently removes the file from the console server. This cannot be undone.`,
                              )
                            )
                              deleteMutation.mutate(name)
                          }}
                        >
                          {deleteMutation.isPending ? 'Deleting…' : 'Delete'}
                        </ActionLink>
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Panel>

      <p className="mt-4 text-xs text-zinc-600 max-w-3xl leading-relaxed">
        Tip: back up before major changes, and copy backups off this server for disaster recovery
        (they live only on the Docker volume). Restoring wipes current data, so the UI asks for
        confirmation first.
      </p>
    </div>
  )
}
