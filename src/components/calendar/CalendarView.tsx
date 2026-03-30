"use client";

import { useState, useMemo } from "react";
import { useRouter } from "next/navigation";
import { Button } from "@/components/ui/button";
import { trpc } from "@/lib/trpc/client";
import { PostCard } from "./PostCard";
import { ChevronLeft, ChevronRight } from "lucide-react";
import { cn } from "@/lib/utils";

const DAYS = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];
const MONTHS = [
  "January", "February", "March", "April", "May", "June",
  "July", "August", "September", "October", "November", "December",
];

interface CalendarViewProps {
  brandId: string;
}

type ViewMode = "month" | "week" | "day";

export function CalendarView({ brandId }: CalendarViewProps) {
  const router = useRouter();
  const [viewMode, setViewMode] = useState<ViewMode>("month");
  const [currentDate, setCurrentDate] = useState(new Date());
  const year = currentDate.getFullYear();
  const month = currentDate.getMonth();

  // Date range for current view
  const { startDate, endDate } = useMemo(() => {
    if (viewMode === "month") {
      const start = new Date(year, month, 1);
      const end = new Date(year, month + 1, 0, 23, 59);
      return { startDate: start.toISOString(), endDate: end.toISOString() };
    }
    if (viewMode === "week") {
      const dayOfWeek = currentDate.getDay();
      const monday = new Date(currentDate);
      monday.setDate(currentDate.getDate() - (dayOfWeek === 0 ? 6 : dayOfWeek - 1));
      monday.setHours(0, 0, 0, 0);
      const sunday = new Date(monday);
      sunday.setDate(monday.getDate() + 6);
      sunday.setHours(23, 59, 59);
      return { startDate: monday.toISOString(), endDate: sunday.toISOString() };
    }
    // day
    const start = new Date(currentDate);
    start.setHours(0, 0, 0, 0);
    const end = new Date(currentDate);
    end.setHours(23, 59, 59);
    return { startDate: start.toISOString(), endDate: end.toISOString() };
  }, [viewMode, currentDate, year, month]);

  const { data: posts = [] } = trpc.publish.listScheduled.useQuery(
    { brandId, startDate, endDate },
    { enabled: !!brandId }
  );

  // Group posts by date string
  const postsByDate = useMemo(() => {
    const map: Record<string, any[]> = {};
    for (const post of posts) {
      if (!post.scheduled_at) continue;
      const dateKey = new Date(post.scheduled_at).toISOString().split("T")[0];
      if (!map[dateKey]) map[dateKey] = [];
      map[dateKey].push(post);
    }
    return map;
  }, [posts]);

  function navigate(direction: -1 | 1) {
    const d = new Date(currentDate);
    if (viewMode === "month") d.setMonth(d.getMonth() + direction);
    else if (viewMode === "week") d.setDate(d.getDate() + 7 * direction);
    else d.setDate(d.getDate() + direction);
    setCurrentDate(d);
  }

  // Month grid
  const daysInMonth = new Date(year, month + 1, 0).getDate();
  const firstDayOfWeek = (() => {
    const d = new Date(year, month, 1).getDay();
    return d === 0 ? 6 : d - 1;
  })();

  const today = new Date();
  const todayStr = `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, "0")}-${String(today.getDate()).padStart(2, "0")}`;

  return (
    <div className="space-y-4">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2">
          <Button variant="ghost" size="sm" onClick={() => navigate(-1)}>
            <ChevronLeft className="h-4 w-4" />
          </Button>
          <h2 className="text-lg font-semibold min-w-[200px] text-center">
            {viewMode === "day"
              ? currentDate.toLocaleDateString("en-US", { weekday: "long", month: "long", day: "numeric", year: "numeric" })
              : `${MONTHS[month]} ${year}`}
          </h2>
          <Button variant="ghost" size="sm" onClick={() => navigate(1)}>
            <ChevronRight className="h-4 w-4" />
          </Button>
        </div>

        <div className="flex items-center bg-muted rounded-lg p-1">
          {(["month", "week", "day"] as const).map((mode) => (
            <button
              key={mode}
              onClick={() => setViewMode(mode)}
              className={cn(
                "px-3 py-1.5 text-xs font-medium rounded-md transition-colors capitalize",
                viewMode === mode
                  ? "bg-background text-foreground shadow-sm"
                  : "text-muted-foreground hover:text-foreground"
              )}
            >
              {mode}
            </button>
          ))}
        </div>
      </div>

      {/* Month View */}
      {viewMode === "month" && (
        <div className="border rounded-lg overflow-hidden">
          {/* Day headers */}
          <div className="grid grid-cols-7 bg-muted">
            {DAYS.map((d) => (
              <div key={d} className="text-center text-xs font-medium text-muted-foreground py-2 border-r last:border-r-0">
                {d}
              </div>
            ))}
          </div>

          {/* Day cells */}
          <div className="grid grid-cols-7">
            {/* Empty cells before first day */}
            {Array.from({ length: firstDayOfWeek }).map((_, i) => (
              <div key={`empty-${i}`} className="min-h-[100px] border-r border-b bg-muted/30" />
            ))}

            {/* Actual days */}
            {Array.from({ length: daysInMonth }).map((_, i) => {
              const day = i + 1;
              const dateStr = `${year}-${String(month + 1).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
              const dayPosts = postsByDate[dateStr] || [];
              const isToday = dateStr === todayStr;

              return (
                <div
                  key={day}
                  className={cn(
                    "min-h-[100px] border-r border-b p-1",
                    isToday && "bg-primary/5"
                  )}
                >
                  <div className={cn(
                    "text-xs font-medium mb-1",
                    isToday ? "text-primary font-bold" : "text-muted-foreground"
                  )}>
                    {day}
                  </div>
                  <div className="space-y-0.5">
                    {dayPosts.slice(0, 3).map((post: any) => {
                      const job = post.publish_jobs?.[0];
                      const platform = job?.social_accounts?.platform;
                      const time = post.scheduled_at
                        ? new Date(post.scheduled_at).toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit" })
                        : "";

                      return (
                        <PostCard
                          key={post.id}
                          title={post.media_groups?.title || "Untitled"}
                          platform={platform}
                          status={post.status}
                          time={time}
                          jobCount={post.publish_jobs?.length || 0}
                          onClick={() => router.push(`/publish/${post.group_id}`)}
                        />
                      );
                    })}
                    {dayPosts.length > 3 && (
                      <p className="text-[10px] text-muted-foreground text-center">
                        +{dayPosts.length - 3} more
                      </p>
                    )}
                  </div>
                </div>
              );
            })}
          </div>
        </div>
      )}

      {/* Week / Day view — simplified list for now */}
      {(viewMode === "week" || viewMode === "day") && (
        <div className="border rounded-lg p-4 space-y-2">
          {posts.length === 0 ? (
            <p className="text-sm text-muted-foreground text-center py-8">
              No posts scheduled for this {viewMode}
            </p>
          ) : (
            posts.map((post: any) => {
              const job = post.publish_jobs?.[0];
              return (
                <div
                  key={post.id}
                  className="flex items-center justify-between p-3 border rounded-lg hover:bg-muted cursor-pointer"
                  onClick={() => router.push(`/publish/${post.group_id}`)}
                >
                  <div>
                    <p className="text-sm font-medium">{post.media_groups?.title || "Untitled"}</p>
                    <p className="text-xs text-muted-foreground">
                      {post.scheduled_at && new Date(post.scheduled_at).toLocaleString()} &middot; {post.status}
                    </p>
                  </div>
                  <div className="text-xs text-muted-foreground">
                    {job?.action}
                  </div>
                </div>
              );
            })
          )}
        </div>
      )}
    </div>
  );
}
