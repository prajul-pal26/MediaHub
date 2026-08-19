"use client";

import { motion, useReducedMotion, type HTMLMotionProps } from "framer-motion";
import type { ReactNode } from "react";

/** Cinematic ease-out (expo-ish). Use across the landing for a consistent feel. */
export const EASE = [0.16, 1, 0.3, 1] as const;

/**
 * Scroll-reveal primitive. Fades + rises into view once. Respects
 * prefers-reduced-motion (falls back to a plain fade, no transform).
 * Shared by every landing section so motion reads as one system.
 */
export function Reveal({
  children,
  delay = 0,
  y = 26,
  className,
  ...rest
}: {
  children: ReactNode;
  delay?: number;
  y?: number;
  className?: string;
} & HTMLMotionProps<"div">) {
  const reduce = useReducedMotion();
  return (
    <motion.div
      className={className}
      initial={reduce ? { opacity: 0 } : { opacity: 0, y }}
      whileInView={{ opacity: 1, y: 0 }}
      viewport={{ once: true, margin: "-80px" }}
      transition={{ duration: 0.75, delay, ease: EASE }}
      {...rest}
    >
      {children}
    </motion.div>
  );
}

/** Stagger container — children using `RevealItem` animate in sequence. */
export function RevealGroup({
  children,
  className,
  stagger = 0.1,
}: {
  children: ReactNode;
  className?: string;
  stagger?: number;
}) {
  return (
    <motion.div
      className={className}
      initial="hidden"
      whileInView="show"
      viewport={{ once: true, margin: "-80px" }}
      variants={{ show: { transition: { staggerChildren: stagger } } }}
    >
      {children}
    </motion.div>
  );
}

export function RevealItem({
  children,
  className,
  y = 26,
}: {
  children: ReactNode;
  className?: string;
  y?: number;
}) {
  const reduce = useReducedMotion();
  return (
    <motion.div
      className={className}
      variants={{
        hidden: reduce ? { opacity: 0 } : { opacity: 0, y },
        show: { opacity: 1, y: 0, transition: { duration: 0.7, ease: EASE } },
      }}
    >
      {children}
    </motion.div>
  );
}
