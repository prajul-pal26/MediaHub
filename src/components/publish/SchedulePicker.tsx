"use client";

import { useState, useMemo } from "react";
import { Button } from "@/components/ui/button";
import { ChevronLeft, ChevronRight, ChevronUp, ChevronDown } from "lucide-react";
import { cn } from "@/lib/utils";

interface SchedulePickerProps {
  open: boolean;
  onClose: () => void;
  onSchedule: (date: Date) => void;
  onPublishNow: () => void;
}

const DAYS = ["Mo", "Tu", "We", "Th", "Fr", "Sa", "Su"];
const MONTHS = [
  "January", "February", "March", "April", "May", "June",
  "July", "August", "September", "October", "November", "December",
];

export function SchedulePicker({ open, onClose, onSchedule, onPublishNow }: SchedulePickerProps) {
  const now = new Date();
  const [viewMonth, setViewMonth] = useState(now.getMonth());
  const [viewYear, setViewYear] = useState(now.getFullYear());
  const [selectedDay, setSelectedDay] = useState<number | null>(null);
  const [hour, setHour] = useState(6);
  const [minute, setMinute] = useState(0);
  const [isPM, setIsPM] = useState(true);

  const daysInMonth = useMemo(() => {
    return new Date(viewYear, viewMonth + 1, 0).getDate();
  }, [viewYear, viewMonth]);

  const firstDayOfWeek = useMemo(() => {
    const d = new Date(viewYear, viewMonth, 1).getDay();
    return d === 0 ? 6 : d - 1; // Monday = 0
  }, [viewYear, viewMonth]);

  const selectedDate = useMemo(() => {
    if (!selectedDay) return null;
    let h24 = hour;
    if (isPM && hour !== 12) h24 = hour + 12;
    if (!isPM && hour === 12) h24 = 0;
    return new Date(viewYear, viewMonth, selectedDay, h24, minute);
  }, [selectedDay, hour, minute, isPM, viewYear, viewMonth]);

  const summaryText = useMemo(() => {
    if (!selectedDate) return "Select a date and time";
    return selectedDate.toLocaleDateString("en-US", {
      weekday: "long",
      year: "numeric",
      month: "long",
      day: "numeric",
    }) + ` at ${hour}:${minute.toString().padStart(2, "0")} ${isPM ? "PM" : "AM"}`;
  }, [selectedDate, hour, minute, isPM]);

  function prevMonth() {
    if (viewMonth === 0) { setViewMonth(11); setViewYear(viewYear - 1); }
    else setViewMonth(viewMonth - 1);
  }

  function nextMonth() {
    if (viewMonth === 11) { setViewMonth(0); setViewYear(viewYear + 1); }
    else setViewMonth(viewMonth + 1);
  }

  function isPast(day: number): boolean {
    const d = new Date(viewYear, viewMonth, day, 23, 59);
    return d < new Date(now.getFullYear(), now.getMonth(), now.getDate());
  }

  if (!open) return null;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center">
      {/* Overlay */}
      <div
        className="absolute inset-0 bg-black/55"
        onClick={onClose}
      />

      {/* Modal */}
      <div className="relative bg-background rounded-2xl shadow-xl w-full max-w-[380px] p-6 space-y-5">
        {/* Calendar */}
        <div>
          <div className="flex items-center justify-between mb-3">
            <button onClick={prevMonth} className="p-1 hover:bg-muted rounded">
              <ChevronLeft className="h-4 w-4" />
            </button>
            <span className="text-sm font-medium">
              {MONTHS[viewMonth]} {viewYear}
            </span>
            <button onClick={nextMonth} className="p-1 hover:bg-muted rounded">
              <ChevronRight className="h-4 w-4" />
            </button>
          </div>

          {/* Day headers */}
          <div className="grid grid-cols-7 gap-1 mb-1">
            {DAYS.map((d) => (
              <div key={d} className="text-center text-[10px] font-medium text-muted-foreground py-1">
                {d}
              </div>
            ))}
          </div>

          {/* Day grid */}
          <div className="grid grid-cols-7 gap-1">
            {Array.from({ length: firstDayOfWeek }).map((_, i) => (
              <div key={`empty-${i}`} />
            ))}
            {Array.from({ length: daysInMonth }).map((_, i) => {
              const day = i + 1;
              const past = isPast(day);
              const isToday =
                day === now.getDate() &&
                viewMonth === now.getMonth() &&
                viewYear === now.getFullYear();
              const isSelected = selectedDay === day;

              return (
                <button
                  key={day}
                  disabled={past}
                  onClick={() => setSelectedDay(day)}
                  className={cn(
                    "h-8 w-8 rounded-full text-xs font-medium flex items-center justify-center mx-auto transition-colors",
                    past && "text-muted-foreground/30 cursor-not-allowed",
                    isToday && !isSelected && "ring-1 ring-primary text-primary",
                    isSelected && "bg-primary text-primary-foreground",
                    !past && !isSelected && "hover:bg-muted"
                  )}
                >
                  {day}
                </button>
              );
            })}
          </div>
        </div>

        {/* Time picker */}
        <div className="flex items-center justify-center gap-4">
          {/* Hour */}
          <div className="flex flex-col items-center gap-1">
            <button onClick={() => setHour(hour >= 12 ? 1 : hour + 1)} className="p-0.5 hover:bg-muted rounded">
              <ChevronUp className="h-4 w-4" />
            </button>
            <span className="text-2xl font-bold w-10 text-center">{hour.toString().padStart(2, "0")}</span>
            <button onClick={() => setHour(hour <= 1 ? 12 : hour - 1)} className="p-0.5 hover:bg-muted rounded">
              <ChevronDown className="h-4 w-4" />
            </button>
          </div>

          <span className="text-2xl font-bold">:</span>

          {/* Minute */}
          <div className="flex flex-col items-center gap-1">
            <button onClick={() => setMinute(minute >= 55 ? 0 : minute + 5)} className="p-0.5 hover:bg-muted rounded">
              <ChevronUp className="h-4 w-4" />
            </button>
            <span className="text-2xl font-bold w-10 text-center">{minute.toString().padStart(2, "0")}</span>
            <button onClick={() => setMinute(minute <= 0 ? 55 : minute - 5)} className="p-0.5 hover:bg-muted rounded">
              <ChevronDown className="h-4 w-4" />
            </button>
          </div>

          {/* AM/PM */}
          <div className="flex flex-col gap-1">
            <button
              onClick={() => setIsPM(false)}
              className={cn(
                "px-3 py-1 text-xs font-medium rounded transition-colors",
                !isPM ? "bg-primary text-primary-foreground" : "bg-muted text-muted-foreground hover:bg-muted/80"
              )}
            >
              AM
            </button>
            <button
              onClick={() => setIsPM(true)}
              className={cn(
                "px-3 py-1 text-xs font-medium rounded transition-colors",
                isPM ? "bg-primary text-primary-foreground" : "bg-muted text-muted-foreground hover:bg-muted/80"
              )}
            >
              PM
            </button>
          </div>
        </div>

        {/* Summary */}
        <p className="text-sm text-center text-muted-foreground">{summaryText}</p>

        {/* Buttons */}
        <div className="flex gap-2">
          <Button variant="ghost" onClick={onClose} className="flex-1">
            Cancel
          </Button>
          <Button
            onClick={() => selectedDate && onSchedule(selectedDate)}
            disabled={!selectedDate}
            className="flex-1"
          >
            Schedule
          </Button>
        </div>

        <button
          onClick={onPublishNow}
          className="w-full text-center text-xs text-muted-foreground hover:text-foreground transition-colors"
        >
          or publish now
        </button>
      </div>
    </div>
  );
}
