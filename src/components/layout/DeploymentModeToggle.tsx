"use client";

import { Cloud, HardDrive } from "lucide-react";
import { cn } from "@/lib/utils";
import { useDeploymentMode } from "@/lib/hooks/use-deployment-mode";

/**
 * Local ⇄ Live preview switch.
 *
 * Renders NOTHING on a live (Vercel) build. That is the whole point: a visitor
 * to the hosted site must never see a control that implies local-only features
 * exist there. `canSwitch` comes from the build-time env var, not from state,
 * so it cannot be flipped at runtime.
 *
 * On a local build it lets you see exactly what the Vercel deployment exposes
 * without having to deploy and check.
 */
export function DeploymentModeToggle() {
  const { mode, setMode, canSwitch } = useDeploymentMode();

  if (!canSwitch) return null;

  const options = [
    { value: "local" as const, label: "Local", icon: HardDrive },
    { value: "live" as const, label: "Live", icon: Cloud },
  ];

  return (
    <div
      role="group"
      aria-label="Deployment mode"
      title={
        mode === "live"
          ? "Previewing what the hosted site shows. Local-only features are hidden."
          : "Full local stack — every feature available."
      }
      className="flex items-center gap-0.5 rounded-lg border border-border bg-muted/50 p-0.5"
    >
      {options.map((option) => {
        const Icon = option.icon;
        const active = mode === option.value;
        return (
          <button
            key={option.value}
            type="button"
            aria-pressed={active}
            onClick={() => setMode(option.value)}
            className={cn(
              "inline-flex items-center gap-1.5 rounded-md px-2 py-1 text-xs font-medium transition-colors",
              active
                ? option.value === "live"
                  ? "bg-amber-500 text-white shadow-sm"
                  : "bg-background text-foreground shadow-sm"
                : "text-muted-foreground hover:text-foreground"
            )}
          >
            <Icon className="h-3.5 w-3.5" />
            {option.label}
          </button>
        );
      })}
    </div>
  );
}
