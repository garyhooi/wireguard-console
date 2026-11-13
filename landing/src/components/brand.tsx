import { IconShieldLock } from "@tabler/icons-react";
import { cn } from "@/lib/cn";

type BrandSize = "sm" | "md" | "lg";

const sizes: Record<BrandSize, { box: string; icon: number; ring: string }> = {
  sm: {
    box: "h-7 w-7 rounded-md",
    icon: 16,
    ring: "ring-teal-500/20",
  },
  md: {
    box: "h-8 w-8 rounded-lg",
    icon: 18,
    ring: "ring-teal-500/20",
  },
  lg: {
    box: "h-12 w-12 rounded-xl",
    icon: 24,
    ring: "ring-teal-400/30 shadow-[0_0_24px_-6px_rgba(45,212,191,0.65)]",
  },
};

/**
 * The product mark used by the console: Tabler's shield-lock inside the same
 * teal-tinted ring used by the signed-in shell and the sign-in card.
 */
export function BrandMark({
  size = "md",
  className,
}: {
  size?: BrandSize;
  className?: string;
}) {
  const spec = sizes[size];
  return (
    <span
      aria-hidden="true"
      className={cn(
        "flex shrink-0 items-center justify-center bg-teal-500/10 ring-1",
        spec.box,
        spec.ring,
        className,
      )}
    >
      <IconShieldLock
        size={spec.icon}
        stroke={1.6}
        className={size === "lg" ? "text-teal-300" : "text-teal-400"}
      />
    </span>
  );
}

export function BrandLockup({
  size = "md",
  className,
  textClassName,
}: {
  size?: BrandSize;
  className?: string;
  textClassName?: string;
}) {
  return (
    <span className={cn("flex items-center gap-2.5", className)}>
      <BrandMark size={size} />
      <span
        className={cn(
          "font-semibold tracking-tight text-white",
          size === "lg" ? "text-2xl" : "text-[15px]",
          textClassName,
        )}
      >
        WireGuard Console
      </span>
    </span>
  );
}
