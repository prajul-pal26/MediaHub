"use client";

import Link from "next/link";
import { cn } from "@/lib/utils";
import {
  Search,
  UserRoundPlus,
  Newspaper,
  Camera,
  LayoutGrid,
} from "lucide-react";

export type InstagramTabKey = "overview" | "scraper" | "creator" | "news" | "photo";

interface InstagramSubNavProps {
  activeTab: InstagramTabKey;
  onTabChange?: (tab: InstagramTabKey) => void;
  showBackToOverview?: boolean;
}

export const INSTAGRAM_TOOLS = [
  {
    key: "scraper" as const,
    label: "Instagram Scraper",
    shortLabel: "Scraper",
    href: "/instagram-hub?tab=scraper",
    directHref: "/instagram",
    icon: Search,
    description: "Extract posts, reels, video views, comments & export CSV",
    badge: "Intelligence",
    badgeColor: "bg-indigo-500/10 text-indigo-600 dark:text-indigo-400 border-indigo-500/20",
  },
  {
    key: "creator" as const,
    label: "Insta ID Creator",
    shortLabel: "ID Creator",
    href: "/instagram-hub?tab=creator",
    directHref: "/insta-id-creator",
    icon: UserRoundPlus,
    description: "Autofill & register 75 district Instagram account credentials",
    badge: "75 Accounts",
    badgeColor: "bg-blue-500/10 text-blue-600 dark:text-blue-400 border-blue-500/20",
  },
  {
    key: "news" as const,
    label: "News Review",
    shortLabel: "News Review",
    href: "/instagram-hub?tab=news",
    directHref: "/editorial-review",
    icon: Newspaper,
    description: "Fact-check public-interest news sources and review queue",
    badge: "Evidence Queue",
    badgeColor: "bg-amber-500/10 text-amber-600 dark:text-amber-400 border-amber-500/20",
  },
  {
    key: "photo" as const,
    label: "Profile Photo Sync",
    shortLabel: "Photo Sync",
    href: "/instagram-hub?tab=photo",
    directHref: "/insta-profile-photo",
    icon: Camera,
    description: "Sync official 1080×1080 district logos from Drive across 75 Safari profiles",
    badge: "Safari & Drive",
    badgeColor: "bg-emerald-500/10 text-emerald-600 dark:text-emerald-400 border-emerald-500/20",
  },
];

export function InstagramSubNav({
  activeTab,
  onTabChange,
  showBackToOverview = true,
}: InstagramSubNavProps) {
  return (
    <div className="sticky top-0 z-30 mb-6 -mx-6 -mt-6 bg-background/95 backdrop-blur-md border-b border-border px-6 py-3 shadow-xs">
      <div className="flex flex-wrap items-center justify-between gap-3">
        {/* Left: Branding & Overview Link */}
        <div className="flex items-center gap-2">
          {onTabChange ? (
            <button
              type="button"
              onClick={() => onTabChange("overview")}
              className={cn(
                "inline-flex items-center gap-2 px-3 py-1.5 rounded-lg text-xs font-semibold transition-all cursor-pointer",
                activeTab === "overview"
                  ? "bg-primary text-primary-foreground shadow-xs"
                  : "bg-muted/60 text-muted-foreground hover:text-foreground hover:bg-muted"
              )}
            >
              <LayoutGrid className="h-4 w-4" />
              <span>All 4 Options</span>
            </button>
          ) : (
            <Link
              href="/instagram-hub"
              className={cn(
                "inline-flex items-center gap-2 px-3 py-1.5 rounded-lg text-xs font-semibold transition-all",
                activeTab === "overview"
                  ? "bg-primary text-primary-foreground shadow-xs"
                  : "bg-muted/60 text-muted-foreground hover:text-foreground hover:bg-muted"
              )}
            >
              <LayoutGrid className="h-4 w-4" />
              <span>All 4 Options</span>
            </Link>
          )}

          <div className="h-4 w-px bg-border hidden sm:block" />
          <span className="text-xs font-medium text-muted-foreground hidden md:inline">
            Instagram Studio
          </span>
        </div>

        {/* Right: The 4 Tool Tabs */}
        <div className="flex items-center gap-1.5 overflow-x-auto py-0.5">
          {INSTAGRAM_TOOLS.map((tool) => {
            const Icon = tool.icon;
            const isActive = activeTab === tool.key;

            if (onTabChange) {
              return (
                <button
                  key={tool.key}
                  type="button"
                  onClick={() => onTabChange(tool.key)}
                  className={cn(
                    "inline-flex items-center gap-2 px-3 py-1.5 rounded-lg text-xs font-medium transition-all cursor-pointer whitespace-nowrap",
                    isActive
                      ? "bg-primary text-primary-foreground font-semibold shadow-xs"
                      : "bg-muted/40 text-muted-foreground hover:text-foreground hover:bg-muted/80 border border-transparent hover:border-border"
                  )}
                >
                  <Icon className={cn("h-3.5 w-3.5", isActive ? "text-primary-foreground" : "text-muted-foreground")} />
                  <span>{tool.label}</span>
                </button>
              );
            }

            return (
              <Link
                key={tool.key}
                href={tool.href}
                className={cn(
                  "inline-flex items-center gap-2 px-3 py-1.5 rounded-lg text-xs font-medium transition-all whitespace-nowrap",
                  isActive
                    ? "bg-primary text-primary-foreground font-semibold shadow-xs"
                    : "bg-muted/40 text-muted-foreground hover:text-foreground hover:bg-muted/80 border border-transparent hover:border-border"
                )}
              >
                <Icon className={cn("h-3.5 w-3.5", isActive ? "text-primary-foreground" : "text-muted-foreground")} />
                <span>{tool.label}</span>
              </Link>
            );
          })}
        </div>
      </div>
    </div>
  );
}
