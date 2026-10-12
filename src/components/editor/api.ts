import type { EditDoc, Layer } from "@/lib/editor/doc";
import type { EditorTool } from "./editor-state";

/** Intrinsic facts about the base file, read from the loaded <img>/<video>. */
export interface SourceInfo {
  w: number;
  h: number;
  durationSeconds: number | null;
}

export interface CommitOptions {
  /**
   * Groups a continuous gesture (a slider drag, say) into one undo step. Pass a
   * stable key for the duration of the gesture.
   */
  coalesce?: string;
  /** Change the selection in the same step. `null` deselects. */
  select?: string | null;
}

/**
 * What an inspector panel is allowed to do.
 *
 * Panels never hold document state of their own: they read `doc` and hand a new
 * document back through `commit`, which is what keeps undo/redo and autosave
 * correct no matter which panel made the change.
 */
export interface EditorApi {
  doc: EditDoc;
  /** Null until the base media has loaded (or when there is no base). */
  source: SourceInfo | null;
  selectedLayer: Layer | null;
  commit: (next: EditDoc, options?: CommitOptions) => void;
  select: (layerId: string | null) => void;
  setTool: (tool: EditorTool) => void;
  /** Preview URL for an image layer, or null when it cannot be resolved. */
  resolveLayerSrc: (layer: Layer) => string | null;
  brandId: string;
  draftId: string;
  /**
   * Re-read the draft from the server and reset history. Needed after a server
   * mutation rewrites the document — applying a template, for instance.
   */
  reload: () => Promise<void>;
}
