"use client";

import { useEffect, useState, useTransition } from "react";
import { useSearchParams, useRouter } from "next/navigation";
import { Search, UserRoundPlus, Video } from "lucide-react";
import { cn } from "@/lib/utils";
import { FacebookScraper } from "@/app/facebook/page";
import { FacebookIdCreator } from "./FacebookIdCreator";
import { FacebookVideoDownloader } from "./FacebookVideoDownloader";

export type FacebookToolKey = "downloader" | "scraper" | "creator";

const VALID_TABS: FacebookToolKey[] = ["downloader", "scraper", "creator"];
const DEFAULT_TAB: FacebookToolKey = "downloader";

interface ToolOption {
  key: FacebookToolKey;
  label: string;
  icon: React.ElementType;
  iconBg: string;
  iconColor: string;
}

const TOOLS: ToolOption[] = [
  {
    key: "downloader",
    label: "Video Downloader",
    icon: Video,
    iconBg: "bg-blue-500/10",
    iconColor: "text-blue-600 dark:text-blue-400",
  },
  {
    key: "scraper",
    label: "Facebook Scraper",
    icon: Search,
    iconBg: "bg-indigo-500/10",
    iconColor: "text-indigo-600 dark:text-indigo-400",
  },
  {
    key: "creator",
    label: "Facebook ID Creator",
    icon: UserRoundPlus,
    iconBg: "bg-blue-500/10",
    iconColor: "text-blue-600 dark:text-blue-400",
  },
];

export function FacebookHub() {
  const searchParams = useSearchParams();
  const router = useRouter();
  const [, startTransition] = useTransition();

  const rawTab = searchParams.get("tab") as FacebookToolKey | null;
  const initialTab: FacebookToolKey =
    rawTab && VALID_TABS.includes(rawTab) ? rawTab : DEFAULT_TAB;

  const [activeTab, setActiveTab] = useState<FacebookToolKey>(initialTab);

  useEffect(() => {
    const currentParam = searchParams.get("tab") as FacebookToolKey | null;
    setActiveTab(currentParam && VALID_TABS.includes(currentParam) ? currentParam : DEFAULT_TAB);
  }, [searchParams]);

  const handleSelectTab = (key: FacebookToolKey) => {
    setActiveTab(key);
    startTransition(() => {
      router.push(`/facebook-hub?tab=${key}`);
    });
  };

  return (
    <div className="w-full space-y-6">
      <div className="grid grid-cols-3 gap-3 sm:max-w-2xl">
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

      {activeTab === "downloader" && <FacebookVideoDownloader />}
      {activeTab === "scraper" && <FacebookScraper embedded={true} />}
      {activeTab === "creator" && <FacebookIdCreator />}
    </div>
  );
}
