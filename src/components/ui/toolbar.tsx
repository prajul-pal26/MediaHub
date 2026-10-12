"use client"

import { Toolbar as ToolbarPrimitive } from "@base-ui/react/toolbar"
import { type VariantProps } from "class-variance-authority"

import { buttonVariants } from "@/components/ui/button"
import { cn } from "@/lib/utils"

function Toolbar({
  className,
  orientation = "horizontal",
  ...props
}: ToolbarPrimitive.Root.Props) {
  return (
    <ToolbarPrimitive.Root
      data-slot="toolbar"
      orientation={orientation}
      className={cn(
        // Base UI emits `data-orientation="vertical"`, not a bare `data-vertical`.
        "group/toolbar flex items-center gap-1 rounded-lg border border-border bg-background p-1 data-[orientation=vertical]:flex-col data-[orientation=vertical]:items-stretch dark:bg-input/30",
        className
      )}
      {...props}
    />
  )
}

function ToolbarGroup({ className, ...props }: ToolbarPrimitive.Group.Props) {
  return (
    <ToolbarPrimitive.Group
      data-slot="toolbar-group"
      className={cn(
        "flex items-center gap-1 group-data-[orientation=vertical]/toolbar:flex-col group-data-[orientation=vertical]/toolbar:items-stretch data-disabled:opacity-50",
        className
      )}
      {...props}
    />
  )
}

function ToolbarButton({
  className,
  variant = "ghost",
  size = "icon-sm",
  ...props
}: ToolbarPrimitive.Button.Props & VariantProps<typeof buttonVariants>) {
  return (
    <ToolbarPrimitive.Button
      data-slot="toolbar-button"
      className={cn(buttonVariants({ variant, size, className }))}
      {...props}
    />
  )
}

function ToolbarLink({
  className,
  variant = "link",
  size = "sm",
  ...props
}: ToolbarPrimitive.Link.Props & VariantProps<typeof buttonVariants>) {
  return (
    <ToolbarPrimitive.Link
      data-slot="toolbar-link"
      className={cn(buttonVariants({ variant, size, className }))}
      {...props}
    />
  )
}

function ToolbarInput({ className, ...props }: ToolbarPrimitive.Input.Props) {
  return (
    <ToolbarPrimitive.Input
      data-slot="toolbar-input"
      className={cn(
        "flex h-7 w-full min-w-0 rounded-[min(var(--radius-md),12px)] border border-input bg-transparent px-2.5 py-1 text-[0.8rem] transition-colors outline-none file:border-0 file:bg-transparent placeholder:text-muted-foreground focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50 disabled:cursor-not-allowed disabled:opacity-50 aria-invalid:border-destructive aria-invalid:ring-3 aria-invalid:ring-destructive/20 dark:bg-input/30 dark:aria-invalid:border-destructive/50 dark:aria-invalid:ring-destructive/40",
        className
      )}
      {...props}
    />
  )
}

function ToolbarSeparator({
  className,
  ...props
}: ToolbarPrimitive.Separator.Props) {
  return (
    <ToolbarPrimitive.Separator
      data-slot="toolbar-separator"
      className={cn(
        // Base UI inverts the orientation for us: a horizontal toolbar gets a
        // `data-orientation="vertical"` separator (a vertical rule), and vice versa.
        "shrink-0 bg-border data-[orientation=vertical]:mx-0.5 data-[orientation=vertical]:h-5 data-[orientation=vertical]:w-px data-[orientation=horizontal]:my-0.5 data-[orientation=horizontal]:h-px data-[orientation=horizontal]:w-full",
        className
      )}
      {...props}
    />
  )
}

export {
  Toolbar,
  ToolbarGroup,
  ToolbarButton,
  ToolbarLink,
  ToolbarInput,
  ToolbarSeparator,
}
