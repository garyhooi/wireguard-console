// Shared UI primitives for the console — one design system, one accent
// (teal), one radius scale (rounded-lg surfaces, rounded-md controls).
// Data density > decoration: bordered sections over shadowed cards.

export function PageHeader({
  title,
  description,
  actions,
}: {
  title: string
  description?: string
  actions?: React.ReactNode
}) {
  return (
    <div className="flex flex-wrap items-end justify-between gap-4 mb-8">
      <div>
        <h1 className="text-xl md:text-2xl font-semibold tracking-tight text-zinc-100">{title}</h1>
        {description && (
          <p className="mt-1 text-sm text-zinc-500 max-w-[65ch] leading-relaxed">{description}</p>
        )}
      </div>
      {actions && <div className="flex items-center gap-3">{actions}</div>}
    </div>
  )
}

export function Panel({
  children,
  className = '',
  title,
  right,
}: {
  children: React.ReactNode
  className?: string
  title?: string
  right?: React.ReactNode
}) {
  return (
    <section className={`bg-zinc-900/60 border border-zinc-800 rounded-lg ${className}`}>
      {title && (
        <header className="flex items-center justify-between px-5 pt-4 pb-1">
          <h2 className="text-sm font-medium text-zinc-300">{title}</h2>
          {right}
        </header>
      )}
      {children}
    </section>
  )
}

export function Stat({
  label,
  value,
  sub,
  tone = 'default',
}: {
  label: string
  value: React.ReactNode
  sub?: string
  tone?: 'default' | 'good' | 'warn' | 'bad'
}) {
  const tones: Record<string, string> = {
    default: 'text-zinc-100',
    good: 'text-teal-400',
    warn: 'text-amber-400',
    bad: 'text-red-400',
  }
  return (
    <div className="px-5 py-4">
      <p className="text-xs uppercase tracking-wider text-zinc-500">{label}</p>
      <p className={`mt-2 text-2xl md:text-3xl font-semibold tabular-nums font-mono ${tones[tone]}`}>
        {value}
      </p>
      {sub && <p className="mt-1 text-xs text-zinc-500">{sub}</p>}
    </div>
  )
}

export function StatusBadge({ status }: { status: string }) {
  const map: Record<string, string> = {
    active: 'bg-teal-500/10 text-teal-400 border-teal-500/30',
    healthy: 'bg-teal-500/10 text-teal-400 border-teal-500/30',
    suspended: 'bg-amber-500/10 text-amber-400 border-amber-500/30',
    invited: 'bg-sky-500/10 text-sky-400 border-sky-500/30',
    removed: 'bg-red-500/10 text-red-400 border-red-500/30',
    disabled: 'bg-red-500/10 text-red-400 border-red-500/30',
    ok: 'bg-teal-500/10 text-teal-400 border-teal-500/30',
    warning: 'bg-amber-500/10 text-amber-400 border-amber-500/30',
    error: 'bg-red-500/10 text-red-400 border-red-500/30',
  }
  return (
    <span
      className={`px-2 py-0.5 inline-flex items-center text-xs font-medium rounded-full border ${
        map[status] || 'bg-zinc-800 text-zinc-400 border-zinc-700'
      }`}
    >
      {status}
    </span>
  )
}

export function Skeleton({ className = '' }: { className?: string }) {
  return <div className={`wgc-skeleton rounded-md ${className}`} aria-hidden="true" />
}

export function EmptyState({
  title,
  hint,
  action,
}: {
  title: string
  hint?: string
  action?: React.ReactNode
}) {
  return (
    <div className="flex flex-col items-center justify-center px-6 py-16 text-center">
      <div className="h-10 w-10 rounded-full border border-dashed border-zinc-700 flex items-center justify-center text-zinc-600 text-lg">
        +
      </div>
      <p className="mt-4 text-sm font-medium text-zinc-300">{title}</p>
      {hint && <p className="mt-1 text-sm text-zinc-500 max-w-sm">{hint}</p>}
      {action && <div className="mt-5">{action}</div>}
    </div>
  )
}

export function PrimaryButton({
  children,
  onClick,
  disabled,
  type = 'button',
}: {
  children: React.ReactNode
  onClick?: () => void
  disabled?: boolean
  type?: 'button' | 'submit'
}) {
  return (
    <button
      type={type}
      onClick={onClick}
      disabled={disabled}
      className="inline-flex items-center gap-2 bg-teal-600 hover:bg-teal-500 active:translate-y-[1px] disabled:opacity-50 disabled:pointer-events-none text-white text-sm font-medium py-2 px-4 rounded-md transition-colors"
    >
      {children}
    </button>
  )
}

export function GhostButton({
  children,
  onClick,
  disabled,
}: {
  children: React.ReactNode
  onClick?: () => void
  disabled?: boolean
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      className="inline-flex items-center gap-2 bg-transparent border border-zinc-700 hover:border-zinc-500 hover:text-zinc-100 active:translate-y-[1px] disabled:opacity-50 disabled:pointer-events-none text-zinc-300 text-sm font-medium py-2 px-4 rounded-md transition-colors"
    >
      {children}
    </button>
  )
}

export const inputCls =
  'w-full bg-zinc-800/60 border border-zinc-700 rounded-md px-3 py-2 text-sm text-zinc-100 placeholder:text-zinc-600 focus:outline-none focus:ring-2 focus:ring-teal-500 focus:border-teal-500 transition-colors'

export const labelCls = 'block text-sm font-medium text-zinc-400 mb-2'