import { useEffect, useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { IconCloud, IconDatabase, IconShieldCheck } from '@tabler/icons-react'
import {
  Badge,
  GhostButton,
  PrimaryButton,
  inputCls,
  labelCls,
} from '../lib/ui'
import { apiJson } from '../lib/api'
import { useCan } from '../lib/permissions'
import { fmtDate } from '../lib/timezone'

interface S3Settings {
  enabled: boolean
  endpoint: string
  region: string
  bucket: string
  prefix: string
  access_key_id: string
  secret_set: boolean
  session_token_set: boolean
  force_path_style: boolean
}

interface BackupSchedule {
  interval_hours: number
  retention_count: number
  last_auto_at?: string
}

interface BackupSettings {
  s3: S3Settings
  schedule: BackupSchedule
}

const EMPTY_S3: S3Settings = {
  enabled: false,
  endpoint: '',
  region: 'us-east-1',
  bucket: '',
  prefix: 'wireguard-console/backups',
  access_key_id: '',
  secret_set: false,
  session_token_set: false,
  force_path_style: false,
}

const INTERVALS = [
  { value: 0, label: 'Off — manual only' },
  { value: 1, label: 'Every hour' },
  { value: 6, label: 'Every 6 hours' },
  { value: 12, label: 'Every 12 hours' },
  { value: 24, label: 'Every day' },
  { value: 72, label: 'Every 3 days' },
  { value: 168, label: 'Every week' },
  { value: 720, label: 'Every 30 days' },
]

export function BackupStorageSettings() {
  const queryClient = useQueryClient()
  const canWrite = useCan('system.manage')
  const [s3, setS3] = useState<S3Settings>(EMPTY_S3)
  const [secret, setSecret] = useState('')
  const [sessionToken, setSessionToken] = useState('')
  const [interval, setIntervalHours] = useState(0)
  const [retention, setRetention] = useState(0)
  const [notice, setNotice] = useState('')
  const [error, setError] = useState('')

  const { data, isLoading, isError } = useQuery<BackupSettings>({
    queryKey: ['backup-settings'],
    queryFn: () => apiJson<BackupSettings>('/api/config/backup-settings'),
  })

  useEffect(() => {
    if (!data) return
    setS3(data.s3)
    setIntervalHours(data.schedule.interval_hours)
    setRetention(data.schedule.retention_count)
  }, [data])

  const saveS3 = useMutation({
    mutationFn: async () =>
      apiJson<{ s3: S3Settings }>('/api/config/backup-settings/s3', {
        method: 'PATCH',
        body: {
          ...s3,
          secret_access_key: secret || undefined,
          session_token: sessionToken || undefined,
        },
      }),
    onSuccess: (result) => {
      setS3(result.s3)
      setSecret('')
      setSessionToken('')
      setNotice(
        result.s3.enabled
          ? 'S3 settings saved. New backups will be uploaded to the configured bucket.'
          : 'S3 destination disabled. New backups stay local only.',
      )
      setError('')
      queryClient.invalidateQueries({ queryKey: ['backups'] })
    },
    onError: (e: Error) => {
      setError(e.message)
      setNotice('')
    },
  })

  const testS3 = useMutation({
    mutationFn: async () =>
      apiJson<{ status: string }>('/api/config/backup-settings/s3/test', {
        method: 'POST',
        body: {
          ...s3,
          secret_access_key: secret || undefined,
          session_token: sessionToken || undefined,
        },
      }),
    onSuccess: () => {
      setNotice('S3 connection verified: list, put, get and delete all work.')
      setError('')
    },
    onError: (e: Error) => {
      setError(e.message)
      setNotice('')
    },
  })

  const saveSchedule = useMutation({
    mutationFn: async () =>
      apiJson('/api/config/backup-settings/schedule', {
        method: 'PATCH',
        body: { interval_hours: interval, retention_count: retention },
      }),
    onSuccess: () => {
      setNotice(
        interval > 0
          ? 'Automatic backup schedule saved.'
          : 'Automatic backups disabled.',
      )
      setError('')
      queryClient.invalidateQueries({ queryKey: ['backup-settings'] })
    },
    onError: (e: Error) => {
      setError(e.message)
      setNotice('')
    },
  })

  const updateS3 = (patch: Partial<S3Settings>) => setS3((current) => ({ ...current, ...patch }))
  const retentionValid = Number.isFinite(retention) && retention >= 0 && retention <= 100
  const scheduleDirty =
    !!data &&
    (interval !== data.schedule.interval_hours || retention !== data.schedule.retention_count)

  return (
    <div className="max-w-3xl space-y-6">
      {error && <p className="text-red-400 text-sm">{error}</p>}
      {notice && <p className="text-teal-400 text-sm">{notice}</p>}

      <div className="rounded-lg border border-zinc-800 bg-zinc-900/50 p-6">
        <div className="mb-1 flex items-center gap-2">
          <IconCloud size={18} stroke={1.6} className="text-zinc-400" aria-hidden="true" />
          <h2 className="text-base font-semibold text-zinc-100">S3-compatible destination</h2>
        </div>
        <p className="mb-4 text-sm leading-relaxed text-zinc-400">
          Every new backup is uploaded to this bucket after its restore check. Leave the
          endpoint empty for AWS S3, or use any S3-compatible provider (MinIO, R2,
          Backblaze B2, Wasabi). Local archives are kept for the one-click restore list.
        </p>

        {isLoading ? (
          <p className="text-sm text-zinc-400">Loading…</p>
        ) : isError ? (
          <p className="text-sm text-red-400">Failed to load backup storage settings.</p>
        ) : (
          <div className="space-y-4">
            <label className="flex cursor-pointer items-start gap-3 rounded-md border border-zinc-800 bg-zinc-950/30 p-3">
              <input
                type="checkbox"
                className="mt-0.5 h-4 w-4 accent-teal-500"
                checked={s3.enabled}
                disabled={!canWrite}
                onChange={(e) => updateS3({ enabled: e.target.checked })}
              />
              <span>
                <span className="block text-sm text-zinc-200">Upload backups to S3</span>
                <span className="block text-xs leading-relaxed text-zinc-500">
                  Applies to manual and automatic backups. Retention removes the matching
                  S3 objects as well as local files.
                </span>
              </span>
            </label>

            <div className="grid gap-4 sm:grid-cols-2">
              <div>
                <label htmlFor="s3Endpoint" className={labelCls}>Endpoint</label>
                <input
                  id="s3Endpoint"
                  className={inputCls}
                  value={s3.endpoint}
                  disabled={!canWrite}
                  onChange={(e) => updateS3({ endpoint: e.target.value })}
                  placeholder="https://s3.example.com (blank for AWS)"
                />
              </div>
              <div>
                <label htmlFor="s3Region" className={labelCls}>Region</label>
                <input
                  id="s3Region"
                  className={inputCls}
                  value={s3.region}
                  disabled={!canWrite}
                  onChange={(e) => updateS3({ region: e.target.value })}
                  placeholder="us-east-1"
                />
              </div>
              <div>
                <label htmlFor="s3Bucket" className={labelCls}>Bucket</label>
                <input
                  id="s3Bucket"
                  className={inputCls}
                  value={s3.bucket}
                  disabled={!canWrite}
                  onChange={(e) => updateS3({ bucket: e.target.value })}
                  placeholder="my-wireguard-backups"
                />
              </div>
              <div>
                <label htmlFor="s3Prefix" className={labelCls}>Object prefix</label>
                <input
                  id="s3Prefix"
                  className={inputCls}
                  value={s3.prefix}
                  disabled={!canWrite}
                  onChange={(e) => updateS3({ prefix: e.target.value })}
                  placeholder="wireguard-console/backups"
                />
              </div>
              <div>
                <label htmlFor="s3AccessKey" className={labelCls}>Access key ID</label>
                <input
                  id="s3AccessKey"
                  className={inputCls}
                  value={s3.access_key_id}
                  disabled={!canWrite}
                  onChange={(e) => updateS3({ access_key_id: e.target.value })}
                  placeholder="Leave blank for the container credential chain"
                  autoComplete="off"
                />
              </div>
              <div>
                <label htmlFor="s3SecretKey" className={labelCls}>Secret access key</label>
                <input
                  id="s3SecretKey"
                  type="password"
                  className={inputCls}
                  value={secret}
                  disabled={!canWrite}
                  onChange={(e) => setSecret(e.target.value)}
                  placeholder={s3.secret_set ? 'Stored — leave blank to keep' : 'Secret access key'}
                  autoComplete="new-password"
                />
              </div>
              <div>
                <label htmlFor="s3SessionToken" className={labelCls}>Session token (optional)</label>
                <input
                  id="s3SessionToken"
                  type="password"
                  className={inputCls}
                  value={sessionToken}
                  disabled={!canWrite}
                  onChange={(e) => setSessionToken(e.target.value)}
                  placeholder={s3.session_token_set ? 'Stored — leave blank to keep' : 'For temporary credentials'}
                  autoComplete="new-password"
                />
              </div>
              <label className="flex items-start gap-3 self-end rounded-md border border-zinc-800 bg-zinc-950/30 p-3">
                <input
                  type="checkbox"
                  className="mt-0.5 h-4 w-4 accent-teal-500"
                  checked={s3.force_path_style}
                  disabled={!canWrite}
                  onChange={(e) => updateS3({ force_path_style: e.target.checked })}
                />
                <span>
                  <span className="block text-sm text-zinc-200">Force path-style URLs</span>
                  <span className="block text-xs leading-relaxed text-zinc-500">
                    Usually needed for MinIO and some self-hosted gateways.
                  </span>
                </span>
              </label>
            </div>

            <div className="rounded-md border border-zinc-800 bg-zinc-950/30 p-3 text-xs leading-relaxed text-zinc-500">
              <div className="mb-1 flex items-center gap-1.5 text-zinc-300">
                <IconShieldCheck size={14} stroke={1.7} aria-hidden="true" />
                Required S3 permissions
              </div>
              <code className="block break-all font-mono text-[11px] text-zinc-400">
                s3:ListBucket on the bucket; s3:GetObject, s3:PutObject, s3:DeleteObject on
                bucket/prefix/*
              </code>
              <p className="mt-1.5">
                The test button checks list, put, get and delete with a temporary object.
                Credentials are encrypted at rest and never returned by the API.
              </p>
            </div>

            <div className="flex flex-wrap gap-3">
              <PrimaryButton
                onClick={() => saveS3.mutate()}
                disabled={!canWrite || saveS3.isPending}
              >
                {saveS3.isPending ? 'Saving…' : 'Save S3 settings'}
              </PrimaryButton>
              <GhostButton
                onClick={() => testS3.mutate()}
                disabled={!canWrite || testS3.isPending}
              >
                {testS3.isPending ? 'Testing…' : 'Test connection'}
              </GhostButton>
              {s3.secret_set && <Badge tone="good">Secret stored</Badge>}
              {s3.session_token_set && <Badge tone="neutral">Token stored</Badge>}
            </div>
          </div>
        )}
      </div>

      <div className="rounded-lg border border-zinc-800 bg-zinc-900/50 p-6">
        <div className="mb-1 flex items-center gap-2">
          <IconDatabase size={18} stroke={1.6} className="text-zinc-400" aria-hidden="true" />
          <h2 className="text-base font-semibold text-zinc-100">Automatic backups &amp; retention</h2>
        </div>
        <p className="mb-4 text-sm leading-relaxed text-zinc-400">
          Schedule a backup independently of manual creates. Retention applies after every
          backup; <span className="text-zinc-300">0</span> keeps every archive. When S3 is
          enabled, matching remote objects are deleted too. If verification or the S3
          upload fails, retention pauses to protect older copies.
        </p>

        {isLoading ? (
          <p className="text-sm text-zinc-400">Loading…</p>
        ) : isError ? (
          <p className="text-sm text-red-400">Failed to load the backup schedule.</p>
        ) : (
          <div className="space-y-4">
            <div className="grid gap-4 sm:grid-cols-2">
              <div>
                <label htmlFor="backupInterval" className={labelCls}>Backup interval</label>
                <select
                  id="backupInterval"
                  className={inputCls}
                  value={interval}
                  disabled={!canWrite}
                  onChange={(e) => setIntervalHours(Number(e.target.value))}
                >
                  {INTERVALS.map((item) => (
                    <option key={item.value} value={item.value}>{item.label}</option>
                  ))}
                </select>
              </div>
              <div>
                <label htmlFor="backupRetention" className={labelCls}>Keep last N backups</label>
                <input
                  id="backupRetention"
                  type="number"
                  min={0}
                  max={100}
                  className={inputCls}
                  value={retention}
                  disabled={!canWrite}
                  onChange={(e) => setRetention(Number(e.target.value))}
                />
                <p className="mt-1 text-xs text-zinc-600">0 = unlimited; max 100.</p>
              </div>
            </div>

            {data?.schedule.last_auto_at && (
              <p className="text-xs text-zinc-500">
                Last automatic attempt: {fmtDate(data.schedule.last_auto_at)}
              </p>
            )}

            <div className="flex flex-wrap items-center gap-3">
              <PrimaryButton
                onClick={() => saveSchedule.mutate()}
                disabled={!canWrite || !retentionValid || !scheduleDirty || saveSchedule.isPending}
              >
                {saveSchedule.isPending ? 'Saving…' : 'Save schedule'}
              </PrimaryButton>
              {!canWrite && <span className="text-xs text-zinc-500">Read-only access.</span>}
              {!retentionValid && <span className="text-xs text-amber-400">Retention must be 0–100.</span>}
            </div>
          </div>
        )}
      </div>
    </div>
  )
}
