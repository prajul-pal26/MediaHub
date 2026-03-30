"use client";

import { useBrand } from "@/lib/hooks/use-brand";
import { CalendarView } from "@/components/calendar/CalendarView";
import { CalendarDays } from "lucide-react";

export default function CalendarPage() {
  const { activeBrandId, loading } = useBrand();

  if (loading) {
    return (
      <div className="flex items-center justify-center h-64">
        <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-primary" />
      </div>
    );
  }

  if (!activeBrandId) {
    return (
      <div className="space-y-6">
        <h1 className="text-2xl font-bold">Content Calendar</h1>
        <div className="flex items-center justify-center h-64 border-2 border-dashed rounded-lg">
          <div className="text-center text-muted-foreground">
            <CalendarDays className="h-12 w-12 mx-auto mb-3 opacity-50" />
            <p className="font-medium">No brand selected</p>
            <p className="text-sm">Create a brand to see scheduled content</p>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-bold">Content Calendar</h1>
        <p className="text-muted-foreground">View and manage scheduled content</p>
      </div>
      <CalendarView brandId={activeBrandId} />
    </div>
  );
}
