"use client";

import { useEffect, useRef, useState } from "react";
import { DeviceMobile, Laptop } from "@phosphor-icons/react";
import { cn } from "@/lib/cn";
import { BrandMark } from "@/components/brand";

export type StageMode = "hero" | "join" | "peers" | "cross-region";
type StageVariant = "compact" | "full";

type Point = { x: number; y: number };
type Positioned = { x: number; y: number };

type NodeDef = {
  id: string;
  city: string;
  code: string;
  zone: string;
  peers: number;
  compact: Positioned;
  full: Positioned;
};

type PeerDef = {
  id: string;
  name: string;
  node: string;
  kind: "laptop" | "phone";
  compact: Positioned;
  full: Positioned;
  compactOnly?: boolean;
};

const NODES: NodeDef[] = [
  {
    id: "fra",
    city: "Frankfurt",
    code: "fra-1",
    zone: "EU",
    peers: 2,
    compact: { x: 20, y: 24 },
    full: { x: 20, y: 23 },
  },
  {
    id: "sgp",
    city: "Singapore",
    code: "sgp-1",
    zone: "APAC",
    peers: 2,
    compact: { x: 80, y: 30 },
    full: { x: 80, y: 22 },
  },
  {
    id: "sfo",
    city: "San Francisco",
    code: "sfo-1",
    zone: "US",
    peers: 2,
    compact: { x: 25, y: 79 },
    full: { x: 20, y: 78 },
  },
  {
    id: "syd",
    city: "Sydney",
    code: "syd-1",
    zone: "AU",
    peers: 1,
    compact: { x: 79, y: 80 },
    full: { x: 80, y: 79 },
  },
];

const PEERS: PeerDef[] = [
  {
    id: "mira",
    name: "Mira",
    node: "fra",
    kind: "laptop",
    compact: { x: 12, y: 12 },
    full: { x: 11, y: 11.5 },
  },
  {
    id: "tomasz",
    name: "Tomasz",
    node: "fra",
    kind: "phone",
    compact: { x: 12, y: 36 },
    full: { x: 11, y: 34 },
    compactOnly: true,
  },
  {
    id: "aisha",
    name: "Aisha",
    node: "sgp",
    kind: "phone",
    compact: { x: 88, y: 17 },
    full: { x: 89, y: 10.5 },
  },
  {
    id: "lucas",
    name: "Lucas",
    node: "sgp",
    kind: "laptop",
    compact: { x: 88, y: 43 },
    full: { x: 89, y: 34 },
    compactOnly: true,
  },
  {
    id: "noah",
    name: "Noah",
    node: "sfo",
    kind: "laptop",
    compact: { x: 12, y: 69 },
    full: { x: 11, y: 66 },
  },
  {
    id: "hana",
    name: "Hana",
    node: "sfo",
    kind: "phone",
    compact: { x: 12, y: 89 },
    full: { x: 11, y: 89 },
    compactOnly: true,
  },
  {
    id: "priya",
    name: "Priya",
    node: "syd",
    kind: "phone",
    compact: { x: 88, y: 90 },
    full: { x: 89, y: 91 },
    compactOnly: true,
  },
];

const ALL_NODES = ["fra", "sgp", "sfo", "syd"];

const MODE_LABEL: Record<StageMode, string> = {
  hero: "4 regions / one control plane",
  join: "node join / token in, agent out",
  peers: "peer handshakes / local exits",
  "cross-region": "cross-region / one admin surface",
};

const MODE_ARIA: Record<StageMode, string> = {
  hero: "Topology: one console connected to WireGuard exit nodes in Frankfurt, Singapore, San Francisco and Sydney, with peer devices attached to each exit.",
  join: "Topology: a new Sydney exit joins the console over an outbound HTTPS agent poll.",
  peers: "Topology: peer devices attach to the exit in their region and exchange WireGuard traffic locally.",
  "cross-region": "Topology: one console manages four exit nodes while peer traffic stays local to each region.",
};

const TAU = Math.PI * 2;

function clamp(value: number, min: number, max: number) {
  return Math.min(max, Math.max(min, value));
}

function easeOutCubic(value: number) {
  return 1 - Math.pow(1 - value, 3);
}

function quadPoint(p0: Point, cp: Point, p1: Point, t: number): Point {
  const mt = 1 - t;
  return {
    x: mt * mt * p0.x + 2 * mt * t * cp.x + t * t * p1.x,
    y: mt * mt * p0.y + 2 * mt * t * cp.y + t * t * p1.y,
  };
}

function controlPoint(a: Point, b: Point, bend: number): Point {
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const length = Math.hypot(dx, dy) || 1;
  return {
    x: (a.x + b.x) / 2 + (-dy / length) * length * bend,
    y: (a.y + b.y) / 2 + (dx / length) * length * bend,
  };
}

function nodeIcon(kind: PeerDef["kind"]) {
  const Icon = kind === "laptop" ? Laptop : DeviceMobile;
  return <Icon size={11} weight="regular" aria-hidden="true" />;
}

type NetworkStageProps = {
  mode: StageMode;
  variant?: StageVariant;
  className?: string;
  hideChrome?: boolean;
};

export function NetworkStage({
  mode,
  variant = "full",
  className,
  hideChrome = false,
}: NetworkStageProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const consoleRef = useRef<HTMLDivElement>(null);
  const nodeRefs = useRef(new Map<string, HTMLDivElement>());
  const peerRefs = useRef(new Map<string, HTMLDivElement>());
  const [joining, setJoining] = useState(mode === "join");

  const isCompact = variant === "compact";
  const nodeIds = ALL_NODES;

  const peerIds =
    mode === "join"
      ? []
      : mode === "hero"
        ? PEERS.filter((peer) => nodeIds.includes(peer.node)).map((peer) => peer.id)
        : PEERS.map((peer) => peer.id);

  const visiblePeers = PEERS.filter((peer) => {
    if (!peerIds.includes(peer.id)) return false;
    if (isCompact && peer.compactOnly) return false;
    if (isCompact && peer.node === "syd") return false;
    return true;
  });

  const visibleNodes = NODES.filter((node) => nodeIds.includes(node.id));

  useEffect(() => {
    if (mode !== "join") {
      setJoining(false);
      return;
    }
    setJoining(true);
    let inner: number | undefined;
    const first = window.setTimeout(() => setJoining(false), 2400);
    const loop = window.setInterval(() => {
      setJoining(true);
      inner = window.setTimeout(() => setJoining(false), 2400);
    }, 9000);
    return () => {
      window.clearTimeout(first);
      window.clearInterval(loop);
      if (inner) window.clearTimeout(inner);
    };
  }, [mode]);

  useEffect(() => {
    const canvas = canvasRef.current;
    const container = containerRef.current;
    if (!canvas || !container) return;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;

    const motionQuery = window.matchMedia("(prefers-reduced-motion: reduce)");
    let reduce = motionQuery.matches;
    let raf = 0;
    let running = false;
    let inView = true;
    let width = 0;
    let height = 0;

    const geo = {
      console: null as Point | null,
      nodes: new Map<string, Point>(),
      peers: new Map<string, Point>(),
    };

    const measure = () => {
      const host = container.getBoundingClientRect();
      width = host.width;
      height = host.height;
      const dpr = Math.min(window.devicePixelRatio || 1, 2);
      canvas.width = Math.max(1, Math.round(width * dpr));
      canvas.height = Math.max(1, Math.round(height * dpr));
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);

      const centerOf = (element: HTMLElement | null | undefined): Point | null => {
        if (!element) return null;
        const rect = element.getBoundingClientRect();
        if (!rect.width || !rect.height) return null;
        return {
          x: rect.left - host.left + rect.width / 2,
          y: rect.top - host.top + rect.height / 2,
        };
      };

      geo.console = centerOf(consoleRef.current);
      geo.nodes.clear();
      nodeRefs.current.forEach((element, id) => {
        const point = centerOf(element);
        if (point) geo.nodes.set(id, point);
      });
      geo.peers.clear();
      peerRefs.current.forEach((element, id) => {
        const point = centerOf(element);
        if (point) geo.peers.set(id, point);
      });
    };

    const drawGrid = () => {
      ctx.clearRect(0, 0, width, height);
      ctx.fillStyle = "rgba(255,255,255,0.055)";
      for (let x = 12; x < width; x += 22) {
        for (let y = 12; y < height; y += 22) {
          ctx.fillRect(x, y, 1, 1);
        }
      }

      if (geo.console) {
        const glow = ctx.createRadialGradient(
          geo.console.x,
          geo.console.y,
          0,
          geo.console.x,
          geo.console.y,
          Math.min(width, height) * 0.62,
        );
        glow.addColorStop(0, "rgba(45,212,191,0.055)");
        glow.addColorStop(1, "rgba(45,212,191,0)");
        ctx.fillStyle = glow;
        ctx.fillRect(0, 0, width, height);

        ctx.strokeStyle = "rgba(148,163,157,0.09)";
        ctx.lineWidth = 1;
        for (const radius of [52, 104, 156]) {
          ctx.beginPath();
          ctx.arc(geo.console.x, geo.console.y, radius, 0, TAU);
          ctx.stroke();
        }
      }
    };

    const drawPacket = (point: Point, alpha: number, radius = 2.2) => {
      ctx.beginPath();
      ctx.arc(point.x, point.y, radius, 0, TAU);
      ctx.fillStyle = `rgba(45,212,191,${alpha})`;
      ctx.fill();
    };

    const drawTrail = (a: Point, cp: Point, b: Point, t: number, alpha: number) => {
      for (let index = 1; index <= 2; index += 1) {
        const point = quadPoint(a, cp, b, clamp(t - index * 0.018, 0, 1));
        drawPacket(point, alpha * (0.32 - index * 0.1), 1.3);
      }
    };

    const drawControlLink = (
      from: Point,
      to: Point,
      bend: number,
      strength: number,
      elapsed: number,
      index: number,
      dashed = true,
    ) => {
      if (strength <= 0.01) return;
      const cp = controlPoint(from, to, bend);
      const gradient = ctx.createLinearGradient(from.x, from.y, to.x, to.y);
      gradient.addColorStop(0, `rgba(45,212,191,${0.14 + strength * 0.24})`);
      gradient.addColorStop(1, `rgba(45,212,191,${0.3 + strength * 0.45})`);
      ctx.beginPath();
      ctx.moveTo(from.x, from.y);
      ctx.quadraticCurveTo(cp.x, cp.y, to.x, to.y);
      ctx.strokeStyle = gradient;
      ctx.lineWidth = strength > 0.6 ? 1.4 : 1.1;
      ctx.setLineDash(dashed ? [2, 5] : []);
      ctx.stroke();
      ctx.setLineDash([]);

      if (reduce) return;
      const pollPhase = (elapsed * 0.16 + index * 0.23) % 1;
      const pollPoint = quadPoint(to, cp, from, pollPhase);
      drawTrail(to, cp, from, pollPhase, 0.7 * strength);
      drawPacket(pollPoint, 0.9 * strength);

      const pushPhase = (elapsed * 0.07 + 0.55 + index * 0.19) % 1;
      const pushPoint = quadPoint(from, cp, to, pushPhase);
      drawPacket(pushPoint, 0.42 * strength, 1.4);
    };

    const drawDataLink = (
      from: Point,
      to: Point,
      intensity: number,
      elapsed: number,
      index: number,
    ) => {
      const cp = controlPoint(from, to, index % 2 === 0 ? 0.06 : -0.06);
      const gradient = ctx.createLinearGradient(from.x, from.y, to.x, to.y);
      gradient.addColorStop(0, "rgba(231,239,236,0.24)");
      gradient.addColorStop(1, `rgba(45,212,191,${0.4 + intensity * 0.32})`);
      ctx.beginPath();
      ctx.moveTo(from.x, from.y);
      ctx.quadraticCurveTo(cp.x, cp.y, to.x, to.y);
      ctx.strokeStyle = gradient;
      ctx.lineWidth = 1.25;
      ctx.stroke();

      if (reduce) return;
      const phase = (elapsed * 0.24 + index * 0.21) % 1;
      const point = quadPoint(from, cp, to, phase);
      drawTrail(from, cp, to, phase, 0.62);
      drawPacket(point, 0.82, 1.7);
    };

    const drawJoin = (elapsed: number) => {
      if (!geo.console) return;
      const cycle = elapsed % 9;
      const progress = easeOutCubic(clamp(cycle / 2.6, 0, 1));
      const newNode = geo.nodes.get("syd");

      const nodes = Array.from(geo.nodes.entries()).filter(([id]) => id !== "syd");
      nodes.forEach(([, point], index) => {
        drawControlLink(
          geo.console as Point,
          point,
          index % 2 === 0 ? 0.1 : -0.1,
          0.18,
          elapsed,
          index,
        );
      });

      if (newNode) {
        const cp = controlPoint(geo.console, newNode, 0.14);
        if (progress < 1) {
          const steps = 48;
          ctx.beginPath();
          for (let step = 0; step <= steps * progress; step += 1) {
            const t = step / steps;
            const point = quadPoint(geo.console, cp, newNode, t);
            if (step === 0) ctx.moveTo(point.x, point.y);
            else ctx.lineTo(point.x, point.y);
          }
          ctx.strokeStyle = "rgba(45,212,191,0.7)";
          ctx.lineWidth = 1.3;
          ctx.setLineDash([2, 5]);
          ctx.stroke();
          ctx.setLineDash([]);
          if (!reduce) {
            const token = quadPoint(
              geo.console,
              cp,
              newNode,
              easeOutCubic(clamp((cycle - 0.2) / 1.9, 0, 1)),
            );
            drawPacket(token, 1, 2.6);
            drawPacket(token, 0.3, 5);
          }
        } else {
          const gradient = ctx.createLinearGradient(
            geo.console.x,
            geo.console.y,
            newNode.x,
            newNode.y,
          );
          gradient.addColorStop(0, "rgba(45,212,191,0.18)");
          gradient.addColorStop(1, "rgba(45,212,191,0.62)");
          ctx.beginPath();
          ctx.moveTo(geo.console.x, geo.console.y);
          ctx.quadraticCurveTo(cp.x, cp.y, newNode.x, newNode.y);
          ctx.strokeStyle = gradient;
          ctx.lineWidth = 1.25;
          ctx.setLineDash([2, 5]);
          ctx.stroke();
          ctx.setLineDash([]);
          if (!reduce) {
            const ripple = (cycle - 2.6) / 1.6;
            if (ripple > 0 && ripple < 1) {
              ctx.beginPath();
              ctx.arc(newNode.x, newNode.y, 18 + ripple * 38, 0, TAU);
              ctx.strokeStyle = `rgba(45,212,191,${(1 - ripple) * 0.32})`;
              ctx.lineWidth = 1;
              ctx.stroke();
            }
          }
        }
      }
    };

    const drawBroadcast = (elapsed: number) => {
      if (!geo.console || reduce) return;
      for (let index = 0; index < 3; index += 1) {
        const phase = ((elapsed / 3.4 + index / 3) % 1 + 1) % 1;
        const radius = 30 + phase * Math.max(width, height) * 0.72;
        ctx.beginPath();
        ctx.arc(geo.console.x, geo.console.y, radius, 0, TAU);
        ctx.strokeStyle = `rgba(45,212,191,${(1 - phase) * 0.12})`;
        ctx.lineWidth = 1;
        ctx.stroke();
      }
    };

    const draw = (now: number) => {
      if (!width || !height) return;
      const elapsed = now / 1000;
      drawGrid();
      if (!geo.console) return;

      if (mode === "join") {
        if (!reduce) drawBroadcast(elapsed * 0.35);
        drawJoin(elapsed);
        return;
      }

      const activeNodeIds = Array.from(geo.nodes.keys());
      const controlStrength = mode === "peers" ? 0.32 : 0.62;

      if (mode === "cross-region") drawBroadcast(elapsed);

      activeNodeIds.forEach((id, index) => {
        const point = geo.nodes.get(id);
        if (!point) return;
        drawControlLink(
          geo.console as Point,
          point,
          index % 2 === 0 ? 0.1 : -0.1,
          controlStrength,
          elapsed,
          index,
        );
      });

      const peerEntries = Array.from(geo.peers.entries());
      peerEntries.forEach(([peerId, peerPoint], index) => {
        const peer = PEERS.find((item) => item.id === peerId);
        if (!peer) return;
        const nodePoint = geo.nodes.get(peer.node);
        if (!nodePoint) return;
        drawDataLink(peerPoint, nodePoint, mode === "peers" ? 1 : 0.72, elapsed, index);
      });

      if (mode === "cross-region" && !reduce) {
        const sweep = (elapsed * 0.12) % 1;
        const sweepPoint = {
          x: geo.console.x + Math.cos(sweep * TAU) * 36,
          y: geo.console.y + Math.sin(sweep * TAU) * 36,
        };
        drawPacket(sweepPoint, 0.45, 1.6);
      }
    };

    const frame = (now: number) => {
      draw(now);
      raf = window.requestAnimationFrame(frame);
    };

    const start = () => {
      if (reduce || running || document.hidden || !inView) return;
      running = true;
      raf = window.requestAnimationFrame(frame);
    };

    const stop = () => {
      running = false;
      window.cancelAnimationFrame(raf);
    };

    measure();
    draw(performance.now());

    const observer = new IntersectionObserver(
      (entries) => {
        inView = entries[0]?.isIntersecting ?? true;
        if (inView) start();
        else stop();
      },
      { threshold: 0.06 },
    );
    observer.observe(container);

    const resizeObserver = new ResizeObserver(() => {
      const previousWidth = width;
      const previousHeight = height;
      measure();
      if (reduce || width !== previousWidth || height !== previousHeight) {
        draw(performance.now());
      }
    });
    resizeObserver.observe(container);

    const onVisibility = () => {
      if (document.hidden) stop();
      else start();
    };
    document.addEventListener("visibilitychange", onVisibility);

    const onMotionChange = (event: MediaQueryListEvent) => {
      reduce = event.matches;
      if (reduce) {
        stop();
        draw(performance.now());
      } else {
        start();
      }
    };
    motionQuery.addEventListener("change", onMotionChange);

    const fontReady = document.fonts?.ready;
    fontReady?.then(() => {
      measure();
      if (reduce) draw(performance.now());
    });

    start();

    return () => {
      stop();
      observer.disconnect();
      resizeObserver.disconnect();
      document.removeEventListener("visibilitychange", onVisibility);
      motionQuery.removeEventListener("change", onMotionChange);
    };
  }, [mode, variant]);

  return (
    <div
      ref={containerRef}
      className={cn(
        "relative isolate w-full min-w-0 overflow-hidden rounded-[14px] border border-line bg-panel",
        className,
      )}
      role="img"
      aria-label={MODE_ARIA[mode]}
    >
      <div className="pointer-events-none absolute inset-0 dot-field opacity-80" aria-hidden="true" />
      <div
        className="pointer-events-none absolute inset-x-0 top-0 h-24 bg-gradient-to-b from-ink/50 to-transparent"
        aria-hidden="true"
      />
      <canvas
        ref={canvasRef}
        className="pointer-events-none absolute inset-0 z-10 h-full w-full"
        aria-hidden="true"
      />

      {!hideChrome && (
        <>
          <div className="pointer-events-none absolute left-4 top-3.5 z-30 font-mono text-[9px] uppercase tracking-[0.18em] text-dim">
            Control plane
          </div>
          <div className="pointer-events-none absolute right-4 top-3.5 z-30 font-mono text-[9px] uppercase tracking-[0.14em] text-dim">
            HTTPS / 15s poll
          </div>
          <div className="pointer-events-none absolute bottom-3.5 left-4 z-30 flex items-center gap-4 font-mono text-[9px] uppercase tracking-[0.12em] text-dim">
            <span className="flex items-center gap-1.5">
              <span className="inline-block w-5 border-t border-dashed border-accent/40" />
              control
            </span>
            <span className="flex items-center gap-1.5">
              <span className="inline-block w-5 border-t border-accent/60" />
              data
            </span>
          </div>
          <div className="pointer-events-none absolute bottom-3.5 right-4 z-30 hidden font-mono text-[9px] uppercase tracking-[0.1em] text-dim sm:block">
            {MODE_LABEL[mode]}
          </div>
        </>
      )}

      <div
        ref={consoleRef}
        className="absolute z-20 -translate-x-1/2 -translate-y-1/2"
        style={{ left: "50%", top: "50%" }}
      >
        <div className="w-[168px] rounded-[12px] border border-accent/25 bg-[#091312]/95 p-2.5 shadow-[0_18px_50px_-20px_rgba(0,0,0,0.9)] sm:w-[182px] sm:p-3">
          <div className="flex items-center gap-2.5">
            <BrandMark size="sm" className="shrink-0" />
            <div className="min-w-0">
              <div className="text-[11.5px] font-semibold leading-tight text-text sm:text-[12px]">
                Console
              </div>
              <div className="truncate font-mono text-[8.5px] leading-tight text-dim sm:text-[9px]">
                console.local
              </div>
            </div>
            <span className="ml-auto rounded-full border border-accent/25 px-1.5 py-0.5 font-mono text-[8px] text-accent">
              MFA
            </span>
          </div>
          <div className="mt-2 flex items-center justify-between border-t border-line/80 pt-1.5 font-mono text-[8px] text-dim">
            <span>self-hosted</span>
            <span>{nodeIds.length} agents</span>
          </div>
        </div>
      </div>

      {visibleNodes.map((node) => {
        const isJoining = mode === "join" && node.id === "syd" && joining;
        const position = isCompact ? node.compact : node.full;
        return (
          <div
            key={node.id}
            ref={(element) => {
              if (element) nodeRefs.current.set(node.id, element);
              else nodeRefs.current.delete(node.id);
            }}
            className="absolute z-20 -translate-x-1/2 -translate-y-1/2"
            style={{ left: `${position.x}%`, top: `${position.y}%` }}
          >
            <div
              className={cn(
                "rounded-[10px] border bg-[#0a0f10]/95 px-2.5 py-1.5 shadow-[0_12px_34px_-18px_rgba(0,0,0,0.9)] backdrop-blur-sm transition-colors sm:px-3 sm:py-2",
                isJoining ? "border-amber/40" : "border-line-strong/80",
              )}
            >
              <div className="flex items-center gap-1.5">
                <span
                  className={cn(
                    "h-1.5 w-1.5 rounded-full",
                    isJoining ? "bg-amber" : "bg-accent",
                  )}
                  aria-hidden="true"
                />
                <span className="text-[10.5px] font-medium leading-none text-text sm:text-[11.5px]">
                  {node.city}
                </span>
                <span className="ml-auto pl-2 font-mono text-[8px] leading-none text-dim sm:text-[9px]">
                  {mode === "join"
                    ? isJoining
                      ? "join"
                      : "ok"
                    : `${node.peers}p`}
                </span>
              </div>
              <div className="mt-1 font-mono text-[8px] leading-none text-dim sm:text-[8.5px]">
                {node.code} / {node.zone}
              </div>
            </div>
          </div>
        );
      })}

      {visiblePeers.map((peer) => {
        const position = isCompact ? peer.compact : peer.full;
        return (
          <div
            key={peer.id}
            ref={(element) => {
              if (element) peerRefs.current.set(peer.id, element);
              else peerRefs.current.delete(peer.id);
            }}
            className="absolute z-20 -translate-x-1/2 -translate-y-1/2"
            style={{ left: `${position.x}%`, top: `${position.y}%` }}
          >
            <div className="flex items-center gap-1.5 rounded-full border border-line-strong/70 bg-[#090d0e]/95 px-2 py-1 text-dim">
              {nodeIcon(peer.kind)}
              <span className="text-[9px] font-medium leading-none text-muted sm:text-[10px]">
                {peer.name}
              </span>
            </div>
          </div>
        );
      })}
    </div>
  );
}