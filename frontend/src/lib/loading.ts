/**
 * Global "something is happening" store.
 *
 * A tiny external store (no React import here) tracking how many
 * state-changing API requests are currently in flight. The root route renders
 * GlobalLoadingOverlay, which subscribes through useSyncExternalStore; apiFetch
 * calls beginLoading()/endLoading() around non-GET requests so slow creates,
 * deletes, logins, resyncs and backups show a full-screen progress overlay.
 *
 * GET/HEAD/OPTIONS are deliberately NOT instrumented: background polling and
 * page data already render skeletons, and a full-screen flash on every poll
 * would be noise.
 *
 * Kept dependency-free and module-scoped so any code path (including non-React
 * helpers) can mark work as busy.
 */

type LoadingListener = () => void

let loadingCount = 0
const listeners = new Set<LoadingListener>()

function emit() {
  // Copy first: a listener may unsubscribe while we iterate.
  for (const listener of Array.from(listeners)) listener()
}

/** Mark one state-changing request as in flight. */
export function beginLoading(): void {
  loadingCount += 1
  emit()
}

/** Mark one in-flight request as settled (never goes below zero). */
export function endLoading(): void {
  if (loadingCount === 0) return
  loadingCount -= 1
  emit()
}

/** Number of state-changing requests currently in flight. */
export function getLoadingCount(): number {
  return loadingCount
}

/** Subscribe to busy-count changes. Returns an unsubscribe function. */
export function subscribeLoading(listener: LoadingListener): () => void {
  listeners.add(listener)
  return () => {
    listeners.delete(listener)
  }
}

/**
 * Test-only: zero the counter and drop every subscriber.
 * Call between tests, after unmounting any overlay.
 */
export function _resetLoadingForTests(): void {
  loadingCount = 0
  listeners.clear()
}
