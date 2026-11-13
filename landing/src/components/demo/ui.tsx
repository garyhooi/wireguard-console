"use client";

import {
  useEffect,
  useRef,
  useState,
  type ButtonHTMLAttributes,
  type ReactNode,
} from "react";
import { createPortal } from "react-dom";
import {
  IconAlertCircle,
  IconCheck,
  IconCircleCheck,
  IconCopy,
  IconInfoCircle,
  IconX,
} from "@tabler/icons-react";
import { cn } from "@/lib/cn";
import type { Toast, ToastTone } from "@/components/demo/data";

// ---------------------------------------------------------------------------
// Layout primitives, copied from the console UI kit so the demo reads as the
// same product: zinc surfaces, one teal accent, rounded-lg panels,
// rounded-md controls, rounded-full pills.
// ---------------------------------------------------------------------------

export function PageHeader({
  title,
  description,
  actions,
  action,
}: {
  title: string;
  description?: string;
  actions?: ReactNode;
  action?: ReactNode;
}) {
  const trailing = actions ?? action;
  return (
    <div className="mb-8 flex flex-wrap items-end justify-between gap-4">
      <div>
        <h1 className="text-xl font-semibold tracking-tight text-zinc-100 md:text-2xl">
          {title}
        </h1>
        {description && (
          <p className="mt-1 max-w-[65ch] text-sm leading-relaxed text-dim">
            {description}
          </p>
        )}
      </div>
      {trailing && <div className="flex items-center gap-3">{trailing}</div>}
    </div>
  );
}

export function Panel({
  children,
  className = "",
  title,
  right,
  description,
}: {
  children: ReactNode;
  className?: string;
  title?: string;
  right?: ReactNode;
  description?: string;
}) {
  return (
    <section
      className={cn(
        "overflow-hidden rounded-lg border border-zinc-800 bg-zinc-900/50",
        className,
      )}
    >
      {(title || right || description) && (
        <header className="flex items-start justify-between gap-4 px-5 pb-2 pt-4">
          <div className="min-w-0">
            {title && <h2 className="text-sm font-medium text-zinc-200">{title}</h2>}
            {description && (
              <p className="mt-0.5 text-xs text-dim">{description}</p>
            )}
          </div>
          {right && <div className="shrink-0">{right}</div>}
        </header>
      )}
      {children}
    </section>
  );
}

export function Stat({
  label,
  value,
  sub,
  tone = "default",
}: {
  label: string;
  value: ReactNode;
  sub?: string;
  tone?: "default" | "good" | "warn" | "bad";
}) {
  const tones: Record<string, string> = {
    default: "text-zinc-100",
    good: "text-teal-400",
    warn: "text-amber-400",
    bad: "text-red-400",
  };
  return (
    <div className="px-5 py-4">
      <p className="text-xs uppercase tracking-wider text-dim">{label}</p>
      <p
        className={cn(
          "mt-2 font-mono text-2xl font-semibold tabular-nums md:text-3xl",
          tones[tone],
        )}
      >
        {value}
      </p>
      {sub && <p className="mt-1 text-xs text-dim">{sub}</p>}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Pills and badges
// ---------------------------------------------------------------------------

type PillTone = "good" | "warn" | "bad" | "info" | "accent" | "neutral";

function pillToneClass(tone: PillTone): string {
  const map: Record<PillTone, string> = {
    good: "bg-teal-500/10 text-teal-400 ring-teal-500/25",
    warn: "bg-amber-500/10 text-amber-400 ring-amber-500/25",
    bad: "bg-red-500/10 text-red-400 ring-red-500/25",
    info: "bg-sky-500/10 text-sky-400 ring-sky-500/25",
    accent: "bg-violet-500/10 text-violet-400 ring-violet-500/25",
    neutral: "bg-zinc-800 text-zinc-300 ring-zinc-700/60",
  };
  return map[tone];
}

export function Badge({
  children,
  tone = "neutral",
  label,
  className,
}: {
  children: ReactNode;
  tone?: PillTone;
  label?: string;
  className?: string;
}) {
  return (
    <span
      className={cn(
        "inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-xs font-medium ring-1 ring-inset",
        pillToneClass(tone),
        className,
      )}
    >
      {label && <span className="lowercase opacity-80">{label}</span>}
      {children}
    </span>
  );
}

const STATUS_TONE: Record<string, PillTone> = {
  active: "good",
  healthy: "good",
  ok: "good",
  connected: "good",
  enabled: "good",
  suspended: "warn",
  invited: "info",
  pending: "info",
  joining: "warn",
  warning: "warn",
  disabled: "bad",
  removed: "bad",
  error: "bad",
  failure: "bad",
  manual: "info",
  global: "accent",
};

export function StatusBadge({
  status,
  label,
  className,
}: {
  status?: string | null;
  label?: string;
  className?: string;
}) {
  const value = status || "";
  const tone = value === "active" ? "good" : STATUS_TONE[value] || "neutral";
  const display = label ?? value.replace(/_/g, " ");
  return (
    <Badge tone={tone} className={className}>
      {display || "not set"}
    </Badge>
  );
}

export function EmptyState({
  title,
  hint,
  action,
}: {
  title: string;
  hint?: string;
  action?: ReactNode;
}) {
  return (
    <div className="flex flex-col items-center justify-center px-6 py-16 text-center">
      <div className="flex h-10 w-10 items-center justify-center rounded-full border border-dashed border-zinc-700 text-lg text-dim">
        +
      </div>
      <p className="mt-4 text-sm font-medium text-zinc-300">{title}</p>
      {hint && <p className="mt-1 max-w-sm text-sm text-dim">{hint}</p>}
      {action && <div className="mt-5">{action}</div>}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Buttons
// ---------------------------------------------------------------------------

const BTN_BASE =
  "inline-flex items-center justify-center gap-2 rounded-md text-sm font-medium transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-teal-500 focus-visible:ring-offset-2 focus-visible:ring-offset-zinc-950 active:translate-y-px disabled:pointer-events-none disabled:opacity-50 disabled:active:translate-y-0";

type ActionButtonProps = ButtonHTMLAttributes<HTMLButtonElement>;

export function PrimaryButton({
  children,
  className,
  type = "button",
  ...props
}: ActionButtonProps) {
  return (
    <button
      type={type}
      className={cn(
        BTN_BASE,
        "bg-teal-700 px-4 py-2 text-white hover:bg-teal-600",
        className,
      )}
      {...props}
    >
      {children}
    </button>
  );
}

export function GhostButton({
  children,
  className,
  type = "button",
  ...props
}: ActionButtonProps) {
  return (
    <button
      type={type}
      className={cn(
        BTN_BASE,
        "border border-zinc-700 px-4 py-2 text-zinc-300 hover:border-zinc-500 hover:text-zinc-100",
        className,
      )}
      {...props}
    >
      {children}
    </button>
  );
}

export function DangerButton({
  children,
  className,
  type = "button",
  ...props
}: ActionButtonProps) {
  return (
    <button
      type={type}
      className={cn(
        BTN_BASE,
        "border border-red-500/40 px-4 py-2 text-red-300 hover:border-red-500/70 hover:text-red-200",
        className,
      )}
      {...props}
    >
      {children}
    </button>
  );
}

export function ActionLink({
  children,
  onClick,
  tone = "default",
  className,
  ...props
}: ActionButtonProps & {
  tone?: "default" | "danger" | "accent";
}) {
  const tones: Record<string, string> = {
    default: "text-zinc-400 hover:bg-zinc-800/60 hover:text-zinc-100",
    danger: "text-red-400 hover:bg-red-500/10 hover:text-red-300",
    accent: "text-teal-400 hover:bg-teal-500/10 hover:text-teal-300",
  };
  return (
    <button
      type="button"
      onClick={onClick}
      className={cn(
        "inline-flex items-center gap-1 rounded-md px-2 py-1 text-sm transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-teal-500",
        tones[tone],
        className,
      )}
      {...props}
    >
      {children}
    </button>
  );
}

// ---------------------------------------------------------------------------
// Form primitives
// ---------------------------------------------------------------------------

export const inputCls =
  "w-full rounded-md border border-zinc-700 bg-zinc-800/60 px-3 py-2 text-sm text-zinc-100 placeholder:text-dim transition-colors focus:border-teal-500 focus:outline-none focus:ring-2 focus:ring-teal-500";

export const selectCls = cn(inputCls, "text-sm");
export const selectInlineCls = cn(
  inputCls.replace("w-full ", ""),
  "w-auto text-sm",
);

export const labelCls = "mb-2 block text-sm font-medium text-zinc-400";

export function Field({
  label,
  htmlFor,
  hint,
  error,
  children,
}: {
  label: string;
  htmlFor: string;
  hint?: string;
  error?: string;
  children: ReactNode;
}) {
  return (
    <div>
      <label htmlFor={htmlFor} className={labelCls}>
        {label}
      </label>
      {children}
      {hint && !error && (
        <p className="mt-1 text-xs leading-relaxed text-dim">{hint}</p>
      )}
      {error && (
        <p role="alert" className="mt-1 text-xs leading-relaxed text-red-400">
          {error}
        </p>
      )}
    </div>
  );
}

export function CopyButton({
  value,
  label = "Copy",
  className,
}: {
  value: string;
  label?: string;
  className?: string;
}) {
  const [copied, setCopied] = useState(false);
  const timer = useRef<number | null>(null);

  useEffect(
    () => () => {
      if (timer.current) window.clearTimeout(timer.current);
    },
    [],
  );

  async function copy() {
    try {
      await navigator.clipboard.writeText(value);
    } catch {
      const area = document.createElement("textarea");
      area.value = value;
      area.setAttribute("readonly", "");
      area.style.position = "fixed";
      area.style.opacity = "0";
      document.body.appendChild(area);
      area.select();
      document.execCommand("copy");
      document.body.removeChild(area);
    }
    setCopied(true);
    if (timer.current) window.clearTimeout(timer.current);
    timer.current = window.setTimeout(() => setCopied(false), 1800);
  }

  return (
    <GhostButton onClick={copy} className={cn("shrink-0", className)}>
      {copied ? (
        <IconCheck size={14} stroke={1.8} aria-hidden="true" />
      ) : (
        <IconCopy size={14} stroke={1.7} aria-hidden="true" />
      )}
      {copied ? "Copied" : label}
    </GhostButton>
  );
}

// ---------------------------------------------------------------------------
// Modal, portal, Escape, body lock, focus restore
// ---------------------------------------------------------------------------

const FOCUSABLE =
  'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';

export function Modal({
  open,
  onClose,
  title,
  description,
  children,
  footer,
  className = "",
}: {
  open: boolean;
  onClose: () => void;
  title?: string;
  description?: string;
  children: ReactNode;
  footer?: ReactNode;
  className?: string;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const onCloseRef = useRef(onClose);
  useEffect(() => {
    onCloseRef.current = onClose;
  });

  useEffect(() => {
    if (!open) return;
    const previous = document.activeElement as HTMLElement | null;
    const bodyOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        onCloseRef.current();
        return;
      }
      if (event.key !== "Tab" || !ref.current) return;
      const items = Array.from(
        ref.current.querySelectorAll<HTMLElement>(FOCUSABLE),
      ).filter((element) => element.offsetParent !== null);
      if (!items.length) return;
      const first = items[0];
      const last = items[items.length - 1];
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
      }
    };
    const frame = window.requestAnimationFrame(() => {
      const target =
        ref.current?.querySelector<HTMLElement>("[data-autofocus]") ??
        ref.current?.querySelector<HTMLElement>("input, select, textarea") ??
        ref.current;
      target?.focus();
    });
    document.addEventListener("keydown", onKey);
    return () => {
      window.cancelAnimationFrame(frame);
      document.removeEventListener("keydown", onKey);
      document.body.style.overflow = bodyOverflow;
      previous?.focus?.();
    };
  }, [open]);

  if (!open) return null;

  const dialog = (
    <div className="fixed inset-0 z-50 overflow-y-auto overscroll-contain">
      <div
        aria-hidden="true"
        className="absolute inset-0 bg-zinc-950/70 backdrop-blur-sm"
        onClick={onClose}
      />
      <div className="pointer-events-none flex min-h-full items-center justify-center p-4">
        <div
          ref={ref}
          tabIndex={-1}
          role="dialog"
          aria-modal="true"
          aria-label={title}
          className={cn(
            "pointer-events-auto relative max-h-[90dvh] w-full overflow-y-auto rounded-xl border border-zinc-800 bg-zinc-900 shadow-2xl focus:outline-none",
            className || "max-w-lg",
          )}
        >
          {(title || description) && (
            <div className="px-6 pb-2 pt-6">
              {title && (
                <h2 className="text-lg font-semibold text-zinc-100">{title}</h2>
              )}
              {description && (
                <p className="mt-1 text-sm leading-relaxed text-zinc-400">
                  {description}
                </p>
              )}
            </div>
          )}
          <div className="px-6 py-4">{children}</div>
          {footer && (
            <div className="flex flex-wrap justify-end gap-3 px-6 pb-6 pt-2">
              {footer}
            </div>
          )}
        </div>
      </div>
    </div>
  );

  if (typeof document === "undefined") return dialog;
  return createPortal(dialog, document.body);
}

// ---------------------------------------------------------------------------
// Tables / toolbar
// ---------------------------------------------------------------------------

export const tableWrapCls =
  "w-full overflow-x-auto rounded-lg border border-zinc-800 bg-zinc-900/50";
export const tableCls = "min-w-full divide-y divide-zinc-800/80";
export const thCls =
  "whitespace-nowrap px-5 py-2.5 text-left text-[11px] font-medium uppercase tracking-wider text-dim";
export const tdCls = "whitespace-nowrap px-5 py-3.5 text-sm text-zinc-400";
export const toolbarCls = "mb-4 flex flex-wrap items-center gap-3";
export const tabGroupCls =
  "inline-flex overflow-hidden rounded-lg border border-zinc-700";
export function toolbarTab(active: boolean, activeCls: string) {
  return cn(
    "px-3 py-1.5 text-xs font-medium transition-colors",
    active ? activeCls : "bg-zinc-900 text-zinc-400 hover:text-zinc-100",
  );
}
export const searchCls =
  "rounded-md border border-zinc-700 bg-zinc-800/60 px-3 py-1.5 text-sm text-zinc-100 placeholder:text-dim focus:outline-none focus:ring-2 focus:ring-teal-500";

// ---------------------------------------------------------------------------
// Toasts, styled like the console surfaces
// ---------------------------------------------------------------------------

const toastTone: Record<ToastTone, { border: string; icon: ReactNode }> = {
  success: {
    border: "border-teal-500/25",
    icon: <IconCircleCheck size={16} stroke={1.8} className="text-teal-400" />,
  },
  info: {
    border: "border-zinc-700",
    icon: <IconInfoCircle size={16} stroke={1.8} className="text-zinc-400" />,
  },
  danger: {
    border: "border-red-500/30",
    icon: <IconAlertCircle size={16} stroke={1.8} className="text-red-400" />,
  },
};

export function ToastRegion({
  toasts,
  onDismiss,
}: {
  toasts: Toast[];
  onDismiss: (id: number) => void;
}) {
  return (
    <div
      aria-live="polite"
      aria-atomic="false"
      className="pointer-events-none fixed bottom-20 right-5 z-[60] flex w-[min(360px,calc(100vw-2.5rem))] flex-col gap-2"
    >
      {toasts.map((toast) => (
        <div
          key={toast.id}
          role="status"
          className={cn(
            "pointer-events-auto flex items-start gap-3 rounded-lg border bg-zinc-900 px-4 py-3 shadow-2xl shadow-black/40",
            toastTone[toast.tone].border,
          )}
        >
          <span className="mt-0.5 shrink-0">{toastTone[toast.tone].icon}</span>
          <p className="flex-1 text-sm leading-relaxed text-zinc-200">
            {toast.message}
          </p>
          <button
            type="button"
            onClick={() => onDismiss(toast.id)}
            aria-label="Dismiss notification"
            className="-mr-1 -mt-1 flex h-6 w-6 shrink-0 items-center justify-center rounded-md text-dim transition-colors hover:bg-zinc-800 hover:text-zinc-200"
          >
            <IconX size={14} stroke={1.8} />
          </button>
        </div>
      ))}
    </div>
  );
}