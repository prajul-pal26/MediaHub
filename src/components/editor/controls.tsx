"use client";

import * as React from "react";
import { cn } from "@/lib/utils";

/** The small, repeated control vocabulary the inspector panels are built from. */

export function PanelSection({
  title,
  action,
  children,
  className,
}: {
  title?: string;
  action?: React.ReactNode;
  children: React.ReactNode;
  className?: string;
}) {
  return (
    <section className={cn("space-y-3", className)}>
      {(title || action) && (
        <header className="flex min-h-6 items-center justify-between gap-2">
          {title && (
            <h3 className="text-[11px] font-semibold tracking-wider text-muted-foreground uppercase">
              {title}
            </h3>
          )}
          {action}
        </header>
      )}
      {children}
    </section>
  );
}

export function ControlRow({
  label,
  value,
  children,
}: {
  label: string;
  value?: string;
  children: React.ReactNode;
}) {
  return (
    <div className="space-y-1.5">
      <div className="flex items-baseline justify-between gap-2">
        <span className="text-xs font-medium text-foreground/80">{label}</span>
        {value != null && (
          <span className="font-mono text-[11px] text-muted-foreground tabular-nums">{value}</span>
        )}
      </div>
      {children}
    </div>
  );
}

export interface SegmentOption<T extends string> {
  value: T;
  label: string;
  icon?: React.ElementType;
  title?: string;
  /** Show only the icon; the label stays as the tooltip and screen-reader name. */
  iconOnly?: boolean;
}

/**
 * A compact segmented control.
 *
 * Deliberately not `ToggleGroup`: these sit inside dense inspector rows where a
 * toggle group's 32px targets and borders dominate the panel, and unlike a
 * toggle group one option is always chosen (there is no "nothing pressed").
 */
export function Segmented<T extends string>({
  options,
  value,
  onChange,
  className,
}: {
  options: SegmentOption<T>[];
  value: T;
  onChange: (value: T) => void;
  className?: string;
}) {
  return (
    <div className={cn("flex items-center gap-1 rounded-lg bg-muted p-1", className)}>
      {options.map((option) => {
        const Icon = option.icon;
        const active = option.value === value;
        return (
          <button
            key={option.value}
            type="button"
            title={option.title ?? option.label}
            aria-label={option.label}
            aria-pressed={active}
            onClick={() => onChange(option.value)}
            className={cn(
              "flex flex-1 items-center justify-center gap-1.5 rounded-md px-2 py-1 text-xs font-medium transition-colors",
              active
                ? "bg-background text-foreground shadow-sm"
                : "text-muted-foreground hover:text-foreground"
            )}
          >
            {Icon && <Icon className="h-3.5 w-3.5 shrink-0" />}
            {!option.iconOnly && <span className="truncate">{option.label}</span>}
          </button>
        );
      })}
    </div>
  );
}

const SWATCHES = [
  "#ffffff",
  "#000000",
  "#ef4444",
  "#f59e0b",
  "#22c55e",
  "#3b82f6",
  "#a855f7",
  "#ec4899",
];

export function ColorField({
  value,
  onChange,
  allowNone = false,
  label,
}: {
  value: string | null;
  onChange: (value: string | null) => void;
  allowNone?: boolean;
  label: string;
}) {
  return (
    <div className="space-y-2">
      <span className="text-xs font-medium text-foreground/80">{label}</span>
      <div className="flex flex-wrap items-center gap-1.5">
        {allowNone && (
          <button
            type="button"
            title="No fill"
            aria-label="No fill"
            onClick={() => onChange(null)}
            className={cn(
              "relative h-6 w-6 overflow-hidden rounded-md border transition-all",
              value == null ? "border-primary ring-2 ring-primary/30" : "border-border"
            )}
          >
            <span className="absolute inset-0 bg-background" />
            <span className="absolute top-1/2 left-1/2 h-px w-8 -translate-x-1/2 -translate-y-1/2 rotate-45 bg-destructive" />
          </button>
        )}
        {SWATCHES.map((swatch) => (
          <button
            key={swatch}
            type="button"
            title={swatch}
            aria-label={swatch}
            onClick={() => onChange(swatch)}
            style={{ backgroundColor: swatch }}
            className={cn(
              "h-6 w-6 rounded-md border transition-all",
              value?.toLowerCase() === swatch
                ? "border-primary ring-2 ring-primary/30"
                : "border-border hover:scale-110"
            )}
          />
        ))}
        <label
          className="flex h-6 cursor-pointer items-center gap-1 rounded-md border border-border px-1.5 text-[10px] font-medium text-muted-foreground transition-colors hover:text-foreground"
          title="Custom colour"
        >
          <span
            className="h-3 w-3 rounded-sm border border-border"
            style={{ backgroundColor: value ?? "transparent" }}
          />
          Custom
          <input
            type="color"
            className="sr-only"
            value={value ?? "#ffffff"}
            onChange={(event) => onChange(event.target.value)}
          />
        </label>
      </div>
    </div>
  );
}
