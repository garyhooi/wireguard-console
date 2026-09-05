// Email templates editor section — a picker of the console's outbound email
// templates, each editable in a dual-mode editor (visual rich text or raw
// HTML source). Keeps a local draft per template and only hits the PATCH
// endpoint when the admin explicitly saves.

import { useEffect, useMemo, useRef, useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import {
  IconAlertCircle,
  IconCheck,
  IconDeviceDesktop,
  IconDeviceFloppy,
  IconMailOpened,
  IconTemplate,
  IconUserPlus,
  IconUserShield,
} from '@tabler/icons-react'
import { GhostButton, inputCls, labelCls, PrimaryButton } from '../lib/ui'
import { RichTextEditor } from '../lib/RichTextEditor'

interface EmailTemplate {
  key: string
  subject: string
  body: string
  updated_at: string
}

interface TemplateMeta {
  label: string
  description: string
  placeholders: string[]
  icon: React.ComponentType<{ size?: number; stroke?: number; className?: string }>
}

// Metadata is static per key; the list itself comes from the API so newly
// seeded template keys (e.g. future migrations) still appear with a sane
// fallback label.
const TEMPLATE_META: Record<string, TemplateMeta> = {
  user_invite: {
    label: 'User invite',
    description: 'Sent when an admin invites a VPN user to claim their account.',
    placeholders: ['{{full_name}}', '{{invite_link}}'],
    icon: IconUserPlus,
  },
  admin_invite: {
    label: 'Admin invite',
    description: 'Sent with the initial admin password, and on admin password resets.',
    placeholders: ['{{console_url}}', '{{email}}', '{{password}}'],
    icon: IconUserShield,
  },
  peer_config: {
    label: 'Peer configuration',
    description: 'Delivers the secure, expiring link to download a peer config.',
    placeholders: ['{{full_name}}', '{{peer_name}}', '{{config_link}}'],
    icon: IconDeviceDesktop,
  },
}

function metaFor(key: string): TemplateMeta {
  return (
    TEMPLATE_META[key] ?? {
      label: key,
      description: 'Custom email template',
      placeholders: [],
      icon: IconMailOpened,
    }
  )
}

function formatUpdatedAt(iso: string): string {
  if (!iso) return ''
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return ''
  return d.toLocaleString(undefined, {
    dateStyle: 'medium',
    timeStyle: 'short',
  })
}

export function EmailTemplatesSection() {
  const queryClient = useQueryClient()
  const authH = useMemo(
    () => ({ Authorization: localStorage.getItem('token') || '' }),
    [],
  )

  const { data: templates, isLoading } = useQuery<EmailTemplate[]>({
    queryKey: ['email-templates'],
    queryFn: async () => {
      const res = await fetch('/api/config/email-templates', { headers: authH })
      if (!res.ok) throw new Error('Failed to load email templates')
      return res.json()
    },
  })

  const [selectedKey, setSelectedKey] = useState<string | null>(null)
  // Drafts are kept per template key so switching between templates (or the
  // SMTP tab) never discards unsaved typing.
  const [drafts, setDrafts] = useState<Record<string, { subject: string; body: string }>>({})
  const [savedKeys, setSavedKeys] = useState<Set<string>>(new Set())
  const [flash, setFlash] = useState<{ tone: 'ok' | 'err'; text: string } | null>(null)
  const flashTimer = useRef<ReturnType<typeof setTimeout> | null>(null)

  // Seed drafts once the API returns.
  useEffect(() => {
    if (!templates) return
    setDrafts((prev) => {
      const next = { ...prev }
      for (const t of templates) {
        if (!next[t.key]) next[t.key] = { subject: t.subject, body: t.body }
      }
      return next
    })
    if (!selectedKey && templates.length > 0) setSelectedKey(templates[0].key)
  }, [templates, selectedKey])

  useEffect(() => {
    return () => {
      if (flashTimer.current) clearTimeout(flashTimer.current)
    }
  }, [])

  const showFlash = (tone: 'ok' | 'err', text: string) => {
    setFlash({ tone, text })
    if (flashTimer.current) clearTimeout(flashTimer.current)
    flashTimer.current = setTimeout(() => setFlash(null), 4000)
  }

  const saveMutation = useMutation({
    mutationFn: async (key: string) => {
      const draft = drafts[key]
      if (!draft) throw new Error('Nothing to save')
      const res = await fetch(`/api/config/email-templates/${key}`, {
        method: 'PATCH',
        headers: { ...authH, 'Content-Type': 'application/json' },
        body: JSON.stringify({ subject: draft.subject, body: draft.body }),
      })
      if (!res.ok) {
        const err = await res.json().catch(() => ({}))
        throw new Error(err.error || 'Failed to save template')
      }
      return key
    },
    onSuccess: (key) => {
      setSavedKeys((prev) => new Set(prev).add(key))
      showFlash('ok', `Template "${metaFor(key).label}" saved.`)
      queryClient.invalidateQueries({ queryKey: ['email-templates'] })
    },
    onError: (e: Error) => {
      showFlash('err', e.message)
    },
  })

  const ordered = templates ?? []
  const selected = ordered.find((t) => t.key === selectedKey) ?? ordered[0]
  const draft = selected ? drafts[selected.key] : undefined
  const dirty =
    !!selected &&
    !!draft &&
    (draft.subject !== selected.subject || draft.body !== selected.body)
  const justSaved = !!selected && savedKeys.has(selected.key)

  const updateDraft = (key: string, patch: Partial<{ subject: string; body: string }>) => {
    setDrafts((prev) => {
      const existing = prev[key] ?? { subject: '', body: '' }
      return {
        ...prev,
        [key]: { ...existing, ...patch },
      }
    })
    setSavedKeys((prev) => {
      const next = new Set(prev)
      next.delete(key)
      return next
    })
  }

  return (
    <div className="grid gap-6 lg:grid-cols-[240px_1fr] items-start">
      {/* Template picker */}
      <aside className="rounded-lg border border-zinc-800 bg-zinc-900/50 overflow-hidden">
        <div className="px-4 pt-3.5 pb-2 border-b border-zinc-800/80">
          <p className="text-xs uppercase tracking-wider text-zinc-500 font-medium flex items-center gap-1.5">
            <IconTemplate size={13} stroke={1.8} aria-hidden="true" />
            Templates
          </p>
        </div>
        {isLoading ? (
          <p className="px-4 py-6 text-sm text-zinc-500">Loading…</p>
        ) : ordered.length === 0 ? (
          <p className="px-4 py-6 text-sm text-zinc-500">No templates yet.</p>
        ) : (
          <ul className="divide-y divide-zinc-800/60">
            {ordered.map((t) => {
              const meta = metaFor(t.key)
              const Icon = meta.icon
              const active = t.key === selected?.key
              const d = drafts[t.key]
              const isDirty = !!d && (d.subject !== t.subject || d.body !== t.body)
              return (
                <li key={t.key}>
                  <button
                    type="button"
                    onClick={() => setSelectedKey(t.key)}
                    className={`w-full text-left px-4 py-3 transition-colors ${
                      active
                        ? 'bg-teal-500/10 border-l-2 border-teal-500'
                        : 'border-l-2 border-transparent hover:bg-zinc-800/40'
                    }`}
                  >
                    <span
                      className={`flex items-center gap-2 text-sm font-medium ${
                        active ? 'text-teal-300' : 'text-zinc-300'
                      }`}
                    >
                      <Icon size={15} stroke={1.7} className="shrink-0 opacity-80" aria-hidden="true" />
                      <span className="truncate">{meta.label}</span>
                      {isDirty && (
                        <span
                          title="Unsaved changes"
                          className="ml-auto h-2 w-2 shrink-0 rounded-full bg-amber-400"
                        />
                      )}
                    </span>
                  </button>
                </li>
              )
            })}
          </ul>
        )}
      </aside>

      {/* Editor */}
      <div className="rounded-lg border border-zinc-800 bg-zinc-900/50 p-5 min-w-0">
        {selected && draft ? (
          <>
            <div className="flex flex-wrap items-start justify-between gap-3 mb-4">
              <div className="min-w-0">
                <div className="flex items-center gap-2">
                  <h3 className="text-base font-semibold text-zinc-100">
                    {metaFor(selected.key).label}
                  </h3>
                  <code className="rounded bg-zinc-800 px-1.5 py-0.5 text-[11px] font-mono text-zinc-400">
                    {selected.key}
                  </code>
                  {justSaved && !dirty && (
                    <span className="inline-flex items-center gap-1 text-xs text-teal-400">
                      <IconCheck size={14} aria-hidden="true" />
                      Saved
                    </span>
                  )}
                </div>
                <p className="mt-1 text-sm text-zinc-500">{metaFor(selected.key).description}</p>
                <p className="mt-0.5 text-xs text-zinc-600">
                  Last saved {formatUpdatedAt(selected.updated_at)}
                </p>
              </div>
              <PrimaryButton
                onClick={() => saveMutation.mutate(selected.key)}
                disabled={!dirty || saveMutation.isPending}
              >
                <IconDeviceFloppy size={15} stroke={1.8} aria-hidden="true" />
                {saveMutation.isPending ? 'Saving…' : dirty ? 'Save template' : 'Saved'}
              </PrimaryButton>
            </div>

            {flash && (
              <div
                className={`mb-4 flex items-center gap-2 rounded-md border px-3 py-2 text-sm ${
                  flash.tone === 'ok'
                    ? 'border-teal-500/30 bg-teal-500/10 text-teal-300'
                    : 'border-red-500/30 bg-red-500/10 text-red-300'
                }`}
                role="status"
              >
                {flash.tone === 'ok' ? (
                  <IconCheck size={15} stroke={1.8} aria-hidden="true" />
                ) : (
                  <IconAlertCircle size={15} stroke={1.8} aria-hidden="true" />
                )}
                {flash.text}
              </div>
            )}

            <div className="space-y-5">
              <div>
                <label htmlFor={`subject-${selected.key}`} className={labelCls}>
                  Subject
                </label>
                <input
                  id={`subject-${selected.key}`}
                  value={draft.subject}
                  onChange={(e) => updateDraft(selected.key, { subject: e.target.value })}
                  placeholder="Email subject line"
                  className={inputCls}
                />
              </div>

              <div>
                <span className={`${labelCls} flex items-center justify-between`}>
                  Body
                  <GhostButton
                    className="!py-1 !px-2 text-xs"
                    onClick={() =>
                      updateDraft(selected.key, {
                        body: `<!DOCTYPE html>
<html>
<body style="font-family: Arial, sans-serif; line-height: 1.6; color: #333;">
  <h2>${metaFor(selected.key).label}</h2>
  <p>Start writing your email…</p>
</body>
</html>`,
                      })
                    }
                  >
                    Reset to skeleton
                  </GhostButton>
                </span>
                <RichTextEditor
                  key={selected.key}
                  value={draft.body}
                  onChange={(body) => updateDraft(selected.key, { body })}
                  placeholders={metaFor(selected.key).placeholders}
                />
                <p className="mt-2 text-xs text-zinc-600 leading-relaxed">
                  The email is sent as HTML. Click a placeholder chip to insert it at the cursor —
                  it is replaced with the real value when the email is sent. Switch to{' '}
                  <span className="text-zinc-400">Code</span> to edit the raw HTML.
                </p>
              </div>
            </div>
          </>
        ) : (
          <p className="py-10 text-center text-sm text-zinc-500">Select a template to edit it.</p>
        )}
      </div>
    </div>
  )
}
