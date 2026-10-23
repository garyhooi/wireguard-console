import { createRootRoute, Outlet } from '@tanstack/react-router'
import { GitHubCornerButton } from '../components/GitHubCornerButton'
import { GlobalLoadingOverlay } from '../components/GlobalLoadingOverlay'

export const Route = createRootRoute({
  component: () => (
    <>
      <Outlet />
      <GitHubCornerButton />
      <GlobalLoadingOverlay />
    </>
  ),
})
