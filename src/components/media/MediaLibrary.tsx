"use client";

import { useState } from "react";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { MediaGroupCard } from "./MediaGroupCard";
import { EditableMediaGroup, MediaEditorPanel } from "./MediaEditorPanel";
import { UploadForm } from "./UploadForm";
import { trpc } from "@/lib/trpc/client";
import { toast } from "sonner";
import { Image as ImageIcon, Search, Loader2 } from "lucide-react";
import { cn } from "@/lib/utils";

interface MediaLibraryProps {
  brandId: string;
}

type LibraryMediaGroup = EditableMediaGroup & {
  tags?: string[];
  variant_count: number;
  status: string;
  created_at: string;
};

export function MediaLibrary({ brandId }: MediaLibraryProps) {
  const [search, setSearch] = useState("");
  const [page, setPage] = useState(1);
  const [editingGroup, setEditingGroup] = useState<EditableMediaGroup | null>(null);

  const utils = trpc.useUtils();

  // Single pool — videos and images together (no type split).
  const { data: mediaData, isLoading, isFetching } = trpc.media.list.useQuery({
    brandId,
    search: search || undefined,
    type: "all",
    page,
    limit: 20,
  });

  const deleteMutation = trpc.media.deleteGroup.useMutation({
    onSuccess: () => {
      toast.success("Media deleted");
      utils.media.list.invalidate();
    },
    onError: (error) => toast.error(error.message),
  });

  // Per-media publishing breakdown (Post/Reel × queued/processing/completed/failed),
  // the data the old Queue page used — now shown inline on each media card.
  const { data: jobGroupData } = trpc.jobs.listGroups.useQuery(
    { brandId },
    {
      // Poll only while something is actually moving. The interval option is
      // re-read on every render, so it stops on its own once nothing is queued
      // or processing — a library of finished posts then makes no background
      // requests at all, instead of one every five seconds forever.
      refetchInterval: (query: any) => {
        const groups = query?.state?.data?.groups ?? [];
        const busy = groups.some(
          (g: any) =>
            (g.post?.queued ?? 0) + (g.post?.processing ?? 0) +
              (g.reel?.queued ?? 0) + (g.reel?.processing ?? 0) >
            0
        );
        return busy ? 5000 : false;
      },
    }
  );
  const jobStatsMap = new Map(
    (jobGroupData?.groups ?? []).map((g: any) => [
      g.id,
      { post: g.post, reel: g.reel, hasPost: g.hasPost, hasReel: g.hasReel, totalJobs: g.totalJobs },
    ])
  );

  const [retrying, setRetrying] = useState<{ groupId: string; category: "post" | "reel" | "all" } | null>(null);
  const retryJobsMutation = trpc.jobs.retryGroupFailed.useMutation({
    onSuccess: (res: any) => {
      toast.success(`${res.retried} failed job${res.retried === 1 ? "" : "s"} re-queued`);
      utils.jobs.listGroups.invalidate();
    },
    onError: (e) => toast.error(e.message),
    onSettled: () => setRetrying(null),
  });
  function handleRetryJobs(groupId: string, category: "post" | "reel" | "all") {
    setRetrying({ groupId, category });
    retryJobsMutation.mutate({ groupId, category });
  }

  function handleDelete(groupId: string) {
    if (confirm("Delete this media? Files will also be removed from Google Drive. This cannot be undone.")) {
      deleteMutation.mutate({ groupId });
    }
  }

  const groups = mediaData?.groups || [];
  const totalPages = mediaData?.totalPages || 1;

  return (
    <div className="space-y-6">
      {/* Inline uploader — replaces the old metric cards. Drop files here to add media. */}
      <UploadForm
        brandId={brandId}
        embedded
        onUploaded={() => utils.media.list.invalidate()}
      />

      {/* Toolbar */}
      <div className="flex items-center gap-3 flex-wrap">
        <div className="relative flex-1 min-w-[200px] max-w-sm">
          <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
          <Input
            placeholder="Search by title, tags..."
            value={search}
            onChange={(e) => {
              setSearch(e.target.value);
              setPage(1);
            }}
            className="pl-9"
          />
        </div>
      </div>

      {/* Grid */}
      {isLoading ? (
        <div className="flex items-center justify-center h-48">
          <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-primary" />
        </div>
      ) : groups.length === 0 ? (
        <div className="flex items-center justify-center h-64 border-2 border-dashed rounded-lg">
          <div className="text-center text-muted-foreground">
            <ImageIcon className="h-12 w-12 mx-auto mb-3 opacity-50" />
            <p className="font-medium">No media yet</p>
            <p className="text-sm">Drop files above to add your first media</p>
          </div>
        </div>
      ) : (
        <>
          {isFetching && !isLoading && (
            <div className="flex items-center justify-center gap-2 text-sm text-muted-foreground">
              <Loader2 className="h-4 w-4 animate-spin" />
              Updating...
            </div>
          )}
          <div className={cn(
            "grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4 transition-opacity",
            isFetching && !isLoading ? "opacity-60" : "opacity-100"
          )}>
            {groups.map((group: LibraryMediaGroup) => (
              <MediaGroupCard
                key={group.id}
                group={group}
                onDelete={handleDelete}
                onEdit={() => setEditingGroup(group)}
                jobStats={jobStatsMap.get(group.id)}
                onRetryJobs={handleRetryJobs}
                retryingCategory={retrying}
              />
            ))}
          </div>

          {/* Pagination */}
          {totalPages > 1 && (
            <div className="flex items-center justify-center gap-2">
              <Button
                variant="outline"
                size="sm"
                disabled={page <= 1}
                onClick={() => setPage(page - 1)}
              >
                Previous
              </Button>
              <span className="text-sm text-muted-foreground">
                Page {page} of {totalPages}
              </span>
              <Button
                variant="outline"
                size="sm"
                disabled={page >= totalPages}
                onClick={() => setPage(page + 1)}
              >
                Next
              </Button>
            </div>
          )}
        </>
      )}

      <MediaEditorPanel
        group={editingGroup}
        open={Boolean(editingGroup)}
        onOpenChange={(open) => {
          if (!open) setEditingGroup(null);
        }}
      />
    </div>
  );
}
