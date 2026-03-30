"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { Card, CardContent } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { MediaGroupCard } from "./MediaGroupCard";
import { trpc } from "@/lib/trpc/client";
import { toast } from "sonner";
import { Image, Upload, Search, FileVideo, Layers, Loader2 } from "lucide-react";
import { cn } from "@/lib/utils";

interface MediaLibraryProps {
  brandId: string;
}

const typeFilters = [
  { key: "all", label: "All", icon: Layers },
  { key: "image", label: "Images", icon: Image },
  { key: "video", label: "Videos", icon: FileVideo },
] as const;

export function MediaLibrary({ brandId }: MediaLibraryProps) {
  const router = useRouter();
  const [search, setSearch] = useState("");
  const [typeFilter, setTypeFilter] = useState<"all" | "image" | "video">("all");
  const [page, setPage] = useState(1);

  const utils = trpc.useUtils();
  const { data: stats } = trpc.media.getStats.useQuery({ brandId });

  const { data: mediaData, isLoading, isFetching } = trpc.media.list.useQuery({
    brandId,
    search: search || undefined,
    type: typeFilter,
    page,
    limit: 20,
  });

  const deleteMutation = trpc.media.deleteGroup.useMutation({
    onSuccess: () => {
      toast.success("Media deleted");
      utils.media.list.invalidate();
      utils.media.getStats.invalidate();
    },
    onError: (error) => toast.error(error.message),
  });

  function handleDelete(groupId: string) {
    if (confirm("Delete this media? Files will also be removed from Google Drive. This cannot be undone.")) {
      deleteMutation.mutate({ groupId });
    }
  }

  const groups = mediaData?.groups || [];
  const totalPages = mediaData?.totalPages || 1;

  return (
    <div className="space-y-6">
      {/* Metric cards */}
      <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
        <MetricCard label="Total Media" value={stats?.total ?? 0} />
        <MetricCard label="Groups" value={stats?.groups ?? 0} />
        <MetricCard label="Published" value={stats?.published ?? 0} />
        <MetricCard label="Scheduled" value={stats?.scheduled ?? 0} />
      </div>

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

        <div className="flex items-center bg-muted rounded-lg p-1">
          {typeFilters.map((f) => {
            const Icon = f.icon;
            return (
              <button
                key={f.key}
                onClick={() => {
                  setTypeFilter(f.key);
                  setPage(1);
                }}
                className={cn(
                  "flex items-center gap-1.5 px-3 py-1.5 rounded-md text-sm font-medium transition-colors",
                  typeFilter === f.key
                    ? "bg-background text-foreground shadow-sm"
                    : "text-muted-foreground hover:text-foreground"
                )}
              >
                <Icon className="h-3.5 w-3.5" />
                {f.label}
              </button>
            );
          })}
        </div>

        <Button onClick={() => router.push("/upload")}>
          <Upload className="h-4 w-4 mr-2" />
          Upload
        </Button>
      </div>

      {/* Grid */}
      {isLoading ? (
        <div className="flex items-center justify-center h-48">
          <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-primary" />
        </div>
      ) : groups.length === 0 ? (
        <div className="flex items-center justify-center h-64 border-2 border-dashed rounded-lg">
          <div className="text-center text-muted-foreground">
            <Image className="h-12 w-12 mx-auto mb-3 opacity-50" />
            <p className="font-medium">No media yet</p>
            <p className="text-sm mb-4">Upload your first media to get started</p>
            <Button onClick={() => router.push("/upload")}>
              <Upload className="h-4 w-4 mr-2" />
              Upload
            </Button>
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
            "grid grid-cols-1 md:grid-cols-2 gap-4 transition-opacity",
            isFetching && !isLoading ? "opacity-60" : "opacity-100"
          )}>
            {groups.map((group: any) => (
              <MediaGroupCard key={group.id} group={group} onDelete={handleDelete} />
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
    </div>
  );
}

function MetricCard({ label, value }: { label: string; value: number }) {
  return (
    <Card>
      <CardContent className="pt-5">
        <p className="text-2xl font-bold">{value}</p>
        <p className="text-sm text-muted-foreground">{label}</p>
      </CardContent>
    </Card>
  );
}
