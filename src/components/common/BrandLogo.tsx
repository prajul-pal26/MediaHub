"use client";

import Link from "next/link";
import { cn } from "@/lib/utils";

/**
 * MEDIA HUB brand lockup — a gradient logo mark + wordmark.
 * Matches the landing hero brand. Use anywhere a clickable home brand is needed.
 */
export function BrandLogo({
  href = "/",
  className,
  hideWordmarkOnMobile = false,
}: {
  href?: string;
  className?: string;
  /** Hide the "MEDIA HUB" wordmark on small screens (mark stays visible). */
  hideWordmarkOnMobile?: boolean;
}) {
  return (
    <Link
      href={href}
      className={cn("group inline-flex items-center gap-2.5", className)}
      aria-label="MEDIA HUB — home"
    >
      {/* Logo mark */}
      <span
        aria-hidden
        className="flex h-9 w-9 shrink-0 items-center justify-center rounded-xl bg-gradient-to-br from-indigo-600 to-fuchsia-500 font-display text-lg font-bold leading-none text-white shadow-sm ring-1 ring-inset ring-white/20 transition-transform group-hover:scale-105"
      >
        M
      </span>

      {/* Wordmark */}
      <span
        className={cn(
          "font-display text-xl uppercase tracking-tight text-zinc-900 transition-colors group-hover:text-indigo-600",
          hideWordmarkOnMobile ? "hidden sm:inline" : "inline",
        )}
      >
        Media&nbsp;Hub
      </span>
    </Link>
  );
}

export default BrandLogo;
