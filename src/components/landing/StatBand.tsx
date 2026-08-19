"use client";

import { useEffect, useRef, useState } from "react";
import { useInView, useReducedMotion } from "framer-motion";

import { EASE } from "@/components/landing/lib/motion";
import { STATS } from "@/components/landing/lib/constants";
import { cn } from "@/lib/utils";

type Stat = (typeof STATS)[number];

/** Format the animated `current` value into { num, unit } based on the stat shape. */
function formatStat(current: number, stat: Stat) {
  const decimals = "decimals" in stat && typeof stat.decimals === "number" ? stat.decimals : undefined;
  // Only the impressions figure (>= 1e9) gets abbreviated to a "B" unit.
  if (stat.value >= 1e9) {
    return { num: (current / 1e9).toFixed(decimals ?? 1), unit: "B" };
  }
  return { num: current.toFixed(decimals ?? 0), unit: "" };
}

function easeOutExpo(t: number) {
  return t === 1 ? 1 : 1 - Math.pow(2, -10 * t);
}

function StatItem({ stat, active, delay }: { stat: Stat; active: boolean; delay: number }) {
  const reduce = useReducedMotion();
  const [current, setCurrent] = useState(reduce ? stat.value : 0);
  const raf = useRef<number | null>(null);

  useEffect(() => {
    if (!active || reduce) {
      setCurrent(stat.value);
      return;
    }
    const duration = 1600;
    const start = performance.now() + delay;

    const tick = (now: number) => {
      if (now < start) {
        raf.current = requestAnimationFrame(tick);
        return;
      }
      const p = Math.min((now - start) / duration, 1);
      setCurrent(easeOutExpo(p) * stat.value);
      if (p < 1) raf.current = requestAnimationFrame(tick);
    };
    raf.current = requestAnimationFrame(tick);
    return () => {
      if (raf.current) cancelAnimationFrame(raf.current);
    };
  }, [active, reduce, stat.value, delay]);

  const { num, unit } = formatStat(current, stat);

  return (
    <div className="flex flex-col items-center px-6 py-8 text-center sm:px-8 md:py-10">
      <div
        className="font-display text-4xl leading-none tracking-tight text-zinc-900 tabular-nums sm:text-5xl md:text-6xl"
        style={{ transition: `opacity 0.6s ${EASE.join(",")}` }}
      >
        {num}
        <span className="text-indigo-600">
          {unit}
          {stat.suffix}
        </span>
      </div>
      <div className="mt-3 font-mono text-[10px] uppercase tracking-[0.25em] text-zinc-500 sm:text-[11px]">
        {stat.label}
      </div>
    </div>
  );
}

export function StatBand() {
  const ref = useRef<HTMLDivElement | null>(null);
  const inView = useInView(ref, { once: true, margin: "-80px" });

  return (
    <div
      ref={ref}
      className="relative w-full border-y border-zinc-200 bg-white"
    >
      {/* faint indigo wash so the band reads as part of the studio system */}
      <div
        aria-hidden
        className="pointer-events-none absolute inset-0"
        style={{
          background:
            "radial-gradient(1200px circle at 50% -40%, rgba(79,70,229,0.07), transparent 70%)",
        }}
      />
      <div className="relative mx-auto grid max-w-7xl grid-cols-2 divide-zinc-200 px-4 lg:grid-cols-4 lg:divide-x">
        {STATS.map((stat, i) => (
          <div
            key={stat.label}
            className={cn(
              "flex items-center justify-center",
              // dividers between rows/cols on the 2-col mobile grid
              i < STATS.length - 2 && "border-b border-zinc-200 lg:border-b-0",
              i % 2 === 0 && "border-r border-zinc-200 lg:border-r-0",
            )}
          >
            <StatItem stat={stat} active={inView} delay={i * 120} />
          </div>
        ))}
      </div>
    </div>
  );
}

export default StatBand;
