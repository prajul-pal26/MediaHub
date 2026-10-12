"use client";

import { useState } from "react";
import { useBrand } from "@/lib/hooks/use-brand";
import { trpc } from "@/lib/trpc/client";
import { toast } from "sonner";
import { ListTodo } from "lucide-react";
import { QueueMediaCard, type QueueMediaGroup } from "@/components/queue/QueueMediaCard";

export default function QueuePage() {
  const { activeBrandId, loading } = useBrand();
  const utils = trpc.useUtils();
  const [retrying, setRetrying] = useState<{ groupId: string; category: "post" | "reel" } | null>(null);

  const { data: groupData } = trpc.jobs.listGroups.useQuery(
    { brandId: activeBrandId! },
    { enabled: !!activeBrandId, refetchInterval: 5000 }
  );

  const retryMutation = trpc.jobs.retryGroupFailed.useMutation({
    onSuccess: (res) => {
      toast.success(`${res.retried} failed job${res.retried === 1 ? "" : "s"} re-queued`);
      utils.jobs.listGroups.invalidate();
    },
    onError: (e) => toast.error(e.message),
    onSettled: () => setRetrying(null),
  });

  function handleRetry(groupId: string, category: "post" | "reel") {
    setRetrying({ groupId, category });
    retryMutation.mutate({ groupId, category });
  }

  if (loading) {
    return (
      <div className="flex items-center justify-center h-64">
        <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-primary" />
      </div>
    );
  }

  const groups = (groupData?.groups ?? []) as QueueMediaGroup[];

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-bold">Publishing Queue</h1>
        <p className="text-muted-foreground">Publishing stats per media, split by Post and Reel</p>
      </div>

      {groups.length === 0 ? (
        <div className="flex items-center justify-center h-40 border-2 border-dashed rounded-lg">
          <div className="text-center text-muted-foreground">
            <ListTodo className="h-10 w-10 mx-auto mb-2 opacity-50" />
            <p className="font-medium">No jobs</p>
            <p className="text-sm">Publish content to see per-media stats here</p>
          </div>
        </div>
      ) : (
        <div className="space-y-2">
          {groups.map((group) => (
            <QueueMediaCard
              key={group.id}
              group={group}
              onRetry={handleRetry}
              retryingCategory={retrying}
            />
          ))}
        </div>
      )}
    </div>
  );
}
