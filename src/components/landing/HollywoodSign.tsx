"use client";

import { motion, useReducedMotion } from "framer-motion";
import { EASE } from "@/components/landing/lib/motion";
import { cn } from "@/lib/utils";

/* ── Carved extrusion for WHITE standing letters on a BRIGHT sky ──
   A warm-grey → deep-olive ramp steps down-right for a real 3-D edge, then a
   strong DARK cast shadow so the white face reads crisply against daylight.  */
const DEPTH = [
  "#e7e2d6",
  "#c8c2b2",
  "#a49e8b",
  "#807a68",
  "#615c4c",
  "#484436",
  "#353226",
  "#26241b",
  "#1a1813",
  "#100f0b",
];
const extrude = DEPTH.map((c, i) => `${i + 1}px ${i + 1}px 0 ${c}`).join(", ");
const carvedTextShadow = `${extrude}, 0 3px 2px rgba(24,20,10,0.45), 0 22px 44px rgba(43,37,18,0.5), 0 8px 16px rgba(43,37,18,0.4), 0 0 3px rgba(30,27,20,0.55)`;

const faceStyle = {
  backgroundImage: "linear-gradient(180deg,#ffffff 0%,#fbf8f1 46%,#efeadd 100%)",
  WebkitBackgroundClip: "text",
  backgroundClip: "text",
  color: "transparent",
  WebkitTextFillColor: "transparent",
  WebkitTextStroke: "0.75px rgba(38,34,22,0.35)",
  textShadow: carvedTextShadow,
} as const;

/**
 * The MEDIA HUB centerpiece — a monumental carved WHITE sign that rises into the
 * daytime sky. Clean single line; no marquee bulbs.
 */
export function HollywoodSign({
  ignite = true,
  className,
}: {
  ignite?: boolean;
  className?: string;
}) {
  const reduce = useReducedMotion();

  return (
    <div
      className={cn("relative flex select-none flex-col items-center", className)}
      aria-hidden
    >
      {/* Soft cool-white halo — lifts the white face off the hills (no warm/yellow tint) */}
      <div className="pointer-events-none absolute inset-0 -z-10 flex items-center justify-center">
        <div className="h-[64%] w-[88%] rounded-full bg-[radial-gradient(ellipse_at_center,rgba(255,255,255,0.55),rgba(226,232,240,0.26)_46%,transparent_72%)] blur-3xl" />
      </div>

      <motion.div
        initial={reduce ? { opacity: 0 } : { opacity: 0, y: 22, scale: 0.97 }}
        animate={
          ignite
            ? { opacity: 1, y: 0, scale: 1 }
            : reduce
              ? { opacity: 0 }
              : { opacity: 0, y: 22, scale: 0.97 }
        }
        transition={{ duration: 0.9, ease: EASE }}
        className="flex flex-col items-center"
      >
        <span
          className="font-display block select-none whitespace-nowrap font-black uppercase leading-[0.9] tracking-[0.01em] text-[clamp(2.75rem,13.5vw,11rem)]"
          style={faceStyle}
        >
          MEDIA&nbsp;HUB
        </span>
      </motion.div>
    </div>
  );
}

export default HollywoodSign;
