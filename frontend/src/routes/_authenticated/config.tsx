import { createFileRoute } from '@tanstack/react-router'

export const Route = createFileRoute('/_authenticated/config')({
  component: ConfigPage,
})

function ConfigPage() {
  return (
    <div>
      <h1 className="text-2xl font-bold text-white mb-6">Configuration</h1>
      <div className="bg-neutral-900 border border-neutral-800 rounded-lg p-6">
        <p className="text-neutral-400">Organization settings and email configuration will appear here.</p>
      </div>
    </div>
  )
}
