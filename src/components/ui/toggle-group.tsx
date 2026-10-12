"use client"

import { Toggle as TogglePrimitive } from "@base-ui/react/toggle"
import { ToggleGroup as ToggleGroupPrimitive } from "@base-ui/react/toggle-group"
import { cva, type VariantProps } from "class-variance-authority"

import { cn } from "@/lib/utils"

const toggleGroupVariants = cva(
  // Base UI emits `data-orientation="vertical"`, not a bare `data-vertical`.
  "group/toggle-group flex w-fit items-center data-[orientation=vertical]:flex-col data-disabled:opacity-50",
  {
    variants: {
      variant: {
        default: "gap-1",
        // A seamless segmented control: one shared border, no gaps.
        segmented:
          "gap-0 rounded-lg border border-input bg-background p-[3px] dark:bg-input/30",
      },
    },
    defaultVariants: {
      variant: "default",
    },
  }
)

/**
 * Single-select toggle group.
 *
 * Base UI models the group as a multi-select and so hands `onValueChange` an
 * ARRAY even when `multiple` is false. This wrapper collapses that to one
 * string: `""` means nothing is pressed (the user toggled the active item off).
 */
function ToggleGroup({
  className,
  variant = "default",
  value,
  onValueChange,
  ...props
}: Omit<ToggleGroupPrimitive.Props<string>, "value" | "onValueChange" | "multiple"> &
  VariantProps<typeof toggleGroupVariants> & {
    value: string
    onValueChange: (value: string) => void
  }) {
  return (
    <ToggleGroupPrimitive
      data-slot="toggle-group"
      data-variant={variant}
      value={value ? [value] : []}
      onValueChange={(next) => onValueChange(next[0] ?? "")}
      className={cn(toggleGroupVariants({ variant }), className)}
      {...props}
    />
  )
}

function ToggleGroupItem({
  className,
  ...props
}: TogglePrimitive.Props<string>) {
  return (
    <TogglePrimitive
      data-slot="toggle-group-item"
      className={cn(
        "inline-flex h-8 min-w-8 shrink-0 items-center justify-center gap-1.5 rounded-lg border border-transparent bg-transparent px-2.5 text-sm font-medium whitespace-nowrap text-foreground/60 transition-all outline-none select-none hover:bg-muted hover:text-foreground focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50 disabled:pointer-events-none disabled:opacity-50 dark:text-muted-foreground dark:hover:bg-muted/50 dark:hover:text-foreground",
        "data-pressed:bg-muted data-pressed:text-foreground dark:data-pressed:bg-input/50 dark:data-pressed:text-foreground",
        "group-data-[variant=segmented]/toggle-group:h-[calc(100%-1px)] group-data-[variant=segmented]/toggle-group:rounded-[min(var(--radius-md),10px)] group-data-[variant=segmented]/toggle-group:data-pressed:bg-background group-data-[variant=segmented]/toggle-group:data-pressed:shadow-sm dark:group-data-[variant=segmented]/toggle-group:data-pressed:bg-input/50",
        "[&_svg]:pointer-events-none [&_svg]:shrink-0 [&_svg:not([class*='size-'])]:size-4",
        className
      )}
      {...props}
    />
  )
}

export { ToggleGroup, ToggleGroupItem, toggleGroupVariants }
