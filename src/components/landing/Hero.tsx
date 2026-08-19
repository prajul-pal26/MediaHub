"use client";

import { useEffect, useRef, useState } from "react";
import {
  motion,
  useReducedMotion,
  useScroll,
  useTransform,
} from "framer-motion";
import { EASE } from "@/components/landing/lib/motion";
import { Grain } from "@/components/landing/Grain";
import { Starfield } from "@/components/landing/Starfield";
import { MountainScene } from "@/components/landing/MountainScene";
import { HollywoodSign } from "@/components/landing/HollywoodSign";

function ChevronDown() {
  return (
    <svg
      viewBox="0 0 24 24"
      className="h-5 w-5"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden
    >
      <path d="m6 9 6 6 6-6" />
    </svg>
  );
}

export function Hero() {
  const reduce = useReducedMotion();
  const sectionRef = useRef<HTMLElement | null>(null);
  const [lit, setLit] = useState(false);

  // Ignite the sign shortly after the mountains have risen.
  useEffect(() => {
    if (reduce) {
      setLit(true);
      return;
    }
    const id = window.setTimeout(() => setLit(true), 750);
    return () => window.clearTimeout(id);
  }, [reduce]);

  const { scrollYProgress } = useScroll({
    target: sectionRef,
    offset: ["start start", "end start"],
  });

  // Subtle depth-parallax — each layer drifts at its own rate on scroll.
  const skyY = useTransform(scrollYProgress, [0, 1], [0, 60]);
  const mountainsY = useTransform(scrollYProgress, [0, 1], [0, 90]);
  const signY = useTransform(scrollYProgress, [0, 1], [0, -70]);
  const signOpacity = useTransform(scrollYProgress, [0, 0.7], [1, 0]);
  const copyY = useTransform(scrollYProgress, [0, 1], [0, 40]);

  const enter = (delay: number) =>
    reduce
      ? { initial: { opacity: 0 }, animate: { opacity: 1 }, transition: { duration: 0.6, delay } }
      : {
          initial: { opacity: 0, y: 22 },
          animate: { opacity: 1, y: 0 },
          transition: { duration: 0.8, ease: EASE, delay },
        };

  return (
    <section
      ref={sectionRef}
      className="relative min-h-screen w-full overflow-hidden bg-[#dbeafe]"
    >
      {/* (1) Bright daytime sky — sky-blue crown → warm cream near the hills */}
      <motion.div
        aria-hidden
        style={reduce ? undefined : { y: skyY }}
        className="absolute inset-0 bg-[radial-gradient(140%_100%_at_50%_-10%,#cfe3ff_0%,#dbeafe_36%,#eaf1fb_62%,#fdf6ec_100%)]"
      >
        <div className="absolute inset-x-0 bottom-0 h-[48%] bg-[linear-gradient(to_top,rgba(253,246,236,0.95),rgba(251,239,216,0.5)_46%,transparent)]" />
      </motion.div>

      {/* (2) Sun glow + drifting clouds */}
      <Starfield />

      {/* (3) Soft sun rays raking down from the light source */}
      <div aria-hidden className="pointer-events-none absolute inset-0 overflow-hidden">
        <div
          className="absolute -top-1/3 left-[18%] h-[130%] w-[16%] rotate-[14deg] blur-2xl bg-[linear-gradient(to_bottom,rgba(255,244,214,0.5),transparent_72%)]"
          style={reduce ? undefined : { animation: "mh-spotlight 14s ease-in-out infinite", transformOrigin: "top center" }}
        />
        <div
          className="absolute -top-1/3 right-[20%] h-[130%] w-[14%] -rotate-[12deg] blur-2xl bg-[linear-gradient(to_bottom,rgba(253,230,138,0.42),transparent_70%)]"
          style={reduce ? undefined : { animation: "mh-spotlight 18s ease-in-out infinite reverse", transformOrigin: "top center" }}
        />
        <div
          className="absolute -top-1/4 left-1/2 h-[120%] w-[10%] -translate-x-1/2 blur-3xl bg-[linear-gradient(to_bottom,rgba(255,255,255,0.42),transparent_66%)]"
          style={reduce ? undefined : { animation: "mh-spotlight 22s ease-in-out infinite", transformOrigin: "top center" }}
        />
      </div>

      {/* (4) Mountain range, risen from the bottom */}
      <motion.div
        aria-hidden
        style={reduce ? undefined : { y: mountainsY }}
        className="absolute inset-x-0 bottom-0 z-[5]"
      >
        <motion.div
          initial={reduce ? { opacity: 0 } : { opacity: 0, y: 90 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ duration: 1.2, ease: EASE }}
        >
          <MountainScene className="h-[42vh] min-h-[280px] w-full sm:h-[46vh]" />
        </motion.div>
      </motion.div>

      {/* (5 + 6) Foreground: sign on the ridge + copy */}
      <motion.div
        style={reduce ? undefined : { y: copyY }}
        className="relative z-20 mx-auto flex min-h-screen max-w-6xl flex-col items-center justify-center px-6 pb-24 pt-24 text-center"
      >
        {/* (5) The sign — H1 */}
        <motion.h1
          aria-label="MEDIA HUB"
          style={reduce ? undefined : { y: signY, opacity: signOpacity }}
          className="my-5 sm:my-7"
        >
          <HollywoodSign ignite={lit} />
        </motion.h1>

        {/* Sub-headline */}
        <motion.p
          {...enter(1.5)}
          className="max-w-2xl text-balance text-base leading-relaxed text-zinc-700 sm:text-lg"
        >
          Intelligence, content and automation across every platform.
        </motion.p>
      </motion.div>

      {/* Scroll cue */}
      <motion.div
        {...enter(2)}
        className="absolute inset-x-0 bottom-6 z-30 flex justify-center"
      >
        <div
          className="flex flex-col items-center gap-1 text-zinc-500"
          style={reduce ? undefined : { animation: "mh-float 2.6s ease-in-out infinite" }}
        >
          <span className="font-mono text-[0.6rem] uppercase tracking-[0.3em]">
            Scroll
          </span>
          <ChevronDown />
        </div>
      </motion.div>

      {/* Top-of-stack film grain + vignette */}
      <Grain />
    </section>
  );
}

export default Hero;
