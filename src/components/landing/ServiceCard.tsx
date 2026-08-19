"use client";

import Link from "next/link";
import { Check } from "lucide-react";

import type { Service } from "@/components/landing/lib/constants";
import { SURFACE } from "@/components/landing/lib/constants";
import { cn } from "@/lib/utils";

function Arrow() {
  return (
    <svg
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={2}
      strokeLinecap="round"
      strokeLinejoin="round"
      className="h-4 w-4 transition-transform duration-300 group-hover/cta:translate-x-0.5"
      aria-hidden
    >
      <path d="M5 12h14M13 6l6 6-6 6" />
    </svg>
  );
}

export function ServiceCard({
  service,
}: {
  service: Service;
  /** Kept for API compatibility — every card now renders identically. */
  featured?: boolean;
}) {
  return (
    <div
      className={cn(
        SURFACE.card,
        SURFACE.cardHover,
        "group flex h-full flex-col p-6 sm:p-7",
        "transition-all duration-300 hover:-translate-y-1",
      )}
    >
      {/* name with a small indigo dot */}
      <div className="flex items-center gap-2.5">
        <span
          aria-hidden
          className="h-2.5 w-2.5 shrink-0 rounded-full bg-indigo-600"
        />
        <h3 className="text-2xl font-bold leading-tight tracking-tight text-zinc-900">
          {service.name}
        </h3>
      </div>

      {/* one short description line */}
      <p className="mt-3 line-clamp-2 text-sm leading-relaxed text-zinc-600">
        {service.description}
      </p>

      {/* what you can do — neat buckets */}
      <p className="mt-6 text-xs font-semibold uppercase tracking-wide text-zinc-500">
        What you can do
      </p>
      <div className="mt-3 grid grid-cols-2 gap-2">
        {service.capabilities.map((capability) => (
          <span
            key={capability}
            className="flex items-center gap-1.5 rounded-lg border border-zinc-200 bg-zinc-50 px-2.5 py-1.5 text-xs text-zinc-700"
          >
            <Check className="h-3.5 w-3.5 shrink-0 text-indigo-600" />
            <span className="truncate">{capability}</span>
          </span>
        ))}
      </div>

      {/* CTA pinned to the bottom — keeps all three cards aligned */}
      <div className="mt-auto pt-8">
        <Link
          href={service.href}
          className="group/cta inline-flex w-full items-center justify-center gap-2 rounded-full bg-indigo-600 px-5 py-2.5 text-sm font-semibold text-white shadow-sm transition-colors duration-300 hover:bg-indigo-500 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-indigo-500/40 focus-visible:ring-offset-2 focus-visible:ring-offset-white active:scale-[0.98]"
        >
          {service.cta}
          <Arrow />
        </Link>
      </div>
    </div>
  );
}

export default ServiceCard;
