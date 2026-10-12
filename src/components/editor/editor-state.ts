import type { EditDoc } from "@/lib/editor/doc";

/**
 * Editor state: one document, one selection, one active tool, and an undo stack.
 *
 * The document is treated as immutable throughout — `past` and `future` hold
 * references to earlier documents, so every edit must produce a new object (see
 * doc-ops.ts). A single in-place mutation would silently rewrite history.
 */

export type EditorTool =
  | "adjust"
  | "stickers"
  | "text"
  | "effects"
  | "audio"
  | "templates"
  | "layers";

export interface EditorState {
  doc: EditDoc;
  past: EditDoc[];
  future: EditDoc[];
  selectedLayerId: string | null;
  tool: EditorTool;
  /**
   * Bumped on every document change. The autosave effect watches this rather
   * than the document itself so a server refetch can never look like an edit.
   */
  revision: number;
  /** Set by the last coalescing commit so a continuous gesture is one undo step. */
  coalesceKey: string | null;
}

export type EditorAction =
  /** Replace the document and drop history — loading a draft, nothing more. */
  | { type: "load"; doc: EditDoc }
  /**
   * Apply an edit. `coalesce` groups a run of commits sharing the same key into
   * a single history entry, which is what keeps dragging a slider from filling
   * the undo stack with hundreds of near-identical documents.
   */
  | { type: "commit"; doc: EditDoc; coalesce?: string; select?: string | null }
  | { type: "undo" }
  | { type: "redo" }
  | { type: "select"; layerId: string | null }
  | { type: "setTool"; tool: EditorTool };

/** Deep enough for a long session, shallow enough to stay cheap to hold. */
const HISTORY_LIMIT = 60;

export function initialEditorState(doc: EditDoc): EditorState {
  return {
    doc,
    past: [],
    future: [],
    selectedLayerId: null,
    tool: "adjust",
    revision: 0,
    coalesceKey: null,
  };
}

export function canUndo(state: EditorState): boolean {
  return state.past.length > 0;
}

export function canRedo(state: EditorState): boolean {
  return state.future.length > 0;
}

/** Drop a selection that points at a layer the document no longer contains. */
function validSelection(doc: EditDoc, selectedLayerId: string | null): string | null {
  if (!selectedLayerId) return null;
  return doc.layers.some((l) => l.id === selectedLayerId) ? selectedLayerId : null;
}

export function editorReducer(state: EditorState, action: EditorAction): EditorState {
  switch (action.type) {
    case "load":
      return initialEditorState(action.doc);

    case "commit": {
      if (action.doc === state.doc) return state;
      const coalescing = action.coalesce != null && action.coalesce === state.coalesceKey;
      const past = coalescing
        ? state.past
        : [...state.past, state.doc].slice(-HISTORY_LIMIT);
      const selectedLayerId =
        action.select !== undefined ? action.select : state.selectedLayerId;
      return {
        ...state,
        doc: action.doc,
        past,
        future: [],
        selectedLayerId: validSelection(action.doc, selectedLayerId),
        revision: state.revision + 1,
        coalesceKey: action.coalesce ?? null,
      };
    }

    case "undo": {
      const previous = state.past[state.past.length - 1];
      if (!previous) return state;
      return {
        ...state,
        doc: previous,
        past: state.past.slice(0, -1),
        future: [state.doc, ...state.future].slice(0, HISTORY_LIMIT),
        selectedLayerId: validSelection(previous, state.selectedLayerId),
        revision: state.revision + 1,
        coalesceKey: null,
      };
    }

    case "redo": {
      const next = state.future[0];
      if (!next) return state;
      return {
        ...state,
        doc: next,
        past: [...state.past, state.doc].slice(-HISTORY_LIMIT),
        future: state.future.slice(1),
        selectedLayerId: validSelection(next, state.selectedLayerId),
        revision: state.revision + 1,
        coalesceKey: null,
      };
    }

    case "select":
      if (state.selectedLayerId === action.layerId) return state;
      return {
        ...state,
        selectedLayerId: validSelection(state.doc, action.layerId),
        // A new selection ends any gesture, so the next edit starts a new step.
        coalesceKey: null,
      };

    case "setTool":
      if (state.tool === action.tool) return state;
      return { ...state, tool: action.tool, coalesceKey: null };

    default:
      return state;
  }
}
