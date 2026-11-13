"use client";

import { useState } from "react";
import {
  IconArchive,
  IconDownload,
  IconTrash,
  IconUpload,
} from "@tabler/icons-react";
import { useDemo } from "@/components/demo/store";
import {
  ActionLink,
  DangerButton,
  GhostButton,
  Modal,
  PageHeader,
  Panel,
  PrimaryButton,
  tableCls,
  tdCls,
  thCls,
} from "@/components/demo/ui";

type Backup = {
  name: string;
  created: string;
  size: string;
};

const SEED: Backup[] = [
  { name: "wgconsole-2026-11-13_031244.sql.gz", created: "2026-11-13 03:12", size: "2.4 MB" },
  { name: "wgconsole-2026-11-12_031201.sql.gz", created: "2026-11-12 03:12", size: "2.3 MB" },
  { name: "wgconsole-2026-11-11_031188.sql.gz", created: "2026-11-11 03:11", size: "2.3 MB" },
];

function stamp() {
  const d = new Date();
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}_${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}`;
}

export function BackupsView() {
  const { pushToast } = useDemo();
  const [backups, setBackups] = useState<Backup[]>(SEED);
  const [creating, setCreating] = useState(false);
  const [restoring, setRestoring] = useState<Backup | null>(null);
  const [deleting, setDeleting] = useState<Backup | null>(null);

  function create() {
    if (creating) return;
    setCreating(true);
    window.setTimeout(() => {
      setBackups((items) => [
        {
          name: `wgconsole-${stamp().replace("_", "_")}.sql.gz`,
          created: "just now",
          size: "2.4 MB",
        },
        ...items,
      ]);
      setCreating(false);
      pushToast("Backup created");
    }, 700);
  }

  function download(backup: Backup) {
    const blob = new Blob(
      [`-- WireGuard Console demo backup\n-- ${backup.name}\n-- Sample only, not a usable database dump.\n`],
      { type: "application/gzip" },
    );
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement("a");
    anchor.href = url;
    anchor.download = backup.name;
    document.body.appendChild(anchor);
    anchor.click();
    anchor.remove();
    URL.revokeObjectURL(url);
    pushToast(`${backup.name} downloaded`, "info");
  }

  function restore() {
    if (!restoring) return;
    pushToast(`Restore queued for ${restoring.name}`, "info");
    setRestoring(null);
  }

  function remove() {
    if (!deleting) return;
    setBackups((items) => items.filter((item) => item.name !== deleting.name));
    pushToast(`${deleting.name} deleted`, "info");
    setDeleting(null);
  }

  return (
    <div>
      <PageHeader
        title="Backups"
        description="One-click database backups live on the console server (Docker volume, /var/backups/wgconsole). Creating one runs pg_dump; restoring replaces the current database with a saved copy. Downloading, restoring, uploading or deleting a backup requires an MFA step-up (passkey or authenticator code)."
        actions={
          <PrimaryButton onClick={create} disabled={creating}>
            <IconArchive size={16} stroke={1.6} aria-hidden="true" />
            {creating ? "Creating…" : "Create backup now"}
          </PrimaryButton>
        }
      />

      <Panel title={`Saved backups (${backups.length})`}>
        <div className="overflow-x-auto">
          <table className={tableCls}>
            <thead>
              <tr className="bg-zinc-800/40 text-left text-[11px] uppercase tracking-wider text-dim">
                <th className={thCls}>Created</th>
                <th className={thCls}>Filename</th>
                <th className={thCls}>Size</th>
                <th className={thCls + " text-right"}>Actions</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-zinc-800/60">
              {backups.map((backup) => (
                <tr
                  key={backup.name}
                  className="transition-colors hover:bg-zinc-800/30"
                >
                  <td className={tdCls + " font-mono tabular-nums"}>
                    {backup.created}
                  </td>
                  <td className={tdCls + " font-mono text-zinc-200"}>
                    {backup.name}
                  </td>
                  <td className={tdCls + " font-mono tabular-nums"}>
                    {backup.size}
                  </td>
                  <td className="whitespace-nowrap px-5 py-3.5 text-right">
                    <div className="flex justify-end gap-1">
                      <ActionLink tone="accent" onClick={() => download(backup)}>
                        <IconDownload size={14} stroke={1.6} aria-hidden="true" />
                        Download
                      </ActionLink>
                      <ActionLink onClick={() => setRestoring(backup)}>
                        <IconUpload size={14} stroke={1.6} aria-hidden="true" />
                        Restore
                      </ActionLink>
                      <ActionLink
                        tone="danger"
                        onClick={() => setDeleting(backup)}
                      >
                        <IconTrash size={14} stroke={1.6} aria-hidden="true" />
                        Delete
                      </ActionLink>
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </Panel>

      <p className="mt-3 text-xs leading-relaxed text-dim">
        Demo only. Creating a backup adds a sample row; downloading produces a
        placeholder file. No database is read or replaced.
      </p>

      <Modal
        open={Boolean(restoring)}
        onClose={() => setRestoring(null)}
        title="Restore this backup?"
        description={
          restoring
            ? `${restoring.name} replaces the current database. This cannot be undone.`
            : undefined
        }
        className="max-w-md"
        footer={
          <>
            <GhostButton onClick={() => setRestoring(null)}>Cancel</GhostButton>
            <DangerButton onClick={restore}>Restore backup</DangerButton>
          </>
        }
      >
        <p className="text-sm text-dim">
          In a real install this action requires a fresh MFA check and restarts
          the API with the restored data. The demo only shows the confirmation.
        </p>
      </Modal>

      <Modal
        open={Boolean(deleting)}
        onClose={() => setDeleting(null)}
        title="Delete backup?"
        description={
          deleting
            ? `${deleting.name} will be removed from the console server.`
            : undefined
        }
        className="max-w-md"
        footer={
          <>
            <GhostButton onClick={() => setDeleting(null)} data-autofocus>
              Cancel
            </GhostButton>
            <DangerButton onClick={remove}>Delete backup</DangerButton>
          </>
        }
      >
        <p className="text-sm text-dim">
          The file is deleted from the backup volume. This cannot be undone.
        </p>
      </Modal>
    </div>
  );
}
