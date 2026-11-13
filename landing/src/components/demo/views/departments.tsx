"use client";

import { useState } from "react";
import { IconPencil, IconPlus, IconTrash } from "@tabler/icons-react";
import { useDemo } from "@/components/demo/store";
import {
  DangerButton,
  EmptyState,
  Field,
  GhostButton,
  Modal,
  PageHeader,
  PrimaryButton,
  inputCls,
  tableCls,
  tableWrapCls,
  tdCls,
  thCls,
} from "@/components/demo/ui";

type Department = { id: string; name: string; userCount: number };

const SEED: Department[] = [
  { id: "engineering", name: "Engineering", userCount: 3 },
  { id: "design", name: "Design", userCount: 1 },
  { id: "finance", name: "Finance", userCount: 1 },
  { id: "sales", name: "Sales", userCount: 1 },
  { id: "support", name: "Support", userCount: 1 },
];

const iconButtonCls =
  "inline-flex h-7 w-7 items-center justify-center rounded-md text-zinc-400 transition-colors hover:bg-zinc-800 hover:text-zinc-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-teal-500";

export function DepartmentsView() {
  const { pushToast } = useDemo();
  const [departments, setDepartments] = useState<Department[]>(SEED);
  const [editing, setEditing] = useState<Department | null>(null);
  const [modalOpen, setModalOpen] = useState(false);
  const [deleting, setDeleting] = useState<Department | null>(null);
  const [name, setName] = useState("");
  const [error, setError] = useState("");

  function openAdd() {
    setEditing(null);
    setName("");
    setError("");
    setModalOpen(true);
  }

  function openEdit(department: Department) {
    setEditing(department);
    setName(department.name);
    setError("");
    setModalOpen(true);
  }

  function save(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const value = name.trim();
    if (!value) {
      setError("Give the department a name.");
      return;
    }
    const duplicate = departments.some(
      (item) =>
        item.name.toLowerCase() === value.toLowerCase() &&
        item.id !== editing?.id,
    );
    if (duplicate) {
      setError("That department already exists.");
      return;
    }
    if (editing) {
      setDepartments((items) =>
        items.map((item) =>
          item.id === editing.id ? { ...item, name: value } : item,
        ),
      );
      pushToast("Department updated");
    } else {
      setDepartments((items) => [
        ...items,
        {
          id: `dept-${Date.now()}`,
          name: value,
          userCount: 0,
        },
      ]);
      pushToast(`${value} added`);
    }
    setModalOpen(false);
  }

  function remove() {
    if (!deleting) return;
    setDepartments((items) =>
      items.filter((item) => item.id !== deleting.id),
    );
    pushToast(`${deleting.name} deleted`, "info");
    setDeleting(null);
  }

  return (
    <div>
      <PageHeader
        title="Departments"
        description="Group VPN users into departments so user lists, rules and activity read at a glance."
        actions={
          <PrimaryButton onClick={openAdd}>
            <IconPlus size={16} stroke={1.6} aria-hidden="true" />
            Add department
          </PrimaryButton>
        }
      />

      <div className={tableWrapCls}>
        {departments.length === 0 ? (
          <EmptyState
            title="No departments yet"
            hint="Add a department to group VPN users and label them consistently."
            action={
              <PrimaryButton onClick={openAdd}>
                <IconPlus size={16} stroke={1.6} aria-hidden="true" />
                Add department
              </PrimaryButton>
            }
          />
        ) : (
          <div className="overflow-x-auto">
            <table className={tableCls}>
              <thead>
                <tr className="bg-zinc-800/40 text-left text-[11px] uppercase tracking-wider text-dim">
                  <th className={thCls}>Name</th>
                  <th className={thCls}>Users</th>
                  <th className={thCls + " text-right"}>Actions</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-zinc-800/60">
                {departments.map((department) => (
                  <tr
                    key={department.id}
                    className="transition-colors hover:bg-zinc-800/30"
                  >
                    <td className="whitespace-nowrap px-5 py-3.5 text-sm text-zinc-200">
                      {department.name}
                    </td>
                    <td className={tdCls + " tabular-nums"}>
                      {department.userCount}
                    </td>
                    <td className="whitespace-nowrap px-5 py-3.5 text-right">
                      <div className="flex justify-end gap-1">
                        <button
                          type="button"
                          onClick={() => openEdit(department)}
                          aria-label={`Edit ${department.name}`}
                          title="Edit department"
                          className={iconButtonCls}
                        >
                          <IconPencil size={14} stroke={1.6} aria-hidden="true" />
                        </button>
                        <button
                          type="button"
                          onClick={() => setDeleting(department)}
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
        )}
      </div>

      <Modal
        open={modalOpen}
        onClose={() => setModalOpen(false)}
        title={editing ? "Edit department" : "Add department"}
        className="max-w-md"
        footer={
          <>
            <GhostButton onClick={() => setModalOpen(false)}>Cancel</GhostButton>
            <PrimaryButton type="submit" form="department-form">
              {editing ? "Save changes" : "Add department"}
            </PrimaryButton>
          </>
        }
      >
        <form id="department-form" onSubmit={save} className="space-y-4">
          <Field label="Name" htmlFor="department-name" error={error}>
            <input
              id="department-name"
              data-autofocus
              value={name}
              onChange={(event) => {
                setName(event.target.value);
                if (error) setError("");
              }}
              placeholder="Engineering"
              className={inputCls}
            />
          </Field>
          {editing && (
            <p className="text-xs text-dim">
              {editing.userCount} VPN user
              {editing.userCount === 1 ? "" : "s"} currently use this department.
            </p>
          )}
        </form>
      </Modal>

      <Modal
        open={Boolean(deleting)}
        onClose={() => setDeleting(null)}
        title="Delete department?"
        description={
          deleting
            ? `${deleting.name} will be removed from the directory. Demo data only.`
            : undefined
        }
        className="max-w-md"
        footer={
          <>
            <GhostButton onClick={() => setDeleting(null)} data-autofocus>
              Cancel
            </GhostButton>
            <DangerButton onClick={remove}>Delete department</DangerButton>
          </>
        }
      >
        <p className="text-sm text-dim">
          Users in this department will keep their peer configs; only the label is
          removed in this demo.
        </p>
      </Modal>
    </div>
  );
}
