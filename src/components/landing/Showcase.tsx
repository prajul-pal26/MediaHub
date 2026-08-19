"use client";

import { useRef } from "react";
import {
  motion,
  useReducedMotion,
  useScroll,
  useTransform,
} from "framer-motion";
import { CheckCircle2, Heart, Play } from "lucide-react";

import { Reveal } from "@/components/landing/lib/motion";

const STAT_TILES = [
  { label: "Followers", value: "2.41M" },
  { label: "Following", value: "312" },
  { label: "Posts", value: "1,847" },
];

// Real photos via picsum — one distinct seed per tile so the grid reads as a
// genuine, varied feed rather than empty placeholders.
const MEDIA = [
  { seed: "mh-post-1", likes: "184k", reel: true },
  { seed: "mh-post-2", likes: "92.7k", reel: false },
  { seed: "mh-post-3", likes: "231k", reel: true },
  { seed: "mh-post-4", likes: "58.1k", reel: false },
  { seed: "mh-post-5", likes: "147k", reel: true },
  { seed: "mh-post-6", likes: "76.4k", reel: false },
];

const FOLLOWERS = [
  { handle: "@nova.reels", id: "17841409" },
  { handle: "@studio.halcyon", id: "50293117" },
  { handle: "@drift.motion", id: "88104552" },
];

export default function Showcase() {
  const reduce = useReducedMotion();
  const wrapRef = useRef<HTMLDivElement | null>(null);
  const { scrollYProgress } = useScroll({
    target: wrapRef,
    offset: ["start end", "center center"],
  });
  // Subtle cinematic settle: tilt flattens as the frame enters the viewport.
  const rotateX = useTransform(scrollYProgress, [0, 1], reduce ? [0, 0] : [9, 0]);
  const yLift = useTransform(scrollYProgress, [0, 1], reduce ? [0, 0] : [40, 0]);

  return (
    <section id="showcase" className="relative bg-[#f6f7fb] py-28">
      <div className="mx-auto max-w-7xl px-4 sm:px-6">
        <Reveal className="mx-auto max-w-2xl text-center">
          <p className="font-mono text-[11px] uppercase tracking-[0.25em] text-indigo-600">
            Intelligence in motion
          </p>
          <h2 className="mt-4 font-display text-4xl font-semibold uppercase tracking-tight text-zinc-900 sm:text-5xl md:text-6xl">
            See the machine work.
          </h2>
          <p className="mt-5 text-base leading-relaxed text-zinc-600 sm:text-lg">
            Point us at any public handle. In seconds we return a forensic readout —
            profile, reach, followers with real IDs, and the full content library,
            ready to download.
          </p>
        </Reveal>

        {/* Cinematic framed mockup */}
        <div
          ref={wrapRef}
          className="relative mx-auto mt-16 max-w-5xl"
          style={{ perspective: 1400 }}
        >
          {/* soft indigo glow behind the frame */}
          <div
            aria-hidden
            className="pointer-events-none absolute -inset-x-16 -top-16 bottom-0"
            style={{
              background:
                "radial-gradient(60% 55% at 30% 10%, oklch(0.62 0.19 264 / 0.14), transparent 70%), radial-gradient(55% 55% at 80% 90%, oklch(0.78 0.15 75 / 0.12), transparent 70%)",
            }}
          />

          <motion.div
            style={{ rotateX, y: yLift, transformStyle: "preserve-3d" }}
            className="relative overflow-hidden rounded-2xl border border-zinc-200 bg-white shadow-[0_40px_120px_-40px_rgba(16,24,40,0.35)]"
          >
            {/* window chrome */}
            <div className="flex items-center gap-2 border-b border-zinc-200 bg-zinc-50/80 px-4 py-3">
              <span className="h-3 w-3 rounded-full bg-rose-400" />
              <span className="h-3 w-3 rounded-full bg-amber-400" />
              <span className="h-3 w-3 rounded-full bg-emerald-400" />
              <div className="ml-4 hidden flex-1 items-center rounded-md border border-zinc-200 bg-white px-3 py-1 sm:flex">
                <span className="font-mono text-[11px] tracking-wide text-zinc-500">
                  mediahub.studio / intelligence / instagram
                </span>
              </div>
              <span className="ml-auto inline-flex items-center gap-1.5 font-mono text-[10px] uppercase tracking-[0.2em] text-emerald-600">
                <span className="h-1.5 w-1.5 rounded-full bg-emerald-500" />
                live
              </span>
            </div>

            {/* app body */}
            <div className="p-5 sm:p-8">
              {/* profile header */}
              <div className="flex flex-col items-start gap-5 sm:flex-row sm:items-center">
                <div className="relative shrink-0">
                  <div className="h-20 w-20 rounded-full bg-gradient-to-br from-amber-300 via-rose-400 to-indigo-500 p-[3px]">
                    <img
                      src="https://picsum.photos/seed/mh-avatar/200/200"
                      alt="@lumen.studios profile"
                      loading="lazy"
                      className="h-full w-full rounded-full object-cover"
                    />
                  </div>
                </div>
                <div className="min-w-0 flex-1">
                  <div className="flex flex-wrap items-center gap-2">
                    <span className="font-display text-xl uppercase tracking-wide text-zinc-900">
                      @lumen.studios
                    </span>
                    <span className="inline-flex items-center gap-1 rounded-full border border-sky-200 bg-sky-50 px-2 py-0.5 text-[11px] font-medium text-sky-700">
                      <CheckCircle2 className="size-3.5" />
                      Verified
                    </span>
                  </div>
                  <p className="mt-1.5 max-w-md text-sm leading-relaxed text-zinc-600">
                    Cinematic content studio · Los Angeles → worldwide. Decoded by
                    MEDIA HUB.
                  </p>
                </div>
              </div>

              {/* stat tiles */}
              <div className="mt-6 grid grid-cols-3 gap-3">
                {STAT_TILES.map((s) => (
                  <div
                    key={s.label}
                    className="rounded-xl border border-zinc-200 bg-zinc-50/80 p-4 text-center"
                  >
                    <div className="font-display text-2xl tracking-tight text-zinc-900 tabular-nums sm:text-3xl">
                      {s.value}
                    </div>
                    <div className="mt-1 font-mono text-[10px] uppercase tracking-[0.2em] text-zinc-500">
                      {s.label}
                    </div>
                  </div>
                ))}
              </div>

              {/* media grid — real photos */}
              <div className="mt-6 grid grid-cols-3 gap-3">
                {MEDIA.map((m) => (
                  <div
                    key={m.seed}
                    className="group relative aspect-square overflow-hidden rounded-xl border border-zinc-200 bg-zinc-100"
                  >
                    <img
                      src={`https://picsum.photos/seed/${m.seed}/600/600`}
                      alt="Content preview"
                      loading="lazy"
                      className="h-full w-full object-cover transition-transform duration-500 group-hover:scale-105"
                    />
                    {m.reel && (
                      <span className="absolute right-2 top-2 inline-flex items-center gap-1 rounded-md bg-black/55 px-1.5 py-0.5 text-[10px] font-medium text-white backdrop-blur-sm">
                        <Play className="size-2.5 fill-current" />
                        Reel
                      </span>
                    )}
                    <span className="absolute bottom-2 left-2 inline-flex items-center gap-1 rounded-md bg-black/50 px-1.5 py-0.5 text-[10px] font-medium text-white backdrop-blur-sm">
                      <Heart className="size-2.5 fill-rose-400 text-rose-400" />
                      {m.likes}
                    </span>
                  </div>
                ))}
              </div>

              {/* follower chips */}
              <div className="mt-6 flex flex-col gap-3 sm:flex-row sm:items-center">
                <span className="font-mono text-[10px] uppercase tracking-[0.2em] text-zinc-500">
                  Sampled followers
                </span>
                <div className="flex flex-wrap gap-2">
                  {FOLLOWERS.map((f) => (
                    <div
                      key={f.id}
                      className="inline-flex items-center gap-2 rounded-full border border-zinc-200 bg-white py-1 pl-1 pr-3"
                    >
                      <img
                        src={`https://picsum.photos/seed/${f.id}/80/80`}
                        alt={`${f.handle} avatar`}
                        loading="lazy"
                        className="h-6 w-6 rounded-full object-cover"
                      />
                      <span className="text-xs font-medium text-zinc-800">
                        {f.handle}
                      </span>
                      <span className="font-mono text-[10px] text-zinc-400">
                        {f.id}
                      </span>
                    </div>
                  ))}
                </div>
              </div>
            </div>
          </motion.div>
        </div>
      </div>
    </section>
  );
}
