"use client";

import { usePathname, useRouter } from "next/navigation";
import { cn } from "@/lib/utils";
import { MessageSquare, MousePointer2, BarChart3 } from "lucide-react";
import type { Mode } from "@/lib/types";

const modes: { id: Mode; label: string; icon: React.ElementType; path: string }[] = [
  { id: "chat", label: "Chat", icon: MessageSquare, path: "/chat" },
  { id: "click", label: "Click", icon: MousePointer2, path: "/library" },
  { id: "analytics", label: "Analytics", icon: BarChart3, path: "/analytics" },
];

function getCurrentMode(pathname: string): Mode {
  if (pathname.startsWith("/chat")) return "chat";
  if (pathname.startsWith("/analytics")) return "analytics";
  return "click";
}

export function ModeSwitcher() {
  const pathname = usePathname();
  const router = useRouter();
  const currentMode = getCurrentMode(pathname);

  return (
    <div className="flex items-center bg-muted rounded-lg p-1">
      {modes.map((mode) => {
        const Icon = mode.icon;
        const isActive = currentMode === mode.id;
        return (
          <button
            key={mode.id}
            onClick={() => router.push(mode.path)}
            className={cn(
              "flex items-center gap-1.5 px-3 py-1.5 rounded-md text-sm font-medium transition-colors",
              isActive
                ? "bg-background text-foreground shadow-sm"
                : "text-muted-foreground hover:text-foreground"
            )}
          >
            <Icon className="h-4 w-4" />
            {mode.label}
          </button>
        );
      })}
    </div>
  );
}
