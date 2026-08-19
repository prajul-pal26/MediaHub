"use client";

import { useReducedMotion } from "framer-motion";
import { cn } from "@/lib/utils";

/** A single soft cloud — a cluster of blurred white lobes that drifts slowly. */
function Cloud({
  className,
  drift,
  duration,
  delay = 0,
  reduce,
}: {
  className?: string;
  drift: number;
  duration: number;
  delay?: number;
  reduce: boolean | null;
}) {
  return (
    <div
      className={cn("absolute", className)}
      style={
        reduce
          ? undefined
          : {
              // Gentle horizontal drift, authored inline so no global keyframe is needed.
              animation: `mh-cloud-${drift > 0 ? "r" : "l"} ${duration}s ease-in-out ${delay}s infinite`,
            }
      }
    >
      <div className="relative h-[9vh] w-[26vw] min-w-[220px] max-w-[560px]">
        <div className="absolute inset-0 rounded-full bg-white/80 blur-2xl" />
        <div className="absolute left-[8%] top-[18%] h-[120%] w-[42%] rounded-full bg-white/70 blur-2xl" />
        <div className="absolute right-[6%] top-[22%] h-[110%] w-[46%] rounded-full bg-white/65 blur-2xl" />
        <div className="absolute left-[34%] -top-[24%] h-[130%] w-[40%] rounded-full bg-white/75 blur-2xl" />
      </div>
    </div>
  );
}

/**
 * Ambient DAYTIME sky layer (formerly the night starfield): a warm sun glow
 * plus a few soft, blurred clouds drifting across the sky. Non-interactive.
 * Reduced-motion → sun + clouds render statically (no drift).
 *
 * Export name kept as `Starfield` for drop-in compatibility with the Hero.
 */
export function Starfield({ className }: { className?: string }) {
  const reduce = useReducedMotion();

  return (
    <div
      aria-hidden
      className={cn(
        "pointer-events-none absolute inset-0 overflow-hidden",
        className,
      )}
    >
      {/* Inline drift keyframes — scoped, additive, respects reduced motion via the guard above. */}
      <style>{`
        @keyframes mh-cloud-r { 0%,100% { transform: translateX(0); } 50% { transform: translateX(3.5vw); } }
        @keyframes mh-cloud-l { 0%,100% { transform: translateX(0); } 50% { transform: translateX(-3.5vw); } }
      `}</style>

      {/* Warm sun glow, high in the sky toward the light source */}
      <div
        className="absolute -top-[14%] right-[8%] h-[52vh] w-[52vh] rounded-full blur-[70px] bg-[radial-gradient(circle,rgba(255,246,214,0.95),rgba(253,224,138,0.5)_38%,rgba(253,224,138,0)_70%)]"
        style={reduce ? undefined : { animation: "mh-float 16s ease-in-out infinite" }}
      />
      {/* Soft secondary sky-blue lift on the opposite side for depth */}
      <div className="absolute -left-[8%] top-[4%] h-[40vh] w-[40vh] rounded-full opacity-70 blur-[90px] bg-[radial-gradient(circle,rgba(191,219,254,0.55),transparent_68%)]" />

      {/* Drifting clouds */}
      <Cloud className="left-[6%] top-[14%]" drift={1} duration={26} reduce={reduce} />
      <Cloud className="right-[10%] top-[30%]" drift={-1} duration={32} delay={-6} reduce={reduce} />
      <Cloud className="left-[30%] top-[46%]" drift={1} duration={38} delay={-12} reduce={reduce} />
    </div>
  );
}

export default Starfield;
