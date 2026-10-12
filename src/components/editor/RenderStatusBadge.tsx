"use client";

import { Check, CircleAlert, Clock, Loader2, Pencil } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { cn } from "@/lib/utils";

export type RenderStatus = "idle" | "queued" | "rendering" | "ready" | "failed";

export const RENDER_STATUSES: RenderStatus[] = ["idle", "queued", "rendering", "ready", "failed"];

/** True while the worker still owes us a result — the gallery polls on this. */
export function isRenderPending(status: string): boolean {
  return status === "queued" || status === "rendering";
}

export function asRenderStatus(value: string | null | undefined): RenderStatus {
  return RENDER_STATUSES.includes(value as RenderStatus) ? (value as RenderStatus) : "idle";
}

const PRESENTATION: Record<
  RenderStatus,
  { label: string; icon: React.ElementType; className: string; spin?: boolean }
> = {
  idle: {
    label: "Draft",
    icon: Pencil,
    className: "bg-muted text-muted-foreground",
  },
  queued: {
    label: "Queued",
    icon: Clock,
    className: "bg-amber-500/10 text-amber-700 dark:text-amber-400",
  },
  rendering: {
    label: "Rendering",
    icon: Loader2,
    className: "bg-blue-500/10 text-blue-700 dark:text-blue-400",
    spin: true,
  },
  ready: {
    label: "Ready",
    icon: Check,
    className: "bg-emerald-500/10 text-emerald-700 dark:text-emerald-400",
  },
  failed: {
    label: "Failed",
    icon: CircleAlert,
    className: "bg-destructive/10 text-destructive",
  },
};

export function RenderStatusBadge({
  status,
  progress,
  className,
}: {
  status: RenderStatus;
  /** 0–100, shown only while rendering. */
  progress?: number | null;
  className?: string;
}) {
  const { label, icon: Icon, className: tone, spin } = PRESENTATION[status];
  const showProgress = status === "rendering" && progress != null && progress > 0;

  return (
    <Badge variant="secondary" className={cn("gap-1 border-transparent", tone, className)}>
      <Icon className={cn(spin && "animate-spin")} />
      {showProgress ? `${label} ${Math.round(progress)}%` : label}
    </Badge>
  );
}
