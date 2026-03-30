"use client";

import { useState } from "react";
import { Card, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { StatusBadge } from "@/components/common/StatusBadge";
import { useBrand } from "@/lib/hooks/use-brand";
import { trpc } from "@/lib/trpc/client";
import { toast } from "sonner";
import { ListTodo, RefreshCw, XCircle } from "lucide-react";
import { cn } from "@/lib/utils";

const statusFilters = ["all", "queued", "processing", "completed", "failed", "dead"] as const;

export default function QueuePage() {
  const { activeBrandId, loading } = useBrand();
  const [statusFilter, setStatusFilter] = useState<string>("all");

  const { data: stats } = trpc.jobs.getStats.useQuery(
    { brandId: activeBrandId! },
    { enabled: !!activeBrandId }
  );

  const { data: jobsData, refetch } = trpc.jobs.list.useQuery(
    {
      brandId: activeBrandId!,
      status: statusFilter === "all" ? undefined : statusFilter,
    },
    { enabled: !!activeBrandId, refetchInterval: 5000 }
  );

  const retryMutation = trpc.jobs.retry.useMutation({
    onSuccess: () => { toast.success("Job re-queued"); refetch(); },
    onError: (e) => toast.error(e.message),
  });

  const cancelMutation = trpc.jobs.cancel.useMutation({
    onSuccess: () => { toast.success("Job cancelled"); refetch(); },
    onError: (e) => toast.error(e.message),
  });

  if (loading) {
    return (
      <div className="flex items-center justify-center h-64">
        <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-primary" />
      </div>
    );
  }

  const jobs = jobsData?.jobs || [];

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-bold">Publishing Queue</h1>
        <p className="text-muted-foreground">Monitor publishing jobs</p>
      </div>

      {/* Metric cards */}
      <div className="grid grid-cols-2 md:grid-cols-5 gap-4">
        <MetricCard label="Queued" value={stats?.queued ?? 0} color="text-yellow-600" />
        <MetricCard label="Processing" value={stats?.processing ?? 0} color="text-blue-600" />
        <MetricCard label="Completed" value={stats?.completed ?? 0} color="text-green-600" />
        <MetricCard label="Failed" value={stats?.failed ?? 0} color="text-red-600" />
        <MetricCard label="Dead" value={stats?.dead ?? 0} color="text-gray-500" />
      </div>

      {/* Status filter */}
      <div className="flex items-center bg-muted rounded-lg p-1 w-fit">
        {statusFilters.map((s) => (
          <button
            key={s}
            onClick={() => setStatusFilter(s)}
            className={cn(
              "px-3 py-1.5 text-xs font-medium rounded-md capitalize transition-colors",
              statusFilter === s
                ? "bg-background text-foreground shadow-sm"
                : "text-muted-foreground hover:text-foreground"
            )}
          >
            {s}
          </button>
        ))}
      </div>

      {/* Job list */}
      {jobs.length === 0 ? (
        <div className="flex items-center justify-center h-48 border-2 border-dashed rounded-lg">
          <div className="text-center text-muted-foreground">
            <ListTodo className="h-12 w-12 mx-auto mb-3 opacity-50" />
            <p className="font-medium">No jobs</p>
            <p className="text-sm">Publish content to see jobs here</p>
          </div>
        </div>
      ) : (
        <div className="space-y-2">
          {jobs.map((job: any) => (
            <div
              key={job.id}
              className="flex items-center justify-between p-3 border rounded-lg"
            >
              <div className="flex items-center gap-3 min-w-0">
                <StatusBadge status={job.status} />
                <div className="min-w-0">
                  <p className="text-sm font-medium truncate">
                    {job.media_assets?.file_name || "File"} → @{job.social_accounts?.platform_username || "account"}
                  </p>
                  <p className="text-xs text-muted-foreground">
                    {job.action} &middot; {job.content_posts?.media_groups?.title || ""}
                    {job.error_message && (
                      <span className="text-red-500 ml-2">{job.error_message}</span>
                    )}
                  </p>
                </div>
              </div>
              <div className="flex items-center gap-2 shrink-0">
                {job.attempt_count > 0 && (
                  <span className="text-xs text-muted-foreground">
                    {job.attempt_count}/3 attempts
                  </span>
                )}
                {(job.status === "failed" || job.status === "dead") && (
                  <Button
                    size="sm"
                    variant="outline"
                    onClick={() => retryMutation.mutate({ jobId: job.id })}
                    disabled={retryMutation.isPending}
                  >
                    <RefreshCw className="h-3 w-3 mr-1" />
                    Retry
                  </Button>
                )}
                {job.status === "queued" && (
                  <Button
                    size="sm"
                    variant="ghost"
                    onClick={() => cancelMutation.mutate({ jobId: job.id })}
                    disabled={cancelMutation.isPending}
                  >
                    <XCircle className="h-3 w-3 mr-1" />
                    Cancel
                  </Button>
                )}
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

function MetricCard({ label, value, color }: { label: string; value: number; color: string }) {
  return (
    <Card>
      <CardContent className="pt-5">
        <p className={`text-2xl font-bold ${color}`}>{value}</p>
        <p className="text-sm text-muted-foreground">{label}</p>
      </CardContent>
    </Card>
  );
}
