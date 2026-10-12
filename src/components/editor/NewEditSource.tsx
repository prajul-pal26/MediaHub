"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { Clipboard, Film, Image as ImageIcon, Loader2, Upload, X } from "lucide-react";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group";
import { trpc } from "@/lib/trpc/client";
import { cn } from "@/lib/utils";
import { RATIO_KEYS, RATIO_PRESETS, type RatioKey } from "@/lib/editor/doc";
import { EDITOR_ASSET_KINDS, acceptAttributeFor } from "@/lib/editor/asset-kinds";

/**
 * Start a draft from a NEW file — pasted, dropped, or picked from disk.
 *
 * Deliberately NOT a Media Library picker. Anything already in the library is
 * already processed or already published, so editing from there is backwards:
 * the flow is paste/pick -> edit -> render -> "Transfer to Media Library", and
 * only that transfer creates a `media_assets` row.
 *
 * The upload goes to `POST /api/editor/asset?kind=source`, which files it in
 * the brand's Drive ORIGINALS folder and returns a descriptor. It writes no
 * database row at all, which is what keeps a draft invisible to the library
 * until it is transferred.
 */

/** The descriptor `POST /api/editor/asset?kind=source` returns. */
interface SourceDescriptor {
  driveFileId: string;
  fileName: string;
  fileType: string;
  width: number | null;
  height: number | null;
  durationMs: number | null;
  fileSize: number | null;
  kind: "image" | "video";
}

interface PickedFile {
  file: File;
  /** Object URL for the local preview. Revoked on replace/unmount. */
  previewUrl: string;
  kind: "image" | "video";
  width: number | null;
  height: number | null;
  durationMs: number | null;
  /** How it arrived, so the UI can confirm a paste actually registered. */
  via: "paste" | "drop" | "pick";
}

function prettyBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function mediaKindOf(type: string): "image" | "video" | null {
  if (type.startsWith("image/")) return "image";
  if (type.startsWith("video/")) return "video";
  return null;
}

/**
 * Measure in the browser.
 *
 * Mandatory for video: ffprobe is NOT installed in the `app` image, so the
 * server cannot read an MP4's dimensions or duration at all — if we don't send
 * them, the document has no source size and `coverCrop` cannot frame the first
 * crop. Images are re-measured server-side with sharp (which wins), but
 * measuring here too means the ratio preview is honest before the upload.
 */
function measure(file: File, kind: "image" | "video", url: string) {
  return new Promise<{ width: number | null; height: number | null; durationMs: number | null }>(
    (resolve) => {
      const give = (v: { width: number | null; height: number | null; durationMs: number | null }) =>
        resolve(v);
      const nothing = { width: null, height: null, durationMs: null };
      // Never hang the dialog on a file the browser cannot decode.
      const timer = setTimeout(() => give(nothing), 10_000);

      if (kind === "image") {
        const img = new Image();
        img.onload = () => {
          clearTimeout(timer);
          give({
            width: img.naturalWidth || null,
            height: img.naturalHeight || null,
            durationMs: null,
          });
        };
        img.onerror = () => {
          clearTimeout(timer);
          give(nothing);
        };
        img.src = url;
        return;
      }

      const video = document.createElement("video");
      video.preload = "metadata";
      video.onloadedmetadata = () => {
        clearTimeout(timer);
        give({
          width: video.videoWidth || null,
          height: video.videoHeight || null,
          // A non-finite duration (some VBR/streaming files) stays unknown
          // rather than becoming a fabricated number.
          durationMs: Number.isFinite(video.duration) ? Math.round(video.duration * 1000) : null,
        });
      };
      video.onerror = () => {
        clearTimeout(timer);
        give(nothing);
      };
      video.src = url;
    }
  );
}

export function NewEditSource({
  brandId,
  open,
  onOpenChange,
}: {
  brandId: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const router = useRouter();
  const utils = trpc.useUtils();

  const [picked, setPicked] = useState<PickedFile | null>(null);
  const [ratio, setRatio] = useState<RatioKey>("4:5");
  const [dragging, setDragging] = useState(false);
  const [uploading, setUploading] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);
  // Held in a ref as well so the unmount cleanup never closes over a stale URL.
  const urlRef = useRef<string | null>(null);

  const spec = EDITOR_ASSET_KINDS.source;

  const clearPicked = useCallback(() => {
    if (urlRef.current) URL.revokeObjectURL(urlRef.current);
    urlRef.current = null;
    setPicked(null);
  }, []);

  useEffect(() => {
    return () => {
      if (urlRef.current) URL.revokeObjectURL(urlRef.current);
    };
  }, []);

  const accept = useCallback(
    async (file: File, via: PickedFile["via"]) => {
      const kind = mediaKindOf(file.type);
      if (!kind) {
        toast.error(
          file.type
            ? `${file.type} can't be edited. Pick a photo or a video.`
            : "That file has no recognisable type. Pick a photo or a video."
        );
        return;
      }
      if (!Object.hasOwn(spec.mimeTypes, file.type)) {
        toast.error(`${file.type} isn't supported yet.`);
        return;
      }
      if (file.size > spec.maxBytes) {
        toast.error(
          `${prettyBytes(file.size)} is over the ${prettyBytes(spec.maxBytes)} limit for one file.`
        );
        return;
      }
      if (file.size === 0) {
        toast.error("That file is empty.");
        return;
      }

      if (urlRef.current) URL.revokeObjectURL(urlRef.current);
      const previewUrl = URL.createObjectURL(file);
      urlRef.current = previewUrl;

      const dims = await measure(file, kind, previewUrl);
      setPicked({ file, previewUrl, kind, via, ...dims });

      // Pre-select the ratio the source is already closest to, so the common
      // case needs no decision. Portrait video -> 9:16, landscape -> 16:9.
      if (dims.width && dims.height) {
        const r = dims.width / dims.height;
        const nearest = RATIO_KEYS.reduce((best, key) => {
          const p = RATIO_PRESETS[key];
          return Math.abs(p.w / p.h - r) < Math.abs(RATIO_PRESETS[best].w / RATIO_PRESETS[best].h - r)
            ? key
            : best;
        }, RATIO_KEYS[0]);
        setRatio(nearest);
      }
    },
    [spec]
  );

  // Paste support. Scoped to while the dialog is open so it never competes with
  // the canvas' own paste handling, and it reads `items` rather than `files`
  // because a screenshot copied from the OS arrives as an item, not a file.
  useEffect(() => {
    if (!open) return;
    function onPaste(event: ClipboardEvent) {
      const items = event.clipboardData?.items;
      if (!items) return;
      for (const item of items) {
        if (item.kind !== "file") continue;
        const file = item.getAsFile();
        if (!file) continue;
        event.preventDefault();
        void accept(file, "paste");
        return;
      }
    }
    window.addEventListener("paste", onPaste);
    return () => window.removeEventListener("paste", onPaste);
  }, [open, accept]);

  const createDraft = trpc.editor.createDraft.useMutation({
    onSuccess: (draft: { id: string }) => {
      void utils.editor.listDrafts.invalidate();
      onOpenChange(false);
      clearPicked();
      router.push(`/editor/${draft.id}`);
    },
    onError: (error) => toast.error(error.message),
  });

  async function start() {
    if (!picked) return;
    setUploading(true);
    try {
      const form = new FormData();
      form.append("file", picked.file);
      form.append("brandId", brandId);
      form.append("kind", "source");
      form.append("name", picked.file.name);
      if (picked.width != null) form.append("width", String(picked.width));
      if (picked.height != null) form.append("height", String(picked.height));
      if (picked.durationMs != null) form.append("durationMs", String(picked.durationMs));

      // `?kind=` lets the server reject an oversized body BEFORE buffering it;
      // the form field above stays authoritative.
      const response = await fetch("/api/editor/asset?kind=source", {
        method: "POST",
        body: form,
      });

      let payload: Partial<SourceDescriptor> & { error?: string } = {};
      try {
        payload = (await response.json()) ?? {};
      } catch {
        payload = {};
      }
      if (!response.ok) {
        throw new Error(payload.error || `Upload failed (${response.status})`);
      }
      if (!payload.driveFileId || !payload.fileName || !payload.fileType) {
        throw new Error("The upload succeeded but returned no file reference");
      }

      createDraft.mutate({
        brandId,
        kind: payload.kind === "video" ? "video" : "image",
        ratio,
        title: picked.file.name.replace(/\.[^.]+$/, "") || "Untitled edit",
        source: {
          driveFileId: payload.driveFileId,
          fileName: payload.fileName,
          fileType: payload.fileType,
          width: payload.width ?? null,
          height: payload.height ?? null,
          durationMs: payload.durationMs ?? null,
          fileSize: payload.fileSize ?? null,
        },
      });
    } catch (e: unknown) {
      toast.error(e instanceof Error ? e.message : "Could not upload that file");
    } finally {
      setUploading(false);
    }
  }

  const busy = uploading || createDraft.isPending;

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (busy) return;
        if (!next) clearPicked();
        onOpenChange(next);
      }}
    >
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>New edit</DialogTitle>
          <DialogDescription>
            Paste, drop, or choose a photo or video. It stays a draft — nothing reaches the Media
            Library until you transfer it.
          </DialogDescription>
        </DialogHeader>

        <input
          ref={inputRef}
          type="file"
          accept={acceptAttributeFor("source")}
          className="hidden"
          onChange={(event) => {
            const file = event.target.files?.[0];
            // Reset so picking the same file twice still fires a change event.
            event.target.value = "";
            if (file) void accept(file, "pick");
          }}
        />

        {!picked ? (
          <button
            type="button"
            onClick={() => inputRef.current?.click()}
            onDragOver={(e) => {
              e.preventDefault();
              setDragging(true);
            }}
            onDragLeave={() => setDragging(false)}
            onDrop={(e) => {
              e.preventDefault();
              setDragging(false);
              const file = e.dataTransfer.files?.[0];
              if (file) void accept(file, "drop");
            }}
            className={cn(
              "flex w-full flex-col items-center justify-center gap-2 rounded-xl border-2 border-dashed px-6 py-10 text-center transition-colors",
              dragging
                ? "border-primary bg-primary/5"
                : "border-border hover:border-primary/40 hover:bg-muted/40"
            )}
          >
            <Upload className="h-7 w-7 text-muted-foreground" />
            <span className="text-sm font-medium">Drop a photo or video here</span>
            <span className="text-xs text-muted-foreground">
              or click to choose · <Clipboard className="inline h-3 w-3" /> paste works too
            </span>
            <span className="mt-1 text-[11px] text-muted-foreground">
              JPEG, PNG, GIF, WebP, HEIC · MP4, MOV, WebM, AVI · up to{" "}
              {prettyBytes(spec.maxBytes)}
            </span>
          </button>
        ) : (
          <div className="flex items-start gap-3 rounded-xl border bg-muted/30 p-3">
            <div className="relative h-20 w-20 shrink-0 overflow-hidden rounded-lg bg-muted">
              {picked.kind === "image" ? (
                // eslint-disable-next-line @next/next/no-img-element
                <img src={picked.previewUrl} alt="" className="h-full w-full object-cover" />
              ) : (
                <video src={picked.previewUrl} muted playsInline className="h-full w-full object-cover" />
              )}
            </div>
            <div className="min-w-0 flex-1">
              <p className="truncate text-sm font-medium">{picked.file.name}</p>
              <p className="text-xs text-muted-foreground">
                {picked.kind === "video" ? (
                  <Film className="mr-1 inline h-3 w-3" />
                ) : (
                  <ImageIcon className="mr-1 inline h-3 w-3" />
                )}
                {prettyBytes(picked.file.size)}
                {picked.width && picked.height ? ` · ${picked.width}×${picked.height}` : ""}
                {picked.durationMs ? ` · ${(picked.durationMs / 1000).toFixed(1)}s` : ""}
                {picked.via === "paste" ? " · pasted" : ""}
              </p>
              {picked.kind === "video" && !picked.width && (
                <p className="mt-1 text-[11px] text-amber-600 dark:text-amber-500">
                  Couldn&apos;t read this video&apos;s size in the browser — the first crop may need
                  adjusting.
                </p>
              )}
            </div>
            <Button variant="ghost" size="icon" onClick={clearPicked} disabled={busy} aria-label="Remove">
              <X className="h-4 w-4" />
            </Button>
          </div>
        )}

        <div className="space-y-2">
          <span className="text-xs font-medium text-foreground/80">Output ratio</span>
          <ToggleGroup
            variant="segmented"
            value={ratio}
            onValueChange={(next) => {
              if (next && (RATIO_KEYS as string[]).includes(next)) setRatio(next as RatioKey);
            }}
            aria-label="Output ratio"
            className="w-full"
          >
            {RATIO_KEYS.map((key) => (
              <ToggleGroupItem key={key} value={key} className="flex-1 px-1 text-xs">
                {key}
              </ToggleGroupItem>
            ))}
          </ToggleGroup>
          <p className="text-[11px] text-muted-foreground">
            {RATIO_PRESETS[ratio].label} · {RATIO_PRESETS[ratio].w}×{RATIO_PRESETS[ratio].h}
          </p>
        </div>

        <DialogFooter showCloseButton>
          <Button disabled={!picked || busy} onClick={() => void start()}>
            {busy && <Loader2 className="animate-spin" />}
            {uploading ? "Uploading…" : "Start editing"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
