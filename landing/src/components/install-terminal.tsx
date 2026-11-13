"use client";

import { useRef, useState } from "react";
import { CopyButton } from "@/components/copy-button";
import { cn } from "@/lib/cn";
import { siteConfig } from "@/lib/site";

const nodeCommand =
  "curl -fsSL https://raw.githubusercontent.com/garyhooi/wireguard-console/main/node-install.sh | sudo bash -s -- <TOKEN> https://console.example.com <NODE_ID>";

const tabs = [
  {
    id: "console",
    label: "Install console",
    command: siteConfig.installCommand,
    hint: "Installs Docker, starts the stack and prints the first admin password.",
  },
  {
    id: "node",
    label: "Join a node",
    command: nodeCommand,
    hint: "Run on the exit host. The agent dials out and polls every 15 seconds.",
  },
] as const;

export function InstallTerminal() {
  const [active, setActive] = useState<(typeof tabs)[number]["id"]>("console");
  const tabRefs = useRef<Array<HTMLButtonElement | null>>([]);
  const current = tabs.find((tab) => tab.id === active) ?? tabs[0];
  const activeIndex = tabs.findIndex((tab) => tab.id === active);

  function onKeyDown(event: React.KeyboardEvent<HTMLDivElement>) {
    const last = tabs.length - 1;
    let next = activeIndex;
    if (event.key === "ArrowRight") next = activeIndex === last ? 0 : activeIndex + 1;
    else if (event.key === "ArrowLeft") next = activeIndex === 0 ? last : activeIndex - 1;
    else if (event.key === "Home") next = 0;
    else if (event.key === "End") next = last;
    else return;
    event.preventDefault();
    setActive(tabs[next].id);
    tabRefs.current[next]?.focus();
  }

  return (
    <div className="min-w-0 overflow-hidden rounded-[14px] border border-line bg-[#060a0a]">
      <div className="flex items-center gap-2 border-b border-line px-2.5 py-2">
        <div
          role="tablist"
          aria-label="Install commands"
          onKeyDown={onKeyDown}
          className="flex items-center gap-1"
        >
          {tabs.map((tab, index) => (
          <button
            key={tab.id}
            ref={(element) => {
              tabRefs.current[index] = element;
            }}
            type="button"
            role="tab"
            id={`install-tab-${tab.id}`}
            aria-selected={active === tab.id}
            aria-controls={`install-panel-${tab.id}`}
            tabIndex={active === tab.id ? 0 : -1}
            onClick={() => setActive(tab.id)}
            className={cn(
              "rounded-full px-3 py-1.5 text-[11.5px] font-medium transition-colors",
              active === tab.id
                ? "bg-panel-2 text-text"
                : "text-dim hover:text-muted",
            )}
            >
              {tab.label}
            </button>
          ))}
        </div>
        <div className="ml-auto">
          <CopyButton value={current.command} className="border-0 bg-transparent" />
        </div>
      </div>

      <div
        role="tabpanel"
        id={`install-panel-${current.id}`}
        aria-labelledby={`install-tab-${current.id}`}
        className="px-4 py-5 sm:px-5"
      >
        <div className="flex min-w-0 items-start gap-3">
          <span className="mt-0.5 select-none font-mono text-[12px] text-accent" aria-hidden="true">
            $
          </span>
          <code className="min-w-0 whitespace-pre-wrap break-words font-mono text-[11.5px] leading-relaxed text-[#c6d5d0]">
            {current.command}
          </code>
        </div>
        <div className="mt-5 flex items-start gap-3 border-t border-line/70 pt-4">
          <span className="mt-1 h-1.5 w-1.5 shrink-0 rounded-full bg-dim" aria-hidden="true" />
          <p className="font-mono text-[10px] leading-relaxed text-dim">
            {current.hint}
          </p>
        </div>
      </div>
    </div>
  );
}