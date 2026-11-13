"use client";

import { useEffect, useMemo, useState } from "react";
import {
  IconDownload,
  IconPlayerPause,
  IconPlayerPlay,
  IconPlus,
  IconTrash,
} from "@tabler/icons-react";
import { useDemo } from "@/components/demo/store";
import {
  buildPeerConfig,
  createJoinCommand,
  departments,
  type PeerKind,
} from "@/components/demo/data";
import {
  CopyButton,
  DangerButton,
  Field,
  GhostButton,
  Modal,
  PrimaryButton,
  StatusBadge,
  inputCls,
  selectCls,
} from "@/components/demo/ui";

export function IssuePeerDialog() {
  const { dialog, regions, issuePeer, closeDialog } = useDemo();
  const open = dialog?.type === "issue";
  const defaultRegion = dialog?.type === "issue" ? dialog.regionId : undefined;

  const [name, setName] = useState("");
  const [device, setDevice] = useState("MacBook Pro");
  const [kind, setKind] = useState<PeerKind>("laptop");
  const [department, setDepartment] = useState<string>(departments[0]);
  const [regionId, setRegionId] = useState("");
  const [error, setError] = useState("");

  useEffect(() => {
    if (!open) return;
    setName("");
    setDevice("MacBook Pro");
    setKind("laptop");
    setDepartment(departments[0]);
    setRegionId(defaultRegion ?? regions[0]?.id ?? "");
    setError("");
  }, [defaultRegion, open, regions]);

  function submit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!name.trim()) {
      setError("Give the peer a name, usually the person and device.");
      return;
    }
    if (!regionId) {
      setError("Choose an exit for this peer.");
      return;
    }
    setError("");
    issuePeer({ name, device, kind, department, regionId });
  }

  return (
    <Modal
      open={open}
      onClose={closeDialog}
      title="Add Peer"
      description="A peer is one device for a user on a server. Keys and the tunnel IP are generated automatically."
      footer={
        <>
          <GhostButton onClick={closeDialog}>Cancel</GhostButton>
          <PrimaryButton type="submit" form="issue-peer-form">
            <IconPlus size={16} stroke={1.6} aria-hidden="true" />
            Add peer
          </PrimaryButton>
        </>
      }
    >
      <form id="issue-peer-form" onSubmit={submit} className="grid gap-4">
        <Field label="Name" htmlFor="peer-name">
          <input
            id="peer-name"
            name="peerName"
            data-autofocus
            value={name}
            onChange={(event) => {
              setName(event.target.value);
              if (error) setError("");
            }}
            placeholder="Mira Chen"
            autoComplete="off"
            className={inputCls}
          />
        </Field>

        <div className="grid gap-4 sm:grid-cols-2">
          <Field label="Device" htmlFor="peer-device">
            <input
              id="peer-device"
              name="peerDevice"
              value={device}
              onChange={(event) => setDevice(event.target.value)}
              placeholder="MacBook Pro"
              autoComplete="off"
              className={inputCls}
            />
          </Field>
          <Field label="Type" htmlFor="peer-kind">
            <select
              id="peer-kind"
              name="peerKind"
              value={kind}
              onChange={(event) => setKind(event.target.value as PeerKind)}
              className={selectCls}
            >
              <option value="laptop">Laptop</option>
              <option value="phone">Phone</option>
              <option value="tablet">Tablet</option>
            </select>
          </Field>
        </div>

        <div className="grid gap-4 sm:grid-cols-2">
          <Field label="Department" htmlFor="peer-department">
            <select
              id="peer-department"
              name="peerDepartment"
              value={department}
              onChange={(event) => setDepartment(event.target.value)}
              className={selectCls}
            >
              {departments.map((item) => (
                <option key={item} value={item}>
                  {item}
                </option>
              ))}
            </select>
          </Field>
          <Field label="Exit" htmlFor="peer-exit">
            <select
              id="peer-exit"
              name="peerExit"
              value={regionId}
              onChange={(event) => setRegionId(event.target.value)}
              className={selectCls}
            >
              {regions.map((region) => (
                <option
                  key={region.id}
                  value={region.id}
                  disabled={region.status === "joining"}
                >
                  {region.code} / {region.city}
                  {region.status === "joining" ? " (joining)" : ""}
                </option>
              ))}
            </select>
          </Field>
        </div>

        {error && (
          <p role="alert" className="text-xs text-red-400">
            {error}
          </p>
        )}

        <p className="text-xs leading-relaxed text-dim">
          Demo only. Key material is generated in this browser tab and never
          reaches a server.
        </p>
      </form>
    </Modal>
  );
}

export function AddNodeDialog() {
  const { dialog, regions, addRegion, closeDialog } = useDemo();
  const open = dialog?.type === "add-node";

  const [name, setName] = useState("Sydney edge");
  const [location, setLocation] = useState("AU, ap-southeast-2");
  const [subnet, setSubnet] = useState("10.12.0.0/24");
  const [error, setError] = useState("");

  useEffect(() => {
    if (!open) return;
    setName("Sydney edge");
    setLocation("AU, ap-southeast-2");
    const next = 12 + Math.max(0, regions.length - 3);
    setSubnet(`10.${next}.0.0/24`);
    setError("");
  }, [open, regions.length]);

  const previewRegion = {
    id: "syd",
    city: name || "New node",
    code: "syd-1",
    zone: location.split(",")[0]?.trim() || "AU",
    status: "ok" as const,
    lastPoll: "waiting",
    servers: 1,
    endpoint: "203.0.113.74:51820",
    subnet,
    dns: subnet.replace(/\/24$/, "").replace(/\.0$/, "") + ".1",
    serverPublicKey: "cHJldmlldy1zZXJ2ZXIta2V5LWZvci10aGUtZGVtby1vbmx5",
  };

  function submit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!name.trim()) {
      setError("Name the node so the agents are easy to tell apart.");
      return;
    }
    if (!/^\d{1,3}(\.\d{1,3}){3}\/24$/.test(subnet.trim())) {
      setError("Use a /24 subnet, for example 10.12.0.0/24.");
      return;
    }
    if (regions.some((region) => region.subnet === subnet.trim())) {
      setError("Another exit already uses that subnet.");
      return;
    }
    setError("");
    addRegion({ name, location, subnet });
  }

  return (
    <Modal
      open={open}
      onClose={closeDialog}
      title="Add Node"
      description="Create the node, then run its one-time join command on the exit host. The agent dials out to this console."
      className="max-w-2xl"
      footer={
        <>
          <GhostButton onClick={closeDialog}>Cancel</GhostButton>
          <PrimaryButton type="submit" form="add-node-form">
            Create node
          </PrimaryButton>
        </>
      }
    >
      <form id="add-node-form" onSubmit={submit} className="grid gap-4">
        <div className="grid gap-4 sm:grid-cols-2">
          <Field label="Name" htmlFor="node-name">
            <input
              id="node-name"
              data-autofocus
              value={name}
              onChange={(event) => {
                setName(event.target.value);
                if (error) setError("");
              }}
              placeholder="Sydney edge"
              className={inputCls}
            />
          </Field>
          <Field label="Location" htmlFor="node-location">
            <input
              id="node-location"
              value={location}
              onChange={(event) => setLocation(event.target.value)}
              placeholder="AU, ap-southeast-2"
              className={inputCls}
            />
          </Field>
        </div>

        <Field
          label="WireGuard subnet"
          htmlFor="node-subnet"
          hint="Every exit needs its own /24. Never reuse one across regions."
        >
          <input
            id="node-subnet"
            value={subnet}
            onChange={(event) => {
              setSubnet(event.target.value);
              if (error) setError("");
            }}
            placeholder="10.12.0.0/24"
            className={`${inputCls} font-mono`}
          />
        </Field>

        {error && (
          <p role="alert" className="text-xs text-red-400">
            {error}
          </p>
        )}

        <div className="overflow-hidden rounded-md border border-zinc-800 bg-zinc-950">
          <div className="flex items-center justify-between gap-3 border-b border-zinc-800 px-3 py-2">
            <span className="text-[11px] font-medium uppercase tracking-wider text-dim">
              Join command
            </span>
            <CopyButton
              value={createJoinCommand(previewRegion)}
              className="border-0 px-1.5 py-1 text-[11px]"
            />
          </div>
          <pre className="thin-scroll overflow-x-auto whitespace-pre-wrap break-all px-3 py-2.5 font-mono text-xs leading-relaxed text-zinc-300">
            <code>{createJoinCommand(previewRegion)}</code>
          </pre>
        </div>
        <p className="text-xs leading-relaxed text-dim">
          After you create the node, the demo waits 2.6 seconds for a simulated
          first poll.
        </p>
      </form>
    </Modal>
  );
}

export function PeerConfigDialog() {
  const {
    dialog,
    peers,
    regions,
    closeDialog,
    togglePeer,
    openRevoke,
  } = useDemo();
  const open = dialog?.type === "config";
  const peer =
    dialog?.type === "config"
      ? peers.find((item) => item.id === dialog.peerId)
      : undefined;
  const region = peer
    ? regions.find((item) => item.id === peer.regionId)
    : undefined;

  const config = useMemo(
    () => (peer && region ? buildPeerConfig(peer, region) : ""),
    [peer, region],
  );

  function download() {
    if (!peer || !config) return;
    const blob = new Blob([config], { type: "text/plain;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement("a");
    anchor.href = url;
    anchor.download = `${peer.name.toLowerCase().replace(/[^a-z0-9]+/g, "-")}.conf`;
    document.body.appendChild(anchor);
    anchor.click();
    anchor.remove();
    URL.revokeObjectURL(url);
  }

  return (
    <Modal
      open={Boolean(open && peer)}
      onClose={closeDialog}
      title={peer ? `${peer.name} · ${peer.device}` : "Peer configuration"}
      description={
        peer && region
          ? `${peer.ip} / ${region.city} (${region.code}) / ${peer.department}`
          : undefined
      }
      className="max-w-2xl"
      footer={
        peer ? (
          <>
            <GhostButton onClick={closeDialog}>Close</GhostButton>
            <GhostButton onClick={() => togglePeer(peer.id)}>
              {peer.status === "active" ? (
                <IconPlayerPause size={15} stroke={1.6} aria-hidden="true" />
              ) : (
                <IconPlayerPlay size={15} stroke={1.6} aria-hidden="true" />
              )}
              {peer.status === "active" ? "Suspend peer" : "Resume peer"}
            </GhostButton>
            <DangerButton onClick={() => openRevoke(peer.id)}>
              <IconTrash size={15} stroke={1.6} aria-hidden="true" />
              Revoke
            </DangerButton>
            <PrimaryButton onClick={download}>
              <IconDownload size={16} stroke={1.6} aria-hidden="true" />
              Download .conf
            </PrimaryButton>
          </>
        ) : (
          <GhostButton onClick={closeDialog}>Close</GhostButton>
        )
      }
    >
      {peer && region && (
        <div className="grid gap-5">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <StatusBadge status={peer.status} />
            <span className="font-mono text-xs text-dim">
              issued {peer.createdAt}
            </span>
          </div>

          <dl className="grid grid-cols-2 gap-x-4 gap-y-3 rounded-md border border-zinc-800 bg-zinc-950 px-4 py-3.5">
            {[
              ["Exit", `${region.code} / ${region.zone}`],
              ["Tunnel IP", peer.ip],
              ["Handshake", peer.lastHandshake],
              ["Endpoint", region.endpoint],
            ].map(([label, value]) => (
              <div key={label}>
                <dt className="text-[10px] uppercase tracking-wider text-dim">
                  {label}
                </dt>
                <dd className="mt-1 break-all font-mono text-xs text-zinc-300">
                  {value}
                </dd>
              </div>
            ))}
          </dl>

          <div className="overflow-hidden rounded-md border border-zinc-800 bg-zinc-950">
            <div className="flex items-center justify-between gap-3 border-b border-zinc-800 px-3 py-2">
              <div>
                <p className="text-[11px] font-medium uppercase tracking-wider text-dim">
                  WireGuard config
                </p>
                <p className="mt-0.5 font-mono text-[10px] text-dim">
                  wg-quick / all traffic
                </p>
              </div>
              <CopyButton value={config} />
            </div>
            <pre className="thin-scroll max-h-[300px] overflow-auto px-3.5 py-3.5 font-mono text-xs leading-relaxed text-zinc-300">
              <code>{config}</code>
            </pre>
          </div>

          <p className="text-xs leading-relaxed text-dim">
            Sample key material generated for this demo. Do not use this config
            on a real device.
          </p>

        </div>
      )}
    </Modal>
  );
}

export function RevokePeerDialog() {
  const { dialog, peers, regions, revokePeer, closeDialog } = useDemo();
  const open = dialog?.type === "revoke";
  const peer =
    dialog?.type === "revoke"
      ? peers.find((item) => item.id === dialog.peerId)
      : undefined;
  const region = peer
    ? regions.find((item) => item.id === peer.regionId)
    : undefined;

  return (
    <Modal
      open={Boolean(open && peer)}
      onClose={closeDialog}
      title="Revoke this peer?"
      description="The config stops working on the next handshake. This cannot be undone in the demo."
      className="max-w-md"
      footer={
        <>
          <GhostButton onClick={closeDialog} data-autofocus>
            Cancel
          </GhostButton>
          <DangerButton onClick={() => peer && revokePeer(peer.id)}>
            Revoke peer
          </DangerButton>
        </>
      }
    >
      {peer && (
        <div className="rounded-md border border-zinc-800 bg-zinc-950 px-4 py-3">
          <p className="text-sm font-medium text-zinc-200">{peer.name}</p>
          <p className="mt-1 font-mono text-xs text-dim">
            {peer.device} / {peer.ip} / exit {region?.code ?? peer.regionId}
          </p>
        </div>
      )}
    </Modal>
  );
}