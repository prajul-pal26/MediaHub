"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { cn } from "@/lib/utils";
import { isGodUser } from "@/lib/god";
import type { UserProfile, Mode } from "@/lib/types";
import {
  Image,
  Upload,
  CalendarDays,
  ListTodo,
  Link2,
  Building2,
  Settings,
  MessageSquare,
  BarChart3,
  FileText,
  Download,
  Brain,
  Heart,
  Users,
  MessagesSquare,
  Clock,
  Search,
} from "lucide-react";

interface NavItem {
  label: string;
  href: string;
  icon: React.ElementType;
  mode: Mode;
  roles?: string[];
}

const navItems: NavItem[] = [
  // Chat Mode
  { label: "Chat", href: "/chat", icon: MessageSquare, mode: "chat" },

  // Click Mode
  { label: "Media Library", href: "/library", icon: Image, mode: "click" },
  { label: "Upload", href: "/upload", icon: Upload, mode: "click" },
  { label: "Calendar", href: "/calendar", icon: CalendarDays, mode: "click" },
  { label: "Threads", href: "/threads", icon: MessagesSquare, mode: "click" },
  { label: "Queue", href: "/queue", icon: ListTodo, mode: "click" },
  { label: "Accounts", href: "/accounts", icon: Link2, mode: "click" },
  { label: "Instagram", href: "/instagram", icon: Search, mode: "click" },
  { label: "Facebook", href: "/fb-scraper", icon: Users, mode: "click" },
  {
    label: "Brands",
    href: "/brands",
    icon: Building2,
    mode: "click",
    roles: ["super_admin", "agency_admin", "agency_editor"],
  },
  {
    label: "Settings",
    href: "/settings",
    icon: Settings,
    mode: "click",
  },

  // Analytics Mode
  { label: "Overview", href: "/analytics", icon: BarChart3, mode: "analytics" },
  { label: "Intelligence", href: "/analytics/intelligence", icon: Brain, mode: "analytics" },
  { label: "Sentiment", href: "/analytics/sentiment", icon: Heart, mode: "analytics" },
  { label: "Competitors", href: "/analytics/competitors", icon: Users, mode: "analytics" },
  { label: "Best Times", href: "/analytics/best-times", icon: Clock, mode: "analytics" },
  { label: "Post Analytics", href: "/analytics/posts", icon: FileText, mode: "analytics" },
  { label: "Export", href: "/analytics/export", icon: Download, mode: "analytics" },
];

function getCurrentMode(pathname: string): Mode {
  if (pathname.startsWith("/chat")) return "chat";
  if (pathname.startsWith("/analytics")) return "analytics";
  return "click";
}

interface SidebarProps {
  profile: UserProfile | null;
}

export function Sidebar({ profile }: SidebarProps) {
  const pathname = usePathname();
  const currentMode = getCurrentMode(pathname);

  const god = isGodUser(profile);
  const visibleItems = navItems.filter((item) => {
    if (item.mode !== currentMode) return false;
    if (item.roles && profile && !item.roles.includes(profile.role)) return false;
    // God (single-user) mode: no brand management — it's a personal studio.
    if (god && item.href === "/brands") return false;
    return true;
  });

  return (
    <aside className="w-60 border-r border-sidebar-border bg-sidebar text-sidebar-foreground h-full flex flex-col">
      <div className="p-4 border-b border-sidebar-border">
        <Link href="/library" className="flex items-center gap-2.5 group">
          <div className="h-8 w-8 rounded-lg bg-gradient-to-br from-primary to-chart-2 flex items-center justify-center shadow-sm ring-1 ring-inset ring-white/10 transition-transform group-hover:scale-105">
            <span className="text-primary-foreground font-bold text-sm">M</span>
          </div>
          <span className="font-semibold text-lg tracking-tight text-foreground">MediaHub</span>
        </Link>
      </div>

      <nav className="flex-1 p-3 space-y-1">
        {visibleItems.map((item) => {
          const Icon = item.icon;
          const isActive = pathname === item.href || pathname.startsWith(item.href + "/");
          return (
            <Link
              key={item.href}
              href={item.href}
              className={cn(
                "group flex items-center gap-3 px-3 py-2 rounded-lg text-sm font-medium transition-all duration-150",
                isActive
                  ? "bg-sidebar-accent text-sidebar-accent-foreground shadow-sm"
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
      </nav>

      {profile && (
        <div className="p-3 border-t border-sidebar-border">
          <div className="flex items-center gap-2 px-2 py-1.5 rounded-lg hover:bg-sidebar-accent/50 transition-colors">
            <div className="h-8 w-8 rounded-full bg-gradient-to-br from-primary to-chart-2 text-primary-foreground flex items-center justify-center text-xs font-semibold shrink-0">
              {god ? "G" : profile.name?.[0]?.toUpperCase() || "?"}
            </div>
            <div className="flex-1 min-w-0">
              <p className="text-sm font-medium truncate">
                {god ? "God" : profile.name}
              </p>
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
