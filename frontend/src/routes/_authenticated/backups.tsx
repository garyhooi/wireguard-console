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
import { ConfirmMFA } from '../../lib/ConfirmMFA'
import { apiFetch, apiJson } from '../../lib/api'
import { useCan } from '../../lib/permissions'
import { isMFAError, useStepUpMinutes } from '../../lib/stepup'
import { getTimezone } from '../../lib/timezone'

interface BackupList {
  backups: string[]
}

export const Route = createFileRoute('/_authenticated/backups')({
  component: BackupsPage,
})


/**
 * The instant a backup was created, parsed from its filename. Backups are
 * named on the server with the API container's wall clock in UTC
 * (wgconsole_backup_YYYYMMDD_HHMMSS.sql.gz — no TZ is configured in the
 * container), so this is parsed as a UTC instant and re-rendered through
 * the console timezone when one is set (Configuration → Timezone) or the
 * viewer's browser zone otherwise.
 */
export function backupCreatedAt(name: string): string | null {
  const m = name.match(/wgconsole_backup_(\d{4})(\d{2})(\d{2})_(\d{2})(\d{2})(\d{2})/)
  if (!m) return null
  const [, y, mo, d, h, mi] = m
  // Trailing 'Z' makes the parse unambiguous: the embedded wall clock is UTC.
  return `${y}-${mo}-${d}T${h}:${mi}:00Z`
}

// "wgconsole_backup_20260903_120405.sql.gz" → "2026-09-03 12:04" in the
// console/browser timezone (falls back to the raw name when unparseable).
// The YYYY-MM-DD HH:MM layout is kept fixed (unambiguous, matches the rest of
// the console's tabular timestamps); only the instant is zone-converted.
export function backupLabel(name: string): string {
  const iso = backupCreatedAt(name)
  if (!iso) return name
  const z = getTimezone() || undefined
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: z,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
    hourCycle: 'h23',
  }).formatToParts(new Date(iso))
  const get = (t: Intl.DateTimeFormatPartTypes) => parts.find((p) => p.type === t)?.value ?? ''
  return `${get('year')}-${get('month')}-${get('day')} ${get('hour')}:${get('minute')}`
}

/** A pending privileged backup action awaiting the admin's own MFA step-up. */
interface PendingMFA {
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
  const [pendingMFA, setPendingMFA] = useState<PendingMFA | null>(null)

  // MFA step-up grace: try the action without a code first — the server
  // accepts it when this session already verified within the window (or a
  // fresh passkey step-up stamped it). Only when the server answers with an
  // MFA step-up error do we open the confirmation modal.
  const stepUpMinutes = useStepUpMinutes()
  const gateMFA = (label: string, run: (code: string) => Promise<void>) => {
    if (stepUpMinutes <= 0) {
      setPendingMFA({ label, run }) // grace off — ask immediately
      return
    }
    run('').catch((e) => {
      if (isMFAError(e)) {
        setPendingMFA({ label, run })
      } else {
        setError(e instanceof Error ? e.message : String(e))
      }
    })
  }

  const canManage = useCan('backups.manage')

  const { data, isLoading } = useQuery<BackupList>({
    queryKey: ['backups'],
    queryFn: async () => {
      return apiJson<BackupList>('/api/backup/list')
    },
  })

  const createMutation = useMutation({
    mutationFn: async () => {
      return apiJson('/api/backup/create', { method: 'POST' })
    },
    onSuccess: () => {
      setNotice('Backup created.')
      setError('')
      queryClient.invalidateQueries({ queryKey: ['backups'] })
    },
    onError: (e: Error) => setError(e.message),
  })

  // Download streams the file; the server requires the actor's MFA step-up.
  const download = (filename: string, code: string) => {
    return apiFetch('/api/backup/download', {
      method: 'POST',
      body: { filename, code },
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
  }

  const confirmDownload = (filename: string) => {
    gateMFA(`download backup ${filename}`, (code) => download(filename, code))
  }

  // Restore from an existing server-side backup (MFA step-up gated).
  const restoreMutation = useMutation({
    mutationFn: async (a: { filename: string; code: string }) => {
      return apiJson('/api/backup/restore', {
        method: 'POST',
        body: { filename: a.filename, code: a.code },
      })
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
    gateMFA(`restore backup ${filename} (replaces current data)`, (code) =>
      restoreMutation.mutateAsync({ filename, code }).then(() => undefined),
    )
  }

  // Restore from an uploaded .sql.gz file (MFA step-up gated).
  const uploadMutation = useMutation({
    mutationFn: async (a: { file: File; code: string }) => {
      const fd = new FormData()
      fd.append('file', a.file)
      fd.append('code', a.code)
      return apiJson('/api/backup/restore-upload', {
        method: 'POST',
        body: fd,
      })
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
      return apiJson('/api/backup/delete', {
        method: 'POST',
        body: { filename: a.filename, code: a.code },
      })
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
    gateMFA(`delete backup ${filename}`, (code) =>
      deleteMutation.mutateAsync({ filename, code }).then(() => undefined),
    )
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
    gateMFA(`restore from uploaded file ${file.name} (replaces current data)`, (code) =>
      uploadMutation.mutateAsync({ file, code }).then(() => undefined),
    )
  }

  return (
    <div>
      <PageHeader
        title="Backups"
        description="One-click database backups live on the console server (Docker volume, /var/backups/wgconsole). Creating one runs pg_dump; restoring replaces the current database with a saved copy. Downloading, restoring, uploading or deleting a backup requires an MFA step-up (passkey or authenticator code)."
        actions={canManage ? (
          <PrimaryButton onClick={() => createMutation.mutate()} disabled={createMutation.isPending}>
            <IconArchive size={16} stroke={1.6} aria-hidden="true" />
            {createMutation.isPending ? 'Creating…' : 'Create backup now'}
          </PrimaryButton>
        ) : undefined}
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
        right={canManage ? (
          <GhostButton
            onClick={() => fileInput.current?.click()}
            disabled={uploadMutation.isPending}
          >
            <IconUpload size={15} stroke={1.6} aria-hidden="true" />
            {uploadMutation.isPending ? 'Restoring…' : 'Restore from upload'}
          </GhostButton>
        ) : undefined}
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
            action={canManage ? (
              <PrimaryButton onClick={() => createMutation.mutate()} disabled={createMutation.isPending}>
                <IconArchive size={16} stroke={1.6} aria-hidden="true" />
                Create backup now
              </PrimaryButton>
            ) : undefined}
          />
        ) : (
          <div className="overflow-x-auto">
            <table className={tableCls}>
              <thead>
                <tr className="text-left text-[11px] uppercase tracking-wider text-zinc-500">
                  <th className={thCls}>Created</th>
                  <th className={thCls}>Filename</th>
                  {canManage && <th className={thCls + ' text-right'}>Actions</th>}
                </tr>
              </thead>
              <tbody className="divide-y divide-zinc-800/60">
                {[...backups].reverse().map((name) => (
                  <tr key={name} className="hover:bg-zinc-800/30 transition-colors">
                    <td className={tdCls + ' font-mono tabular-nums'}>{backupLabel(name)}</td>
                    <td className={tdCls + ' font-mono text-zinc-200'}>{name}</td>
                    {canManage && (
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
                    )}
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
        restoring wipes current data, so every destructive action asks for an MFA step-up first.
      </p>

      {/* Step-up MFA gate for backup actions */}
      <ConfirmMFA
        open={pendingMFA !== null}
        onClose={() => setPendingMFA(null)}
        title="Confirm with MFA"
        description={
          pendingMFA
            ? `Confirm this action with your passkey or an authenticator code to ${pendingMFA.label}.`
            : undefined
        }
        onSubmit={pendingMFA ? pendingMFA.run : null}
      />
    </div>
  )
}