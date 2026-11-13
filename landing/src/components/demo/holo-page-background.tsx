"use client";

import { HoloBackground } from "@/components/demo/holo-background";

export function HoloPageBackground() {
  return (
    <>
      <HoloBackground />
      <div
        aria-hidden="true"
        className="pointer-events-none absolute inset-0 bg-[radial-gradient(ellipse_at_center,rgba(4,6,12,0.15)_0%,rgba(4,6,12,0.72)_62%,rgba(4,6,12,0.94)_100%)]"
      />
      <div
        aria-hidden="true"
        className="pointer-events-none absolute inset-0 opacity-[0.05] [background-image:repeating-linear-gradient(0deg,rgba(226,232,240,0.9)_0px,rgba(226,232,240,0.9)_1px,transparent_1px,transparent_3px)]"
      />
    </>
  );
}
