"use client";

import { useState } from "react";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { Calendar as CalendarIcon, ChevronLeft, ChevronRight } from "lucide-react";
import { cn } from "@/lib/utils";

export interface DateRange {
  start: Date;
  end: Date;
}

const WEEKDAYS = ["S", "M", "T", "W", "T", "F", "S"];
const MONTHS = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];

function startOfDay(d: Date) {
  return new Date(d.getFullYear(), d.getMonth(), d.getDate());
}
function sameDay(a: Date, b: Date) {
  return a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth() && a.getDate() === b.getDate();
}
function addDays(d: Date, n: number) {
  const r = new Date(d);
  r.setDate(r.getDate() + n);
  return r;
}
function fmt(d: Date) {
  return d.toLocaleDateString(undefined, { month: "short", day: "numeric", year: "numeric" });
}

const PRESETS: { label: string; range: () => DateRange }[] = [
  { label: "Last 7 days", range: () => ({ start: startOfDay(addDays(new Date(), -6)), end: startOfDay(new Date()) }) },
  { label: "Last 30 days", range: () => ({ start: startOfDay(addDays(new Date(), -29)), end: startOfDay(new Date()) }) },
  { label: "Last 90 days", range: () => ({ start: startOfDay(addDays(new Date(), -89)), end: startOfDay(new Date()) }) },
  {
    label: "This month",
    range: () => {
      const now = new Date();
      return { start: new Date(now.getFullYear(), now.getMonth(), 1), end: startOfDay(now) };
    },
  },
];

export function DateRangePicker({
  value,
  onChange,
}: {
  value: DateRange;
  onChange: (range: DateRange) => void;
}) {
  const [open, setOpen] = useState(false);
  const [viewMonth, setViewMonth] = useState(() => new Date(value.start.getFullYear(), value.start.getMonth(), 1));
  const [draftStart, setDraftStart] = useState<Date | null>(null);
  const [draftEnd, setDraftEnd] = useState<Date | null>(null);

  // What's shown as selected: the in-progress draft, else the committed value.
  const selStart = draftStart ?? value.start;
  const selEnd = draftStart ? draftEnd : value.end;

  function handleDayClick(day: Date) {
    if (!draftStart || (draftStart && draftEnd)) {
      setDraftStart(day);
      setDraftEnd(null);
      return;
    }
    // draftStart set, choosing the end
    if (day < draftStart) {
      setDraftStart(day);
      return;
    }
    const range = { start: draftStart, end: day };
    setDraftStart(null);
    setDraftEnd(null);
    onChange(range);
    setOpen(false);
  }

  function applyPreset(r: DateRange) {
    setDraftStart(null);
    setDraftEnd(null);
    setViewMonth(new Date(r.start.getFullYear(), r.start.getMonth(), 1));
    onChange(r);
    setOpen(false);
  }

  // Build the day grid for viewMonth.
  const firstOfMonth = new Date(viewMonth.getFullYear(), viewMonth.getMonth(), 1);
  const leading = firstOfMonth.getDay();
  const daysInMonth = new Date(viewMonth.getFullYear(), viewMonth.getMonth() + 1, 0).getDate();
  const cells: (Date | null)[] = [];
  for (let i = 0; i < leading; i++) cells.push(null);
  for (let d = 1; d <= daysInMonth; d++) cells.push(new Date(viewMonth.getFullYear(), viewMonth.getMonth(), d));

  const today = startOfDay(new Date());

  function inRange(day: Date) {
    if (!selEnd) return false;
    return day >= startOfDay(selStart) && day <= startOfDay(selEnd);
  }

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger className="inline-flex items-center gap-2 h-9 px-3 rounded-md border border-input bg-background text-sm font-medium shadow-sm hover:bg-accent hover:text-accent-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring">
        <CalendarIcon className="h-3.5 w-3.5" />
        <span className="tabular-nums">
          {fmt(value.start)} – {fmt(value.end)}
        </span>
      </PopoverTrigger>
      <PopoverContent align="end" className="w-auto p-0">
        <div className="flex">
          {/* Presets */}
          <div className="flex flex-col gap-0.5 border-r p-2 w-36">
            {PRESETS.map((p) => (
              <button
                key={p.label}
                onClick={() => applyPreset(p.range())}
                className="text-left text-sm px-2 py-1.5 rounded-md hover:bg-muted transition-colors"
              >
                {p.label}
              </button>
            ))}
          </div>

          {/* Calendar */}
          <div className="p-3">
            <div className="flex items-center justify-between mb-2">
              <button
                onClick={() => setViewMonth(new Date(viewMonth.getFullYear(), viewMonth.getMonth() - 1, 1))}
                className="h-7 w-7 flex items-center justify-center rounded-md hover:bg-muted"
                aria-label="Previous month"
              >
                <ChevronLeft className="h-4 w-4" />
              </button>
              <span className="text-sm font-semibold">
                {MONTHS[viewMonth.getMonth()]} {viewMonth.getFullYear()}
              </span>
              <button
                onClick={() => setViewMonth(new Date(viewMonth.getFullYear(), viewMonth.getMonth() + 1, 1))}
                className="h-7 w-7 flex items-center justify-center rounded-md hover:bg-muted"
                aria-label="Next month"
              >
                <ChevronRight className="h-4 w-4" />
              </button>
            </div>

            <div className="grid grid-cols-7 gap-0.5 mb-1">
              {WEEKDAYS.map((w, i) => (
                <div key={i} className="h-7 w-8 flex items-center justify-center text-[11px] font-medium text-muted-foreground">
                  {w}
                </div>
              ))}
            </div>

            <div className="grid grid-cols-7 gap-0.5">
              {cells.map((day, i) => {
                if (!day) return <div key={i} className="h-8 w-8" />;
                const isStart = sameDay(day, selStart);
                const isEnd = selEnd ? sameDay(day, selEnd) : false;
                const isEndpoint = isStart || isEnd;
                const within = inRange(day);
                const isToday = sameDay(day, today);
                const isFuture = day > today;
                return (
                  <button
                    key={i}
                    disabled={isFuture}
                    onClick={() => handleDayClick(day)}
                    className={cn(
                      "h-8 w-8 text-sm rounded-md flex items-center justify-center transition-colors",
                      isEndpoint && "bg-primary text-primary-foreground font-semibold",
                      !isEndpoint && within && "bg-primary/10 text-foreground rounded-none",
                      !isEndpoint && !within && !isFuture && "hover:bg-muted",
                      isFuture && "text-muted-foreground/30 cursor-not-allowed",
                      isToday && !isEndpoint && "ring-1 ring-inset ring-primary/40"
                    )}
                  >
                    {day.getDate()}
                  </button>
                );
              })}
            </div>

            {draftStart && !draftEnd && (
              <p className="text-[11px] text-muted-foreground mt-2 text-center">
                Select the end date
              </p>
            )}
          </div>
        </div>
      </PopoverContent>
    </Popover>
  );
}
