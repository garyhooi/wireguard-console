"use client";

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useRef,
  useState,
  type ReactNode,
} from "react";
import {
  seedActivity,
  seedIpBlocks,
  seedPeers,
  seedRegions,
  seedRuleGroups,
  type Activity,
  type ActivityKind,
  type IpBlock,
  type Peer,
  type PeerKind,
  type Region,
  type RuleGroup,
  type Toast,
  type ToastTone,
} from "@/components/demo/data";

export type DemoView =
  | "dashboard"
  | "statistics"
  | "server-monitoring"
  | "web-activity"
  | "audit-log"
  | "servers"
  | "peers"
  | "nodes"
  | "users"
  | "departments"
  | "admins"
  | "domain-rules"
  | "ip-rules"
  | "backups"
  | "configuration"
  | "profile";

export type DialogState =
  | { type: "issue"; regionId?: string }
  | { type: "config"; peerId: string }
  | { type: "revoke"; peerId: string }
  | { type: "add-node" }
  | null;

type NewPeerInput = {
  name: string;
  device: string;
  kind: PeerKind;
  department: string;
  regionId: string;
};

type NewRegionInput = {
  name: string;
  location: string;
  subnet: string;
};

type DemoStore = {
  view: DemoView;
  setView: (view: DemoView) => void;
  peers: Peer[];
  regions: Region[];
  activity: Activity[];
  ruleGroups: RuleGroup[];
  ipBlocks: IpBlock[];
  dnsEnabled: boolean;
  dnsScope: string;
  dialog: DialogState;
  toasts: Toast[];
  issuePeer: (input: NewPeerInput) => void;
  togglePeer: (id: string) => void;
  revokePeer: (id: string) => void;
  addRegion: (input: NewRegionInput) => void;
  setDnsEnabled: (value: boolean) => void;
  setDnsScope: (value: string) => void;
  toggleRule: (id: string) => void;
  addRuleGroup: (label: string) => void;
  addIpBlock: (cidr: string, scope?: string) => void;
  removeIpBlock: (id: string) => void;
  openIssue: (regionId?: string) => void;
  openConfig: (peerId: string) => void;
  openRevoke: (peerId: string) => void;
  openAddNode: () => void;
  closeDialog: () => void;
  resetDemo: () => void;
  pushToast: (message: string, tone?: ToastTone) => void;
  dismissToast: (id: number) => void;
};

const DemoContext = createContext<DemoStore | null>(null);

function clonePeers() {
  return seedPeers.map((peer) => ({ ...peer }));
}
function cloneRegions() {
  return seedRegions.map((region) => ({ ...region }));
}
function cloneRules() {
  return seedRuleGroups.map((rule) => ({ ...rule }));
}
function cloneBlocks() {
  return seedIpBlocks.map((block) => ({ ...block }));
}
function cloneActivity() {
  return seedActivity.map((event) => ({ ...event }));
}

function randomKey() {
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}

function slugCode(name: string, existing: string[]) {
  const base =
    name
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, " ")
      .trim()
      .split(" ")[0]
      ?.slice(0, 3) || "nod";
  let index = 1;
  while (existing.includes(`${base}-${index}`)) index += 1;
  return `${base}-${index}`;
}

function nextIp(region: Region, peers: Peer[]) {
  const prefix = region.subnet.split(".").slice(0, 3).join(".") + ".";
  const used = new Set(
    peers
      .filter((peer) => peer.regionId === region.id)
      .map((peer) => Number(peer.ip.split(".").pop())),
  );
  let host = 2;
  while (used.has(host) && host < 250) host += 1;
  return `${prefix}${host}`;
}

export function DemoProvider({ children }: { children: ReactNode }) {
  const [view, setView] = useState<DemoView>("dashboard");
  const [peers, setPeers] = useState<Peer[]>(clonePeers);
  const [regions, setRegions] = useState<Region[]>(cloneRegions);
  const [activity, setActivity] = useState<Activity[]>(cloneActivity);
  const [ruleGroups, setRuleGroups] = useState<RuleGroup[]>(cloneRules);
  const [ipBlocks, setIpBlocks] = useState<IpBlock[]>(cloneBlocks);
  const [dnsEnabled, setDnsEnabledState] = useState(true);
  const [dnsScope, setDnsScopeState] = useState("All peers");
  const [dialog, setDialog] = useState<DialogState>(null);
  const [toasts, setToasts] = useState<Toast[]>([]);

  const toastId = useRef(0);
  const eventId = useRef(0);
  const timers = useRef<number[]>([]);

  useEffect(() => {
    const current = timers.current;
    return () => {
      current.forEach((timer) => window.clearTimeout(timer));
    };
  }, []);

  const dismissToast = useCallback((id: number) => {
    setToasts((prev) => prev.filter((toast) => toast.id !== id));
  }, []);

  const pushToast = useCallback(
    (message: string, tone: ToastTone = "success") => {
      const id = toastId.current;
      toastId.current += 1;
      setToasts((prev) => [...prev.slice(-2), { id, message, tone }]);
      const timer = window.setTimeout(() => {
        setToasts((prev) => prev.filter((toast) => toast.id !== id));
      }, 3800);
      timers.current.push(timer);
    },
    [],
  );

  const logActivity = useCallback(
    (kind: ActivityKind, action: string, detail: string) => {
      const id = `evt-${eventId.current}`;
      eventId.current += 1;
      setActivity((prev) =>
        [
          {
            id,
            kind,
            action,
            detail,
            at: "just now",
            actor: kind === "node" ? "System" : "Demo operator",
          },
          ...prev,
        ].slice(0, 40),
      );
    },
    [],
  );

  const closeDialog = useCallback(() => setDialog(null), []);
  const openIssue = useCallback((regionId?: string) => setDialog({ type: "issue", regionId }), []);
  const openConfig = useCallback((peerId: string) => setDialog({ type: "config", peerId }), []);
  const openRevoke = useCallback((peerId: string) => setDialog({ type: "revoke", peerId }), []);
  const openAddNode = useCallback(() => setDialog({ type: "add-node" }), []);

  const issuePeer = useCallback(
    (input: NewPeerInput) => {
      const region = regions.find((item) => item.id === input.regionId) ?? regions[0];
      if (!region) return;
      const peer: Peer = {
        id: `peer-${Date.now()}`,
        name: input.name.trim(),
        device: input.device.trim() || "Unnamed device",
        kind: input.kind,
        department: input.department,
        regionId: region.id,
        ip: nextIp(region, peers),
        status: "active",
        lastHandshake: "never",
        createdAt: "just now",
        publicKey: randomKey(),
      };
      setPeers((prev) => [peer, ...prev]);
      logActivity(
        "peer",
        "Issued a peer",
        `${peer.name} / ${peer.device} / ${region.code}`,
      );
      pushToast(`Peer issued for ${peer.name}`);
      setDialog({ type: "config", peerId: peer.id });
    },
    [logActivity, peers, pushToast, regions],
  );

  const togglePeer = useCallback(
    (id: string) => {
      const peer = peers.find((item) => item.id === id);
      if (!peer) return;
      const nextStatus = peer.status === "active" ? "suspended" : "active";
      setPeers((prev) =>
        prev.map((item) =>
          item.id === id ? { ...item, status: nextStatus } : item,
        ),
      );
      logActivity(
        "peer",
        nextStatus === "active" ? "Resumed a peer" : "Suspended a peer",
        `${peer.name} / ${peer.device}`,
      );
      pushToast(
        nextStatus === "active"
          ? `${peer.name} is active again`
          : `${peer.name} is suspended`,
        nextStatus === "active" ? "success" : "info",
      );
    },
    [logActivity, peers, pushToast],
  );

  const revokePeer = useCallback(
    (id: string) => {
      const peer = peers.find((item) => item.id === id);
      if (!peer) return;
      setPeers((prev) => prev.filter((item) => item.id !== id));
      setDialog(null);
      logActivity("peer", "Revoked a peer", `${peer.name} / ${peer.device}`);
      pushToast(`${peer.name}'s config was revoked`, "danger");
    },
    [logActivity, peers, pushToast],
  );

  const addRegion = useCallback(
    (input: NewRegionInput) => {
      const code = slugCode(
        input.name,
        regions.map((region) => region.code),
      );
      const zone = input.location.split(",")[0]?.trim() || "NEW";
      const ipBase = 60 + regions.length * 7;
      const subnetPrefix = input.subnet.replace(/\/24$/, "").replace(/\.0$/, "");
      const region: Region = {
        id: code,
        city: input.name.trim() || "New region",
        code,
        zone,
        status: "joining",
        lastPoll: "waiting",
        servers: 1,
        endpoint: `203.0.113.${ipBase}:51820`,
        subnet: input.subnet.trim(),
        dns: `${subnetPrefix}.1`,
        serverPublicKey: randomKey(),
      };
      setRegions((prev) => [...prev, region]);
      logActivity("node", "Requested a join token", `${region.code} / ${region.zone}`);
      pushToast(`${region.code} is joining. Waiting for its first poll.`, "info");
      setDialog(null);
      setView("nodes");
      const timer = window.setTimeout(() => {
        setRegions((prev) =>
          prev.map((item) =>
            item.id === region.id
              ? { ...item, status: "ok", lastPoll: "1s ago" }
              : item,
          ),
        );
        logActivity(
          "node",
          "Agent completed its first poll",
          `${region.code} / 15s interval`,
        );
        pushToast(`${region.code} is healthy`);
      }, 2600);
      timers.current.push(timer);
    },
    [logActivity, pushToast, regions],
  );

  const setDnsEnabled = useCallback(
    (value: boolean) => {
      setDnsEnabledState(value);
      logActivity(
        "rule",
        value ? "Enabled DNS filtering" : "Disabled DNS filtering",
        `scope: ${dnsScope}`,
      );
      pushToast(value ? "DNS filtering enabled" : "DNS filtering disabled", "info");
    },
    [dnsScope, logActivity, pushToast],
  );

  const setDnsScope = useCallback(
    (value: string) => {
      setDnsScopeState(value);
      logActivity("rule", "Changed DNS rule scope", value);
      pushToast(`DNS rules now apply to ${value.toLowerCase()}`, "info");
    },
    [logActivity, pushToast],
  );

  const toggleRule = useCallback(
    (id: string) => {
      const rule = ruleGroups.find((item) => item.id === id);
      if (!rule) return;
      setRuleGroups((prev) =>
        prev.map((item) =>
          item.id === id ? { ...item, enabled: !item.enabled } : item,
        ),
      );
      logActivity(
        "rule",
        rule.enabled ? "Disabled a domain group" : "Enabled a domain group",
        `${rule.label} / scope: ${dnsScope}`,
      );
      pushToast(
        `${rule.label} ${rule.enabled ? "disabled" : "enabled"}`,
        "info",
      );
    },
    [dnsScope, logActivity, pushToast, ruleGroups],
  );

  const addRuleGroup = useCallback(
    (label: string) => {
      const group: RuleGroup = {
        id: `group-${Date.now()}`,
        label: label.trim(),
        domains: 1,
        enabled: true,
      };
      setRuleGroups((prev) => [...prev, group]);
      logActivity(
        "rule",
        "Added a domain group",
        `${group.label} / scope: ${dnsScope}`,
      );
      pushToast(`${group.label} added`);
    },
    [dnsScope, logActivity, pushToast],
  );

  const addIpBlock = useCallback(
    (cidr: string, scope = "All peers") => {
      const block: IpBlock = {
        id: `ip-${Date.now()}`,
        cidr: cidr.trim(),
        scope,
        addedAt: "just now",
      };
      setIpBlocks((prev) => [block, ...prev]);
      logActivity("rule", "Added an IP block", `${block.cidr} / ${scope}`);
      pushToast(`${block.cidr} is blocked`);
    },
    [logActivity, pushToast],
  );

  const removeIpBlock = useCallback(
    (id: string) => {
      const block = ipBlocks.find((item) => item.id === id);
      if (!block) return;
      setIpBlocks((prev) => prev.filter((item) => item.id !== id));
      logActivity("rule", "Removed an IP block", block.cidr);
      pushToast(`${block.cidr} unblocked`, "info");
    },
    [ipBlocks, logActivity, pushToast],
  );

  const resetDemo = useCallback(() => {
    timers.current.forEach((timer) => window.clearTimeout(timer));
    timers.current.length = 0;
    setPeers(clonePeers());
    setRegions(cloneRegions());
    setActivity(cloneActivity());
    setRuleGroups(cloneRules());
    setIpBlocks(cloneBlocks());
    setDnsEnabledState(true);
    setDnsScopeState("All peers");
    setDialog(null);
    setToasts([]);
    setView("dashboard");
    pushToast("Demo reset to sample data", "info");
  }, [pushToast]);

  const value: DemoStore = {
    view,
    setView,
    peers,
    regions,
    activity,
    ruleGroups,
    ipBlocks,
    dnsEnabled,
    dnsScope,
    dialog,
    toasts,
    issuePeer,
    togglePeer,
    revokePeer,
    addRegion,
    setDnsEnabled,
    setDnsScope,
    toggleRule,
    addRuleGroup,
    addIpBlock,
    removeIpBlock,
    openIssue,
    openConfig,
    openRevoke,
    openAddNode,
    closeDialog,
    resetDemo,
    pushToast,
    dismissToast,
  };

  return <DemoContext.Provider value={value}>{children}</DemoContext.Provider>;
}

export function useDemo() {
  const value = useContext(DemoContext);
  if (!value) {
    throw new Error("useDemo must be used inside DemoProvider");
  }
  return value;
}