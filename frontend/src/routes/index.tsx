import { createFileRoute, redirect } from '@tanstack/react-router'

// Visiting the site root (e.g. https://<host>/ — with no path, or after a
// hard refresh to "/") should never land on a 404. Send signed-in users to
// the dashboard and everyone else to the login page.
export const Route = createFileRoute('/')({
  beforeLoad: () => {
    const hasToken = Boolean(localStorage.getItem('token'))
    throw redirect({ to: hasToken ? '/dashboard' : '/login' })
  },
})
