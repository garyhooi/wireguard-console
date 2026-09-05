import { createRootRoute, Outlet } from '@tanstack/react-router'
import { GitHubCornerButton } from '../components/GitHubCornerButton'

export const Route = createRootRoute({
  component: () => (
    <>
      <Outlet />
      <GitHubCornerButton />
    </>
  ),
})
