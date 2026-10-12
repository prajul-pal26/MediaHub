"use client";

import * as React from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { CircleAlert, Loader2, Sparkles } from "lucide-react";
import { Button } from "@/components/ui/button";
import { trpc } from "@/lib/trpc/client";
import { cn } from "@/lib/utils";
import {
  changeRatio,
  createEmptyDoc,
  editDocSchema,
  RATIO_KEYS,
  type EditDoc,
  type Layer,
  type RatioKey,
} from "@/lib/editor/doc";
import type { EditorApi, CommitOptions, SourceInfo } from "./api";
import { CanvasStage } from "./CanvasStage";
import { EditorTopBar } from "./EditorTopBar";
import { Inspector } from "./inspector/Inspector";
import { ToolRail } from "./ToolRail";
import { asRenderStatus, isRenderPending, RenderStatusBadge } from "./RenderStatusBadge";
import { canRedo, canUndo, editorReducer, initialEditorState } from "./editor-state";
import { findLayer, nudgeLayer, removeLayer, resizeLayer, updateLayer } from "./doc-ops";
import { editorAssetUrl } from "./library/types";
import { useAutosave } from "./use-autosave";
import type { LayerGeometryChange } from "./LayerView";

const NUDGE_UNITS = 0.004;
const NUDGE_UNITS_COARSE = 0.02;

function isRatioKey(value: unknown): value is RatioKey {
  return typeof value === "string" && (RATIO_KEYS as string[]).includes(value);
}

/** A draft row's `doc` starts life as `{}`, so an empty document is the fallback. */
function parseDraftDoc(draft: any): EditDoc {
  const parsed = editDocSchema.safeParse(draft?.doc);
  if (parsed.success) return parsed.data;
  return createEmptyDoc({
    ratio: isRatioKey(draft?.doc?.canvas?.ratio) ? draft.doc.canvas.ratio : "1:1",
    kind: draft?.kind === "video" ? "video" : "image",
    assetId: draft?.source_asset_id ?? null,
  });
}

function isTypingTarget(target: EventTarget | null): boolean {
  const el = target as HTMLElement | null;
  if (!el || typeof el.tagName !== "string") return false;
  return (
    el.tagName === "INPUT" ||
    el.tagName === "TEXTAREA" ||
    el.tagName === "SELECT" ||
    el.isContentEditable
  );
}

export function EditorWorkspace({ draftId }: { draftId: string }) {
  const router = useRouter();
  const utils = trpc.useUtils();

  const draftQuery = trpc.editor.getDraft.useQuery(
    { id: draftId },
    { retry: false, refetchOnWindowFocus: false }
  );
  const draft: any = draftQuery.data;
  const renderStatus = asRenderStatus(draft?.render_status);

  const refetchDraft = React.useRef(draftQuery.refetch);
  React.useEffect(() => {
    refetchDraft.current = draftQuery.refetch;
  });

  // Only poll while the worker still owes us a result.
  const pending = isRenderPending(renderStatus);
  React.useEffect(() => {
    if (!pending) return;
    const timer = setInterval(() => {
      void refetchDraft.current();
    }, 4000);
    return () => clearInterval(timer);
  }, [pending]);

  const [state, dispatch] = React.useReducer(editorReducer, null, () =>
    initialEditorState(createEmptyDoc({ ratio: "1:1", kind: "image", assetId: null }))
  );

  const [title, setTitle] = React.useState("");
  const [titleRevision, setTitleRevision] = React.useState(0);
  const [source, setSource] = React.useState<SourceInfo | null>(null);
  const [renderBusy, setRenderBusy] = React.useState(false);

  // Load once per draft. A later poll must never clobber unsaved local edits,
  // so this is keyed on the id rather than on the query data.
  const loadedIdRef = React.useRef<string | null>(null);
  React.useEffect(() => {
    if (!draft || loadedIdRef.current === draftId) return;
    loadedIdRef.current = draftId;
    dispatch({ type: "load", doc: parseDraftDoc(draft) });
    setTitle(typeof draft.title === "string" ? draft.title : "Untitled edit");
  }, [draft, draftId]);

  const brandId: string = draft?.brand_id ?? "";

  const autosave = useAutosave({
    draftId,
    doc: state.doc,
    revision: state.revision + titleRevision,
    title,
    enabled: loadedIdRef.current === draftId,
  });

  const updateDraft = trpc.editor.updateDraft.useMutation();
  const requestRender = trpc.editor.requestRender.useMutation();
  const transferToLibrary = trpc.editor.transferToLibrary.useMutation();
  const saveTemplate = trpc.editor.saveTemplate.useMutation();

  // ── Document plumbing ──────────────────────────────────────────────────────
  const commit = React.useCallback((next: EditDoc, options?: CommitOptions) => {
    dispatch({ type: "commit", doc: next, coalesce: options?.coalesce, select: options?.select });
  }, []);

  const select = React.useCallback((layerId: string | null) => {
    dispatch({ type: "select", layerId });
  }, []);

  /**
   * Where the base media's bytes come from — the one place that knows about the
   * two source models.
   *
   * An Editor upload (the normal case) has NO `media_assets` row, so
   * `doc.base.assetId` is null and the bytes are addressed by the draft id.
   * A draft started from a Media Library asset still uses the media proxy.
   * Resolving this from `doc.base.assetId` alone shows "No source media" on
   * every uploaded file.
   */
  const sourceUrl = React.useMemo<string | null>(() => {
    const assetId = state.doc.base.assetId;
    if (assetId) return `/api/media/${encodeURIComponent(assetId)}`;
    if (draft?.source_drive_file_id) {
      return `/api/editor/asset/${encodeURIComponent(draftId)}?kind=source`;
    }
    return null;
  }, [state.doc.base.assetId, draft?.source_drive_file_id, draftId]);

  /**
   * Stickers are not media assets, so they are served by the editor's own asset
   * route rather than the media byte proxy.
   */
  const resolveLayerSrc = React.useCallback((layer: Layer): string | null => {
    const src = layer.src;
    if (!src) return null;
    if (src.kind === "url" && src.url) return src.url;
    if (src.kind === "sticker" && src.stickerId) return editorAssetUrl(src.stickerId);
    return null;
  }, []);

  const reload = React.useCallback(async () => {
    const result = await refetchDraft.current();
    const data: any = result.data;
    if (!data) return;
    dispatch({ type: "load", doc: parseDraftDoc(data) });
    if (typeof data.title === "string") setTitle(data.title);
  }, []);

  const selectedLayer = findLayer(state.doc, state.selectedLayerId);

  const api: EditorApi = React.useMemo(
    () => ({
      doc: state.doc,
      source,
      selectedLayer,
      commit,
      select,
      setTool: (tool) => dispatch({ type: "setTool", tool }),
      resolveLayerSrc,
      brandId,
      draftId,
      reload,
    }),
    [state.doc, source, selectedLayer, commit, select, resolveLayerSrc, brandId, draftId, reload]
  );

  /** A completed drag / resize / rotate gesture on the stage. */
  const handleLayerGeometry = React.useCallback(
    (layerId: string, change: LayerGeometryChange) => {
      let next = state.doc;
      if (change.offset) next = updateLayer(next, layerId, { offset: change.offset });
      if (change.width != null) next = resizeLayer(next, layerId, change.width);
      if (change.rotation != null) next = updateLayer(next, layerId, { rotation: change.rotation });
      if (next !== state.doc) commit(next);
    },
    [state.doc, commit]
  );

  const handleSourceLoad = React.useCallback((info: SourceInfo) => {
    setSource((previous) =>
      previous && previous.w === info.w && previous.h === info.h ? previous : info
    );
  }, []);

  function handleRatioChange(ratio: RatioKey) {
    if (ratio === state.doc.canvas.ratio) return;
    commit(changeRatio(state.doc, ratio, source ?? undefined));
  }

  // ── Keyboard ───────────────────────────────────────────────────────────────
  // The listener is registered once, so it reads the current state through a ref
  // that is refreshed after every render.
  const latest = React.useRef({ state, autosave, commit, select });
  React.useEffect(() => {
    latest.current = { state, autosave, commit, select };
  });

  React.useEffect(() => {
    function onKeyDown(event: KeyboardEvent) {
      const { state: current, autosave: save } = latest.current;
      const meta = event.metaKey || event.ctrlKey;

      if (meta && event.key.toLowerCase() === "s") {
        event.preventDefault();
        void save.saveNow();
        return;
      }
      if (meta && event.key.toLowerCase() === "z") {
        event.preventDefault();
        dispatch({ type: event.shiftKey ? "redo" : "undo" });
        return;
      }
      if (meta && event.key.toLowerCase() === "y") {
        event.preventDefault();
        dispatch({ type: "redo" });
        return;
      }

      // Everything below is a bare key, so leave text fields alone.
      if (isTypingTarget(event.target)) return;

      if (event.key === "Escape") {
        latest.current.select(null);
        return;
      }

      const layerId = current.selectedLayerId;
      if (!layerId) return;

      if (event.key === "Delete" || event.key === "Backspace") {
        event.preventDefault();
        latest.current.commit(removeLayer(current.doc, layerId), { select: null });
        return;
      }

      const step = event.shiftKey ? NUDGE_UNITS_COARSE : NUDGE_UNITS;
      const delta =
        event.key === "ArrowLeft"
          ? { dx: -step, dy: 0 }
          : event.key === "ArrowRight"
            ? { dx: step, dy: 0 }
            : event.key === "ArrowUp"
              ? { dx: 0, dy: -step }
              : event.key === "ArrowDown"
                ? { dx: 0, dy: step }
                : null;
      if (!delta) return;
      event.preventDefault();
      latest.current.commit(nudgeLayer(current.doc, layerId, delta.dx, delta.dy), {
        coalesce: `nudge-${layerId}`,
      });
    }

    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, []);

  // ── Render ─────────────────────────────────────────────────────────────────
  /**
   * Overlays go to the editor's own asset route, not `/api/upload`.
   *
   * That route writes no database row: the overlay is referenced only from the
   * edit document and read back by the worker straight from Drive. Routing it
   * through the library endpoint would need a `groupId` and would put a
   * machine-generated PNG in the Media Library, which nothing should see until
   * the user transfers a finished render.
   */
  async function uploadOverlay(blob: Blob): Promise<string> {
    const form = new FormData();
    form.append("file", new File([blob], `overlay-${draftId}.png`, { type: "image/png" }));
    form.append("brandId", brandId);
    form.append("kind", "overlay");
    form.append("name", `Overlay for ${title || "edit"}`);
    form.append("width", String(state.doc.canvas.w));
    form.append("height", String(state.doc.canvas.h));

    // The kind also rides in the query string so the route can reject an
    // oversized body before buffering it.
    const response = await fetch("/api/editor/asset?kind=overlay", { method: "POST", body: form });
    const payload = await response.json().catch(() => null);
    if (!response.ok) {
      throw new Error(payload?.error || "Overlay upload failed");
    }
    if (!payload?.driveFileId) throw new Error("Overlay upload returned no Drive file");
    return payload.driveFileId as string;
  }

  /**
   * Flatten every layer to one transparent PNG so the server renderer only has
   * to composite a single image over the processed base.
   */
  async function rasterizeOverlay(doc: EditDoc): Promise<Blob | null> {
    let rasterizer: any = null;
    try {
      rasterizer = await import("@/lib/editor/rasterize");
    } catch {
      rasterizer = null;
    }
    if (!rasterizer || typeof rasterizer.rasterizeOverlays !== "function") {
      // Guarded on purpose: without the rasteriser the base still renders, and
      // saying so beats failing the whole render.
      toast.warning("Overlays could not be flattened — rendering the base only.");
      return null;
    }
    // Errors from the rasteriser itself propagate: a layer that silently fails
    // to draw would ship a render missing the thing the user just placed.
    return await rasterizer.rasterizeOverlays(doc, (layer: Layer) => resolveLayerSrc(layer) ?? "");
  }

  async function handleRender() {
    if (!brandId) return;
    setRenderBusy(true);
    try {
      await autosave.saveNow();

      if (state.doc.layers.length > 0) {
        const blob = await rasterizeOverlay(state.doc);
        if (blob) {
          const overlayDriveFileId = await uploadOverlay(blob);
          await updateDraft.mutateAsync({ id: draftId, overlayDriveFileId });
        }
      }

      await requestRender.mutateAsync({ id: draftId });
      toast.success("Render queued");
      await refetchDraft.current();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Could not start the render");
    } finally {
      setRenderBusy(false);
    }
  }

  async function handleSaveTemplate() {
    const name = window.prompt("Name this template", title || "Untitled template");
    if (!name?.trim()) return;
    try {
      await autosave.saveNow();
      await saveTemplate.mutateAsync({ brandId, name: name.trim(), docFromEditId: draftId });
      await utils.editor.listTemplates.invalidate();
      toast.success("Template saved");
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Could not save the template");
    }
  }

  async function handleTransfer() {
    try {
      await transferToLibrary.mutateAsync({ id: draftId, title: title || undefined });
      await utils.media.list.invalidate();
      toast.success("Added to the Media Library");
      router.push("/library");
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Could not transfer the edit");
    }
  }

  // ── States ─────────────────────────────────────────────────────────────────
  if (draftQuery.isLoading) {
    return (
      <div className="flex items-center justify-center h-64">
        <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-primary" />
      </div>
    );
  }

  if (draftQuery.error || !draft) {
    return (
      <div className="flex items-center justify-center h-64">
        <div className="text-center text-muted-foreground">
          <CircleAlert className="mx-auto mb-3 h-12 w-12 opacity-50" />
          <p className="font-medium">Edit not found</p>
          <p className="text-sm">
            {draftQuery.error?.message || "This draft may have been deleted"}
          </p>
        </div>
      </div>
    );
  }

  return (
    // Escapes the dashboard's p-6 so the stage can run edge to edge; the shell's
    // own header is h-14.
    <div className="-m-6 flex h-[calc(100svh-3.5rem)] flex-col overflow-hidden bg-background">
      <EditorTopBar
        title={title}
        onTitleChange={(next) => {
          setTitle(next);
          setTitleRevision((value) => value + 1);
        }}
        ratio={state.doc.canvas.ratio}
        onRatioChange={handleRatioChange}
        canUndo={canUndo(state)}
        canRedo={canRedo(state)}
        onUndo={() => dispatch({ type: "undo" })}
        onRedo={() => dispatch({ type: "redo" })}
        saveStatus={autosave.status}
        onSave={() => void autosave.saveNow()}
        onRender={() => void handleRender()}
        renderStatus={renderStatus}
        renderBusy={renderBusy || pending}
        onSaveTemplate={() => void handleSaveTemplate()}
      />

      {(renderStatus === "ready" || renderStatus === "failed") && (
        <RenderBanner
          status={renderStatus}
          error={draft.render_error}
          transferred={Boolean(draft.transferred_asset_id)}
          transferring={transferToLibrary.isPending}
          onTransfer={() => void handleTransfer()}
        />
      )}

      <div className="flex min-h-0 flex-1">
        <ToolRail
          tool={state.tool}
          onToolChange={(tool) => dispatch({ type: "setTool", tool })}
          layerCount={state.doc.layers.length}
        />
        <CanvasStage
          doc={state.doc}
          sourceUrl={sourceUrl}
          selectedLayerId={state.selectedLayerId}
          onSelect={select}
          onLayerGeometry={handleLayerGeometry}
          onSourceLoad={handleSourceLoad}
          resolveLayerSrc={resolveLayerSrc}
          onToggleMuteOriginal={() =>
            commit({
              ...state.doc,
              audio: { ...state.doc.audio, muteOriginal: !state.doc.audio.muteOriginal },
            })
          }
        />
        <Inspector api={api} tool={state.tool} />
      </div>
    </div>
  );
}

function RenderBanner({
  status,
  error,
  transferred,
  transferring,
  onTransfer,
}: {
  status: "ready" | "failed";
  error?: string | null;
  transferred: boolean;
  transferring: boolean;
  onTransfer: () => void;
}) {
  const ready = status === "ready";
  return (
    <div
      className={cn(
        "flex shrink-0 items-center gap-3 border-b px-4 py-2 text-sm",
        ready
          ? "border-emerald-500/20 bg-emerald-500/5 text-emerald-800 dark:text-emerald-300"
          : "border-destructive/20 bg-destructive/5 text-destructive"
      )}
    >
      {ready ? <Sparkles className="h-4 w-4 shrink-0" /> : <CircleAlert className="h-4 w-4 shrink-0" />}
      <span className="min-w-0 flex-1 truncate">
        {ready
          ? transferred
            ? "This render is already in the Media Library."
            : "The render is ready."
          : error || "The render failed."}
      </span>
      <RenderStatusBadge status={status} />
      {ready && !transferred && (
        <Button size="sm" variant="outline" onClick={onTransfer} disabled={transferring}>
          {transferring && <Loader2 className="animate-spin" />}
          Transfer to Media Library
        </Button>
      )}
    </div>
  );
}
