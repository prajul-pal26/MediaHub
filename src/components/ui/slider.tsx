"use client"

import { Slider as SliderPrimitive } from "@base-ui/react/slider"

import { cn } from "@/lib/utils"

/**
 * A scalar slider. Base UI's `onValueChange` is
 * `(value, eventDetails) => void` and hands back a plain `number` when the
 * root is typed as a scalar, so the wrapper narrows it to `(n: number) => void`
 * and callers never see the event details.
 */
function Slider({
  className,
  value,
  onValueChange,
  min = 0,
  max = 100,
  step = 1,
  label,
  formatValue,
  ...props
}: Omit<SliderPrimitive.Root.Props<number>, "value" | "onValueChange"> & {
  value: number
  onValueChange: (value: number) => void
  label?: React.ReactNode
  /** Renders the readout next to the label. Omit to hide the readout. */
  formatValue?: (value: number) => React.ReactNode
}) {
  return (
    <SliderPrimitive.Root<number>
      data-slot="slider"
      value={value}
      onValueChange={(next) => onValueChange(next)}
      min={min}
      max={max}
      step={step}
      className={cn(
        // Base UI emits `data-orientation="vertical"`, not a bare `data-vertical`,
        // so the orientation variants must be spelled out to match.
        "group/slider flex w-full flex-col gap-2 data-[orientation=vertical]:h-full data-[orientation=vertical]:w-fit data-[orientation=vertical]:flex-row data-disabled:opacity-50",
        className
      )}
      {...props}
    >
      {(label != null || formatValue) && (
        <div className="flex items-center justify-between gap-3 group-data-[orientation=vertical]/slider:hidden">
          {label != null ? <SliderLabel>{label}</SliderLabel> : <span />}
          {formatValue && (
            <span
              data-slot="slider-readout"
              className="text-xs tabular-nums text-muted-foreground"
            >
              {formatValue(value)}
            </span>
          )}
        </div>
      )}
      <SliderControl>
        <SliderTrack>
          <SliderIndicator />
          <SliderThumb />
        </SliderTrack>
      </SliderControl>
    </SliderPrimitive.Root>
  )
}

function SliderLabel({ className, ...props }: SliderPrimitive.Label.Props) {
  return (
    <SliderPrimitive.Label
      data-slot="slider-label"
      className={cn("text-sm leading-none font-medium select-none", className)}
      {...props}
    />
  )
}

function SliderValue({ className, ...props }: SliderPrimitive.Value.Props) {
  return (
    <SliderPrimitive.Value
      data-slot="slider-value"
      className={cn("text-xs tabular-nums text-muted-foreground", className)}
      {...props}
    />
  )
}

function SliderControl({ className, ...props }: SliderPrimitive.Control.Props) {
  return (
    <SliderPrimitive.Control
      data-slot="slider-control"
      className={cn(
        "relative flex w-full touch-none items-center select-none data-[orientation=vertical]:h-full data-[orientation=vertical]:w-4 data-[orientation=vertical]:justify-center data-disabled:cursor-not-allowed",
        className
      )}
      {...props}
    />
  )
}

function SliderTrack({ className, ...props }: SliderPrimitive.Track.Props) {
  return (
    <SliderPrimitive.Track
      data-slot="slider-track"
      className={cn(
        "relative grow overflow-hidden rounded-full bg-muted data-[orientation=horizontal]:h-1.5 data-[orientation=horizontal]:w-full data-[orientation=vertical]:h-full data-[orientation=vertical]:w-1.5 dark:bg-input/80",
        className
      )}
      {...props}
    />
  )
}

function SliderIndicator({
  className,
  ...props
}: SliderPrimitive.Indicator.Props) {
  return (
    <SliderPrimitive.Indicator
      data-slot="slider-indicator"
      className={cn("absolute rounded-full bg-primary", className)}
      {...props}
    />
  )
}

function SliderThumb({ className, ...props }: SliderPrimitive.Thumb.Props) {
  return (
    <SliderPrimitive.Thumb
      data-slot="slider-thumb"
      className={cn(
        "size-4 shrink-0 rounded-full border border-primary bg-background shadow-sm transition-[color,box-shadow] outline-none hover:ring-4 hover:ring-ring/50 focus-visible:ring-4 focus-visible:ring-ring/50 data-dragging:ring-4 data-dragging:ring-ring/50 data-disabled:pointer-events-none",
        className
      )}
      {...props}
    />
  )
}

export {
  Slider,
  SliderLabel,
  SliderValue,
  SliderControl,
  SliderTrack,
  SliderIndicator,
  SliderThumb,
}
