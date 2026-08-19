"use client";

import Link from "next/link";

import { Reveal } from "@/components/landing/lib/motion";

export default function CTASection() {
  return (
    <section className="relative overflow-hidden bg-[#f6f7fb] py-32">
      {/* soft indigo/amber radial glow on white */}
      <div
        aria-hidden
        className="pointer-events-none absolute inset-0"
        style={{
          background:
            "radial-gradient(60% 60% at 50% 40%, oklch(0.62 0.19 264 / 0.14), transparent 68%), radial-gradient(55% 65% at 50% 100%, oklch(0.78 0.15 75 / 0.12), transparent 70%)",
        }}
      />
      <div
        aria-hidden
        className="pointer-events-none absolute inset-x-0 top-0 h-px bg-gradient-to-r from-transparent via-indigo-300 to-transparent"
      />

      <div className="relative mx-auto max-w-4xl px-4 text-center sm:px-6">
        <Reveal>
          <p className="font-mono text-[11px] uppercase tracking-[0.28em] text-indigo-600">
            The studio is open
          </p>
          <h2 className="mx-auto mt-6 max-w-3xl font-display font-semibold uppercase leading-[0.95] tracking-tight text-zinc-900 text-[clamp(2.75rem,8vw,6rem)]">
            Produce your social presence.
          </h2>
          <p className="mx-auto mt-6 max-w-xl text-base leading-relaxed text-zinc-600 sm:text-lg">
            Intelligence, automation and an AI copilot in one control room. Sign
            in and let the machine run your presence across every platform.
          </p>

          <div className="mt-10 flex flex-col items-center justify-center gap-4 sm:flex-row">
            <Link
              href="/api/studio-enter"
              className="inline-flex h-12 w-full items-center justify-center gap-2 rounded-full bg-indigo-600 px-7 text-sm font-semibold text-white shadow-sm transition-colors hover:bg-indigo-500 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-indigo-500/50 focus-visible:ring-offset-2 sm:w-auto"
            >
              Launch the studio
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" aria-hidden>
                <path
                  d="M5 12h14M13 6l6 6-6 6"
                  stroke="currentColor"
                  strokeWidth="1.8"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                />
              </svg>
            </Link>
            <Link
              href="/instagram"
              className="inline-flex h-12 w-full items-center justify-center rounded-full border border-zinc-300 bg-white px-7 text-sm font-semibold text-zinc-800 transition-colors hover:bg-zinc-50 hover:text-zinc-900 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-zinc-300 sm:w-auto"
            >
              Try the live demo
            </Link>
          </div>
        </Reveal>
      </div>
    </section>
  );
}
