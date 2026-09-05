import { useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import {
  IconAlertTriangle,
  IconBrandGithub,
  IconCheck,
  IconCopy,
  IconExternalLink,
  IconPackage,
  IconRefresh,
  IconShieldCheck,
} from '@tabler/icons-react'
import { GhostButton, Modal, PrimaryButton } from '../lib/ui'
import { apiJson } from '../lib/api'

// Canonical one-liner shown to the admin who runs updates on the server.
// install.sh itself re-prints this in its header; keeping a single literal
// here means the copy button always copies exactly what the README teaches.
export const INSTALL_CMD =
  'curl -fsSL https://raw.githubusercontent.com/garyhooi/wireguard-console/main/install.sh | sudo bash'

export const GITHUB_RELEASES_URL = 'https://github.com/garyhooi/wireguard-console/releases'

export interface UpdateCheckResponse {
  current: string
  latest: string
  latest_url: string
  published_at?: string | null
  outdated: boolean
  update: boolean
  check_error?: string
  checked_at: string
  install_cmd: string
  releases_url: string
  backup_first: boolean
  backup_method: string
}

/** Copy text to the clipboard with a legacy fallback for http (non-secure) hosts. */
async function copyText(text: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(text)
    return true
  } catch {
    try {
      const el = document.createElement('textarea')
      el.value = text
      el.style.position = 'fixed'
      el.style.opacity = '0'
      document.body.appendChild(el)
      el.select()
      document.execCommand('copy')
      document.body.removeChild(el)
      return true
    } catch {
      return false
    }
  }
}

const REPO_OWNER = 'garyhooi'
const REPO_NAME = 'wireguard-console'

/**
 * Normalize a version for display: strip a leading "v" so the UI can always
 * prefix exactly one. GitHub release tags are "v1.0.0" while APP_VERSION
 * (from the repo VERSION file) is "1.0.0" — rendering v${latest} verbatim
 * produced the double-v ("vv1.0.0").
 */
export function stripVersionPrefix(v: string | undefined | null): string {
  return (v || '').trim().replace(/^v/i, '')
}

/** Display form: exactly one leading "v" ("v1.0.0"), "" when empty. */
function displayVersion(v: string): string {
  const bare = stripVersionPrefix(v)
  return bare ? `v${bare}` : ''
}

// ---------------------------------------------------------------------------
// ConsoleVersionControl — current version + auto-detected GitHub latest
// release, rendered in the top bar of the authenticated shell. Shows a pill
// with the running version and, when a newer release exists, an amber
// "Update available" chip that opens a modal with the exact commands the
// admin runs on the server (backup first, then the one-liner), plus a copy
// button and a link to the release notes.
// ---------------------------------------------------------------------------
export function ConsoleVersionControl() {
  const [showModal, setShowModal] = useState(false)
  const [copied, setCopied] = useState(false)
  const [copyError, setCopyError] = useState('')

  const { data, isLoading, isFetching, refetch, isError } = useQuery<UpdateCheckResponse>({
    queryKey: ['update-check'],
    queryFn: () => apiJson<UpdateCheckResponse>('/api/update/check'),
    // Auto re-check periodically so a fresh release surfaces without a
    // reload. Long interval: the check is cheap and cached server-side.
    refetchInterval: 15 * 60 * 1000,
  })

  const hasUpdate = !!data?.update
  const canCheck = !!data?.latest
  // Display/copy the server-provided one-liner (kept in sync with README +
  // install.sh); the exported constant is the fallback while loading/failed.
  const installCmd = data?.install_cmd || INSTALL_CMD
  // Normalize once so a leading "v" (GitHub tags) never double-prefixes.
  const currentV = displayVersion(data?.current || '')
  const latestV = displayVersion(data?.latest || '')

  const onCopyInstall = async () => {
    const ok = await copyText(installCmd)
    if (ok) {
      setCopied(true)
      setCopyError('')
      window.setTimeout(() => setCopied(false), 2000)
    } else {
      setCopyError('Copy failed — select the command and copy manually.')
    }
  }

  return (
    <>
      <div className="flex items-center gap-2 shrink-0">
        {/* Running version (the "current version inside the console"). Clicking
            it opens the release/update modal, which is how an up-to-date console
            still reaches its version details and re-check. */}
        <button
          type="button"
          onClick={() => setShowModal(true)}
          title={
            canCheck
              ? `${currentV} running · latest release ${latestV} — click for update info`
              : `Version ${data?.current ?? '…'} — click for release info`
          }
          aria-label={`Version ${data?.current ?? 'unknown'}${
            hasUpdate && latestV ? ` — update available: ${latestV}` : ''
          }`}
          className="hidden md:inline-flex items-center gap-1.5 text-xs text-zinc-500 hover:text-zinc-300 rounded-md px-1.5 py-1 -mx-1.5 transition-colors"
        >
          <IconPackage size={13} stroke={1.7} aria-hidden="true" />
          <span className="font-mono tabular-nums">{currentV || '…'}</span>
        </button>

        {/* Update available → opens the modal with backup + install steps */}
        {hasUpdate && latestV && (
          <button
            type="button"
            onClick={() => setShowModal(true)}
            title={`${latestV} is available — you are on ${currentV}`}
            className="inline-flex items-center gap-1.5 text-xs font-medium rounded-full px-2.5 py-1 bg-amber-500/10 text-amber-300 ring-1 ring-inset ring-amber-500/30 hover:bg-amber-500/20 transition-colors"
          >
            <IconAlertTriangle size={13} stroke={1.8} aria-hidden="true" />
            Update available
          </button>
        )}

        {/* GitHub releases — "check on the latest release" top-banner button */}
        <a
          href={GITHUB_RELEASES_URL}
          target="_blank"
          rel="noopener noreferrer"
          title={`WireGuard Console releases (latest: ${latestV || '—'})`}
          aria-label="View the latest release on GitHub"
          className="inline-flex items-center gap-1.5 text-xs rounded-md border border-zinc-700 hover:border-zinc-500 hover:text-zinc-100 text-zinc-400 px-2.5 py-1.5 transition-colors"
        >
          <IconBrandGithub size={14} stroke={1.7} aria-hidden="true" />
          <span className="hidden sm:inline">Releases</span>
          <IconExternalLink size={11} stroke={1.8} aria-hidden="true" />
        </a>
      </div>

      <Modal
        open={showModal}
        onClose={() => setShowModal(false)}
        title={
          hasUpdate && latestV
            ? `Update available: ${currentV} → ${latestV}`
            : `WireGuard Console ${currentV || '…'}`
        }
        description="Updates run on the server, not from this page. The console does not touch the server's files — an admin runs two commands over SSH."
      >
        {data && (
          <div className="space-y-4">
            {/* Version summary */}
            <div className="grid grid-cols-2 gap-3">
              <div className="rounded-md border border-zinc-800 bg-zinc-950/60 px-3 py-2">
                <p className="text-[11px] uppercase tracking-wider text-zinc-500">Current</p>
                <p className="mt-1 font-mono text-sm text-zinc-200">{currentV || '—'}</p>
              </div>
              <div className="rounded-md border border-zinc-800 bg-zinc-950/60 px-3 py-2">
                <p className="text-[11px] uppercase tracking-wider text-zinc-500">Latest release</p>
                <p className="mt-1 font-mono text-sm text-teal-300">{latestV || '—'}</p>
              </div>
            </div>

            {data.check_error && (
              <p className="text-xs text-amber-300/90 flex items-start gap-1.5">
                <IconAlertTriangle size={14} className="mt-0.5 shrink-0" aria-hidden="true" />
                Could not reach GitHub to check the latest release ({data.check_error}). You are
                still on {currentV}; try again in a bit or open the Releases page directly.
              </p>
            )}

            {hasUpdate && data.latest ? (
              <>
                {/* Step 1 — backup */}
                <div className="rounded-md border border-zinc-800 p-3">
                  <div className="flex items-center gap-2 text-sm text-zinc-200">
                    <span className="flex h-5 w-5 items-center justify-center rounded-full bg-teal-500/10 text-teal-300 ring-1 ring-inset ring-teal-500/30 text-xs font-semibold">
                      1
                    </span>
                    <span className="font-medium">Back up first</span>
                  </div>
                  <p className="mt-2 text-xs text-zinc-500 leading-relaxed pl-7">
                    The installer replaces the running stack. Create a backup before updating —
                    open the{' '}
                    <a href="/backups" className="text-teal-400 hover:text-teal-300 underline underline-offset-2">
                      Backups
                    </a>{' '}
                    page and run <span className="font-mono text-zinc-300">New backup</span>, or
                    download one to keep off the server.
                  </p>
                </div>

                {/* Step 2 — install command */}
                <div className="rounded-md border border-zinc-800 p-3">
                  <div className="flex items-center gap-2 text-sm text-zinc-200">
                    <span className="flex h-5 w-5 items-center justify-center rounded-full bg-teal-500/10 text-teal-300 ring-1 ring-inset ring-teal-500/30 text-xs font-semibold">
                      2
                    </span>
                    <span className="font-medium">Run this on the server (SSH, as sudo)</span>
                  </div>
                  <div className="mt-2 flex items-stretch gap-2 pl-7">
                    <code className="flex-1 min-w-0 overflow-x-auto rounded-md border border-zinc-800 bg-zinc-950/80 px-3 py-2 text-xs text-zinc-100 whitespace-nowrap">
                      {installCmd}
                    </code>
                    <button
                      type="button"
                      onClick={onCopyInstall}
                      title="Copy install command"
                      aria-label="Copy install command"
                      className="inline-flex items-center gap-1.5 rounded-md border border-zinc-700 hover:border-teal-500/60 hover:text-teal-300 text-zinc-300 px-2.5 text-xs transition-colors"
                    >
                      {copied ? (
                        <>
                          <IconCheck size={14} stroke={1.8} aria-hidden="true" /> Copied
                        </>
                      ) : (
                        <>
                          <IconCopy size={14} stroke={1.8} aria-hidden="true" /> Copy
                        </>
                      )}
                    </button>
                  </div>
                  {copyError && <p className="mt-2 pl-7 text-xs text-red-400">{copyError}</p>}
                  <p className="mt-2 text-xs text-zinc-500 pl-7 leading-relaxed">
                    Re-running the installer updates the stack in place — your admins, peers and
                    data are kept. After it finishes, refresh this page to see {latestV}.
                  </p>
                </div>

                {/* Step 3 — release notes */}
                <div className="rounded-md border border-zinc-800 p-3">
                  <div className="flex items-center gap-2 text-sm text-zinc-200">
                    <span className="flex h-5 w-5 items-center justify-center rounded-full bg-teal-500/10 text-teal-300 ring-1 ring-inset ring-teal-500/30 text-xs font-semibold">
                      3
                    </span>
                    <span className="font-medium">See what changed</span>
                  </div>
                  <p className="mt-2 text-xs text-zinc-500 pl-7">
                    Review the release notes before updating:{' '}
                    <a
                      href={data.latest_url || GITHUB_RELEASES_URL}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="text-teal-400 hover:text-teal-300 underline underline-offset-2 inline-flex items-center gap-0.5"
                    >
                      {latestV} on GitHub <IconExternalLink size={11} aria-hidden="true" />
                    </a>
                  </p>
                </div>
              </>
            ) : (
              <p className="text-sm text-zinc-500">
                You are running the latest release{data.current !== 'dev' ? '' : ' (dev build)'}.
                Releases are published on GitHub.
              </p>
            )}

            <div className="flex items-center justify-between pt-1">
              <GhostButton onClick={() => refetch()} disabled={isLoading || isFetching}>
                <IconRefresh
                  size={14}
                  stroke={1.7}
                  aria-hidden="true"
                  className={isFetching ? 'animate-spin' : ''}
                />
                Check again
              </GhostButton>
              <div className="flex items-center gap-2">
                {isError && <span className="text-xs text-red-400">Check failed</span>}
                <GhostButton
                  onClick={() => {
                    setShowModal(false)
                    window.location.href = '/backups'
                  }}
                >
                  <IconShieldCheck size={14} stroke={1.7} aria-hidden="true" />
                  Backups
                </GhostButton>
                <PrimaryButton onClick={() => setShowModal(false)}>Close</PrimaryButton>
              </div>
            </div>
          </div>
        )}

        {!data && (
          <div className="flex flex-col items-center justify-center py-10 text-zinc-500 text-sm">
            <IconRefresh size={18} className="animate-spin mb-3" aria-hidden="true" />
            Checking for updates…
          </div>
        )}
      </Modal>
    </>
  )
}

// Re-export so tests and the header can reference one source of truth.
export const REPO = { owner: REPO_OWNER, name: REPO_NAME }
