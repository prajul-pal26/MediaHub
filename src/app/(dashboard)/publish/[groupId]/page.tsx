"use client";

import { use } from "react";
import { trpc } from "@/lib/trpc/client";
import { PublishPanel } from "@/components/publish/PublishPanel";
import { AlertCircle } from "lucide-react";

export default function PublishPage({
  params,
}: {
  params: Promise<{ groupId: string }>;
}) {
  const { groupId } = use(params);

  const { data, isLoading, error } = trpc.publish.getPublishData.useQuery(
    { groupId },
    { retry: false }
  );

  if (isLoading) {
    return (
      <div className="flex items-center justify-center h-64">
        <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-primary" />
      </div>
    );
  }

  if (error || !data) {
    return (
      <div className="flex items-center justify-center h-64">
        <div className="text-center text-muted-foreground">
          <AlertCircle className="h-12 w-12 mx-auto mb-3 opacity-50" />
          <p className="font-medium">Media group not found</p>
          <p className="text-sm">{error?.message || "The group may have been deleted"}</p>
        </div>
      </div>
    );
  }

  return (
    <PublishPanel
      group={data.group}
      accounts={data.accounts}
      previousJobs={data.previousJobs || []}
    />
  );
}
