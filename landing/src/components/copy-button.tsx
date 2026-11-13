"use client";

import { useEffect, useRef, useState } from "react";
import { Check, Copy } from "@phosphor-icons/react";
import { cn } from "@/lib/cn";

type CopyButtonProps = {
  value: string;
  label?: string;
  copiedLabel?: string;
  className?: string;
  iconOnly?: boolean;
};

export function CopyButton({
  value,
  label = "Copy",
  copiedLabel = "Copied",
  className,
  iconOnly = false,
}: CopyButtonProps) {
  const [copied, setCopied] = useState(false);
  const timer = useRef<number | null>(null);

  useEffect(() => {
    return () => {
      if (timer.current) window.clearTimeout(timer.current);
    };
  }, []);

  async function copy() {
    try {
      await navigator.clipboard.writeText(value);
    } catch {
      const area = document.createElement("textarea");
      area.value = value;
      area.setAttribute("readonly", "");
      area.style.position = "fixed";
      area.style.opacity = "0";
      document.body.appendChild(area);
      area.select();
      document.execCommand("copy");
      document.body.removeChild(area);
    }
    setCopied(true);
    if (timer.current) window.clearTimeout(timer.current);
    timer.current = window.setTimeout(() => setCopied(false), 1800);
  }

  return (
    <button
      type="button"
      onClick={copy}
      className={cn(
        "inline-flex items-center gap-1.5 rounded-[7px] border border-line-strong/80 bg-panel px-2.5 py-1.5 text-[11.5px] font-medium text-muted transition-colors hover:border-line-strong hover:text-text active:scale-[0.98]",
        className,
      )}
      aria-label={copied ? `${copiedLabel}` : `${label} to clipboard`}
    >
      {copied ? (
        <Check size={13} weight="bold" className="text-accent" aria-hidden="true" />
      ) : (
        <Copy size={13} aria-hidden="true" />
      )}
      {!iconOnly && <span>{copied ? copiedLabel : label}</span>}
      <span className="sr-only" aria-live="polite">
        {copied ? copiedLabel : ""}
      </span>
    </button>
  );
}
