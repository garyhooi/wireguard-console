import { createFileRoute, redirect } from '@tanstack/react-router'
import { fetchSession } from '../lib/api'

// Visiting the site root (e.g. https://<host>/ — with no path, or after a
// hard refresh to "/") should never land on a 404. The session lives in an
// HttpOnly cookie, so the authoritative check is a server probe: send
// signed-in users to the dashboard and everyone else to the login page.
export const Route = createFileRoute('/')({
  beforeLoad: async () => {
    const session = await fetchSession()
    throw redirect({ to: session ? '/dashboard' : '/login' })
  },
})
