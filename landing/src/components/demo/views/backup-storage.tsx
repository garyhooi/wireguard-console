"use client";

import { useState } from "react";
import {
  IconCloud,
  IconDatabase,
  IconSettings,
  IconShieldCheck,
} from "@tabler/icons-react";
import { useDemo } from "@/components/demo/store";
import { DemoLoadingOverlay } from "@/components/demo/loading-overlay";
import {
  Badge,
  GhostButton,
  PrimaryButton,
  inputCls,
  labelCls,
  selectCls,
} from "@/components/demo/ui";

function Card({ children }: { children: React.ReactNode }) {
  return (
    <div className="rounded-lg border border-zinc-800 bg-zinc-900/50 p-6">
      {children}
    </div>
  );
}

function SettingsTitle({
  icon: Icon,
  title,
}: {
  icon: typeof IconSettings;
  title: string;
}) {
  return (
    <div className="mb-1 flex items-center gap-2">
      <Icon size={18} stroke={1.6} className="text-zinc-400" aria-hidden="true" />
      <h2 className="text-base font-semibold text-zinc-100">{title}</h2>
    </div>
  );
}

const INTERVALS = [
  { value: "0", label: "Off — manual only" },
  { value: "1", label: "Every hour" },
  { value: "6", label: "Every 6 hours" },
  { value: "12", label: "Every 12 hours" },
  { value: "24", label: "Every day" },
  { value: "72", label: "Every 3 days" },
  { value: "168", label: "Every week" },
  { value: "720", label: "Every 30 days" },
];

export function BackupStorageSettings() {
  const { pushToast } = useDemo();
  const [enabled, setEnabled] = useState(true);
  const [endpoint, setEndpoint] = useState("https://s3.example.com");
  const [region, setRegion] = useState("us-east-1");
  const [bucket, setBucket] = useState("wgconsole-backups");
  const [prefix, setPrefix] = useState("wireguard-console/backups");
  const [accessKey, setAccessKey] = useState("AKIAEXAMPLE");
  const [secret, setSecret] = useState("");
  const [pathStyle, setPathStyle] = useState(true);
  const [interval, setIntervalHours] = useState("24");
  const [retention, setRetention] = useState("7");
  const [busy, setBusy] = useState<"save" | "test" | "schedule" | null>(null);
  const [saved, setSaved] = useState(false);

  function saveS3() {
    setBusy("save");
    window.setTimeout(() => {
      setBusy(null);
      setSaved(true);
      pushToast("S3 settings saved");
    }, 700);
  }

  function testS3() {
    setBusy("test");
    window.setTimeout(() => {
      setBusy(null);
      pushToast("S3 connection verified: list, put, get and delete work");
    }, 900);
  }

  function saveSchedule() {
    setBusy("schedule");
    window.setTimeout(() => {
      setBusy(null);
      pushToast(
        interval === "0"
          ? "Automatic backups disabled"
          : "Automatic backup schedule saved",
      );
    }, 600);
  }

  const disabled = busy !== null;

  const busyLabel =
    busy === "test"
      ? "Testing S3 connection"
      : busy === "save"
        ? "Saving S3 settings"
        : busy === "schedule"
          ? "Saving backup schedule"
          : "";

  return (
    <div className="max-w-3xl space-y-6">
      {busy && <DemoLoadingOverlay label={busyLabel} />}
      <Card>
        <SettingsTitle icon={IconCloud} title="S3-compatible destination" />
        <p className="mb-4 text-sm leading-relaxed text-zinc-400">
          Every new backup is uploaded after its restore check. Use AWS S3 with
          an empty endpoint, or any S3-compatible provider such as MinIO, R2,
          Backblaze B2 or Wasabi. Local archives stay available for one-click
          restore.
        </p>

        <div className="space-y-4">
          <label className="flex cursor-pointer items-start gap-3 rounded-md border border-zinc-800 bg-zinc-950/30 p-3">
            <input
              type="checkbox"
              className="mt-0.5 h-4 w-4 accent-teal-500"
              checked={enabled}
              disabled={disabled}
              onChange={(event) => setEnabled(event.target.checked)}
            />
            <span>
              <span className="block text-sm text-zinc-200">
                Upload backups to S3
              </span>
              <span className="block text-xs leading-relaxed text-zinc-500">
                Manual and automatic backups. Retention removes matching S3
                objects as well as local files.
              </span>
            </span>
          </label>

          <div className="grid gap-4 sm:grid-cols-2">
            <div>
              <label htmlFor="s3Endpoint" className={labelCls}>
                Endpoint
              </label>
              <input
                id="s3Endpoint"
                className={inputCls}
                value={endpoint}
                disabled={disabled}
                onChange={(event) => setEndpoint(event.target.value)}
                placeholder="https://s3.example.com (blank for AWS)"
              />
            </div>
            <div>
              <label htmlFor="s3Region" className={labelCls}>
                Region
              </label>
              <input
                id="s3Region"
                className={inputCls}
                value={region}
                disabled={disabled}
                onChange={(event) => setRegion(event.target.value)}
                placeholder="us-east-1"
              />
            </div>
            <div>
              <label htmlFor="s3Bucket" className={labelCls}>
                Bucket
              </label>
              <input
                id="s3Bucket"
                className={inputCls}
                value={bucket}
                disabled={disabled}
                onChange={(event) => setBucket(event.target.value)}
                placeholder="my-wireguard-backups"
              />
            </div>
            <div>
              <label htmlFor="s3Prefix" className={labelCls}>
                Object prefix
              </label>
              <input
                id="s3Prefix"
                className={inputCls}
                value={prefix}
                disabled={disabled}
                onChange={(event) => setPrefix(event.target.value)}
                placeholder="wireguard-console/backups"
              />
            </div>
            <div>
              <label htmlFor="s3AccessKey" className={labelCls}>
                Access key ID
              </label>
              <input
                id="s3AccessKey"
                className={inputCls}
                value={accessKey}
                disabled={disabled}
                onChange={(event) => setAccessKey(event.target.value)}
                autoComplete="off"
              />
            </div>
            <div>
              <label htmlFor="s3Secret" className={labelCls}>
                Secret access key
              </label>
              <input
                id="s3Secret"
                type="password"
                className={inputCls}
                value={secret}
                disabled={disabled}
                onChange={(event) => setSecret(event.target.value)}
                placeholder="Stored — leave blank to keep"
                autoComplete="new-password"
              />
            </div>
          </div>

          <label className="flex items-start gap-3 rounded-md border border-zinc-800 bg-zinc-950/30 p-3">
            <input
              type="checkbox"
              className="mt-0.5 h-4 w-4 accent-teal-500"
              checked={pathStyle}
              disabled={disabled}
              onChange={(event) => setPathStyle(event.target.checked)}
            />
            <span>
              <span className="block text-sm text-zinc-200">
                Force path-style URLs
              </span>
              <span className="block text-xs leading-relaxed text-zinc-500">
                Usually needed for MinIO and some self-hosted gateways.
              </span>
            </span>
          </label>

          <div className="rounded-md border border-zinc-800 bg-zinc-950/30 p-3 text-xs leading-relaxed text-zinc-500">
            <div className="mb-1 flex items-center gap-1.5 text-zinc-300">
              <IconShieldCheck size={14} stroke={1.7} aria-hidden="true" />
              Required S3 permissions
            </div>
            <code className="block break-all font-mono text-[11px] text-zinc-400">
              s3:ListBucket on the bucket; s3:GetObject, s3:PutObject,
              s3:DeleteObject on bucket/prefix/*
            </code>
            <p className="mt-1.5">
              The test checks list, put, get and delete with a temporary object.
              Credentials are encrypted at rest and never returned by the API.
            </p>
          </div>

          <div className="flex flex-wrap items-center gap-3">
            <PrimaryButton onClick={saveS3} disabled={disabled}>
              {busy === "save" ? "Saving…" : "Save S3 settings"}
            </PrimaryButton>
            <GhostButton onClick={testS3} disabled={disabled}>
              {busy === "test" ? "Testing…" : "Test connection"}
            </GhostButton>
            {saved && <Badge tone="good">Demo settings saved</Badge>}
          </div>
        </div>
      </Card>

      <Card>
        <SettingsTitle
          icon={IconDatabase}
          title="Automatic backups & retention"
        />
        <p className="mb-4 text-sm leading-relaxed text-zinc-400">
          Schedule a backup independently of manual creates. Retention applies
          after every backup; 0 keeps every archive. If verification or the S3
          upload fails, retention pauses to protect older copies.
        </p>

        <div className="grid gap-4 sm:grid-cols-2">
          <div>
            <label htmlFor="backupInterval" className={labelCls}>
              Backup interval
            </label>
            <select
              id="backupInterval"
              className={selectCls}
              value={interval}
              disabled={disabled}
              onChange={(event) => setIntervalHours(event.target.value)}
            >
              {INTERVALS.map((item) => (
                <option key={item.value} value={item.value}>
                  {item.label}
                </option>
              ))}
            </select>
          </div>
          <div>
            <label htmlFor="backupRetention" className={labelCls}>
              Keep last N backups
            </label>
            <input
              id="backupRetention"
              type="number"
              min={0}
              max={100}
              className={inputCls}
              value={retention}
              disabled={disabled}
              onChange={(event) => setRetention(event.target.value)}
            />
            <p className="mt-1 text-xs text-zinc-600">0 = unlimited; max 100.</p>
          </div>
        </div>

        <p className="mt-4 text-xs text-zinc-500">
          Last automatic attempt: 2026-11-13 03:12 · verified and uploaded to S3.
        </p>

        <div className="mt-4 flex flex-wrap items-center gap-3">
          <PrimaryButton onClick={saveSchedule} disabled={disabled}>
            {busy === "schedule" ? "Saving…" : "Save schedule"}
          </PrimaryButton>
          <span className="text-xs text-zinc-500">Demo values only.</span>
        </div>
      </Card>
    </div>
  );
}