"use client";

import { useState } from "react";
import Link from "next/link";
import { motion, AnimatePresence } from "framer-motion";

import { NAV_LINKS } from "@/components/landing/lib/constants";
import { EASE } from "@/components/landing/lib/motion";
import { cn } from "@/lib/utils";

const PRIMARY_BTN =
  "inline-flex h-10 items-center justify-center gap-2 rounded-full bg-indigo-600 px-4 text-sm font-semibold text-white shadow-sm transition-colors hover:bg-indigo-500 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-indigo-500/50 focus-visible:ring-offset-2";

function Wordmark() {
  return (
    <Link href="/" className="group inline-flex items-center gap-2.5">
      <span className="relative flex h-2.5 w-2.5 items-center justify-center">
        <span className="absolute inline-flex h-2.5 w-2.5 rounded-full bg-indigo-400/40 blur-[3px]" />
        <span className="relative inline-flex h-2 w-2 rounded-full bg-indigo-600 shadow-[0_0_10px_1px_rgba(79,70,229,0.5)]" />
      </span>
      <span className="font-display text-lg font-semibold uppercase tracking-[0.18em] text-zinc-900 transition-colors group-hover:text-indigo-600">
        Media Hub
      </span>
    </Link>
  );
}

export function LandingHeader({ authed = false }: { authed?: boolean }) {
  const [open, setOpen] = useState(false);

  return (
    <motion.header
      initial={{ opacity: 0, y: -16 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.7, ease: EASE }}
      className="sticky top-0 z-50 w-full border-b border-zinc-200 bg-white/80 backdrop-blur-md"
    >
      <nav className="mx-auto flex h-16 max-w-7xl items-center justify-between px-4 sm:px-6">
        <Wordmark />

        {/* Center nav — desktop */}
        <div className="absolute left-1/2 hidden -translate-x-1/2 items-center gap-8 md:flex">
          {NAV_LINKS.map((link) => (
            <a
              key={link.href}
              href={link.href}
              className="font-mono text-[12px] uppercase tracking-[0.18em] text-zinc-600 transition-colors hover:text-zinc-900"
            >
              {link.label}
            </a>
          ))}
        </div>

        {/* Right actions — desktop */}
        <div className="hidden items-center gap-4 md:flex">
          {authed ? (
            <Link href="/api/studio-enter" className={PRIMARY_BTN}>
              Open studio
            </Link>
          ) : (
            <>
              <Link
                href="/login"
                className="text-sm font-medium text-zinc-600 transition-colors hover:text-zinc-900"
              >
                Sign in
              </Link>
              <Link href="/api/studio-enter" className={PRIMARY_BTN}>
                Launch studio
              </Link>
            </>
          )}
        </div>

        {/* Mobile hamburger */}
        <button
          type="button"
          aria-label="Toggle menu"
          aria-expanded={open}
          onClick={() => setOpen((v) => !v)}
          className="inline-flex h-10 w-10 items-center justify-center rounded-lg border border-zinc-300 text-zinc-700 transition-colors hover:border-zinc-400 hover:bg-zinc-50 hover:text-zinc-900 md:hidden"
        >
          <svg width="18" height="18" viewBox="0 0 24 24" fill="none" aria-hidden>
            {open ? (
              <path
                d="M6 6l12 12M18 6L6 18"
                stroke="currentColor"
                strokeWidth="1.8"
                strokeLinecap="round"
              />
            ) : (
              <path
                d="M3 6h18M3 12h18M3 18h18"
                stroke="currentColor"
                strokeWidth="1.8"
                strokeLinecap="round"
              />
            )}
          </svg>
        </button>
      </nav>

      {/* Mobile dropdown panel */}
      <AnimatePresence>
        {open && (
          <motion.div
            initial={{ opacity: 0, height: 0 }}
            animate={{ opacity: 1, height: "auto" }}
            exit={{ opacity: 0, height: 0 }}
            transition={{ duration: 0.35, ease: EASE }}
            className="overflow-hidden border-t border-zinc-200 bg-white/95 backdrop-blur-md md:hidden"
          >
            <div className="flex flex-col gap-1 px-4 py-4">
              {NAV_LINKS.map((link) => (
                <a
                  key={link.href}
                  href={link.href}
                  onClick={() => setOpen(false)}
                  className="rounded-lg px-3 py-3 font-mono text-[12px] uppercase tracking-[0.18em] text-zinc-600 transition-colors hover:bg-zinc-50 hover:text-zinc-900"
                >
                  {link.label}
                </a>
              ))}
              <div className="mt-2 flex flex-col gap-2 border-t border-zinc-200 pt-4">
                {authed ? (
                  <Link
                    href="/api/studio-enter"
                    onClick={() => setOpen(false)}
                    className={cn(PRIMARY_BTN, "w-full")}
                  >
                    Open studio
                  </Link>
                ) : (
                  <>
                    <Link
                      href="/login"
                      onClick={() => setOpen(false)}
                      className="rounded-lg px-3 py-2.5 text-center text-sm font-medium text-zinc-600 transition-colors hover:text-zinc-900"
                    >
                      Sign in
                    </Link>
                    <Link
                      href="/api/studio-enter"
                      onClick={() => setOpen(false)}
                      className={cn(PRIMARY_BTN, "w-full")}
                    >
                      Launch studio
                    </Link>
                  </>
                )}
              </div>
            </div>
          </motion.div>
        )}
      </AnimatePresence>
    </motion.header>
  );
}

export default LandingHeader;
