import { createFileRoute } from '@tanstack/react-router'
import { apiFetch } from '../../lib/api'
import { useQuery } from '@tanstack/react-query'
import { useEffect, useState } from 'react'
import { IconCpu, IconDeviceDesktop, IconRefresh } from '@tabler/icons-react'
import {
  EmptyState,
  GhostButton,
  PageHeader,
  Panel,
  Skeleton,
  StatusBadge,
} from '../../lib/ui'

export const Route = createFileRoute('/_authenticated/monitoring')({
  component: MonitoringPage,
})

// ---------------------------------------------------------------------------
// API shapes (mirror the backend's metrics.Snapshot JSON)
// ---------------------------------------------------------------------------

interface Metrics {
  cpu?: { cores?: number | null; percent?: number | null }
  load?: (number | null)[]
  mem?: { total?: number | null; used?: number | null; percent?: number | null }
  swap?: { total?: number | null; used?: number | null; percent?: number | null }
  disk?: { mount: string; device: string; fs: string; total: number; used: number; percent?: number | null }[]
  net?: { interface: string; rx_bps?: number | null; tx_bps?: number | null }[]
  uptime_s?: number | null
  host?: {
    hostname?: string | null
    os?: string | null
    arch?: string | null
    kernel?: string | null
    agent_version?: string | null
  }
  collected_at?: string | null
}

interface Node {
  id: string
  name: string
  location: string
  status: string
  last_seen_at: string | null
  last_status: string
  server_count: number
  metrics?: Metrics
  metrics_at?: string | null
}

interface LocalStatus {
  hostname?: string
  is_local?: boolean
  metrics?: Metrics
  metrics_at?: string | null
}

function fetchJSON<T>(url: string): Promise<T> {
  return apiFetch(url).then((res) => {
    if (!res.ok) throw new Error(`Failed to fetch ${url} (${res.status})`)
    return res.json() as Promise<T>
  })
}

function isOnline(metricsAt?: string | null, lastSeenAt?: string | null): boolean {
  const ref = metricsAt ?? lastSeenAt
  if (!ref) return false
  return Date.now() - new Date(ref).getTime() < 60_000
}

// ---------------------------------------------------------------------------
// Formatting helpers
// ---------------------------------------------------------------------------

function formatBytes(bytes?: number | null): string {
  if (bytes === undefined || bytes === null || !Number.isFinite(bytes)) return '—'
  const k = 1024
  const sizes = ['B', 'KB', 'MB', 'GB', 'TB']
  if (bytes < k) return `${bytes} B`
  const i = Math.min(Math.floor(Math.log(bytes) / Math.log(k)), sizes.length - 1)
  return `${parseFloat((bytes / Math.pow(k, i)).toFixed(1))} ${sizes[i]}`
}

function fmtPct(p?: number | null): string {
  if (p === undefined || p === null || !Number.isFinite(p)) return '—'
  return `${p.toFixed(1)}%`
}

function formatUptime(sec?: number | null): string {
  if (sec === undefined || sec === null) return '—'
  const d = Math.floor(sec / 86400)
  const h = Math.floor((sec % 86400) / 3600)
  const m = Math.floor((sec % 3600) / 60)
  if (d > 0) return `${d}d ${h}h`
  if (h > 0) return `${h}h ${m}m`
  return `${m}m`
}

function freshTime(iso?: string | null): string {
  if (!iso) return ''
  const diff = Date.now() - new Date(iso).getTime()
  const s = Math.max(0, Math.floor(diff / 1000))
  if (s < 5) return 'just now'
  if (s < 60) return `${s}s ago`
  const m = Math.floor(s / 60)
  if (m < 60) return `${m}m ago`
  const h = Math.floor(m / 60)
  return `${h}h ago`
}

// ---------------------------------------------------------------------------
// Gauge
// ---------------------------------------------------------------------------

function gaugeTone(p: number): string {
  if (p >= 90) return 'bg-red-500'
  if (p >= 75) return 'bg-amber-500'
  return 'bg-teal-500'
}

function Meter({
  label,
  percent,
  detail,
}: {
  label: string
  percent?: number | null
  detail: string
}) {
  const value = percent ?? 0
  const p = Math.max(0, Math.min(100, value))
  const has = percent !== undefined && percent !== null && Number.isFinite(percent)
  return (
    <div>
      <div className="flex items-baseline justify-between gap-3 text-xs">
        <span className="text-zinc-400 truncate">{label}</span>
        <span className="text-zinc-500 font-mono tabular-nums shrink-0">{detail}</span>
      </div>
      <div className="mt-1.5 h-1.5 rounded-full bg-zinc-800 overflow-hidden">
        <div
          className={`h-full rounded-full ${gaugeTone(p)} transition-all duration-500`}
          style={{ width: `${has ? p : 0}%` }}
          role="progressbar"
          aria-valuenow={Math.round(p)}
          aria-valuemin={0}
          aria-valuemax={100}
          aria-label={label}
        />
      </div>
    </div>
  )
}

// ---------------------------------------------------------------------------
// Card: one machine
// ---------------------------------------------------------------------------

function StatLine({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex items-baseline justify-between gap-3 text-xs">
      <span className="text-zinc-600">{label}</span>
      <span className="text-zinc-400 font-mono tabular-nums text-right">{children}</span>
    </div>
  )
}

function MetricsCard({
  title,
  sub,
  online,
  lastStatus,
  serverCount,
  metrics,
  metricsAt,
  stale,
}: {
  title: string
  sub?: string
  online: boolean
  lastStatus?: string
  serverCount?: number
  metrics?: Metrics
  metricsAt?: string | null
  stale?: boolean
}) {
  const hasMetrics = !!metrics && (
    !!metrics.mem?.total ||
    (metrics.cpu?.percent ?? 0) > 0 ||
    (metrics.disk?.length ?? 0) > 0 ||
    !!metrics.uptime_s
  )
  const disks = metrics?.disk ?? []
  const opacity = stale ? 'opacity-60' : ''
  return (
    <Panel className={`flex flex-col ${opacity}`}>
      <header className="flex items-start justify-between gap-3 px-5 pt-4 pb-3 border-b border-zinc-800/60">
        <div className="min-w-0">
          <p className="text-sm font-medium text-zinc-100 flex items-center gap-2">
            {stale && <IconDeviceDesktop size={15} stroke={1.6} className="text-zinc-500 shrink-0" aria-hidden="true" />}
            <span className="truncate">{title}</span>
          </p>
          <p className="mt-0.5 text-xs text-zinc-500 truncate">
            {sub ? `${sub} · ` : ''}
            {serverCount !== undefined ? `${serverCount} WG server${serverCount === 1 ? '' : 's'}` : ''}
            {metricsAt ? ` · updated ${freshTime(metricsAt)}` : ''}
          </p>
        </div>
        <StatusBadge status={online ? 'ok' : stale ? 'warning' : 'error'} />
      </header>

      {!hasMetrics ? (
        <div className="px-5 py-6 text-sm text-zinc-500">
          <p>Waiting for agent metrics.</p>
          <p className="mt-1 text-xs text-zinc-600">
            Re-run the node install command to update the agent to a version that reports host metrics.
          </p>
        </div>
      ) : (
        <div className="px-5 py-4 space-y-4">
          <div className="space-y-3">
            <Meter
              label={`CPU${metrics?.cpu?.cores ? ` · ${metrics.cpu.cores} cores` : ''}`}
              percent={metrics?.cpu?.percent}
              detail={fmtPct(metrics?.cpu?.percent)}
            />
            <Meter
              label="Memory"
              percent={metrics?.mem?.percent}
              detail={
                metrics?.mem?.total
                  ? `${formatBytes(metrics.mem.used)} / ${formatBytes(metrics.mem.total)}`
                  : '—'
              }
            />
            {!!metrics?.swap?.total && metrics.swap.total > 0 && (
              <Meter
                label="Swap"
                percent={metrics.swap.percent}
                detail={`${formatBytes(metrics.swap.used)} / ${formatBytes(metrics.swap.total)}`}
              />
            )}
          </div>

          {(disks.length ?? 0) > 0 && (
            <div className="space-y-2.5 border-t border-zinc-800/60 pt-3">
              {disks.slice(0, 4).map((d) => (
                <Meter
                  key={d.mount + d.device}
                  label={d.mount === '/' ? 'Disk /' : `Disk ${d.mount}`}
                  percent={d.percent}
                  detail={`${formatBytes(d.used)} / ${formatBytes(d.total)}`}
                />
              ))}
              {disks.length > 4 && (
                <p className="text-[11px] text-zinc-600">
                  +{disks.length - 4} more mounts
                </p>
              )}
            </div>
          )}

          <div className="space-y-1.5 border-t border-zinc-800/60 pt-3">
            {(metrics?.load?.length ?? 0) > 0 && (
              <StatLine label="Load">
                {(metrics?.load ?? []).slice(0, 3).map((v, i) => (v === undefined || v === null ? '—' : v.toFixed(2))).join(' / ')}
              </StatLine>
            )}
            <StatLine label="Uptime">{formatUptime(metrics?.uptime_s)}</StatLine>
            {(metrics?.net?.length ?? 0) > 0 && (
              <StatLine label="Net">
                {(metrics?.net ?? []).slice(0, 2).map((n) => `${n.interface} ↓${formatBytes(n.rx_bps)}/s`).join('  ')}
              </StatLine>
            )}
            {metrics?.host?.agent_version && (
              <StatLine label="Agent">{metrics.host.agent_version}</StatLine>
            )}
            {metrics?.host?.kernel && (
              <StatLine label="Kernel">{metrics.host.kernel}</StatLine>
            )}
          </div>
        </div>
      )}

      {lastStatus && lastStatus !== 'ok' && lastStatus.trim() !== '' && (
        <footer className="px-5 py-2.5 bg-amber-500/5 border-t border-amber-500/15 text-xs text-amber-400/90">
          {lastStatus}
        </footer>
      )}
    </Panel>
  )
}

// ---------------------------------------------------------------------------
// Page
// ---------------------------------------------------------------------------

export function MonitoringPage() {
  // Tick every 5s so relative "updated Xs ago" labels stay fresh.
  const [, setTick] = useState(0)
  useEffect(() => {
    const t = setInterval(() => setTick((n) => n + 1), 5000)
    return () => clearInterval(t)
  }, [])

  const { data: nodes, isLoading: nodesLoading, refetch: refetchNodes } = useQuery<Node[]>({
    queryKey: ['nodes'],
    queryFn: () => fetchJSON<Node[]>('/api/nodes'),
    refetchInterval: 15000,
  })

  // Console host card: hide silently when wg-helper isn't reachable (dev
  // without the helper, or pre-monitoring helper).
  const { data: local, isLoading: localLoading, refetch: refetchLocal } = useQuery<LocalStatus | null>({
    queryKey: ['local-status'],
    queryFn: async () => {
      const res = await apiFetch('/api/nodes/local/status')
      if (res.status === 503) return null
      if (!res.ok) throw new Error('Failed to fetch local status')
      return res.json()
    },
    refetchInterval: 15000,
    retry: false,
  })

  const isLoading = nodesLoading && localLoading
  const refresh = () => {
    refetchNodes()
    refetchLocal()
    setTick((n) => n + 1)
  }

  return (
    <div>
      <PageHeader
        title="Server Monitoring"
        description="Live resource health of every WireGuard machine — remote nodes and the console host — refreshed every 15 seconds."
        actions={
          <GhostButton onClick={refresh}>
            <IconRefresh size={16} stroke={1.6} aria-hidden="true" />
            Refresh
          </GhostButton>
        }
      />

      {isLoading ? (
        <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-4">
          {Array.from({ length: 3 }).map((_, i) => (
            <div key={i} className="border border-zinc-800 rounded-lg bg-zinc-900/50 p-5 space-y-4">
              <Skeleton className="h-4 w-32" />
              <Skeleton className="h-3 w-24" />
              <Skeleton className="h-8 w-full" />
              <Skeleton className="h-8 w-full" />
            </div>
          ))}
        </div>
      ) : (nodes || []).length === 0 && !local ? (
        <EmptyState
          title="Nothing to monitor yet"
          hint="Add a node from the Nodes page or create a server on this host — its machine shows up here with CPU, memory and disk gauges."
        />
      ) : (
        <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-4">
          {/* Console host card pinned first */}
          {local?.metrics && (
            <MetricsCard
              title={local.hostname || 'Local host (console)'}
              sub="Console host"
              online={isOnline(local.metrics_at)}
              metrics={local.metrics}
              metricsAt={local.metrics_at}
            />
          )}

          {(nodes || []).map((node) => {
            const online = isOnline(node.metrics_at, node.last_seen_at)
            return (
              <MetricsCard
                key={node.id}
                title={node.name}
                sub={node.location || undefined}
                online={online}
                lastStatus={node.last_status}
                serverCount={node.server_count}
                metrics={node.metrics}
                metricsAt={node.metrics_at}
                stale={!online}
              />
            )
          })}
        </div>
      )}

      <p className="mt-4 text-xs text-zinc-600 flex items-center gap-1.5">
        <IconCpu size={13} stroke={1.6} aria-hidden="true" />
        Metrics are collected by the wg-helper agent on each machine and reported to this console every ~15s — no inbound ports required.
      </p>
    </div>
  )
}
