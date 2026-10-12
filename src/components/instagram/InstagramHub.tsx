"use client";

import { useEffect, useState, useTransition } from "react";
import { useSearchParams, useRouter } from "next/navigation";
import {
  Search,
  UserRoundPlus,
  Newspaper,
  Camera,
} from "lucide-react";
import { cn } from "@/lib/utils";
import { InstagramScraper } from "@/app/instagram/page";
import { InstagramIdCreator } from "./InstagramIdCreator";
import { EditorialReview } from "@/components/editorial/EditorialReview";
import { InstagramProfilePhotoSync } from "./InstagramProfilePhotoSync";

export type InstagramToolKey = "scraper" | "creator" | "news" | "photo";

interface ToolOption {
  key: InstagramToolKey;
  label: string;
  icon: React.ElementType;
  iconBg: string;
  iconColor: string;
}

const TOOLS: ToolOption[] = [
  {
    key: "scraper",
    label: "Instagram Scraper",
    icon: Search,
    iconBg: "bg-indigo-500/10",
    iconColor: "text-indigo-600 dark:text-indigo-400",
  },
  {
    key: "creator",
    label: "Instagram ID Creator",
    icon: UserRoundPlus,
    iconBg: "bg-blue-500/10",
    iconColor: "text-blue-600 dark:text-blue-400",
  },
  {
    key: "news",
    label: "News Review",
    icon: Newspaper,
    iconBg: "bg-amber-500/10",
    iconColor: "text-amber-600 dark:text-amber-400",
  },
  {
    key: "photo",
    label: "Profile Photo Sync",
    icon: Camera,
    iconBg: "bg-emerald-500/10",
    iconColor: "text-emerald-600 dark:text-emerald-400",
  },
];

export function InstagramHub() {
  const searchParams = useSearchParams();
  const router = useRouter();
  const [, startTransition] = useTransition();

  const isValidTab = (t: string | null): t is InstagramToolKey =>
    t === "scraper" || t === "creator" || t === "news" || t === "photo";

  // Default to the Instagram Scraper when no (valid) tool is selected.
  const rawTab = searchParams.get("tab");
  const initialTab: InstagramToolKey = isValidTab(rawTab) ? rawTab : "scraper";

  const [activeTab, setActiveTab] = useState<InstagramToolKey>(initialTab);

  // Sync activeTab when query param changes
  useEffect(() => {
    const currentParam = searchParams.get("tab");
    setActiveTab(isValidTab(currentParam) ? currentParam : "scraper");
  }, [searchParams]);

  const handleSelectTab = (key: InstagramToolKey) => {
    setActiveTab(key);
    startTransition(() => {
      router.push(`/instagram-hub?tab=${key}`);
    });
  };

  return (
    <div className="w-full space-y-6">
      {/* All four options on a single line */}
      <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
        {TOOLS.map((tool) => {
          const Icon = tool.icon;
          const isActive = activeTab === tool.key;
          return (
            <button
              key={tool.key}
              type="button"
              onClick={() => handleSelectTab(tool.key)}
              className={cn(
                "flex items-center gap-3 p-3.5 rounded-xl border text-left transition-all cursor-pointer group",
                isActive
                  ? "border-primary bg-primary/10 text-primary shadow-xs ring-1 ring-primary/30 font-semibold"
                  : "border-border bg-card text-card-foreground hover:border-primary/40 hover:bg-accent/60 hover:shadow-xs"
              )}
            >
              <div
                className={cn(
                  "h-10 w-10 rounded-lg flex items-center justify-center shrink-0 transition-transform group-hover:scale-105",
                  isActive
                    ? "bg-primary text-primary-foreground"
                    : cn(tool.iconBg, tool.iconColor)
                )}
              >
                <Icon className="h-5 w-5" />
              </div>
              <div className="min-w-0 flex-1">
                <span
                  className={cn(
                    "block text-sm font-semibold truncate",
                    isActive
                      ? "text-primary"
                      : "text-foreground group-hover:text-primary transition-colors"
                  )}
                >
                  {tool.label}
                </span>
              </div>
            </button>
          );
        })}
      </div>

      {/* Render active tool */}
      {activeTab === "scraper" && <InstagramScraper embedded={true} />}
      {activeTab === "creator" && <InstagramIdCreator />}
      {activeTab === "news" && <EditorialReview />}
      {activeTab === "photo" && <InstagramProfilePhotoSync />}
    </div>
  );
}
