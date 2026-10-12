"use client";

import type { EditorApi } from "../api";
import type { EditorTool } from "../editor-state";
import { AdjustPanel } from "./AdjustPanel";
import { AudioPanel } from "./AudioPanel";
import { EffectsPanel } from "./EffectsPanel";
import { LayerInspector } from "./LayerInspector";
import { LayersPanel } from "./LayersPanel";
import { StickersPanel } from "./StickersPanel";
import { TemplatesSection } from "./TemplatesSection";
import { TextPanel } from "./TextPanel";

/**
 * The contextual inspector: the only place controls live, and it shows exactly
 * one context — the selected layer if there is one, otherwise the active tool.
 *
 * Selection wins over the tool because a selection is the more specific intent;
 * Escape clears it and the tool's own panel comes back.
 */
export function Inspector({ api, tool }: { api: EditorApi; tool: EditorTool }) {
  const layer = api.selectedLayer;

  return (
    <aside
      aria-label="Inspector"
      className="flex w-72 shrink-0 flex-col overflow-y-auto border-l border-border bg-card"
    >
      {/* Each panel titles itself, so the shell adds no heading of its own. */}
      <div className="p-4">
        {layer ? <LayerInspector api={api} layer={layer} /> : <ToolPanel api={api} tool={tool} />}
      </div>
    </aside>
  );
}

function ToolPanel({ api, tool }: { api: EditorApi; tool: EditorTool }) {
  switch (tool) {
    case "adjust":
      return <AdjustPanel api={api} />;
    case "stickers":
      return <StickersPanel api={api} />;
    case "text":
      return <TextPanel api={api} />;
    case "effects":
      return <EffectsPanel api={api} />;
    case "audio":
      return <AudioPanel api={api} />;
    case "templates":
      return <TemplatesSection api={api} />;
    case "layers":
      return <LayersPanel api={api} />;
    default:
      return null;
  }
}
