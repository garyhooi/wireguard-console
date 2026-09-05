// Dual-mode HTML editor used for email template bodies.
//
//  * Visual mode — a sandboxed, designMode iframe renders the stored HTML
//    (including the outer <html>/<body> wrapper and inline styles, so what
//    you see matches what gets emailed). A toolbar applies formatting to the
//    current selection via document.execCommand, and placeholder tokens can
//    be inserted at the caret.
//  * Code mode — the raw HTML source in a monospace textarea, for developers
//    who want to see/edit the exact markup.
//
// Both modes edit the SAME string (the component's `value`); toggling between
// them round-trips without loss, and every edit is reported through onChange.
//
// Hydration rules keep the visual iframe in sync without destroying the
// caret while typing:
//   * entering visual mode always (re)loads the latest `value`;
//   * while in visual mode, an external `value` change (code-mode edit, a
//     "reset" action, refetched data) reloads the iframe;
//   * edits that originate inside the iframe are already reflected in its DOM
//     (we serialize and emit them), so those `value` updates skip the reload.

import { useCallback, useEffect, useRef, useState } from 'react'
import {
  IconBold,
  IconBraces,
  IconCode,
  IconEraser,
  IconH2,
  IconH3,
  IconItalic,
  IconLink,
  IconLinkOff,
  IconList,
  IconListNumbers,
  IconQuote,
  IconStrikethrough,
  IconTypography,
  IconUnderline,
} from '@tabler/icons-react'

export type RichTextMode = 'visual' | 'code'

// Serialize a designMode document back to a stored HTML string. Browsers
// synthesize an empty <head> when none was authored — drop it so round trips
// stay clean, and keep the rest of the document byte-for-byte.
export function serializeEmailDocument(doc: Document): string {
  const root = doc.documentElement
  if (!root) return ''
  const html = root.outerHTML
  return html.replace(/<head><\/head>/i, '')
}

const TOOL_BUTTON =
  'inline-flex h-8 w-8 items-center justify-center rounded-md text-zinc-400 hover:text-zinc-100 hover:bg-zinc-700/70 transition-colors disabled:opacity-30 disabled:pointer-events-none focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-teal-500'

function ToolButton({
  label,
  onClick,
  children,
  disabled,
}: {
  label: string
  onClick: () => void
  children: React.ReactNode
  disabled?: boolean
}) {
  return (
    <button
      type="button"
      title={label}
      aria-label={label}
      disabled={disabled}
      className={TOOL_BUTTON}
      onMouseDown={(e) => e.preventDefault() /* keep the editor's selection */}
      onClick={onClick}
    >
      {children}
    </button>
  )
}

function Divider() {
  return <span className="mx-1 h-5 w-px bg-zinc-700/80 shrink-0" aria-hidden="true" />
}

export function RichTextEditor({
  value,
  onChange,
  placeholders = [],
  defaultMode = 'visual',
  height = 440,
}: {
  value: string
  onChange: (html: string) => void
  /** Tokens shown as insertable chips, e.g. ["{{full_name}}", "{{invite_link}}"] */
  placeholders?: string[]
  defaultMode?: RichTextMode
  height?: number
}) {
  const [mode, setMode] = useState<RichTextMode>(defaultMode)
  const iframeRef = useRef<HTMLIFrameElement>(null)
  const textareaRef = useRef<HTMLTextAreaElement>(null)
  const [linkOpen, setLinkOpen] = useState(false)
  const [linkUrl, setLinkUrl] = useState('')

  const inCode = mode === 'code'

  // Always call the latest onChange (the iframe 'input' listener attaches to a
  // render-scoped function; the ref keeps it from going stale).
  const onChangeRef = useRef(onChange)
  useEffect(() => {
    onChangeRef.current = onChange
  })

  const getDoc = useCallback((): Document | null => {
    return iframeRef.current?.contentDocument ?? null
  }, [])

  // Last HTML we serialized out of the visual iframe. Used to tell "this value
  // change came from the iframe itself" (skip reload) from external changes
  // (reload the iframe).
  const lastEmitted = useRef<string | null>(null)

  const emitFromIframe = useCallback(() => {
    const doc = getDoc()
    if (!doc || !doc.documentElement) return
    const html = serializeEmailDocument(doc)
    lastEmitted.current = html
    onChangeRef.current(html)
  }, [getDoc])

  function onIframeLoad() {
    const doc = getDoc()
    if (!doc) return
    try {
      doc.designMode = 'on'
    } catch {
      /* sandboxed/unsupported — toolbar will no-op */
    }
    doc.addEventListener('input', emitFromIframe)
  }

  // Hydrate the visual iframe:
  //  * on entering visual mode (always — the iframe may be brand new);
  //  * on an external value change while already in visual mode.
  // Changes we ourselves emitted are skipped (the DOM already holds them).
  useEffect(() => {
    if (mode !== 'visual') return
    const iframe = iframeRef.current
    if (!iframe) return
    if (lastEmitted.current === value) return
    iframe.srcdoc = value
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [mode, value])

  function exec(command: string, arg?: string) {
    const doc = getDoc()
    if (!doc) return
    try {
      iframeRef.current?.contentWindow?.focus()
      doc.execCommand(command, false, arg)
    } catch {
      /* ignore unsupported commands */
    }
    emitFromIframe()
    setLinkOpen(false)
  }

  // ------------------------------------------------------------------
  // Placeholder insertion (works in both modes)
  // ------------------------------------------------------------------

  function insertPlaceholder(token: string) {
    if (inCode) {
      const ta = textareaRef.current
      if (!ta) return
      const start = ta.selectionStart ?? value.length
      const end = ta.selectionEnd ?? value.length
      const next = value.slice(0, start) + token + value.slice(end)
      onChange(next)
      requestAnimationFrame(() => {
        ta.focus()
        const caret = start + token.length
        ta.setSelectionRange(caret, caret)
      })
      return
    }
    // Visual: insert a plain-text node at the caret in the iframe document.
    const doc = getDoc()
    if (!doc?.body) return
    iframeRef.current?.contentWindow?.focus()
    try {
      let sel = doc.getSelection()
      if (!sel || sel.rangeCount === 0 || !doc.body.contains(sel.anchorNode)) {
        // No usable selection — append at the end of the body.
        sel?.removeAllRanges()
        const range = doc.createRange()
        range.selectNodeContents(doc.body)
        range.collapse(false)
        sel = doc.getSelection()
        sel?.removeAllRanges()
        sel?.addRange(range)
      }
      const selection = sel
      if (!selection || selection.rangeCount === 0) return
      const range = selection.getRangeAt(0)
      range.deleteContents()
      const node = doc.createTextNode(token)
      range.insertNode(node)
      range.setStartAfter(node)
      range.collapse(true)
      selection.removeAllRanges()
      selection.addRange(range)
    } catch {
      /* ignore */
    }
    emitFromIframe()
  }

  // ------------------------------------------------------------------
  // Rendering
  // ------------------------------------------------------------------

  const toolbarDisabled = inCode

  return (
    <div className="rounded-lg border border-zinc-800 bg-zinc-900/60 overflow-hidden">
      {/* Toolbar */}
      <div className="flex flex-wrap items-center gap-0.5 border-b border-zinc-800 px-2 py-1.5 select-none">
        <ToolButton
          label="Bold"
          disabled={toolbarDisabled}
          onClick={() => exec('bold')}
        >
          <IconBold size={16} stroke={1.8} aria-hidden="true" />
        </ToolButton>
        <ToolButton
          label="Italic"
          disabled={toolbarDisabled}
          onClick={() => exec('italic')}
        >
          <IconItalic size={16} stroke={1.8} aria-hidden="true" />
        </ToolButton>
        <ToolButton
          label="Underline"
          disabled={toolbarDisabled}
          onClick={() => exec('underline')}
        >
          <IconUnderline size={16} stroke={1.8} aria-hidden="true" />
        </ToolButton>
        <ToolButton
          label="Strikethrough"
          disabled={toolbarDisabled}
          onClick={() => exec('strikeThrough')}
        >
          <IconStrikethrough size={16} stroke={1.8} aria-hidden="true" />
        </ToolButton>

        <Divider />

        <ToolButton
          label="Heading"
          disabled={toolbarDisabled}
          onClick={() => exec('formatBlock', '<h2>')}
        >
          <IconH2 size={16} stroke={1.8} aria-hidden="true" />
        </ToolButton>
        <ToolButton
          label="Subheading"
          disabled={toolbarDisabled}
          onClick={() => exec('formatBlock', '<h3>')}
        >
          <IconH3 size={16} stroke={1.8} aria-hidden="true" />
        </ToolButton>
        <ToolButton
          label="Paragraph"
          disabled={toolbarDisabled}
          onClick={() => exec('formatBlock', '<p>')}
        >
          <IconTypography size={16} stroke={1.8} aria-hidden="true" />
        </ToolButton>

        <Divider />

        <ToolButton
          label="Bulleted list"
          disabled={toolbarDisabled}
          onClick={() => exec('insertUnorderedList')}
        >
          <IconList size={16} stroke={1.8} aria-hidden="true" />
        </ToolButton>
        <ToolButton
          label="Numbered list"
          disabled={toolbarDisabled}
          onClick={() => exec('insertOrderedList')}
        >
          <IconListNumbers size={16} stroke={1.8} aria-hidden="true" />
        </ToolButton>
        <ToolButton
          label="Quote"
          disabled={toolbarDisabled}
          onClick={() => exec('formatBlock', '<blockquote>')}
        >
          <IconQuote size={16} stroke={1.8} aria-hidden="true" />
        </ToolButton>

        <Divider />

        {/* Link */}
        <div className="relative">
          <ToolButton
            label="Insert link"
            disabled={toolbarDisabled}
            onClick={() => {
              setLinkUrl('https://')
              setLinkOpen(true)
            }}
          >
            <IconLink size={16} stroke={1.8} aria-hidden="true" />
          </ToolButton>
          <ToolButton
            label="Remove link"
            disabled={toolbarDisabled}
            onClick={() => exec('unlink')}
          >
            <IconLinkOff size={16} stroke={1.8} aria-hidden="true" />
          </ToolButton>

          {linkOpen && !toolbarDisabled && (
            <div className="absolute left-0 top-full z-30 mt-1 flex items-center gap-2 rounded-lg border border-zinc-700 bg-zinc-800 px-2 py-1.5 shadow-xl">
              <input
                autoFocus
                value={linkUrl}
                onChange={(e) => setLinkUrl(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') exec('createLink', linkUrl)
                  if (e.key === 'Escape') setLinkOpen(false)
                }}
                placeholder="https://example.com"
                className="w-56 bg-zinc-900/80 border border-zinc-700 rounded px-2 py-1 text-sm text-zinc-100 placeholder:text-zinc-600 focus:outline-none focus:ring-2 focus:ring-teal-500"
              />
              <button
                type="button"
                onClick={() => exec('createLink', linkUrl)}
                className="inline-flex h-7 items-center rounded bg-teal-700 hover:bg-teal-600 px-2.5 text-xs font-medium text-white transition-colors"
              >
                Apply
              </button>
            </div>
          )}
        </div>

        <ToolButton
          label="Clear formatting"
          disabled={toolbarDisabled}
          onClick={() => exec('removeFormat')}
        >
          <IconEraser size={16} stroke={1.8} aria-hidden="true" />
        </ToolButton>

        <div className="flex-1" />

        {/* Mode switch: Visual | Code */}
        <div
          className="inline-flex rounded-md border border-zinc-700 overflow-hidden"
          role="tablist"
          aria-label="Editor mode"
        >
          <button
            type="button"
            role="tab"
            aria-selected={mode === 'visual'}
            onClick={() => setMode('visual')}
            className={`inline-flex items-center gap-1.5 px-2.5 h-8 text-xs font-medium transition-colors ${
              mode === 'visual'
                ? 'bg-teal-700 text-white'
                : 'bg-zinc-900 text-zinc-400 hover:text-zinc-100'
            }`}
          >
            <IconTypography size={14} stroke={1.8} aria-hidden="true" />
            Visual
          </button>
          <button
            type="button"
            role="tab"
            aria-selected={mode === 'code'}
            onClick={() => setMode('code')}
            className={`inline-flex items-center gap-1.5 px-2.5 h-8 text-xs font-medium transition-colors ${
              mode === 'code'
                ? 'bg-teal-700 text-white'
                : 'bg-zinc-900 text-zinc-400 hover:text-zinc-100'
            }`}
          >
            <IconCode size={14} stroke={1.8} aria-hidden="true" />
            Code
          </button>
        </div>
      </div>

      {/* Placeholder chips */}
      {placeholders.length > 0 && (
        <div className="flex flex-wrap items-center gap-1.5 border-b border-zinc-800 bg-zinc-950/40 px-3 py-2">
          <span className="inline-flex items-center gap-1 text-[11px] uppercase tracking-wider text-zinc-600 font-medium">
            <IconBraces size={12} stroke={1.8} aria-hidden="true" />
            Placeholders
          </span>
          {placeholders.map((token) => (
            <button
              key={token}
              type="button"
              onClick={() => insertPlaceholder(token)}
              title={`Insert ${token} at the cursor`}
              className="inline-flex items-center rounded border border-teal-500/25 bg-teal-500/10 px-2 py-0.5 font-mono text-[11px] text-teal-400 hover:bg-teal-500/20 hover:border-teal-500/40 transition-colors"
            >
              {token}
            </button>
          ))}
        </div>
      )}

      {/* Editing surface — both surfaces stay mounted so switching modes
          preserves the visual document (and the code caret). */}
      <div style={{ height }} className="relative bg-white">
        <iframe
          ref={iframeRef}
          title="Email body visual editor"
          sandbox="allow-same-origin"
          onLoad={onIframeLoad}
          className={`h-full w-full border-0 ${inCode ? 'hidden' : ''}`}
        />
        <textarea
          ref={textareaRef}
          aria-label="HTML source"
          spellCheck={false}
          value={value}
          onChange={(e) => onChange(e.target.value)}
          className={`h-full w-full resize-none bg-zinc-950 p-3 font-mono text-[13px] leading-relaxed text-zinc-200 placeholder:text-zinc-600 focus:outline-none ${
            inCode ? '' : 'hidden'
          }`}
        />
      </div>
    </div>
  )
}
