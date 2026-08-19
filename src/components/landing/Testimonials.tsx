"use client";

import { motion, useReducedMotion } from "framer-motion";

import {
  Reveal,
  RevealGroup,
  RevealItem,
} from "@/components/landing/lib/motion";
import { TESTIMONIALS, SURFACE } from "@/components/landing/lib/constants";
import { cn } from "@/lib/utils";

const BRANDS = [
  "LUMEN",
  "NORTHWIND",
  "HALCYON",
  "AXIOM",
  "MERIDIAN",
  "VANTA",
];

function Marquee() {
  const reduce = useReducedMotion();
  // Duplicate the list so the -50% translate loops seamlessly.
  const row = [...BRANDS, ...BRANDS];
  return (
    <div className="relative overflow-hidden py-2 [mask-image:linear-gradient(to_right,transparent,black_12%,black_88%,transparent)]">
      <motion.div
        className="flex w-max items-center gap-16 pr-16"
        animate={reduce ? undefined : { x: ["0%", "-50%"] }}
        transition={
          reduce
            ? undefined
            : { duration: 26, ease: "linear", repeat: Infinity }
        }
      >
        {row.map((brand, i) => (
          <span
            key={`${brand}-${i}`}
            className="font-display text-2xl uppercase tracking-[0.15em] text-zinc-400 sm:text-3xl"
          >
            {brand}
          </span>
        ))}
      </motion.div>
    </div>
  );
}

export default function Testimonials() {
  return (
    <section id="agency" className="relative bg-white py-28">
      <div className="mx-auto max-w-7xl px-4 sm:px-6">
        {/* trusted-by marquee */}
        <Reveal className="mx-auto max-w-4xl">
          <p className="mb-6 text-center font-mono text-[11px] uppercase tracking-[0.25em] text-zinc-500">
            Trusted by studios that ship
          </p>
          <Marquee />
        </Reveal>

        {/* agency positioning */}
        <Reveal className="mx-auto mt-24 max-w-2xl text-center">
          <p className="font-mono text-[11px] uppercase tracking-[0.25em] text-indigo-600">
            The agency layer
          </p>
          <h2 className="mt-4 font-display text-4xl font-semibold uppercase tracking-tight text-zinc-900 sm:text-5xl md:text-6xl">
            An agency, engineered.
          </h2>
          <p className="mt-5 text-base leading-relaxed text-zinc-600 sm:text-lg">
            The strategy of a boutique studio, the throughput of a machine. One
            control room produces, publishes and measures your presence across
            every platform.
          </p>
        </Reveal>

        {/* quote cards */}
        <RevealGroup className="mt-16 grid gap-6 md:grid-cols-3">
          {TESTIMONIALS.map((t) => (
            <RevealItem key={t.name}>
              <figure
                className={cn(
                  SURFACE.card,
                  SURFACE.cardHover,
                  "flex h-full flex-col p-7",
                )}
              >
                <svg
                  width="30"
                  height="24"
                  viewBox="0 0 30 24"
                  fill="none"
                  aria-hidden
                  className="text-indigo-300"
                >
                  <path
                    d="M0 24V13.2C0 5.9 4.2 1.5 12 0l1.5 3.6C9 5.1 6.9 7.5 6.9 11.1H12V24H0Zm18 0V13.2C18 5.9 22.2 1.5 30 0l1.5 3.6C27 5.1 24.9 7.5 24.9 11.1H30V24H18Z"
                    fill="currentColor"
                  />
                </svg>
                <blockquote className="mt-5 flex-1 text-lg leading-relaxed text-zinc-800">
                  {t.quote}
                </blockquote>
                <figcaption className="mt-6 border-t border-zinc-200 pt-5">
                  <div className="font-display text-base uppercase tracking-wide text-zinc-900">
                    {t.name}
                  </div>
                  <div className="mt-0.5 text-sm text-zinc-500">{t.role}</div>
                </figcaption>
              </figure>
            </RevealItem>
          ))}
        </RevealGroup>
      </div>
    </section>
  );
}
