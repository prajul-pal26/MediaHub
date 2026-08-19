/**
 * Single source of truth for landing content. Agency copy is written in a
 * confident, cinematic "we produce your social presence" voice.
 * NOTE: stat numbers + testimonials are illustrative placeholders — the owner
 * should replace them with real figures before selling.
 */

export type ServiceStatus = "live" | "coming-soon" | "gated";

export interface Service {
  slug: string;
  index: string; // "01"
  name: string;
  kicker: string;
  href: string;
  status: ServiceStatus;
  cta: string;
  tagline: string;
  description: string;
  features: string[];
  /** Short "what you can do" chips rendered on the service card */
  capabilities: string[];
  /** OKLCH accent used for this service's glow/gradient */
  accent: string;
}

export const SERVICES: Service[] = [
  {
    slug: "instagram",
    index: "01",
    name: "Instagram Intelligence",
    kicker: "Live now",
    href: "/instagram",
    status: "live",
    cta: "Open Instagram",
    tagline: "Every public profile, decoded.",
    description:
      "Point us at any public Instagram handle and we pull the whole picture — profile, engagement, followers and following, and the full content library — reels, posts and carousels, ready to download.",
    features: [
      "Followers & following with real user IDs",
      "All posts, reels & carousels with one-click download",
      "Likes, comments & play-count analytics",
      "Batch multiple handles at once",
    ],
    capabilities: [
      "Profile & followers",
      "Posts & reels",
      "Likes & comments",
      "View counts",
      "Trending by hashtag",
      "Download media",
    ],
    accent: "oklch(0.7 0.18 20)", // instagram warm rose
  },
  {
    slug: "facebook",
    index: "02",
    name: "Facebook Intelligence",
    kicker: "Live now",
    href: "/facebook",
    status: "live",
    cta: "Open Facebook",
    tagline: "Any public Page, decoded.",
    description:
      "Point us at any Facebook Page and we render it like a real browser — pulling followers, category, and recent posts with engagement. Live page intelligence, straight from the source.",
    features: [
      "Followers, likes & category for any public Page",
      "Recent posts with reactions & comments",
      "Batch multiple Pages at once",
      "Renders the real page — no API gatekeeping",
    ],
    capabilities: [
      "Page & followers",
      "Recent posts",
      "Reactions & comments",
      "Live page render",
      "Any public Page",
    ],
    accent: "oklch(0.62 0.2 264)", // facebook blue/indigo
  },
  {
    slug: "automation",
    index: "03",
    name: "Media Automation",
    kicker: "Live now",
    href: "/api/studio-enter",
    status: "live",
    cta: "Open Studio",
    tagline: "Publish everywhere. On autopilot.",
    description:
      "Turn one idea into posts, reels and stories across every platform — automatically. An AI copilot writes, schedules and publishes while a unified calendar and analytics keep your whole brand in motion. Built to push AI-crafted media to the public, at scale.",
    features: [
      "AI copilot that writes, schedules & publishes for you",
      "One calendar & approval queue for every platform",
      "Cross-platform analytics, reach & sentiment",
      "Multi-brand, agency-grade access control",
    ],
    capabilities: [
      "Upload to Drive",
      "Schedule & publish",
      "AI chat copilot",
      "Cross-platform analytics",
      "Every platform",
    ],
    accent: "oklch(0.62 0.19 264)", // indigo — matches the studio brand
  },
];

export const NAV_LINKS = [
  { label: "Services", href: "#services" },
  { label: "Showcase", href: "#showcase" },
  { label: "Agency", href: "#agency" },
];

export const STATS = [
  { value: 8_200_000_000, suffix: "+", label: "Impressions orchestrated" },
  { value: 47, suffix: "M", label: "Profiles analysed", divide: 1 },
  { value: 12, suffix: "", label: "Platforms automated" },
  { value: 99.9, suffix: "%", label: "Pipeline uptime", decimals: 1 },
];

export const TESTIMONIALS = [
  {
    quote:
      "MEDIA HUB replaced four tools and two contractors. Our content velocity tripled in a quarter.",
    name: "Ava Moreau",
    role: "Head of Growth, Lumen Studios",
  },
  {
    quote:
      "The intelligence layer is unreal. We scout creators and benchmark competitors in seconds, not days.",
    name: "Daniel Osei",
    role: "Founder, Northwind Social",
  },
  {
    quote:
      "It feels like having a production studio on retainer. The automation just runs.",
    name: "Priya Nair",
    role: "CMO, Halcyon Brands",
  },
];

/** Shared LIGHT-theme surface fragments (kept here so every section matches the studio). */
export const SURFACE = {
  card: "rounded-2xl border border-zinc-200 bg-white shadow-[0_1px_2px_rgba(16,24,40,0.04),0_8px_24px_-12px_rgba(16,24,40,0.12)]",
  cardHover: "transition-all hover:border-indigo-300 hover:shadow-[0_12px_32px_-12px_rgba(79,70,229,0.25)]",
  kicker: "font-mono text-[11px] uppercase tracking-[0.25em] text-indigo-600",
  gold: "text-indigo-600",
  ink: "text-zinc-900",
  sub: "text-zinc-600",
} as const;
