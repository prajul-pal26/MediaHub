"use client";

import { useState } from "react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { cn } from "@/lib/utils";
import { isGodUser } from "@/lib/god";
import type { Capability } from "@/lib/deployment";
import { useDeploymentMode } from "@/lib/hooks/use-deployment-mode";
import type { UserProfile } from "@/lib/types";
import {
  Image,
  Link2,
  Building2,
  Settings,
  BarChart3,
  FileText,
  Clock,
  ChevronRight,
  Wand2,
} from "lucide-react";

interface NavItem {
  label: string;
  href: string;
  icon: React.ElementType;
  roles?: string[];
  hideForGod?: boolean;
  /**
   * Capability this page needs. In live (Vercel) mode the item is hidden when
   * the capability is unavailable there — the page's backend genuinely does not
   * exist on serverless, so linking to it would be a dead end.
   */
  capability?: Capability;
}

interface NavGroup {
  label: string;
  items: NavItem[];
  collapsible?: boolean;
  matchPrefix?: string;
}

function InstagramIcon(props: React.SVGProps<SVGSVGElement>) {
  return (
    <svg viewBox="0 0 24 24" width="24" height="24" stroke="currentColor" strokeWidth="2" fill="none" strokeLinecap="round" strokeLinejoin="round" {...props}>
      <rect width="20" height="20" x="2" y="2" rx="5" ry="5" />
      <path d="M16 11.37A4 4 0 1 1 12.63 8 4 4 0 0 1 16 11.37z" />
      <line x1="17.5" x2="17.51" y1="6.5" y2="6.5" />
    </svg>
  );
}

function FacebookIcon(props: React.SVGProps<SVGSVGElement>) {
  return (
    <svg viewBox="0 0 24 24" width="24" height="24" stroke="currentColor" strokeWidth="2" fill="none" strokeLinecap="round" strokeLinejoin="round" {...props}>
      <path d="M18 2h-3a5 5 0 0 0-5 5v3H7v4h3v8h4v-8h3l1-4h-4V7a1 1 0 0 1 1-1h3z" />
    </svg>
  );
}

const navGroups: NavGroup[] = [
  {
    label: "Studio",
    items: [
      { label: "Media Library", href: "/library", icon: Image },
      { label: "Editor", href: "/editor", icon: Wand2 },
    ],
  },
  {
    label: "Social tools",
    items: [
      { label: "Instagram", href: "/instagram-hub", icon: InstagramIcon, capability: "scrapers" },
      { label: "Facebook", href: "/facebook-hub", icon: FacebookIcon, capability: "scrapers" },
    ],
  },
  {
    label: "Analytics",
    collapsible: true,
    matchPrefix: "/analytics",
    items: [
      { label: "Overview", href: "/analytics", icon: BarChart3 },
      { label: "Best Times", href: "/analytics/best-times", icon: Clock },
      { label: "Post Analytics", href: "/analytics/posts", icon: FileText },
    ],
  },
  {
    label: "Manage",
    items: [
      { label: "Accounts", href: "/accounts", icon: Link2 },
      { label: "Brands", href: "/brands", icon: Building2, roles: ["super_admin", "agency_admin", "agency_editor"], hideForGod: true },
      { label: "Settings", href: "/settings", icon: Settings },
    ],
  },
];

interface SidebarProps {
  profile: UserProfile | null;
}

export function Sidebar({ profile }: SidebarProps) {
  const pathname = usePathname();
  const god = isGodUser(profile);
  const { can } = useDeploymentMode();
  // Analytics is important — keep its group expanded by default (still collapsible).
  const [analyticsOpen, setAnalyticsOpen] = useState(true);

  function isItemActive(href: string): boolean {
    if (href === "/instagram-hub") {
      return (
        pathname.startsWith("/instagram-hub") ||
        pathname.startsWith("/insta-") ||
        pathname === "/editorial-review" ||
        pathname.startsWith("/instagram")
      );
    }
    if (href === "/facebook-hub") {
      return pathname.startsWith("/facebook-hub") || pathname.startsWith("/facebook") || pathname.startsWith("/fb-");
    }
    // Exact match for /analytics so it doesn't swallow its own sub-routes.
    if (href === "/analytics") return pathname === "/analytics";
    return pathname === href || pathname.startsWith(href + "/");
  }

  function visibleItems(items: NavItem[]): NavItem[] {
    return items.filter((item) => {
      if (item.roles && profile && !item.roles.includes(profile.role)) return false;
      if (god && item.hideForGod) return false;
      // Hidden in live mode when the page's backend cannot run on Vercel.
      if (item.capability && !can(item.capability)) return false;
      return true;
    });
  }

  return (
    <aside className="w-60 border-r border-sidebar-border bg-sidebar text-sidebar-foreground h-full flex flex-col shrink-0">
      <div className="p-4 border-b border-sidebar-border">
        <Link href="/library" className="flex items-center gap-2.5 group">
          <div className="h-8 w-8 rounded-lg bg-gradient-to-br from-primary to-chart-2 flex items-center justify-center shadow-sm ring-1 ring-inset ring-white/10 transition-transform group-hover:scale-105">
            <span className="text-primary-foreground font-bold text-sm">M</span>
          </div>
          <span className="font-semibold text-lg tracking-tight text-foreground">MediaHub</span>
        </Link>
      </div>

      <nav className="flex-1 p-3 space-y-5 overflow-y-auto">
        {navGroups.map((group) => {
          const items = visibleItems(group.items);
          if (items.length === 0) return null;

          const groupActive = group.matchPrefix ? pathname.startsWith(group.matchPrefix) : false;
          const open = group.collapsible ? analyticsOpen || groupActive : true;

          return (
            <div key={group.label} className="space-y-1">
              {group.collapsible ? (
                <button
                  onClick={() => setAnalyticsOpen((v) => !v)}
                  className="w-full flex items-center justify-between px-3 py-1 text-[11px] font-semibold uppercase tracking-wider text-sidebar-foreground/40 hover:text-sidebar-foreground/70 transition-colors"
                >
                  {group.label}
                  <ChevronRight className={cn("h-3.5 w-3.5 transition-transform", open && "rotate-90")} />
                </button>
              ) : (
                <p className="px-3 py-1 text-[11px] font-semibold uppercase tracking-wider text-sidebar-foreground/40">
                  {group.label}
                </p>
              )}

              {open &&
                items.map((item) => {
                  const Icon = item.icon;
                  const isActive = isItemActive(item.href);
                  return (
                    <Link
                      key={item.href}
                      href={item.href}
                      className={cn(
                        "group flex items-center gap-3 px-3 py-2 rounded-lg text-sm font-medium transition-all duration-150",
                        isActive
                          ? "bg-sidebar-accent text-sidebar-accent-foreground shadow-sm font-semibold"
                          : "text-sidebar-foreground/70 hover:text-sidebar-foreground hover:bg-sidebar-accent/50"
                      )}
                    >
                      <Icon
                        className={cn(
                          "h-4 w-4 shrink-0 transition-colors",
                          isActive ? "text-primary" : "text-sidebar-foreground/50 group-hover:text-sidebar-foreground"
                        )}
                      />
                      {item.label}
                    </Link>
                  );
                })}
            </div>
          );
        })}
      </nav>

      {profile && (
        <div className="p-3 border-t border-sidebar-border">
          <div className="flex items-center gap-2 px-2 py-1.5 rounded-lg hover:bg-sidebar-accent/50 transition-colors">
            <div className="h-8 w-8 rounded-full bg-gradient-to-br from-primary to-chart-2 text-primary-foreground flex items-center justify-center text-xs font-semibold shrink-0">
              {god ? "G" : profile.name?.[0]?.toUpperCase() || "?"}
            </div>
            <div className="flex-1 min-w-0">
              <p className="text-sm font-medium truncate">{god ? "God" : profile.name}</p>
              <p className="text-xs text-muted-foreground truncate">
                {god ? "Owner · full access" : profile.role.replace(/_/g, " ")}
              </p>
            </div>
          </div>
        </div>
      )}
    </aside>
  );
}
