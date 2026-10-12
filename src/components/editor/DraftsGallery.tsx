"use client";

import { useState } from "react";
import Link from "next/link";
import { toast } from "sonner";
import { Film, Image as ImageIcon, Loader2, Trash2, Upload, Wand2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { trpc } from "@/lib/trpc/client";
import { cn } from "@/lib/utils";
import { RATIO_PRESETS, type RatioKey } from "@/lib/editor/doc";
import { NewEditSource } from "./NewEditSource";
import { asRenderStatus, isRenderPending, RenderStatusBadge } from "./RenderStatusBadge";

/** Which "start an edit" dialog is open, if any. */
type Starting = "upload" | null;

export function DraftsGallery({ brandId }: { brandId: string }) {
  const [starting, setStarting] = useState<Starting>(null);
  const utils = trpc.useUtils();

  const draftsQuery = trpc.editor.listDrafts.useQuery(
    { brandId },
    {
      // Keep polling only while a render is in flight; the interval option is
      // re-read each render, so it stops on its own once nothing is pending.
      refetchInterval: (query: any) =>
        draftsFrom(query?.state?.data).some((d) => isRenderPending(d.render_status)) ? 4000 : false,
    }
  );
  const drafts = draftsFrom(draftsQuery.data);

  const deleteDraft = trpc.editor.deleteDraft.useMutation({
    onSuccess: () => {
      toast.success("Edit deleted");
      utils.editor.listDrafts.invalidate();
    },
    onError: (error) => toast.error(error.message),
  });

  const transfer = trpc.editor.transferToLibrary.useMutation({
    onSuccess: () => {
      toast.success("Added to the Media Library");
      utils.editor.listDrafts.invalidate();
      utils.media.list.invalidate();
    },
    onError: (error) => toast.error(error.message),
  });

  function handleDelete(id: string, title: string) {
    if (confirm(`Delete “${title}”? The edit and any rendered file go with it.`)) {
      deleteDraft.mutate({ id });
    }
  }

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between gap-3">
        <p className="text-sm text-muted-foreground">
          {drafts.length > 0
            ? `${drafts.length} edit${drafts.length === 1 ? "" : "s"}`
            : "Crop, filter, caption and sticker your media before it is published."}
        </p>
        <div className="flex items-center gap-2">
          {/* ONE way in, on purpose: a brand new file, pasted/dropped/picked.
              There is deliberately no Media Library picker — anything already in
              the library is already processed or already published, so editing
              from there is backwards. The flow is paste -> edit -> render ->
              Transfer, and only Transfer puts anything in the library. */}
          <Button onClick={() => setStarting("upload")}>
            <Upload />
            New edit
          </Button>
        </div>
      </div>

      {draftsQuery.isLoading ? (
        <div className="flex items-center justify-center h-64">
          <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-primary" />
        </div>
      ) : drafts.length === 0 ? (
        <div className="flex items-center justify-center h-64 border-2 border-dashed rounded-lg">
          <div className="text-center text-muted-foreground">
            <Wand2 className="mx-auto mb-3 h-12 w-12 opacity-50" />
            <p className="font-medium">No edits yet</p>
            <p className="text-sm">Paste, drop or choose a photo or video to start one</p>
          </div>
        </div>
      ) : (
        <div className="grid grid-cols-2 gap-4 sm:grid-cols-3 lg:grid-cols-4">
          {drafts.map((draft) => (
            <DraftCard
              key={draft.id}
              draft={draft}
              transferring={transfer.isPending && transfer.variables?.id === draft.id}
              deleting={deleteDraft.isPending && deleteDraft.variables?.id === draft.id}
              onTransfer={() => transfer.mutate({ id: draft.id })}
              onDelete={() => handleDelete(draft.id, draft.title)}
            />
          ))}
        </div>
      )}

      <NewEditSource
        brandId={brandId}
        open={starting === "upload"}
        onOpenChange={(open) => setStarting(open ? "upload" : null)}
      />
    </div>
  );
}

interface DraftRow {
  id: string;
  title: string;
  kind: "image" | "video";
  render_status: string;
  render_progress: number | null;
  render_error: string | null;
  source_asset_id: string | null;
  /** Set for an Editor upload, which has no media_assets row to point at. */
  source_drive_file_id: string | null;
  transferred_asset_id: string | null;
  /** Known only once a render has happened — `listDrafts` omits `doc`. */
  ratio: RatioKey | null;
  thumb: string | null;
  updated_at: string | null;
}

function ratioKeyOrNull(value: unknown): RatioKey | null {
  return typeof value === "string" && value in RATIO_PRESETS ? (value as RatioKey) : null;
}

/** `listDrafts` may answer with an array or `{ drafts }`; both are accepted. */
function draftsFrom(data: unknown): DraftRow[] {
  const raw: any = data;
  const list: any[] = Array.isArray(raw) ? raw : Array.isArray(raw?.drafts) ? raw.drafts : [];
  return list
    .filter((row) => row && typeof row.id === "string")
    .map((row) => ({
      id: row.id,
      title: typeof row.title === "string" && row.title ? row.title : "Untitled edit",
      kind: row.kind === "video" ? "video" : "image",
      render_status: typeof row.render_status === "string" ? row.render_status : "idle",
      render_progress: typeof row.render_progress === "number" ? row.render_progress : null,
      render_error: row.render_error ?? null,
      source_asset_id: row.source_asset_id ?? null,
      source_drive_file_id: row.source_drive_file_id ?? null,
      transferred_asset_id: row.transferred_asset_id ?? null,
      ratio: ratioKeyOrNull(row.rendered_aspect_ratio) ?? ratioKeyOrNull(row.doc?.canvas?.ratio),
      thumb: typeof row.preview_thumb === "string" && row.preview_thumb ? row.preview_thumb : null,
      updated_at: row.updated_at ?? null,
    }));
}

function DraftCard({
  draft,
  transferring,
  deleting,
  onTransfer,
  onDelete,
}: {
  draft: DraftRow;
  transferring: boolean;
  deleting: boolean;
  onTransfer: () => void;
  onDelete: () => void;
}) {
  const [thumbFailed, setThumbFailed] = useState(false);
  const status = asRenderStatus(draft.render_status);
  const ready = status === "ready";
  const transferred = Boolean(draft.transferred_asset_id);
  // Prefer the stored preview: it avoids streaming the full source out of Drive
  // for every card in the grid.
  //
  // The two fallbacks are the two source models. An Editor upload has no
  // media_assets row at all, so /api/media/<assetId> can never serve it — its
  // bytes come from the draft itself. Without this branch every newly uploaded
  // draft would render as a bare icon.
  // A poster for BOTH kinds now — ffmpeg is in the app image, so a video draft
  // gets a real first frame instead of streaming its whole source. The two
  // branches are the two source models: an Editor upload has no media_assets
  // row, so its bytes are addressed by the draft id.
  const thumbSrc =
    draft.thumb ??
    (draft.source_drive_file_id
      ? `/api/editor/asset/${draft.id}?kind=source&variant=thumb`
      : draft.source_asset_id
        ? `/api/media/${draft.source_asset_id}?variant=thumb`
        : null);
  // A source whose Drive bytes cannot be fetched should still read as a card,
  // not as an empty black square.
  const thumb = thumbFailed ? null : thumbSrc;
  // Video drafts have no still image — stream a muted <video> seeked to the first
  // frame (#t=0.1) so the card shows an actual preview instead of a VIDEO icon.
  // Only when the poster itself failed: then stream the first frame directly.
  const videoSrc =
    thumbFailed && draft.kind === "video"
      ? draft.source_drive_file_id
        ? `/api/editor/asset/${draft.id}?kind=source#t=0.1`
        : draft.source_asset_id
          ? `/api/media/${draft.source_asset_id}#t=0.1`
          : null
      : null;

  return (
    <Card className="group gap-0 overflow-hidden py-0">
      <Link
        href={`/editor/${draft.id}`}
        className="relative flex aspect-square items-center justify-center overflow-hidden bg-zinc-900"
      >
        {thumb ? (
          <img
            src={thumb}
            alt=""
            loading="lazy"
            className="h-full w-full object-cover transition-transform duration-200 group-hover:scale-[1.03]"
            draggable={false}
            onError={() => setThumbFailed(true)}
          />
        ) : videoSrc ? (
          <video
            src={videoSrc}
            preload="metadata"
            muted
            playsInline
            className="h-full w-full object-cover transition-transform duration-200 group-hover:scale-[1.03]"
            onError={() => setThumbFailed(true)}
          />
        ) : (
          <span className="flex flex-col items-center gap-1 text-white/40">
            {draft.kind === "video" ? <Film className="h-7 w-7" /> : <ImageIcon className="h-7 w-7" />}
            <span className="text-[10px] font-medium uppercase tracking-wide">{draft.kind}</span>
          </span>
        )}

        <span className="absolute top-2 left-2">
          <RenderStatusBadge status={status} progress={draft.render_progress} />
        </span>
        {draft.ratio && (
          <span
            title={RATIO_PRESETS[draft.ratio].label}
            className="absolute right-2 bottom-2 rounded bg-black/60 px-1.5 py-0.5 font-mono text-[10px] text-white/80"
          >
            {draft.ratio}
          </span>
        )}
      </Link>

      <CardContent className="space-y-2 p-3">
        <div className="min-w-0">
          <p className="truncate text-sm font-medium">{draft.title}</p>
          <p
            className={cn(
              "truncate text-[11px]",
              status === "failed" ? "text-destructive" : "text-muted-foreground"
            )}
          >
            {status === "failed"
              ? draft.render_error || "Render failed"
              : transferred
                ? "In the Media Library"
                : formatWhen(draft.updated_at)}
          </p>
        </div>

        <div className="flex items-center gap-1.5">
          <Button
            variant="outline"
            size="sm"
            className="flex-1"
            // The rendered element is an <a>, not a <button> — Base UI needs to
            // be told so it does not assume native button semantics.
            nativeButton={false}
            render={<Link href={`/editor/${draft.id}`} />}
          >
            Open
          </Button>
          <Button
            variant="ghost"
            size="icon-sm"
            aria-label="Delete edit"
            className="text-destructive"
            disabled={deleting}
            onClick={onDelete}
          >
            {deleting ? <Loader2 className="animate-spin" /> : <Trash2 />}
          </Button>
        </div>

        {ready && !transferred && (
          <Button size="sm" className="w-full" disabled={transferring} onClick={onTransfer}>
            {transferring && <Loader2 className="animate-spin" />}
            Transfer to Media Library
          </Button>
        )}
      </CardContent>
    </Card>
  );
}

function formatWhen(value: string | null): string {
  if (!value) return "Draft";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "Draft";
  return `Edited ${date.toLocaleDateString(undefined, { month: "short", day: "numeric" })}`;
}
