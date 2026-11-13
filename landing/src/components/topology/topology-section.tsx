"use client";

import { useRef, useState } from "react";
import Link from "next/link";
import { ArrowUpRight, Check } from "@phosphor-icons/react";
import { chapters } from "@/lib/content";
import { NetworkStage, type StageMode } from "@/components/topology/network-stage";
import { CopyButton } from "@/components/copy-button";
import { cn } from "@/lib/cn";

const modes: Record<string, StageMode> = {
  join: "join",
  peers: "peers",
  "cross-region": "cross-region",
};

export function TopologySection() {
  const [activeIndex, setActiveIndex] = useState(0);
  const tabRefs = useRef<Array<HTMLButtonElement | null>>([]);
  const active = chapters[activeIndex];

  function onKeyDown(event: React.KeyboardEvent<HTMLDivElement>) {
    const last = chapters.length - 1;
    let next = activeIndex;
    if (event.key === "ArrowDown" || event.key === "ArrowRight") {
      next = activeIndex === last ? 0 : activeIndex + 1;
    } else if (event.key === "ArrowUp" || event.key === "ArrowLeft") {
      next = activeIndex === 0 ? last : activeIndex - 1;
    } else if (event.key === "Home") {
      next = 0;
    } else if (event.key === "End") {
      next = last;
    } else {
      return;
    }
    event.preventDefault();
    setActiveIndex(next);
    tabRefs.current[next]?.focus();
  }

  return (
    <section id="topology" className="relative py-20 lg:py-28">
      <div className="mx-auto w-full max-w-[1320px] px-5 sm:px-8">
        <div className="max-w-3xl">
          <h2 className="text-balance text-3xl font-semibold tracking-[-0.035em] text-text sm:text-4xl lg:text-[2.85rem] lg:leading-[1.05]">
            The mesh is a console and its agents.
          </h2>
          <p className="mt-5 max-w-[62ch] text-[15px] leading-relaxed text-muted">
            Every node dials out to the console. Every peer attaches to the exit
            you assign. Nothing in between needs a public management port.
          </p>
        </div>

        <div
          role="tablist"
          aria-label="Topology chapters"
          onKeyDown={onKeyDown}
          className="mt-10 grid max-w-[620px] grid-cols-3 gap-1 rounded-[12px] border border-line bg-panel/60 p-1"
        >
          {chapters.map((chapter, index) => {
            const selected = index === activeIndex;
            return (
              <button
                key={chapter.id}
                ref={(element) => {
                  tabRefs.current[index] = element;
                }}
                type="button"
                role="tab"
                id={`topology-tab-${chapter.id}`}
                aria-selected={selected}
                aria-controls={`topology-panel-${chapter.id}`}
                tabIndex={selected ? 0 : -1}
                onClick={() => setActiveIndex(index)}
                className={cn(
                  "flex items-center justify-between gap-1.5 rounded-[8px] px-2.5 py-2.5 text-left text-[11px] transition-colors sm:gap-2 sm:px-4 sm:text-[13px]",
                  selected
                    ? "bg-[#111a1a] text-text"
                    : "text-muted hover:bg-panel hover:text-text",
                )}
              >
                <span className="flex items-center gap-2">
                  <span
                    className={cn(
                      "h-1.5 w-1.5 shrink-0 rounded-full transition-colors",
                      selected ? "bg-accent" : "bg-line-strong",
                    )}
                    aria-hidden="true"
                  />
                  {chapter.label}
                </span>
                <ArrowUpRight
                  size={13}
                  weight="bold"
                  aria-hidden="true"
                  className={cn(
                    "hidden shrink-0 transition-opacity sm:block",
                    selected ? "text-accent opacity-100" : "opacity-0",
                  )}
                />
              </button>
            );
          })}
        </div>

        <div className="mt-8 grid gap-8 lg:grid-cols-12 lg:items-start lg:gap-10">
          <div className="order-1 min-w-0 lg:order-none lg:col-span-7">
            <NetworkStage
              mode={modes[active.id]}
              variant="full"
              className="h-[404px] sm:h-[480px] lg:h-[552px]"
            />
            <div className="mt-4 flex flex-col gap-2 text-[11.5px] leading-relaxed text-dim sm:flex-row sm:items-center sm:justify-between">
              <p>
                Control plane runs over HTTPS. Peer traffic stays between the
                device and its exit.
              </p>
              <Link
                href="/demo"
                className="inline-flex shrink-0 items-center gap-1 font-medium text-muted transition-colors hover:text-accent"
              >
                See it in the demo
                <ArrowUpRight size={12} weight="bold" aria-hidden="true" />
              </Link>
            </div>
          </div>

          <div
            role="tabpanel"
            id={`topology-panel-${active.id}`}
            aria-labelledby={`topology-tab-${active.id}`}
            key={active.id}
            className="order-2 flex min-w-0 flex-col lg:order-none lg:col-span-5"
          >
            <h3 className="text-balance text-xl font-semibold tracking-[-0.02em] text-text sm:text-2xl">
              {active.title}
            </h3>
            <p className="mt-3 max-w-[48ch] text-sm leading-relaxed text-muted">
              {active.body}
            </p>
            <ul className="mt-5 flex flex-wrap gap-x-5 gap-y-2">
              {active.points.map((point) => (
                <li
                  key={point}
                  className="flex items-center gap-1.5 text-[12px] text-muted"
                >
                  <Check size={13} weight="bold" className="text-accent" aria-hidden="true" />
                  {point}
                </li>
              ))}
            </ul>

            <div className="relative mt-7 overflow-hidden rounded-[10px] border border-line bg-[#060a0a]">
              <div className="flex items-center justify-between border-b border-line/80 px-3 py-2">
                <span className="font-mono text-[9px] uppercase tracking-[0.14em] text-dim">
                  {active.id === "join"
                    ? "On the exit host"
                    : active.id === "peers"
                      ? "Generated config"
                      : "Address plan"}
                </span>
                <CopyButton value={active.command} className="border-0 bg-transparent px-1.5 py-1 text-[10px]" />
              </div>
              <pre className="thin-scroll overflow-x-auto px-3 py-3 font-mono text-[10.5px] leading-relaxed text-[#b8c8c3]">
                <code>{active.command}</code>
              </pre>
            </div>
          </div>
        </div>
      </div>
    </section>
  );
}