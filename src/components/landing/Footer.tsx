"use client";

import Link from "next/link";
import type { ReactNode } from "react";

const COLUMNS: { title: string; links: { label: string; href: string }[] }[] = [
  {
    title: "Services",
    links: [
      { label: "Instagram", href: "/instagram" },
      { label: "Facebook", href: "/facebook" },
      { label: "Media Automation", href: "/api/studio-enter" },
    ],
  },
  {
    title: "Company",
    links: [
      { label: "About", href: "#" },
      { label: "Careers", href: "#" },
      { label: "Contact", href: "#" },
    ],
  },
  {
    title: "Legal",
    links: [
      { label: "Privacy", href: "#" },
      { label: "Terms", href: "#" },
    ],
  },
];

const SOCIALS: { label: string; href: string; icon: ReactNode }[] = [
  {
    label: "X",
    href: "#",
    icon: (
      <svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor" aria-hidden>
        <path d="M18.9 2H22l-7.3 8.3L23.3 22h-6.8l-5.3-6.9L5.1 22H2l7.8-8.9L1 2h6.9l4.8 6.3L18.9 2Zm-1.2 18h1.9L7.4 3.9H5.4L17.7 20Z" />
      </svg>
    ),
  },
  {
    label: "Instagram",
    href: "/instagram",
    icon: (
      <svg width="16" height="16" viewBox="0 0 24 24" fill="none" aria-hidden>
        <rect x="2.5" y="2.5" width="19" height="19" rx="5.5" stroke="currentColor" strokeWidth="1.6" />
        <circle cx="12" cy="12" r="4.2" stroke="currentColor" strokeWidth="1.6" />
        <circle cx="17.3" cy="6.7" r="1.2" fill="currentColor" />
      </svg>
    ),
  },
  {
    label: "LinkedIn",
    href: "#",
    icon: (
      <svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor" aria-hidden>
        <path d="M4.98 3.5A2.5 2.5 0 1 0 5 8.5a2.5 2.5 0 0 0-.02-5ZM3 9h4v12H3V9Zm6 0h3.8v1.64h.05c.53-1 1.82-2.06 3.75-2.06C20.6 8.58 22 10.2 22 13.6V21h-4v-6.6c0-1.57-.03-3.6-2.2-3.6-2.2 0-2.54 1.72-2.54 3.49V21H9V9Z" />
      </svg>
    ),
  },
  {
    label: "YouTube",
    href: "#",
    icon: (
      <svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor" aria-hidden>
        <path d="M23 12s0-3.4-.43-5.02a2.6 2.6 0 0 0-1.83-1.84C19.12 4.7 12 4.7 12 4.7s-7.12 0-8.74.44A2.6 2.6 0 0 0 1.43 6.98C1 8.6 1 12 1 12s0 3.4.43 5.02c.24.9.94 1.6 1.83 1.84 1.62.44 8.74.44 8.74.44s7.12 0 8.74-.44a2.6 2.6 0 0 0 1.83-1.84C23 15.4 23 12 23 12ZM9.75 15.27V8.73L15.5 12l-5.75 3.27Z" />
      </svg>
    ),
  },
];

export default function Footer() {
  return (
    <footer className="relative border-t border-zinc-200 bg-white py-16">
      <div className="mx-auto max-w-7xl px-4 sm:px-6">
        <div className="grid gap-12 md:grid-cols-[1.5fr_2fr]">
          {/* brand + tagline + socials */}
          <div>
            <div className="flex items-center gap-2.5">
              <span className="inline-flex h-2 w-2 rounded-full bg-indigo-600 shadow-[0_0_10px_1px_rgba(79,70,229,0.5)]" />
              <span className="font-display text-lg font-semibold uppercase tracking-[0.18em] text-zinc-900">
                Media Hub
              </span>
            </div>
            <p className="mt-4 max-w-xs text-sm leading-relaxed text-zinc-500">
              A billion-dollar media agency, engineered — intelligence and
              automation for every social platform.
            </p>
            <div className="mt-6 flex items-center gap-3">
              {SOCIALS.map((s) => (
                <Link
                  key={s.label}
                  href={s.href}
                  aria-label={s.label}
                  className="inline-flex h-9 w-9 items-center justify-center rounded-lg border border-zinc-200 text-zinc-400 transition-colors hover:border-zinc-300 hover:bg-zinc-50 hover:text-zinc-900"
                >
                  {s.icon}
                </Link>
              ))}
            </div>
          </div>

          {/* link columns */}
          <div className="grid grid-cols-2 gap-8 sm:grid-cols-3">
            {COLUMNS.map((col) => (
              <div key={col.title}>
                <h3 className="font-mono text-[11px] uppercase tracking-[0.2em] text-zinc-500">
                  {col.title}
                </h3>
                <ul className="mt-4 space-y-3">
                  {col.links.map((link) => (
                    <li key={link.label}>
                      <Link
                        href={link.href}
                        className="text-sm text-zinc-600 transition-colors hover:text-zinc-900"
                      >
                        {link.label}
                      </Link>
                    </li>
                  ))}
                </ul>
              </div>
            ))}
          </div>
        </div>

        {/* bottom bar */}
        <div className="mt-14 flex flex-col items-center justify-between gap-3 border-t border-zinc-200 pt-8 sm:flex-row">
          <p className="text-xs text-zinc-500">
            © 2026 MEDIA HUB. All rights reserved.
          </p>
          <p className="font-mono text-[11px] uppercase tracking-[0.2em] text-zinc-500">
            Crafted for the spotlight.
          </p>
        </div>
      </div>
    </footer>
  );
}
