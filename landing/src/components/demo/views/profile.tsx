"use client";

import { useState } from "react";
import {
  IconDeviceLaptop,
  IconFingerprint,
  IconKey,
  IconPlus,
} from "@tabler/icons-react";
import { useDemo } from "@/components/demo/store";
import {
  Badge,
  GhostButton,
  PageHeader,
  Panel,
  PrimaryButton,
  inputCls,
  labelCls,
} from "@/components/demo/ui";

export function ProfileView() {
  const { pushToast } = useDemo();
  const [pw, setPw] = useState({ current: "", next: "", confirm: "" });
  const [pwError, setPwError] = useState("");
  const [pwMessage, setPwMessage] = useState("");

  function changePassword(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (pw.next.length < 12) {
      setPwError("Use at least 12 characters for the new password.");
      setPwMessage("");
      return;
    }
    if (pw.next !== pw.confirm) {
      setPwError("New passwords do not match.");
      setPwMessage("");
      return;
    }
    setPwError("");
    setPwMessage("Password updated for this demo.");
    setPw({ current: "", next: "", confirm: "" });
    pushToast("Password updated");
  }

  return (
    <div>
      <PageHeader
        title="Profile"
        description="Manage your console account: password and multi-factor authentication."
      />

      <div className="grid grid-cols-1 gap-6 lg:grid-cols-2">
        <Panel title="Account">
          <div className="space-y-3 px-5 py-4">
            <div className="flex items-center justify-between gap-3">
              <span className="text-sm text-dim">Email</span>
              <span className="font-mono text-sm text-zinc-200">
                demo@console.local
              </span>
            </div>
            <div className="flex items-center justify-between gap-3">
              <span className="text-sm text-dim">Role</span>
              <Badge tone="accent">super admin</Badge>
            </div>
            <div className="flex items-center justify-between gap-3">
              <span className="text-sm text-dim">MFA</span>
              <Badge tone="good">enabled</Badge>
            </div>
            <p className="pt-2 text-xs leading-relaxed text-dim">
              Multi-factor authentication protects this account and every
              privileged action.
            </p>
          </div>
        </Panel>

        <Panel title="Change password">
          <form onSubmit={changePassword} className="space-y-4 px-5 py-4">
            <input
              type="text"
              name="username"
              autoComplete="username"
              value="demo@console.local"
              readOnly
              hidden
            />
            {pwError && (
              <p role="alert" className="text-sm text-red-400">
                {pwError}
              </p>
            )}
            {pwMessage && (
              <p role="status" className="text-sm text-teal-400">
                {pwMessage}
              </p>
            )}
            <div>
              <label htmlFor="current-password" className={labelCls}>
                Current password
              </label>
              <input
                id="current-password"
                type="password"
                required
                autoComplete="current-password"
                value={pw.current}
                onChange={(event) =>
                  setPw((value) => ({ ...value, current: event.target.value }))
                }
                className={inputCls}
              />
            </div>
            <div>
              <label htmlFor="new-password" className={labelCls}>
                New password
              </label>
              <input
                id="new-password"
                type="password"
                required
                autoComplete="new-password"
                value={pw.next}
                onChange={(event) =>
                  setPw((value) => ({ ...value, next: event.target.value }))
                }
                className={inputCls}
              />
              <p className="mt-1 text-xs leading-relaxed text-dim">
                At least 12 characters, with upper/lowercase, a number and a
                special character.
              </p>
            </div>
            <div>
              <label htmlFor="confirm-password" className={labelCls}>
                Confirm new password
              </label>
              <input
                id="confirm-password"
                type="password"
                required
                autoComplete="new-password"
                value={pw.confirm}
                onChange={(event) =>
                  setPw((value) => ({ ...value, confirm: event.target.value }))
                }
                className={inputCls}
              />
            </div>
            <PrimaryButton type="submit">Update Password</PrimaryButton>
          </form>
        </Panel>
      </div>

      <div className="mt-6">
        <Panel
          title="Multi-factor authentication"
          right={<Badge tone="good">enabled</Badge>}
        >
          <div className="space-y-5 px-5 py-4">
            <p className="text-sm leading-relaxed text-dim">
              Sign in and authorize sensitive actions with a passkey, an
              authenticator app, or a one-time recovery code. A passkey can also
              sign you in from the login page without a password.
            </p>

            <ul className="divide-y divide-zinc-800/60 overflow-hidden rounded-lg border border-zinc-800">
              <li className="flex flex-wrap items-center gap-3 px-4 py-3">
                <span className="flex h-9 w-9 items-center justify-center rounded-lg bg-zinc-800/70 text-zinc-400">
                  <IconKey size={18} stroke={1.6} aria-hidden="true" />
                </span>
                <div className="min-w-0 flex-1">
                  <div className="flex flex-wrap items-center gap-2">
                    <span className="text-sm font-medium text-zinc-200">
                      Authenticator app
                    </span>
                    <Badge tone="good">enabled</Badge>
                  </div>
                  <p className="mt-0.5 text-xs text-dim">
                    Added 2026-01-12 · last used 2026-11-13
                  </p>
                </div>
                <ActionRemove onClick={() => pushToast("Authenticator removed (demo)", "info")} />
              </li>

              <li className="flex flex-wrap items-center gap-3 px-4 py-3">
                <span className="flex h-9 w-9 items-center justify-center rounded-lg bg-zinc-800/70 text-zinc-400">
                  <IconFingerprint size={18} stroke={1.6} aria-hidden="true" />
                </span>
                <div className="min-w-0 flex-1">
                  <div className="flex flex-wrap items-center gap-2">
                    <span className="text-sm font-medium text-zinc-200">
                      MacBook Pro Touch ID
                    </span>
                    <Badge tone="accent">passkey</Badge>
                  </div>
                  <p className="mt-0.5 text-xs text-dim">
                    Added 2026-03-04 · last used 2026-11-13 · synced
                  </p>
                </div>
                <ActionRemove onClick={() => pushToast("Passkey removed (demo)", "info")} />
              </li>
            </ul>

            <div className="flex flex-wrap gap-3">
              <PrimaryButton onClick={() => pushToast("Passkey added (demo)")}>
                <IconPlus size={15} stroke={1.8} aria-hidden="true" />
                Add passkey
              </PrimaryButton>
              <GhostButton
                onClick={() => pushToast("Authenticator flow opened (demo)", "info")}
              >
                <IconPlus size={15} stroke={1.8} aria-hidden="true" />
                Add authenticator app
              </GhostButton>
            </div>

            <div className="flex flex-wrap items-center justify-between gap-3 border-t border-zinc-800 pt-4">
              <div>
                <p className="text-sm text-zinc-300">Recovery codes</p>
                <p className="text-xs text-dim">
                  8 of 10 recovery codes remaining. Each code signs you in once.
                </p>
              </div>
              <GhostButton
                onClick={() =>
                  pushToast("New recovery codes generated (demo)", "info")
                }
              >
                Regenerate recovery codes
              </GhostButton>
            </div>
          </div>
        </Panel>
      </div>

      <div className="mt-6">
        <Panel title="Active sessions">
          <ul className="divide-y divide-zinc-800/60">
            <li className="flex flex-wrap items-center gap-3 px-5 py-4">
              <span className="flex h-9 w-9 items-center justify-center rounded-lg bg-zinc-800/70 text-zinc-400">
                <IconDeviceLaptop size={18} stroke={1.6} aria-hidden="true" />
              </span>
              <div className="min-w-0 flex-1">
                <p className="text-sm text-zinc-200">Chrome on macOS</p>
                <p className="mt-0.5 font-mono text-xs text-dim">
                  10.8.0.1 · current session
                </p>
              </div>
              <Badge tone="good">current</Badge>
            </li>
          </ul>
        </Panel>
      </div>
    </div>
  );
}

function ActionRemove({ onClick }: { onClick: () => void }) {
  return (
    <button
      type="button"
      onClick={onClick}
      className="shrink-0 rounded-md px-2 py-1 text-xs font-medium text-red-400 transition-colors hover:bg-red-500/10 hover:text-red-300 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-teal-500"
    >
      Remove
    </button>
  );
}