import { createFileRoute } from '@tanstack/react-router'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { useRef, useState } from 'react'
import { IconArchive, IconDownload, IconUpload } from '@tabler/icons-react'
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
import { Confirm2FA } from '../../lib/Confirm2FA'

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

/** A pending privileged backup action awaiting the admin's own 2FA code. */
interface Pending2FA {
  label: string
  run: (code: string) => Promise<void>
}

async function errMsg(res: Response, fallback: string): Promise<string> {
  try {
    const j = await res.json()
    return (j as { error?: string }).error || fallback
  } catch {
    return fallback
  }
}

function BackupsPage() {
  const queryClient = useQueryClient()
  const fileInput = useRef<HTMLInputElement>(null)
  const [notice, setNotice] = useState('')
  const [error, setError] = useState('')
  const [pending2FA, setPending2FA] = useState<Pending2FA | null>(null)

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
      if (!res.ok) throw new Error(await errMsg(res, 'Failed to create backup'))
      return res.json()
    },
    onSuccess: () => {
      setNotice('Backup created.')
      setError('')
      queryClient.invalidateQueries({ queryKey: ['backups'] })
    },
    onError: (e: Error) => setError(e.message),
  })

  // Download streams the file; the server requires the actor's 2FA code.
  const download = (filename: string, code: string) => {
    const res = fetch('/api/backup/download', {
      method: 'POST',
      headers: { ...auth, 'Content-Type': 'application/json' },
      body: JSON.stringify({ filename, code }),
    }).then(async (r) => {
      if (!r.ok) throw new Error(await errMsg(r, 'Failed to download backup'))
      const blob = await r.blob()
      const url = URL.createObjectURL(blob)
      const a = document.createElement('a')
      a.href = url
      a.download = filename
      a.click()
      URL.revokeObjectURL(url)
    })
    return res
  }

  const confirmDownload = (filename: string) => {
    setPending2FA({
      label: `download backup ${filename}`,
      run: (code) => download(filename, code),
    })
  }

  // Restore from an existing server-side backup (2FA-gated).
  const restoreMutation = useMutation({
    mutationFn: async (a: { filename: string; code: string }) => {
      const res = await fetch('/api/backup/restore', {
        method: 'POST',
        headers: { ...auth, 'Content-Type': 'application/json' },
        body: JSON.stringify({ filename: a.filename, code: a.code }),
      })
      if (!res.ok) throw new Error(await errMsg(res, 'Failed to restore backup'))
      return res.json()
    },
    onSuccess: () => {
      setNotice('Backup restored. The API reloads data; refresh the page if needed.')
      setError('')
      queryClient.invalidateQueries({ queryKey: ['backups'] })
    },
    onError: (e: Error) => setError(e.message),
  })

  const confirmRestore = (filename: string) => {
    if (
      !confirm(
        `Restore backup "${filename}"?\n\nThe current database will be replaced with this backup. This cannot be undone — create a fresh backup first if you are unsure.`,
      )
    ) {
      return
    }
    setPending2FA({
      label: `restore backup ${filename} (replaces current data)`,
      run: (code) => restoreMutation.mutateAsync({ filename, code }).then(() => undefined),
    })
  }

  // Restore from an uploaded .sql.gz file (2FA-gated).
  const uploadMutation = useMutation({
    mutationFn: async (a: { file: File; code: string }) => {
      const fd = new FormData()
      fd.append('file', a.file)
      fd.append('code', a.code)
      const res = await fetch('/api/backup/restore-upload', {
        method: 'POST',
        headers: auth,
        body: fd,
      })
      if (!res.ok) throw new Error(await errMsg(res, 'Failed to restore uploaded backup'))
      return res.json()
    },
    onSuccess: () => {
      setNotice('Uploaded backup restored. The API reloads data; refresh the page if needed.')
      setError('')
      queryClient.invalidateQueries({ queryKey: ['backups'] })
    },
    onError: (e: Error) => setError(e.message),
  })

  const deleteMutation = useMutation({
    mutationFn: async (a: { filename: string; code: string }) => {
      const res = await fetch('/api/backup/delete', {
        method: 'POST',
        headers: { ...auth, 'Content-Type': 'application/json' },
        body: JSON.stringify({ filename: a.filename, code: a.code }),
      })
      if (!res.ok) throw new Error(await errMsg(res, 'Failed to delete backup'))
      return res.json()
    },
    onSuccess: () => {
      setNotice('Backup deleted.')
      setError('')
      queryClient.invalidateQueries({ queryKey: ['backups'] })
    },
    onError: (e: Error) => setError(e.message),
  })

  const confirmDelete = (filename: string) => {
    if (
      !confirm(
        `Delete backup "${filename}"?\n\nThis permanently removes the file from the console server. This cannot be undone.`,
      )
    ) {
      return
    }
    setPending2FA({
      label: `delete backup ${filename}`,
      run: (code) => deleteMutation.mutateAsync({ filename, code }).then(() => undefined),
    })
  }

  const backups = data?.backups ?? []
  const newest = backups[backups.length - 1] ?? ''

  const handlePickFile = (file?: File | null) => {
    if (!file) return
    if (!file.name.endsWith('.sql.gz')) {
      setError('Please pick a .sql.gz backup file exported from this console.')
      return
    }
    if (!confirm(`Restore from uploaded "${file.name}"?\n\nThe current database will be replaced.`)) {
      return
    }
    setError('')
    setPending2FA({
      label: `restore from uploaded file ${file.name} (replaces current data)`,
      run: (code) => uploadMutation.mutateAsync({ file, code }).then(() => undefined),
    })
  }

  return (
    <div>
      <PageHeader
        title="Backups"
        description="One-click database backups live on the console server (Docker volume, /var/backups/wgconsole). Creating one runs pg_dump; restoring replaces the current database with a saved copy. Downloading, restoring, uploading or deleting a backup requires your own 2FA code."
        actions={
          <PrimaryButton onClick={() => createMutation.mutate()} disabled={createMutation.isPending}>
            <IconArchive size={16} stroke={1.6} aria-hidden="true" />
            {createMutation.isPending ? 'Creating…' : 'Create backup now'}
          </PrimaryButton>
        }
      />

      {(createMutation.isError || restoreMutation.isError || deleteMutation.isError || uploadMutation.isError) && (
        <p className="text-red-400 text-sm mb-3">
          {createMutation.error?.message ||
            restoreMutation.error?.message ||
            deleteMutation.error?.message ||
            uploadMutation.error?.message}
        </p>
      )}
      {error && <p className="text-red-400 text-sm mb-3">{error}</p>}
      {notice && <p className="text-teal-400 text-sm mb-3">{notice}</p>}
      {createMutation.isSuccess && (
        <p className="text-teal-400 text-sm mb-3">Backup created — {newest || ''}</p>
      )}
      {restoreMutation.isSuccess && (
        <p className="text-teal-400 text-sm mb-3">
          Backup restored. The API restarts with the reloaded data; you may need to refresh.
        </p>
      )}

      <Panel
        title={`Saved backups (${backups.length})`}
        right={
          <GhostButton
            onClick={() => fileInput.current?.click()}
            disabled={uploadMutation.isPending}
          >
            <IconUpload size={15} stroke={1.6} aria-hidden="true" />
            {uploadMutation.isPending ? 'Restoring…' : 'Restore from upload'}
          </GhostButton>
        }
      >
        <input
          ref={fileInput}
          type="file"
          accept=".sql.gz,application/gzip"
          className="hidden"
          onChange={(e) => {
            handlePickFile(e.target.files?.[0])
            e.target.value = ''
          }}
        />

        {isLoading ? (
          <div className="p-5 space-y-3">
            <Skeleton className="h-10 w-full" />
            <Skeleton className="h-10 w-full" />
          </div>
        ) : backups.length === 0 ? (
          <EmptyState
            title="No backups yet"
            hint="Create your first backup with the button above, or restore from a .sql.gz file you exported earlier. Backups are stored inside the api container's persistent volume."
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
                        <GhostButton disabled={restoreMutation.isPending} onClick={() => confirmDownload(name)}>
                          <IconDownload size={14} stroke={1.6} aria-hidden="true" />
                          Download
                        </GhostButton>
                        <GhostButton disabled={restoreMutation.isPending} onClick={() => confirmRestore(name)}>
                          {restoreMutation.isPending ? 'Restoring…' : 'Restore'}
                        </GhostButton>
                        <ActionLink tone="danger" onClick={() => confirmDelete(name)}>
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
        (they live only on the Docker volume). Downloading a backup lets you keep an off-site copy;
        restoring wipes current data, so every destructive action asks for your 2FA code first.
      </p>

      {/* Step-up 2FA gate for backup actions */}
      <Confirm2FA
        open={pending2FA !== null}
        onClose={() => setPending2FA(null)}
        title="Confirm with 2FA"
        description={
          pending2FA
            ? `Enter your own authenticator code to ${pending2FA.label}.`
            : undefined
        }
        onSubmit={pending2FA ? pending2FA.run : null}
      />
    </div>
  )
}
