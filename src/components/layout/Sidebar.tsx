"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { cn } from "@/lib/utils";
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

  const visibleItems = navItems.filter((item) => {
    if (item.mode !== currentMode) return false;
    if (item.roles && profile && !item.roles.includes(profile.role)) return false;
    return true;
  });

  return (
    <aside className="w-60 border-r bg-card h-full flex flex-col">
      <div className="p-4 border-b">
        <Link href="/library" className="flex items-center gap-2">
          <div className="h-8 w-8 rounded-lg bg-primary flex items-center justify-center">
            <span className="text-primary-foreground font-bold text-sm">M</span>
          </div>
          <span className="font-semibold text-lg">MediaHub</span>
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
                "flex items-center gap-3 px-3 py-2 rounded-md text-sm font-medium transition-colors",
                isActive
                  ? "bg-primary/10 text-primary"
                  : "text-muted-foreground hover:text-foreground hover:bg-muted"
              )}
            >
              <Icon className="h-4 w-4" />
              {item.label}
            </Link>
          );
        })}
      </nav>

      {profile && (
        <div className="p-3 border-t">
          <div className="flex items-center gap-2 px-3 py-2">
            <div className="h-8 w-8 rounded-full bg-muted flex items-center justify-center text-xs font-medium">
              {profile.name?.[0]?.toUpperCase() || "?"}
            </div>
            <div className="flex-1 min-w-0">
              <p className="text-sm font-medium truncate">{profile.name}</p>
              <p className="text-xs text-muted-foreground truncate">
                {profile.role.replace(/_/g, " ")}
              </p>
            </div>
          </div>
        </div>
      )}
    </aside>
  );
}
