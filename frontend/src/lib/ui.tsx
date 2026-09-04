// Shared UI primitives for the console — one design system, one accent
// (teal-500/600), one radius scale (rounded-lg surfaces, rounded-md controls,
// rounded-full pills), one cool-neutral family (zinc-*).
//
// Data density > decoration: bordered surfaces over shadowed cards, hairline
// dividers over box shadows. Every interactive element has a visible focus
// ring, a 150-200ms transition, a tactile :active push, and is keyboard
// reachable. All status/scope/role pills use translucent dark tokens so they
// stay legible on dark surfaces (never light-theme badge colors).

import { useEffect, useRef } from 'react'

// ---------------------------------------------------------------------------
// Layout primitives
// ---------------------------------------------------------------------------

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
  description,
}: {
  children: React.ReactNode
  className?: string
  title?: string
  right?: React.ReactNode
  description?: string
}) {
  return (
    <section className={`border border-zinc-800 rounded-lg bg-zinc-900/50 overflow-hidden ${className}`}>
      {(title || right || description) && (
        <header className="flex items-start justify-between gap-4 px-5 pt-4 pb-2">
          <div className="min-w-0">
            {title && <h2 className="text-sm font-medium text-zinc-200">{title}</h2>}
            {description && <p className="mt-0.5 text-xs text-zinc-500">{description}</p>}
          </div>
          {right && <div className="shrink-0">{right}</div>}
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

// ---------------------------------------------------------------------------
// Pills / badges — translucent dark tokens, legible on dark surfaces
// ---------------------------------------------------------------------------

type PillTone = 'good' | 'warn' | 'bad' | 'info' | 'accent' | 'neutral'

function pillToneClass(tone: PillTone): string {
  const map: Record<PillTone, string> = {
    good: 'bg-teal-500/10 text-teal-400 ring-teal-500/25',
    warn: 'bg-amber-500/10 text-amber-400 ring-amber-500/25',
    bad: 'bg-red-500/10 text-red-400 ring-red-500/25',
    info: 'bg-sky-500/10 text-sky-400 ring-sky-500/25',
    accent: 'bg-violet-500/10 text-violet-400 ring-violet-500/25',
    neutral: 'bg-zinc-800 text-zinc-300 ring-zinc-700/60',
  }
  return map[tone]
}

export function Badge({
  children,
  tone = 'neutral',
  label,
}: {
  children: React.ReactNode
  tone?: PillTone
  label?: string
}) {
  return (
    <span
      className={`inline-flex items-center gap-1 px-2 py-0.5 text-xs font-medium rounded-full ring-1 ring-inset ${
        pillToneClass(tone)
      }`}
    >
      {label && <span className="lowercase opacity-80">{label}</span>}
      {children}
    </span>
  )
}

const STATUS_TONE: Record<string, PillTone> = {
  active: 'good',
  healthy: 'good',
  ok: 'good',
  connected: 'good',
  enabled: 'good',
  suspended: 'warn',
  invited: 'info',
  pending: 'info',
  warning: 'warn',
  disabled: 'bad',
  removed: 'bad',
  error: 'bad',
  failure: 'bad',
  manual: 'info',
  global: 'accent',
  super_admin: 'accent',
  admin: 'good',
  auditor: 'neutral',
}

export function StatusBadge({ status }: { status: string }) {
  const tone = status === 'active' ? 'good' : STATUS_TONE[status] || 'neutral'
  const display = status.replace(/_/g, ' ')
  return <Badge tone={tone}>{display}</Badge>
}

// ---------------------------------------------------------------------------
// Loading / empty states
// ---------------------------------------------------------------------------

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

// ---------------------------------------------------------------------------
// Buttons
// ---------------------------------------------------------------------------

const BTN_BASE =
  'inline-flex items-center justify-center gap-2 text-sm font-medium rounded-md transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-teal-500 focus-visible:ring-offset-2 focus-visible:ring-offset-zinc-950 active:translate-y-[1px] disabled:opacity-50 disabled:pointer-events-none disabled:active:translate-y-0'

export function PrimaryButton({
  children,
  onClick,
  disabled,
  type = 'button',
  className = '',
}: {
  children: React.ReactNode
  onClick?: () => void
  disabled?: boolean
  type?: 'button' | 'submit'
  className?: string
}) {
  return (
    <button
      type={type}
      onClick={onClick}
      disabled={disabled}
      className={`${BTN_BASE} bg-teal-700 hover:bg-teal-600 text-white py-2 px-4 ${className}`}
    >
      {children}
    </button>
  )
}

export function GhostButton({
  children,
  onClick,
  disabled,
  type = 'button',
  className = '',
}: {
  children: React.ReactNode
  onClick?: () => void
  disabled?: boolean
  type?: 'button' | 'submit'
  className?: string
}) {
  return (
    <button
      type={type}
      onClick={onClick}
      disabled={disabled}
      className={`${BTN_BASE} border border-zinc-700 hover:border-zinc-500 hover:text-zinc-100 text-zinc-300 py-2 px-4 ${className}`}
    >
      {children}
    </button>
  )
}

export function DangerButton({
  children,
  onClick,
  disabled,
  type = 'button',
  className = '',
}: {
  children: React.ReactNode
  onClick?: () => void
  disabled?: boolean
  type?: 'button' | 'submit'
  className?: string
}) {
  return (
    <button
      type={type}
      onClick={onClick}
      disabled={disabled}
      className={`${BTN_BASE} border border-red-500/40 hover:border-red-500/70 text-red-300 hover:text-red-200 py-2 px-4 ${className}`}
    >
      {children}
    </button>
  )
}

export function ActionLink({
  children,
  onClick,
  tone = 'default',
}: {
  children: React.ReactNode
  onClick?: () => void
  tone?: 'default' | 'danger' | 'accent'
}) {
  const tones: Record<string, string> = {
    default: 'text-zinc-400 hover:text-zinc-100 hover:bg-zinc-800/60',
    danger: 'text-red-400 hover:text-red-300 hover:bg-red-500/10',
    accent: 'text-teal-400 hover:text-teal-300 hover:bg-teal-500/10',
  }
  return (
    <button
      type="button"
      onClick={onClick}
      className={`inline-flex items-center gap-1 text-sm rounded-md px-2 py-1 transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-teal-500 ${tones[tone]}`}
    >
      {children}
    </button>
  )
}

// ---------------------------------------------------------------------------
// Form fields
// ---------------------------------------------------------------------------

export const inputCls =
  'w-full bg-zinc-800/60 border border-zinc-700 rounded-md px-3 py-2 text-sm text-zinc-100 placeholder:text-zinc-600 focus:outline-none focus:ring-2 focus:ring-teal-500 focus:border-teal-500 transition-colors'

export const labelCls = 'block text-sm font-medium text-zinc-400 mb-2'

// ---------------------------------------------------------------------------
// Modal — shared dialog with Escape-to-close, overlay, and body scroll lock
// ---------------------------------------------------------------------------

export function Modal({
  open,
  onClose,
  title,
  description,
  children,
  footer,
  className = '',
}: {
  open: boolean
  onClose: () => void
  title?: string
  description?: string
  children: React.ReactNode
  footer?: React.ReactNode
  className?: string
}) {
  const ref = useRef<HTMLDivElement>(null)
  // Keep the latest onClose without making the focus/scroll-lock effect
  // re-run on every parent render. Callers pass a fresh inline arrow each
  // render (e.g. () => setShowX(false)); if onClose were a dependency, the
  // effect would re-run on every keystroke and refocus() would yank the
  // caret out of whatever input the user is typing in.
  const onCloseRef = useRef(onClose)
  useEffect(() => {
    onCloseRef.current = onClose
  })
  // True once the dialog has been focused; reset in the effect cleanup when
  // the modal closes, so the next closed→open transition focuses again.
  const hasFocused = useRef(false)

  useEffect(() => {
    if (!open) return
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onCloseRef.current()
    }
    document.addEventListener('keydown', onKey)
    document.body.style.overflow = 'hidden'
    // Focus the dialog only on the closed→open transition, not on re-renders
    // (typing in a field re-renders the parent, which would steal focus).
    if (!hasFocused.current) {
      ref.current?.focus()
      hasFocused.current = true
    }
    return () => {
      document.removeEventListener('keydown', onKey)
      document.body.style.overflow = ''
      hasFocused.current = false
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps -- onClose deliberately omitted
  }, [open])

  if (!open) return null

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4">
      <div
        className="absolute inset-0 bg-zinc-950/70 backdrop-blur-sm"
        onClick={onClose}
        aria-hidden="true"
      />
      <div
        ref={ref}
        tabIndex={-1}
        role="dialog"
        aria-modal="true"
        aria-label={title}
        className={`relative w-full bg-zinc-900 border border-zinc-800 rounded-xl shadow-2xl max-h-[90dvh] overflow-y-auto focus:outline-none ${
          className || 'max-w-lg'
        }`}
      >
        {(title || description) && (
          <div className="px-6 pt-6 pb-2">
            {title && <h2 className="text-lg font-semibold text-zinc-100">{title}</h2>}
            {description && <p className="mt-1 text-sm text-zinc-400 leading-relaxed">{description}</p>}
          </div>
        )}
        <div className="px-6 py-4">{children}</div>
        {footer && <div className="px-6 pb-6 pt-2 flex justify-end gap-3">{footer}</div>}
      </div>
    </div>
  )
}

// ---------------------------------------------------------------------------
// Table / toolbar style constants (shared so every table reads the same)
// ---------------------------------------------------------------------------

export const tableWrapCls =
  'w-full overflow-x-auto border border-zinc-800 rounded-lg bg-zinc-900/50'

export const tableCls = 'min-w-full divide-y divide-zinc-800/80'

export const thCls =
  'px-5 py-2.5 text-left text-[11px] font-medium uppercase tracking-wider text-zinc-500 whitespace-nowrap'

export const tdCls = 'px-5 py-3.5 whitespace-nowrap text-sm text-zinc-400'

// Toolbar used above tables: tabs + search + meta
export const toolbarCls = 'mb-4 flex flex-wrap items-center gap-3'

export const tabGroupCls = 'inline-flex rounded-lg border border-zinc-700 overflow-hidden'

export function toolbarTab(
  active: boolean,
  activeCls: string,
): string {
  return `px-3 py-1.5 text-xs font-medium transition-colors ${
    active ? activeCls : 'bg-zinc-900 text-zinc-400 hover:text-zinc-100'
  }`
}

export const searchCls =
  'bg-zinc-800/60 border border-zinc-700 rounded-md px-3 py-1.5 text-sm text-zinc-100 placeholder:text-zinc-600 focus:outline-none focus:ring-2 focus:ring-teal-500'
