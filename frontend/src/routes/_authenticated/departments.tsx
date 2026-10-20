import { createFileRoute } from '@tanstack/react-router'
import { useState } from 'react'
import { useMutation, useQuery } from '@tanstack/react-query'
import { IconPencil, IconPlus, IconTrash } from '@tabler/icons-react'
import { apiJson } from '../../lib/api'
import {
  EmptyState,
  GhostButton,
  Modal,
  PageHeader,
  PrimaryButton,
  Skeleton,
  tableCls,
  tableWrapCls,
  tdCls,
  thCls,
  inputCls,
  labelCls,
} from '../../lib/ui'

interface Department {
  id: string
  name: string
  user_count: number
  created_at: string
}

interface DeleteDepartmentResult {
  status: string
  users_cleared: number
}

const smallPrimaryButtonCls =
  'inline-flex shrink-0 items-center justify-center gap-1.5 rounded-md bg-teal-700 px-3 py-1.5 text-xs font-medium text-white transition-colors hover:bg-teal-600 active:translate-y-[1px] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-teal-500'

const iconButtonCls =
  'inline-flex items-center justify-center rounded-md p-1.5 text-zinc-500 transition-colors hover:bg-zinc-800 hover:text-zinc-200 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-teal-500'

export const Route = createFileRoute('/_authenticated/departments')({
  component: DepartmentsPage,
})

export function DepartmentsPage() {
  const [showModal, setShowModal] = useState(false)
  const [editing, setEditing] = useState<Department | null>(null)
  const [name, setName] = useState('')

  const {
    data: departmentsData,
    isLoading,
    isError,
    refetch,
  } = useQuery<Department[]>({
    queryKey: ['departments'],
    queryFn: async () => {
      return apiJson<Department[]>('/api/departments')
    },
  })
  const departments = Array.isArray(departmentsData) ? departmentsData : []

  const saveMutation = useMutation({
    mutationFn: async () => {
      const body = { name: name.trim() }
      return editing
        ? apiJson<Department>(`/api/departments/${editing.id}`, { method: 'PATCH', body })
        : apiJson<Department>('/api/departments', { method: 'POST', body })
    },
    onSuccess: () => {
      setShowModal(false)
      setEditing(null)
      refetch()
    },
  })

  // Deleting a department only unassigns its users — it never removes them.
  const deleteMutation = useMutation({
    mutationFn: async (department: Department) => {
      return apiJson<DeleteDepartmentResult>(`/api/departments/${department.id}`, {
        method: 'DELETE',
      })
    },
    onSuccess: () => refetch(),
  })

  const openAddModal = () => {
    saveMutation.reset()
    setEditing(null)
    setName('')
    setShowModal(true)
  }

  const openEditModal = (department: Department) => {
    saveMutation.reset()
    setEditing(department)
    setName(department.name)
    setShowModal(true)
  }

  const closeModal = () => {
    saveMutation.reset()
    setShowModal(false)
    setEditing(null)
  }

  const handleSave = (e: React.FormEvent) => {
    e.preventDefault()
    if (!name.trim()) return
    saveMutation.mutate()
  }

  const confirmDelete = (department: Department) => {
    const unassigned =
      department.user_count > 0
        ? ` ${department.user_count} user(s) will be unassigned.`
        : ''
    if (confirm(`Delete department "${department.name}"?${unassigned}`)) {
      deleteMutation.mutate(department)
    }
  }

  return (
    <div>
      <PageHeader
        title="Departments"
        description="Group VPN users into departments so user lists, rules and activity read at a glance."
        actions={
          <button type="button" onClick={openAddModal} className={smallPrimaryButtonCls}>
            <IconPlus size={14} stroke={1.8} aria-hidden="true" />
            Add department
          </button>
        }
      />

      {isLoading ? (
        <div className={tableWrapCls}>
          <div className="p-5 space-y-3">
            <Skeleton className="h-10 w-full" />
            <Skeleton className="h-10 w-full" />
          </div>
        </div>
      ) : isError ? (
        <p role="alert" className="text-sm text-red-400">
          Failed to load departments.
        </p>
      ) : departments.length === 0 ? (
        <div className={tableWrapCls}>
          <EmptyState
            title="No departments yet"
            hint="Add a department to group VPN users and label them consistently."
            action={
              <PrimaryButton onClick={openAddModal}>
                <IconPlus size={16} stroke={1.6} aria-hidden="true" />
                Add department
              </PrimaryButton>
            }
          />
        </div>
      ) : (
        <div className={tableWrapCls}>
          <div className="overflow-x-auto">
            <table className={tableCls}>
              <thead>
                <tr className="bg-zinc-800/40 text-left text-[11px] uppercase tracking-wider text-zinc-500">
                  <th className={thCls}>Name</th>
                  <th className={thCls}>Users</th>
                  <th className={thCls + ' text-right'}>Actions</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-zinc-800/60">
                {departments.map((department) => (
                  <tr key={department.id} className="transition-colors hover:bg-zinc-800/30">
                    <td className="px-5 py-3.5 whitespace-nowrap text-sm text-zinc-200">
                      {department.name}
                    </td>
                    <td className={tdCls + ' tabular-nums'}>{department.user_count}</td>
                    <td className="px-5 py-3.5 whitespace-nowrap text-right text-sm font-medium">
                      <div className="flex justify-end gap-1">
                        <button
                          type="button"
                          onClick={() => openEditModal(department)}
                          aria-label={`Edit ${department.name}`}
                          title="Edit department"
                          className={iconButtonCls}
                        >
                          <IconPencil size={14} stroke={1.6} aria-hidden="true" />
                        </button>
                        <button
                          type="button"
                          onClick={() => confirmDelete(department)}
                          aria-label={`Delete ${department.name}`}
                          title="Delete department"
                          className={`${iconButtonCls} hover:bg-red-500/10 hover:text-red-300`}
                        >
                          <IconTrash size={14} stroke={1.6} aria-hidden="true" />
                        </button>
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}

      <Modal
        open={showModal}
        onClose={closeModal}
        title={editing ? 'Edit department' : 'Add department'}
        className="max-w-md"
      >
        <form onSubmit={handleSave} className="space-y-4">
          <div>
            <label htmlFor="dept-name" className={labelCls}>
              Name
            </label>
            <input
              id="dept-name"
              type="text"
              required
              className={inputCls}
              placeholder="Engineering"
              value={name}
              onChange={(e) => {
                setName(e.target.value)
                saveMutation.reset()
              }}
            />
          </div>

          {/* Server-side 400 (invalid name) or 409 (duplicate name). */}
          {saveMutation.isError && (
            <p role="alert" className="text-sm text-red-400">
              {saveMutation.error?.message || 'Failed to save department.'}
            </p>
          )}

          <div className="flex justify-end gap-3 pt-2">
            <GhostButton type="button" onClick={closeModal}>
              Cancel
            </GhostButton>
            <PrimaryButton type="submit" disabled={saveMutation.isPending || !name.trim()}>
              {saveMutation.isPending ? 'Saving…' : editing ? 'Save' : 'Add department'}
            </PrimaryButton>
          </div>
        </form>
      </Modal>
    </div>
  )
}
