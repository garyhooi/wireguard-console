"use client";

import { useState } from "react";
import {
  IconArchive,
  IconCloud,
  IconDownload,
  IconLock,
  IconShieldCheck,
  IconTrash,
  IconUpload,
} from "@tabler/icons-react";
import { useDemo } from "@/components/demo/store";
import { DemoLoadingOverlay } from "@/components/demo/loading-overlay";
import {
  ActionLink,
  Badge,
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
  encrypted: boolean;
  verified: boolean;
  s3: boolean;
};

const SEED: Backup[] = [
  {
    name: "wgconsole_backup_20261113_031244.sql.gz.enc",
    created: "2026-11-13 03:12",
    size: "2.4 MB",
    encrypted: true,
    verified: true,
    s3: true,
  },
  {
    name: "wgconsole_backup_20261112_031201.sql.gz.enc",
    created: "2026-11-12 03:12",
    size: "2.3 MB",
    encrypted: true,
    verified: true,
    s3: true,
  },
  {
    name: "wgconsole_backup_20261111_031188.sql.gz",
    created: "2026-11-11 03:11",
    size: "2.3 MB",
    encrypted: false,
    verified: true,
    s3: false,
  },
];

function stamp() {
  const d = new Date();
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}_${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}`;
}

export function BackupsView() {
  const { pushToast } = useDemo();
  const [backups, setBackups] = useState<Backup[]>(SEED);
  const [creating, setCreating] = useState(false);
  const [restoring, setRestoring] = useState<Backup | null>(null);
  const [deleting, setDeleting] = useState<Backup | null>(null);
  const [busy, setBusy] = useState<string | null>(null);

  function create() {
    if (creating) return;
    setCreating(true);
    setBusy("Creating and verifying backup");
    window.setTimeout(() => {
      setBackups((items) => [
        {
          name: `wgconsole_backup_${stamp()}.sql.gz.enc`,
          created: "just now",
          size: "2.4 MB",
          encrypted: true,
          verified: true,
          s3: true,
        },
        ...items,
      ]);
      setCreating(false);
      setBusy(null);
      pushToast("Backup created, verified and uploaded to S3");
    }, 1100);
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
    const name = restoring.name;
    setRestoring(null);
    setBusy("Restoring database");
    window.setTimeout(() => {
      setBusy(null);
      pushToast(`Restore queued for ${name}`, "info");
    }, 1100);
  }

  function remove() {
    if (!deleting) return;
    const message = deleting.s3
      ? `${deleting.name} deleted from the console and S3`
      : `${deleting.name} deleted`;
    const name = deleting.name;
    setDeleting(null);
    setBusy(deleting.s3 ? "Deleting local and S3 copies" : "Deleting backup");
    window.setTimeout(() => {
      setBackups((items) => items.filter((item) => item.name !== name));
      setBusy(null);
      pushToast(message, "info");
    }, 750);
  }

  return (
    <div>
      {busy && <DemoLoadingOverlay label={busy} />}
      <PageHeader
        title="Backups"
        description="Every new backup runs pg_dump, is encrypted when backup encryption is enabled, restored into a temporary database to verify it, and uploaded to S3 when configured. Automatic schedules and retention live under Configuration → Backup storage. Downloading, restoring, uploading or deleting requires an MFA step-up (passkey or authenticator code)."
        actions={
          <PrimaryButton onClick={create} disabled={creating}>
            <IconArchive size={16} stroke={1.6} aria-hidden="true" />
            {creating ? "Creating…" : "Create backup now"}
          </PrimaryButton>
        }
      />

      <Panel
        title={`Saved backups (${backups.length})`}
        right={<Badge tone="info">Auto: daily · keep 7 · S3</Badge>}
      >
        <div className="overflow-x-auto">
          <table className={tableCls}>
            <thead>
              <tr className="bg-zinc-800/40 text-left text-[11px] uppercase tracking-wider text-dim">
                <th className={thCls}>Created</th>
                <th className={thCls}>Filename</th>
                <th className={thCls}>Size</th>
                <th className={thCls}>Protection</th>
                <th className={thCls}>Verification</th>
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
                  <td className={tdCls}>
                    <div className="flex flex-wrap gap-1">
                      <Badge tone={backup.encrypted ? "good" : "neutral"}>
                        {backup.encrypted && (
                          <IconLock size={12} stroke={1.7} aria-hidden="true" />
                        )}
                        {backup.encrypted ? "Encrypted" : "Plain"}
                      </Badge>
                      {backup.s3 && (
                        <Badge tone="info">
                          <IconCloud size={12} stroke={1.7} aria-hidden="true" />
                          S3
                        </Badge>
                      )}
                    </div>
                  </td>
                  <td className={tdCls}>
                    <Badge tone={backup.verified ? "good" : "bad"}>
                      {backup.verified && (
                        <IconShieldCheck size={12} stroke={1.7} aria-hidden="true" />
                      )}
                      {backup.verified ? "Verified" : "Unverified"}
                    </Badge>
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
        placeholder file. No database is read, replaced, uploaded or deleted.
        In a real install, deleting an S3-backed backup removes both the local
        archive and the remote object.
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
          the API with the restored data. Passphrase-encrypted archives also
          need the backup passphrase. The demo only shows the confirmation.
        </p>
      </Modal>

      <Modal
        open={Boolean(deleting)}
        onClose={() => setDeleting(null)}
        title="Delete backup?"
        description={
          deleting
            ? deleting.s3
              ? `${deleting.name} will be removed from the console server and its S3 bucket.`
              : `${deleting.name} will be removed from the console server.`
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
          {deleting?.s3
            ? "The local archive and its S3 object are deleted. If the S3 copy cannot be removed, the local file is kept so you can fix the destination and retry."
            : "The file is deleted from the backup volume. This cannot be undone."}
        </p>
      </Modal>
    </div>
  );
}