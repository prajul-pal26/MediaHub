"use client";

import { Reveal, RevealGroup, RevealItem } from "@/components/landing/lib/motion";
import { SERVICES } from "@/components/landing/lib/constants";
import { ServiceCard } from "@/components/landing/ServiceCard";

export default function ServicesSection() {
  return (
    <section
      id="services"
      className="relative overflow-hidden bg-[#f6f7fb] py-24 md:py-28"
    >
      {/* soft ambient indigo wash */}
      <div
        aria-hidden
        className="pointer-events-none absolute inset-0"
        style={{
          background:
            "radial-gradient(900px circle at 80% -10%, rgba(79,70,229,0.08), transparent 60%)",
        }}
      />

      <div className="relative mx-auto max-w-7xl px-4 sm:px-6 lg:px-8">
        {/* header */}
        <Reveal className="max-w-2xl">
          <h2 className="font-display text-4xl font-bold leading-[1.05] tracking-tight text-zinc-900 sm:text-5xl">
            Three services. One studio.
          </h2>
          <p className="mt-5 text-base leading-relaxed text-zinc-700 md:text-lg">
            Intelligence and automation — built to scout, decode and publish
            across every platform.
          </p>
        </Reveal>

        {/* symmetric grid: three equal-width, equal-height cards */}
        <RevealGroup
          className="mt-14 grid grid-cols-1 gap-6 md:grid-cols-3 lg:mt-16"
          stagger={0.12}
        >
          {SERVICES.map((service) => (
            <RevealItem key={service.slug} className="h-full">
              <ServiceCard service={service} />
            </RevealItem>
          ))}
        </RevealGroup>
      </div>
    </section>
  );
}
