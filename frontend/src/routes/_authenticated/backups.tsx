import { createFileRoute } from '@tanstack/react-router'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { useEffect, useRef, useState } from 'react'
import { IconArchive, IconDownload, IconLoader2, IconLock, IconShieldCheck, IconUpload } from '@tabler/icons-react'
import {
  ActionLink,
  Badge,
  EmptyState,
  GhostButton,
  Modal,
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

interface BackupDetail {
  encrypted: boolean
  verified: boolean
  verified_known: boolean
  verified_at?: string
  size: number
}

interface BackupList {
  backups: string[]
  details?: Record<string, BackupDetail>
  backup_passphrase_enabled?: boolean
}

interface CreateBackupResponse {
  status: string
  filename: string
  encrypted: boolean
  verified: boolean
  size: number
  verification_warning?: string
}

const CREATE_STAGES = [
  'Snapshotting the PostgreSQL database…',
  'Compressing the archive…',
  'Encrypting with the backup passphrase when enabled…',
  'Verifying the backup by restoring it into a temporary database…',
]

export function formatBytes(bytes?: number): string {
  if (typeof bytes !== 'number' || !Number.isFinite(bytes) || bytes < 0) return '—'
  if (bytes < 1024) return `${Math.round(bytes)} B`
  const units = ['KB', 'MB', 'GB', 'TB']
  let value = bytes / 1024
  let unit = 0
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024
    unit++
  }
  return `${value >= 10 ? value.toFixed(0) : value.toFixed(1)} ${units[unit]}`
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
  const [createStage, setCreateStage] = useState(0)

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
      return apiJson<CreateBackupResponse>('/api/backup/create', { method: 'POST', skipGlobalLoading: true })
    },
    onSuccess: (result) => {
      if (result.verified) {
        const protection = result.encrypted ? 'passphrase-encrypted and ' : ''
        setNotice(
          `Backup ${result.filename} created — ${protection}restore-verified (${formatBytes(result.size)}).`,
        )
        setError('')
      } else {
        setNotice('')
        setError(
          result.verification_warning ||
            'Backup was created, but the automatic restore check failed. Check the server logs before relying on it.',
        )
      }
      queryClient.invalidateQueries({ queryKey: ['backups'] })
    },
    onError: (e: Error) => {
      setNotice('')
      setError(e.message)
    },
  })

  useEffect(() => {
    if (!createMutation.isPending) {
      setCreateStage(0)
      return
    }
    setCreateStage(0)
    const timer = setInterval(() => {
      setCreateStage((current) => Math.min(current + 1, CREATE_STAGES.length - 1))
    }, 4000)
    return () => clearInterval(timer)
  }, [createMutation.isPending])

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

  // Restore from an uploaded plain or passphrase-encrypted backup (MFA-gated).
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

  const handlePickFile = (file?: File | null) => {
    if (!file) return
    if (!file.name.endsWith('.sql.gz') && !file.name.endsWith('.sql.gz.enc')) {
      setError('Please pick a .sql.gz or .sql.gz.enc backup file exported from this console.')
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
        description="One-click database backups live on the console server (Docker volume, /var/backups/wgconsole). Creating one runs pg_dump, encrypts it when backup encryption is enabled, and restores it into a temporary database to verify it before reporting success. Downloading, restoring, uploading or deleting a backup requires an MFA step-up (passkey or authenticator code)."
        actions={canManage ? (
          <PrimaryButton onClick={() => createMutation.mutate()} disabled={createMutation.isPending}>
            <IconArchive size={16} stroke={1.6} aria-hidden="true" />
            {createMutation.isPending ? 'Creating & verifying…' : 'Create backup now'}
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
      {restoreMutation.isSuccess && (
        <p className="text-teal-400 text-sm mb-3">
          Backup restored. The API restarts with the reloaded data; you may need to refresh.
        </p>
      )}
      {data?.backup_passphrase_enabled && (
        <p className="mb-3 inline-flex items-center gap-1.5 text-xs text-teal-400">
          <IconLock size={13} stroke={1.7} aria-hidden="true" />
          New backups are passphrase-encrypted.
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
          accept=".sql.gz,.sql.gz.enc,.gz,.enc,application/gzip,application/x-gzip,application/octet-stream"
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
            hint="Create your first backup with the button above, or restore from a .sql.gz or .sql.gz.enc file you exported earlier. Backups are stored inside the api container's persistent volume."
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
                  <th className={thCls}>Size</th>
                  <th className={thCls}>Protection</th>
                  <th className={thCls}>Verification</th>
                  {canManage && <th className={thCls + ' text-right'}>Actions</th>}
                </tr>
              </thead>
              <tbody className="divide-y divide-zinc-800/60">
                {[...backups].reverse().map((name) => {
                  const detail = data?.details?.[name]
                  const encrypted = detail?.encrypted ?? name.endsWith('.enc')
                  return (
                  <tr key={name} className="hover:bg-zinc-800/30 transition-colors">
                    <td className={tdCls + ' font-mono tabular-nums'}>{backupLabel(name)}</td>
                    <td className={tdCls + ' font-mono text-zinc-200'}>{name}</td>
                    <td className={tdCls + ' font-mono tabular-nums'}>{formatBytes(detail?.size)}</td>
                    <td className={tdCls}>
                      <Badge tone={encrypted ? 'good' : 'neutral'}>
                        {encrypted && <IconLock size={12} stroke={1.7} aria-hidden="true" />}
                        {encrypted ? 'Encrypted' : 'Plain'}
                      </Badge>
                    </td>
                    <td className={tdCls}>
                      {detail?.verified ? (
                        <span title={detail.verified_at ? `Verified ${new Date(detail.verified_at).toLocaleString()}` : 'Verified'}>
                          <Badge tone="good">
                            <IconShieldCheck size={12} stroke={1.7} aria-hidden="true" />
                            Verified
                          </Badge>
                        </span>
                      ) : detail?.verified_known ? (
                        <Badge tone="bad">Unverified</Badge>
                      ) : (
                        <span className="text-xs text-zinc-600" title="Created before verification metadata was recorded">—</span>
                      )}
                    </td>
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
                  )
                })}
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

      <Modal
        open={createMutation.isPending}
        onClose={() => {}}
        title="Creating and verifying backup"
        className="max-w-md"
      >
        <div role="status" aria-live="polite" className="space-y-5">
          <div className="flex items-start gap-3">
            <IconLoader2 size={28} stroke={1.8} className="mt-0.5 shrink-0 animate-spin text-teal-400" aria-hidden="true" />
            <div>
              <p className="text-sm font-medium text-zinc-100">{CREATE_STAGES[createStage]}</p>
              <p className="mt-1 text-xs leading-relaxed text-zinc-500">
                The archive is dumped, encrypted when configured, then restored into a
                temporary database. This can take a while on a large database.
              </p>
            </div>
          </div>
          <div className="h-1.5 overflow-hidden rounded-full bg-zinc-800">
            <div className="h-full w-1/3 animate-pulse rounded-full bg-teal-500" />
          </div>
          <div className="grid grid-cols-4 gap-1.5">
            {CREATE_STAGES.map((_, i) => (
              <span
                key={i}
                className={`h-1 rounded-full ${i <= createStage ? 'bg-teal-500' : 'bg-zinc-700'} ${i === createStage ? 'animate-pulse' : ''}`}
              />
            ))}
          </div>
          <p className="text-xs leading-relaxed text-zinc-600">
            Keep this tab open. The backup is only reported as successful after the restore check
            finishes.
          </p>
        </div>
      </Modal>

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