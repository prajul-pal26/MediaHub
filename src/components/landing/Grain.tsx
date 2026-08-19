"use client";

import { cn } from "@/lib/utils";

/**
 * Very subtle LIGHT paper-texture + soft vignette overlay.
 * Fixed, full-screen, non-interactive. Sits above every hero layer.
 * - feTurbulence noise at ~3% opacity, blended so it never darkens a light page.
 * - A whisper-faint radial vignette adds a lensed feel without dimming the sky.
 */
export function Grain({ className }: { className?: string }) {
  return (
    <div
      aria-hidden
      className={cn(
        "pointer-events-none fixed inset-0 z-50 overflow-hidden",
        className,
      )}
    >
      {/* Paper grain — turbulence noise, oversized so the drift never reveals an edge */}
      <svg
        className="mh-grain absolute -inset-[15%] h-[130%] w-[130%] opacity-[0.03] mix-blend-multiply"
        xmlns="http://www.w3.org/2000/svg"
      >
        <filter id="mh-grain-noise">
          <feTurbulence
            type="fractalNoise"
            baseFrequency="0.9"
            numOctaves="3"
            stitchTiles="stitch"
          />
          <feColorMatrix type="saturate" values="0" />
        </filter>
        <rect width="100%" height="100%" filter="url(#mh-grain-noise)" />
      </svg>

      {/* Soft light vignette — barely-there warm dimming at the extreme corners only */}
      <div className="absolute inset-0 bg-[radial-gradient(120%_120%_at_50%_36%,transparent_62%,rgba(60,50,25,0.05)_88%,rgba(50,42,20,0.09)_100%)]" />
    </div>
  );
}

export default Grain;
