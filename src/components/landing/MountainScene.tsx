"use client";

import type { CSSProperties } from "react";
import { cn } from "@/lib/utils";

/**
 * Bespoke layered mountain range — sunlit Hollywood hills in warm sage / olive
 * / tan that DEEPEN toward the viewer (so the white sign pops), each crest
 * catching a bright sunlit rim, over a soft warm haze where the hills meet the
 * sky. Stretches edge-to-edge (preserveAspectRatio=none).
 *
 * `layerShift` nudges the far ridges horizontally so a parent can imply depth;
 * the Hero also parallax-scrolls the whole element for a stronger effect.
 */
export function MountainScene({
  className,
  style,
  layerShift = 0,
}: {
  className?: string;
  style?: CSSProperties;
  layerShift?: number;
}) {
  return (
    <svg
      aria-hidden
      className={cn("block w-full", className)}
      style={style}
      viewBox="0 0 1440 560"
      preserveAspectRatio="none"
    >
      <defs>
        {/* Warm sunlit haze where the hills meet the bright sky */}
        <linearGradient id="mh-dusk" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stopColor="#fdf6ec" stopOpacity="0.9" />
          <stop offset="30%" stopColor="#fbefd8" stopOpacity="0.5" />
          <stop offset="60%" stopColor="#f6e6c4" stopOpacity="0.18" />
          <stop offset="100%" stopColor="#f6e6c4" stopOpacity="0" />
        </linearGradient>

        {/* Ridges deepen toward the viewer: hazy tan far → deep olive front */}
        <linearGradient id="mh-ridge-far" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stopColor="#d4c599" />
          <stop offset="100%" stopColor="#c0b183" />
        </linearGradient>
        <linearGradient id="mh-ridge-mid" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stopColor="#b3ac72" />
          <stop offset="100%" stopColor="#9aa063" />
        </linearGradient>
        <linearGradient id="mh-ridge-near" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stopColor="#8a9a5b" />
          <stop offset="100%" stopColor="#6f7d47" />
        </linearGradient>
        <linearGradient id="mh-ridge-front" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stopColor="#5b6838" />
          <stop offset="100%" stopColor="#454f2a" />
        </linearGradient>

        {/* Rim-light strokes: soft sun on far crests, hot sun on near crests */}
        <linearGradient id="mh-rim-cool" x1="0" y1="0" x2="1" y2="0">
          <stop offset="0%" stopColor="#fff4d6" stopOpacity="0" />
          <stop offset="50%" stopColor="#fffaf0" stopOpacity="0.6" />
          <stop offset="100%" stopColor="#fff4d6" stopOpacity="0" />
        </linearGradient>
        <linearGradient id="mh-rim-warm" x1="0" y1="0" x2="1" y2="0">
          <stop offset="0%" stopColor="#ffe6a3" stopOpacity="0" />
          <stop offset="50%" stopColor="#fff2c8" stopOpacity="0.75" />
          <stop offset="100%" stopColor="#ffe6a3" stopOpacity="0" />
        </linearGradient>
      </defs>

      {/* Warm haze wash behind the crests */}
      <rect x="0" y="0" width="1440" height="560" fill="url(#mh-dusk)" />

      {/* Ridge 1 — farthest, palest, faint cool rim */}
      <g transform={`translate(${layerShift * 1.6} 0)`}>
        <path
          d="M-40 300 L120 240 L260 288 L400 208 L560 292 L720 222 L900 300 L1080 236 L1240 296 L1480 250 L1480 560 L-40 560 Z"
          fill="url(#mh-ridge-far)"
        />
        <path
          d="M-40 300 L120 240 L260 288 L400 208 L560 292 L720 222 L900 300 L1080 236 L1240 296 L1480 250"
          fill="none"
          stroke="url(#mh-rim-cool)"
          strokeWidth="1.5"
        />
      </g>

      {/* Ridge 2 — mid */}
      <g transform={`translate(${layerShift * 1.15} 0)`}>
        <path
          d="M-40 360 L160 300 L340 372 L520 296 L700 384 L900 312 L1120 388 L1320 320 L1480 372 L1480 560 L-40 560 Z"
          fill="url(#mh-ridge-mid)"
        />
        <path
          d="M-40 360 L160 300 L340 372 L520 296 L700 384 L900 312 L1120 388 L1320 320 L1480 372"
          fill="none"
          stroke="url(#mh-rim-cool)"
          strokeWidth="1.5"
          opacity="0.7"
        />
      </g>

      {/* Ridge 3 — near, warm gold rim catching the sign glow */}
      <g transform={`translate(${layerShift * 0.6} 0)`}>
        <path
          d="M-40 428 L200 372 L420 440 L640 360 L860 452 L1080 380 L1300 448 L1480 400 L1480 560 L-40 560 Z"
          fill="url(#mh-ridge-near)"
        />
        <path
          d="M-40 428 L200 372 L420 440 L640 360 L860 452 L1080 380 L1300 448 L1480 400"
          fill="none"
          stroke="url(#mh-rim-warm)"
          strokeWidth="1.75"
        />
      </g>

      {/* Ridge 4 — foreground, darkest, anchors the base */}
      <path
        d="M-40 496 L260 452 L520 500 L780 448 L1040 502 L1300 456 L1480 496 L1480 560 L-40 560 Z"
        fill="url(#mh-ridge-front)"
      />
    </svg>
  );
}

export default MountainScene;
