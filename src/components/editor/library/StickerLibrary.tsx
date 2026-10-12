"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { trpc } from "@/lib/trpc/client";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import {
  ChevronRight,
  FolderPlus,
  ImagePlus,
  Loader2,
  Sticker,
  Trash2,
} from "lucide-react";
import {
  DropZone,
  InlineNameForm,
  PanelBusy,
  PanelEmpty,
  PanelError,
  PanelHeader,
  PanelLoading,
} from "./panel-chrome";
import {
  STICKER_ACCEPT,
  editorAssetUrl,
  fileLabel,
  isStickerFile,
  measureImage,
  normalizeList,
  normalizeStickerPack,
  uploadEditorAsset,
  type EditorSticker,
  type EditorStickerPack,
  type PickedSticker,
} from "./types";

/**
 * Sticker packs, the WhatsApp way: one row per pack, a dense grid of stickers
 * inside the pack that is open, and exactly one pack open at a time. Picking a
 * sticker hands it to the shell, which turns it into a layer.
 */

interface StickerLibraryProps {
  brandId: string;
  onPick: (sticker: PickedSticker) => void;
}

interface UploadProgress {
  packId: string;
  done: number;
  total: number;
}

export function StickerLibrary({ brandId, onPick }: StickerLibraryProps) {
  const utils = trpc.useUtils();

  const [openPackId, setOpenPackId] = useState<string | null>(null);
  const [creatingPack, setCreatingPack] = useState(false);
  const [upload, setUpload] = useState<UploadProgress | null>(null);
  const [deletingId, setDeletingId] = useState<string | null>(null);

  /**
   * Intrinsic sizes read off the rendered thumbnails.
   *
   * Everything uploaded through this panel is measured before it leaves the
   * browser, but a row created some other way can still be missing width and
   * height — and `aspect` is the one field the shell cannot guess, because a
   * wrong one stretches the layer. The thumbnail is the real file served
   * through the byte proxy, so its naturalWidth/Height is an exact fallback.
   */
  const measuredSizes = useRef(new Map<string, { width: number; height: number }>());

  const packsQuery = trpc.editor.listStickerPacks.useQuery(
    { brandId },
    { enabled: Boolean(brandId) }
  );

  const packs = useMemo<EditorStickerPack[]>(
    () => normalizeList(packsQuery.data, normalizeStickerPack),
    [packsQuery.data]
  );

  // Keep a pack open: the grid is the point of the panel, so an empty right-hand
  // column after a load or a delete would be a dead end.
  useEffect(() => {
    if (!packs.length) {
      if (openPackId !== null) setOpenPackId(null);
      return;
    }
    if (!openPackId || !packs.some((pack) => pack.id === openPackId)) {
      setOpenPackId(packs[0].id);
    }
  }, [packs, openPackId]);

  const createPack = trpc.editor.createStickerPack.useMutation({
    onSuccess: async (created) => {
      const pack = normalizeStickerPack(created);
      setCreatingPack(false);
      await utils.editor.listStickerPacks.invalidate();
      if (pack) {
        setOpenPackId(pack.id);
        toast.success(`Pack "${pack.name}" created`);
      }
    },
    onError: (error) => toast.error(error.message),
  });

  const deleteSticker = trpc.editor.deleteSticker.useMutation({
    onSuccess: async () => {
      await utils.editor.listStickerPacks.invalidate();
    },
    onError: (error) => toast.error(error.message),
    onSettled: () => setDeletingId(null),
  });

  async function handleFiles(packId: string, files: File[]) {
    const accepted = files.filter(isStickerFile);
    const skipped = files.length - accepted.length;
    if (skipped > 0) {
      toast.error(`${skipped} file${skipped === 1 ? "" : "s"} skipped — use PNG or WebP`);
    }
    if (!accepted.length) return;

    setUpload({ packId, done: 0, total: accepted.length });
    let succeeded = 0;

    try {
      for (const file of accepted) {
        // Measure first. An image the browser cannot decode would upload with
        // an unknown aspect and then render stretched, so it is refused here
        // rather than silently stored.
        const dimensions = await measureImage(file);
        if (!dimensions) {
          toast.error(`Could not read the dimensions of ${file.name}`);
          setUpload((current) => (current ? { ...current, done: current.done + 1 } : current));
          continue;
        }

        try {
          await uploadEditorAsset({
            file,
            brandId,
            kind: "sticker",
            packId,
            name: fileLabel(file.name),
            width: dimensions.width,
            height: dimensions.height,
            // Same convention as Layer.aspect: intrinsic height / width.
            aspect: dimensions.height / dimensions.width,
          });
          succeeded += 1;
        } catch (error) {
          toast.error(error instanceof Error ? error.message : `Could not upload ${file.name}`);
        }

        setUpload((current) => (current ? { ...current, done: current.done + 1 } : current));
      }
    } finally {
      setUpload(null);
      await utils.editor.listStickerPacks.invalidate();
    }

    if (succeeded > 0) {
      toast.success(`${succeeded} sticker${succeeded === 1 ? "" : "s"} added`);
    }
  }

  function handlePick(sticker: EditorSticker) {
    const measured = measuredSizes.current.get(sticker.id);
    const width = sticker.width ?? measured?.width ?? 0;
    const height = sticker.height ?? measured?.height ?? 0;
    const aspect =
      sticker.width && sticker.height
        ? sticker.height / sticker.width
        : measured
          ? measured.height / measured.width
          : sticker.aspect;

    onPick({
      id: sticker.id,
      driveFileId: sticker.driveFileId,
      name: sticker.name,
      width,
      height,
      aspect: aspect > 0 ? aspect : 1,
    });
  }

  const header = (
    <PanelHeader
      icon={Sticker}
      title="Stickers"
      hint={packs.length ? undefined : "Group your logos and badges into packs"}
    >
      {!creatingPack && (
        <Button
          type="button"
          size="xs"
          variant="outline"
          onClick={() => setCreatingPack(true)}
          disabled={createPack.isPending}
        >
          <FolderPlus />
          New pack
        </Button>
      )}
    </PanelHeader>
  );

  return (
    <div className="space-y-3">
      {header}

      {creatingPack && (
        <InlineNameForm
          placeholder="Pack name"
          submitLabel="Create pack"
          busy={createPack.isPending}
          onSubmit={(name) => createPack.mutate({ brandId, name })}
          onCancel={() => setCreatingPack(false)}
        />
      )}

      {packsQuery.isLoading ? (
        <PanelLoading label="Loading packs..." />
      ) : packsQuery.error ? (
        <PanelError
          message={packsQuery.error.message}
          onRetry={() => packsQuery.refetch()}
          retrying={packsQuery.isFetching}
        />
      ) : packs.length === 0 ? (
        !creatingPack && (
          <PanelEmpty
            icon={Sticker}
            title="No sticker packs yet"
            hint="A pack keeps a set of stickers together, so you can reuse the whole set across edits."
          >
            <Button type="button" size="sm" variant="outline" onClick={() => setCreatingPack(true)}>
              <FolderPlus />
              Create a pack
            </Button>
          </PanelEmpty>
        )
      ) : (
        <div className="space-y-1.5">
          {packs.map((pack) => {
            const isOpen = pack.id === openPackId;
            const packUpload = upload?.packId === pack.id ? upload : null;

            return (
              <div key={pack.id} className="overflow-hidden rounded-lg border bg-card">
                <button
                  type="button"
                  aria-expanded={isOpen}
                  onClick={() => setOpenPackId(isOpen ? null : pack.id)}
                  className={cn(
                    "flex w-full items-center gap-2 px-2.5 py-2 text-left transition-colors outline-none",
                    "focus-visible:ring-3 focus-visible:ring-ring/50 focus-visible:ring-inset",
                    isOpen ? "bg-muted/60" : "hover:bg-muted/40"
                  )}
                >
                  <ChevronRight
                    className={cn(
                      "h-3.5 w-3.5 shrink-0 text-muted-foreground transition-transform",
                      isOpen && "rotate-90"
                    )}
                  />
                  <span className="min-w-0 flex-1 truncate text-xs font-medium">{pack.name}</span>
                  <span className="shrink-0 text-[11px] tabular-nums text-muted-foreground">
                    {pack.stickers.length}
                  </span>
                </button>

                {isOpen && (
                  <div className="space-y-2 border-t p-2">
                    {pack.stickers.length > 0 && (
                      <div className="grid grid-cols-4 gap-1.5">
                        {pack.stickers.map((sticker) => (
                          <StickerTile
                            key={sticker.id}
                            sticker={sticker}
                            deleting={deletingId === sticker.id}
                            onPick={() => handlePick(sticker)}
                            onDelete={() => {
                              setDeletingId(sticker.id);
                              deleteSticker.mutate({ id: sticker.id });
                            }}
                            onMeasured={(size) => measuredSizes.current.set(sticker.id, size)}
                          />
                        ))}
                      </div>
                    )}

                    {packUpload ? (
                      <PanelBusy
                        label={`Uploading ${packUpload.done + 1} of ${packUpload.total}...`}
                      />
                    ) : (
                      <DropZone
                        accept={STICKER_ACCEPT}
                        icon={ImagePlus}
                        title={pack.stickers.length ? "Add stickers" : "Drop stickers here"}
                        hint="PNG or WebP, transparent background"
                        disabled={Boolean(upload)}
                        onFiles={(files) => handleFiles(pack.id, files)}
                      />
                    )}
                  </div>
                )}
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}

function StickerTile({
  sticker,
  deleting,
  onPick,
  onDelete,
  onMeasured,
}: {
  sticker: EditorSticker;
  deleting: boolean;
  onPick: () => void;
  onDelete: () => void;
  onMeasured: (size: { width: number; height: number }) => void;
}) {
  const [failed, setFailed] = useState(false);

  return (
    <div className="group relative">
      <button
        type="button"
        onClick={onPick}
        disabled={deleting}
        title={sticker.name}
        aria-label={`Add ${sticker.name} to the canvas`}
        className={cn(
          "flex aspect-square w-full items-center justify-center rounded-md border bg-muted/40 p-1 transition-colors outline-none",
          "hover:border-primary hover:bg-primary/5 focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50",
          deleting && "pointer-events-none opacity-40"
        )}
      >
        {failed ? (
          <span className="px-0.5 text-[10px] leading-tight text-muted-foreground">
            Unavailable
          </span>
        ) : (
          // eslint-disable-next-line @next/next/no-img-element
          <img
            src={editorAssetUrl(sticker.id)}
            alt=""
            loading="lazy"
            draggable={false}
            onLoad={(event) => {
              const image = event.currentTarget;
              if (image.naturalWidth > 0 && image.naturalHeight > 0) {
                onMeasured({ width: image.naturalWidth, height: image.naturalHeight });
              }
            }}
            onError={() => setFailed(true)}
            className="max-h-full max-w-full object-contain"
          />
        )}
      </button>

      <button
        type="button"
        onClick={onDelete}
        disabled={deleting}
        title={`Delete ${sticker.name}`}
        aria-label={`Delete ${sticker.name}`}
        className={cn(
          "absolute -top-1 -right-1 flex h-5 w-5 items-center justify-center rounded-full border bg-background text-muted-foreground shadow-sm transition-opacity outline-none",
          "opacity-0 group-hover:opacity-100 focus-visible:opacity-100 focus-visible:ring-3 focus-visible:ring-ring/50",
          "hover:border-destructive/40 hover:text-destructive",
          deleting && "opacity-100"
        )}
      >
        {deleting ? (
          <Loader2 className="h-3 w-3 animate-spin" />
        ) : (
          <Trash2 className="h-3 w-3" />
        )}
      </button>
    </div>
  );
}
