"use client";

import { Type } from "lucide-react";
import { cn } from "@/lib/utils";
import type { EditorApi } from "../api";
import { PanelSection } from "../controls";
import { PanelHeader } from "../library/panel-chrome";
import { TEXT_PRESETS, addLayer, createTextLayer } from "../doc-ops";

/**
 * Adding text. Editing it belongs to the selected-layer inspector, so this panel
 * stays a short menu rather than a second copy of every typography control.
 */
export function TextPanel({ api }: { api: EditorApi }) {
  const { doc } = api;
  const textLayers = doc.layers.filter((layer) => layer.type === "text");

  function add(presetKey: string) {
    const preset = TEXT_PRESETS.find((p) => p.key === presetKey);
    if (!preset) return;
    const layer = createTextLayer(doc, preset);
    api.commit(addLayer(doc, layer), { select: layer.id });
  }

  return (
    <div className="space-y-6">
      <PanelHeader icon={Type} title="Text" hint="Pick a size — edit it on the canvas" />

      <PanelSection title="Add text">
        <div className="space-y-1.5">
          {TEXT_PRESETS.map((preset) => (
            <button
              key={preset.key}
              type="button"
              onClick={() => add(preset.key)}
              className="flex w-full items-center gap-2.5 rounded-lg border border-border px-2.5 py-2 text-left transition-colors hover:border-primary/40 hover:bg-muted"
            >
              <Type className="h-4 w-4 shrink-0 text-muted-foreground" />
              <span className="min-w-0 flex-1">
                <span
                  className="block truncate font-semibold text-foreground"
                  style={{ fontSize: `${Math.min(16, preset.sizeInUnits * 120)}px` }}
                >
                  {preset.label}
                </span>
              </span>
            </button>
          ))}
        </div>
      </PanelSection>

      {textLayers.length > 0 && (
        <PanelSection title="In this edit">
          <div className="space-y-1">
            {textLayers.map((layer) => (
              <button
                key={layer.id}
                type="button"
                onClick={() => api.select(layer.id)}
                className={cn(
                  "flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-xs transition-colors",
                  api.selectedLayer?.id === layer.id
                    ? "bg-primary/10 text-primary"
                    : "text-muted-foreground hover:bg-muted hover:text-foreground"
                )}
              >
                <Type className="h-3.5 w-3.5 shrink-0" />
                <span className="truncate">{layer.text?.content || "Empty text"}</span>
              </button>
            ))}
          </div>
        </PanelSection>
      )}
    </div>
  );
}
