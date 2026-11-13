"use client";

import { useState } from "react";
import {
  IconClock,
  IconCode,
  IconMail,
  IconSend,
  IconSettings,
  IconShieldLock,
} from "@tabler/icons-react";
import { useDemo } from "@/components/demo/store";
import {
  GhostButton,
  PageHeader,
  PrimaryButton,
  inputCls,
  labelCls,
  selectCls,
} from "@/components/demo/ui";

type ConfigTab = "smtp" | "templates" | "timezone" | "security";

const TABS: Array<{
  id: ConfigTab;
  label: string;
  icon: typeof IconSettings;
}> = [
  { id: "smtp", label: "Email (SMTP)", icon: IconSettings },
  { id: "templates", label: "Email templates", icon: IconCode },
  { id: "timezone", label: "Timezone", icon: IconClock },
  { id: "security", label: "Security", icon: IconShieldLock },
];

const ZONES = [
  "UTC",
  "Europe/London",
  "Europe/Berlin",
  "Europe/Warsaw",
  "Asia/Dubai",
  "Asia/Singapore",
  "Asia/Kuala_Lumpur",
  "Asia/Tokyo",
  "America/New_York",
  "America/Chicago",
  "America/Denver",
  "America/Los_Angeles",
  "Australia/Sydney",
];

const TEMPLATES = {
  "vpn-invite": {
    label: "VPN user invite",
    subject: "You have been invited to WireGuard Console",
    body: `Hi {{user_name}},

Your VPN access is ready. Open the claim link below to choose your device and download the WireGuard config:

{{claim_url}}

The link expires in {{expiry_hours}} hours. If you were not expecting this invite, ignore this message.

The WireGuard Console team`,
  },
  "admin-invite": {
    label: "Admin invite",
    subject: "You have been invited to operate WireGuard Console",
    body: `Hi {{admin_email}},

You have been invited as {{role}} for WireGuard Console. Set your password and enroll MFA here:

{{invite_url}}

This invite expires in {{expiry_hours}} hours.

The WireGuard Console team`,
  },
  "peer-claim": {
    label: "Peer config link",
    subject: "Your WireGuard configuration is ready",
    body: `Hi {{user_name}},

Your device {{peer_name}} is ready. Claim the config on this page:

{{claim_url}}

The link expires in {{expiry_hours}} hours.

The WireGuard Console team`,
  },
} as const;

type TemplateKey = keyof typeof TEMPLATES;

function Card({ children, className = "" }: { children: React.ReactNode; className?: string }) {
  return (
    <div
      className={`rounded-lg border border-zinc-800 bg-zinc-900/50 p-6 ${
        className || "max-w-xl"
      }`}
    >
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

function SmtpSettings() {
  const { pushToast } = useDemo();
  const [form, setForm] = useState({
    host: "smtp.example.com",
    port: "587",
    username: "console",
    password: "",
    from: "no-reply@console.local",
  });
  const [testTo, setTestTo] = useState("");
  const [message, setMessage] = useState("");

  function save() {
    setMessage("SMTP settings saved.");
    pushToast("SMTP settings saved");
  }

  function sendTest() {
    if (!testTo.trim()) return;
    setMessage(`Test email queued to ${testTo.trim()}.`);
    pushToast("Test email queued", "info");
  }

  return (
    <Card>
      <SettingsTitle icon={IconMail} title="Email (SMTP)" />
      <p className="mb-4 text-sm leading-relaxed text-zinc-400">
        Used for user invitations and admin invites. Saved in the console
        database, no server file edits needed.
      </p>

      {message && (
        <p role="status" className="mb-3 text-sm text-teal-400">
          {message}
        </p>
      )}

      <form
        onSubmit={(event) => event.preventDefault()}
        className="space-y-4"
      >
        <div>
          <label htmlFor="smtpHost" className={labelCls}>
            SMTP host
          </label>
          <input
            id="smtpHost"
            value={form.host}
            onChange={(event) =>
              setForm((value) => ({ ...value, host: event.target.value }))
            }
            placeholder="smtp.example.com"
            className={inputCls}
          />
        </div>

        <div className="grid grid-cols-2 gap-4">
          <div>
            <label htmlFor="smtpPort" className={labelCls}>
              Port
            </label>
            <input
              id="smtpPort"
              value={form.port}
              onChange={(event) =>
                setForm((value) => ({ ...value, port: event.target.value }))
              }
              className={inputCls}
            />
          </div>
          <div>
            <label htmlFor="smtpUser" className={labelCls}>
              Username
            </label>
            <input
              id="smtpUser"
              autoComplete="username"
              value={form.username}
              onChange={(event) =>
                setForm((value) => ({ ...value, username: event.target.value }))
              }
              className={inputCls}
            />
          </div>
        </div>

        <div>
          <label htmlFor="smtpPass" className={labelCls}>
            Password
            <span className="font-normal text-dim">
              {" "}
              (stored, leave empty to keep)
            </span>
          </label>
          <input
            id="smtpPass"
            type="password"
            value={form.password}
            onChange={(event) =>
              setForm((value) => ({ ...value, password: event.target.value }))
            }
            autoComplete="new-password"
            placeholder="••••••••"
            className={inputCls}
          />
        </div>

        <div>
          <label htmlFor="smtpFrom" className={labelCls}>
            From address
          </label>
          <input
            id="smtpFrom"
            value={form.from}
            onChange={(event) =>
              setForm((value) => ({ ...value, from: event.target.value }))
            }
            placeholder="no-reply@example.com"
            className={inputCls}
          />
        </div>

        <div className="flex flex-wrap items-center gap-3 pt-2">
          <PrimaryButton onClick={save}>Save SMTP Settings</PrimaryButton>
          <div className="flex items-center gap-2">
            <input
              id="smtpTestTo"
              name="smtpTestTo"
              autoComplete="off"
              value={testTo}
              onChange={(event) => setTestTo(event.target.value)}
              placeholder="test@example.com"
              aria-label="Test recipient"
              className="w-44 rounded-md border border-zinc-700 bg-zinc-800/60 px-3 py-2 text-sm text-zinc-100 placeholder:text-dim focus:outline-none focus:ring-2 focus:ring-teal-500"
            />
            <GhostButton onClick={sendTest} disabled={!testTo.trim()}>
              <IconSend size={15} stroke={1.6} aria-hidden="true" />
              Send test
            </GhostButton>
          </div>
        </div>
      </form>
    </Card>
  );
}

function TemplateSettings() {
  const { pushToast } = useDemo();
  const [key, setKey] = useState<TemplateKey>("vpn-invite");
  const template = TEMPLATES[key];
  const [subject, setSubject] = useState<string>(template.subject);
  const [body, setBody] = useState<string>(template.body);
  const [message, setMessage] = useState("");

  function choose(next: TemplateKey) {
    setKey(next);
    setSubject(TEMPLATES[next].subject);
    setBody(TEMPLATES[next].body);
    setMessage("");
  }

  function save() {
    setMessage("Template saved.");
    pushToast("Email template saved");
  }

  return (
    <Card className="max-w-3xl">
      <SettingsTitle icon={IconCode} title="Email templates" />
      <p className="mb-4 text-sm leading-relaxed text-zinc-400">
        Variables in double braces are replaced when a message is sent. Keep the
        claim and invite links intact so recipients can finish setup.
      </p>

      {message && (
        <p role="status" className="mb-3 text-sm text-teal-400">
          {message}
        </p>
      )}

      <div className="space-y-4">
        <div>
          <label htmlFor="templateKey" className={labelCls}>
            Template
          </label>
          <select
            id="templateKey"
            value={key}
            onChange={(event) => choose(event.target.value as TemplateKey)}
            className={selectCls}
          >
            {(Object.keys(TEMPLATES) as TemplateKey[]).map((id) => (
              <option key={id} value={id}>
                {TEMPLATES[id].label}
              </option>
            ))}
          </select>
        </div>

        <div>
          <label htmlFor="templateSubject" className={labelCls}>
            Subject
          </label>
          <input
            id="templateSubject"
            value={subject}
            onChange={(event) => setSubject(event.target.value)}
            className={inputCls}
          />
        </div>

        <div>
          <label htmlFor="templateBody" className={labelCls}>
            Message
          </label>
          <textarea
            id="templateBody"
            value={body}
            onChange={(event) => setBody(event.target.value)}
            rows={11}
            className={`${inputCls} resize-y font-mono text-xs leading-relaxed`}
          />
        </div>

        <div className="flex flex-wrap items-center justify-between gap-3">
          <p className="font-mono text-[11px] text-dim">
            {"{{user_name}}"} {"{{claim_url}}"} {"{{expiry_hours}}"}
          </p>
          <PrimaryButton onClick={save}>Save template</PrimaryButton>
        </div>
      </div>
    </Card>
  );
}

function TimezoneSettings() {
  const { pushToast } = useDemo();
  const [current, setCurrent] = useState("Asia/Kuala_Lumpur");
  const [draft, setDraft] = useState("Asia/Kuala_Lumpur");
  const [message, setMessage] = useState("");
  const [error, setError] = useState("");

  const preview = (() => {
    try {
      return new Intl.DateTimeFormat("en-GB", {
        timeZone: draft,
        hour: "2-digit",
        minute: "2-digit",
      }).format(new Date("2026-01-15T20:00:00Z"));
    } catch {
      return "";
    }
  })();

  function save() {
    setCurrent(draft);
    setMessage(
      `Timezone set to ${draft}. Reports and timestamps across the console now use it.`,
    );
    setError("");
    pushToast("Timezone saved");
  }

  function reset() {
    let browser = "UTC";
    try {
      browser = Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";
    } catch {
      // keep UTC
    }
    setDraft(browser);
    setCurrent(browser);
    setMessage(
      `Timezone now follows the browser (${browser}) for this demo.`,
    );
    setError("");
    pushToast("Timezone reset to browser", "info");
  }

  return (
    <Card>
      <SettingsTitle icon={IconClock} title="Timezone" />
      <p className="mb-4 text-sm leading-relaxed text-zinc-400">
        The display timezone for reports, charts and logs across the console.
        Picked once by an admin, it applies to every viewer so the usage report,
        traffic chart and web-activity records all align to one clock.
      </p>

      {error && (
        <p role="alert" className="mb-3 text-sm text-red-400">
          {error}
        </p>
      )}
      {message && (
        <p role="status" className="mb-3 text-sm text-teal-400">
          {message}
        </p>
      )}

      <div className="space-y-5">
        <div className="flex items-baseline justify-between gap-3 text-sm">
          <span className="text-dim">Currently</span>
          <span className="font-mono tabular-nums text-zinc-100">
            {current}
          </span>
        </div>

        <div>
          <label htmlFor="tzZone" className={labelCls}>
            Timezone
          </label>
          <select
            id="tzZone"
            value={draft}
            onChange={(event) => setDraft(event.target.value)}
            className={selectCls}
          >
            {ZONES.map((zone) => (
              <option key={zone} value={zone}>
                {zone}
              </option>
            ))}
          </select>
          <p className="mt-1.5 text-xs leading-relaxed text-dim">
            Stored as an IANA zone name. Reports and log timestamps render in
            this zone for every viewer.
          </p>
        </div>

        <div className="rounded-md border border-zinc-800 bg-zinc-950/60 px-3 py-2.5 text-sm">
          <span className="text-dim">20:00 UTC is</span>{" "}
          <span className="font-mono tabular-nums text-teal-300">
            {preview}
          </span>{" "}
          <span className="text-dim">in {draft}</span>
        </div>

        <div className="flex flex-wrap items-center gap-3 pt-1">
          <PrimaryButton onClick={save} disabled={draft === current}>
            Save timezone
          </PrimaryButton>
          <GhostButton onClick={reset}>Reset to browser timezone</GhostButton>
        </div>
      </div>
    </Card>
  );
}

function SecuritySettings() {
  const { pushToast } = useDemo();
  const [attempts, setAttempts] = useState("3");
  const [ipSeconds, setIpSeconds] = useState("60");
  const [accountSeconds, setAccountSeconds] = useState("60");
  const [vpnHours, setVpnHours] = useState("72");
  const [peerHours, setPeerHours] = useState("72");
  const [adminHours, setAdminHours] = useState("24");
  const [message, setMessage] = useState("");
  const [error, setError] = useState("");

  function saveLockout() {
    const a = Number(attempts);
    const ip = Number(ipSeconds);
    const account = Number(accountSeconds);
    if (
      !Number.isInteger(a) ||
      a < 1 ||
      a > 20 ||
      !Number.isInteger(ip) ||
      ip < 5 ||
      ip > 3600 ||
      !Number.isInteger(account) ||
      account < 5 ||
      account > 3600
    ) {
      setError("Attempts must be 1-20 and lockout windows 5-3600 seconds.");
      return;
    }
    setError("");
    setMessage("Login lockout policy saved.");
    pushToast("Login lockout policy saved");
  }

  function saveExpiry() {
    const values = [Number(vpnHours), Number(peerHours), Number(adminHours)];
    if (
      values.some(
        (value) => !Number.isInteger(value) || value < 1 || value > 720,
      )
    ) {
      setError("Expiry windows must be whole hours between 1 and 720.");
      return;
    }
    setError("");
    setMessage("Invite expiry settings saved.");
    pushToast("Invite expiry settings saved");
  }

  return (
    <div className="max-w-3xl space-y-6">
      {error && (
        <p role="alert" className="text-sm text-red-400">
          {error}
        </p>
      )}
      {message && (
        <p role="status" className="text-sm text-teal-400">
          {message}
        </p>
      )}

      <Card className="max-w-none">
        <SettingsTitle icon={IconShieldLock} title="Login lockout" />
        <p className="mb-4 text-sm leading-relaxed text-zinc-400">
          After this many wrong passwords, both the source IP and the account are
          locked for the configured windows. Changing IP does not bypass the
          account lock. Defaults: 3 attempts, 60 seconds each.
        </p>

        <div className="space-y-5">
          <div className="flex items-baseline justify-between gap-3 text-sm">
            <span className="text-dim">Currently</span>
            <span className="font-mono tabular-nums text-zinc-100">
              {attempts} attempts · IP {ipSeconds}s · account {accountSeconds}s
            </span>
          </div>

          <div className="grid gap-4 sm:grid-cols-3">
            <div>
              <label htmlFor="loginMaxAttempts" className={labelCls}>
                Failed attempts
              </label>
              <input
                id="loginMaxAttempts"
                type="number"
                min={1}
                max={20}
                value={attempts}
                onChange={(event) => setAttempts(event.target.value)}
                className={inputCls}
              />
            </div>
            <div>
              <label htmlFor="loginIpLockoutSeconds" className={labelCls}>
                IP lockout (seconds)
              </label>
              <input
                id="loginIpLockoutSeconds"
                type="number"
                min={5}
                max={3600}
                value={ipSeconds}
                onChange={(event) => setIpSeconds(event.target.value)}
                className={inputCls}
              />
            </div>
            <div>
              <label htmlFor="loginAccountLockoutSeconds" className={labelCls}>
                Account lockout (seconds)
              </label>
              <input
                id="loginAccountLockoutSeconds"
                type="number"
                min={5}
                max={3600}
                value={accountSeconds}
                onChange={(event) => setAccountSeconds(event.target.value)}
                className={inputCls}
              />
            </div>
          </div>

          <div className="flex flex-wrap items-center gap-3">
            <PrimaryButton onClick={saveLockout}>
              Save lockout policy
            </PrimaryButton>
            <p className="text-xs text-dim">
              Attempts 1-20, windows 5-3600s. Applies to new lockouts.
            </p>
          </div>
        </div>
      </Card>

      <Card className="max-w-none">
        <SettingsTitle icon={IconClock} title="Invite and claim expiry" />
        <p className="mb-4 text-sm leading-relaxed text-zinc-400">
          How long invite links stay valid. Shorter windows reduce the exposure
          of a forwarded email; longer windows are easier for people on holiday.
        </p>

        <div className="grid gap-4 sm:grid-cols-3">
          <div>
            <label htmlFor="vpnExpiryHours" className={labelCls}>
              VPN invite (hours)
            </label>
            <input
              id="vpnExpiryHours"
              type="number"
              min={1}
              max={720}
              value={vpnHours}
              onChange={(event) => setVpnHours(event.target.value)}
              className={inputCls}
            />
          </div>
          <div>
            <label htmlFor="peerExpiryHours" className={labelCls}>
              Peer claim (hours)
            </label>
            <input
              id="peerExpiryHours"
              type="number"
              min={1}
              max={720}
              value={peerHours}
              onChange={(event) => setPeerHours(event.target.value)}
              className={inputCls}
            />
          </div>
          <div>
            <label htmlFor="adminExpiryHours" className={labelCls}>
              Admin invite (hours)
            </label>
            <input
              id="adminExpiryHours"
              type="number"
              min={1}
              max={720}
              value={adminHours}
              onChange={(event) => setAdminHours(event.target.value)}
              className={inputCls}
            />
          </div>
        </div>

        <div className="mt-4 flex flex-wrap items-center gap-3">
          <PrimaryButton onClick={saveExpiry}>Save expiry settings</PrimaryButton>
          <p className="text-xs text-dim">
            Windows 1-720 hours. Applies to links issued after saving.
          </p>
        </div>
      </Card>
    </div>
  );
}

export function ConfigurationView() {
  const [tab, setTab] = useState<ConfigTab>("smtp");

  return (
    <div>
      <PageHeader
        title="Configuration"
        description="Outbound email (SMTP), the templates the console uses for invites, the display timezone for reports and logs, and security policy."
      />

      <div className="mb-6 flex flex-wrap items-center gap-1 border-b border-zinc-800">
        {TABS.map(({ id, label, icon: Icon }) => {
          const active = tab === id;
          return (
            <button
              key={id}
              type="button"
              onClick={() => setTab(id)}
              aria-current={active ? "page" : undefined}
              className={`-mb-px inline-flex items-center gap-2 border-b-2 px-4 py-2.5 text-sm font-medium transition-colors ${
                active
                  ? "border-teal-500 text-teal-300"
                  : "border-transparent text-dim hover:border-zinc-700 hover:text-zinc-200"
              }`}
            >
              <Icon size={16} stroke={1.7} aria-hidden="true" />
              {label}
            </button>
          );
        })}
      </div>

      {tab === "smtp" && <SmtpSettings />}
      {tab === "templates" && <TemplateSettings />}
      {tab === "timezone" && <TimezoneSettings />}
      {tab === "security" && <SecuritySettings />}
    </div>
  );
}