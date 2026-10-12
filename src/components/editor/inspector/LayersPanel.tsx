"use client";

import { Layers, Lock, LockOpen, MoveDown, MoveUp, Square, Trash2, Type } from "lucide-react";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import type { Layer } from "@/lib/editor/doc";
import type { EditorApi } from "../api";
import { PanelEmpty, PanelHeader } from "../library/panel-chrome";
import { removeLayer, reorderLayer, stackOrder, updateLayer } from "../doc-ops";

/** The stack, front to back. */
export function LayersPanel({ api }: { api: EditorApi }) {
  const { doc } = api;
  const layers = stackOrder(doc);

  return (
    <div className="space-y-4">
      <PanelHeader icon={Layers} title="Layers" hint="Everything stacked over the base media" />

      {layers.length === 0 ? (
        <PanelEmpty
          icon={Layers}
          title="Nothing on top yet"
          hint="Add a sticker or some text and it will appear here."
        />
      ) : (
        <LayerRows api={api} layers={layers} />
      )}
    </div>
  );
}

function LayerRows({ api, layers }: { api: EditorApi; layers: Layer[] }) {
  const { doc } = api;
  return (
    <div className="space-y-1">
      {layers.map((layer, index) => {
        const selected = api.selectedLayer?.id === layer.id;
        return (
          <div
            key={layer.id}
            className={cn(
              "group flex items-center gap-2 rounded-lg border px-2 py-1.5 transition-colors",
              selected ? "border-primary bg-primary/5" : "border-transparent hover:bg-muted"
            )}
          >
            <button
              type="button"
              onClick={() => api.select(layer.id)}
              className="flex min-w-0 flex-1 items-center gap-2 text-left"
            >
              <LayerThumb layer={layer} src={api.resolveLayerSrc(layer)} />
              <span className="min-w-0 flex-1">
                <span className="block truncate text-xs font-medium">{layerName(layer)}</span>
                <span className="block text-[10px] text-muted-foreground">
                  {Math.round(layer.opacity * 100)}%
                  {layer.rotation !== 0 && ` · ${Math.round(layer.rotation)}°`}
                </span>
              </span>
            </button>

            <div className="flex items-center opacity-0 transition-opacity group-hover:opacity-100 has-[:focus-visible]:opacity-100">
              <Button
                variant="ghost"
                size="icon-xs"
                aria-label="Bring forward"
                disabled={index === 0}
                onClick={() => api.commit(reorderLayer(doc, layer.id, "up"))}
              >
                <MoveUp />
              </Button>
              <Button
                variant="ghost"
                size="icon-xs"
                aria-label="Send backward"
                disabled={index === layers.length - 1}
                onClick={() => api.commit(reorderLayer(doc, layer.id, "down"))}
              >
                <MoveDown />
              </Button>
              <Button
                variant="ghost"
                size="icon-xs"
                aria-label={layer.locked ? "Unlock layer" : "Lock layer"}
                onClick={() => api.commit(updateLayer(doc, layer.id, { locked: !layer.locked }))}
              >
                {layer.locked ? <Lock /> : <LockOpen />}
              </Button>
              <Button
                variant="ghost"
                size="icon-xs"
                aria-label="Delete layer"
                className="text-destructive"
                onClick={() => api.commit(removeLayer(doc, layer.id), { select: null })}
              >
                <Trash2 />
              </Button>
            </div>
          </div>
        );
      })}
    </div>
  );
}

export function layerName(layer: Layer): string {
  if (layer.type === "text") {
    const content = layer.text?.content?.split("\n")[0]?.trim();
    return content ? content.slice(0, 32) : "Empty text";
  }
  if (layer.type === "shape") return "Shape";
  return "Sticker";
}

function LayerThumb({ layer, src }: { layer: Layer; src: string | null }) {
  if (layer.type === "image" && src) {
    return (
      <span className="flex h-7 w-7 shrink-0 items-center justify-center overflow-hidden rounded border border-border bg-muted">
        <img src={src} alt="" className="h-full w-full object-contain" draggable={false} />
      </span>
    );
  }
  const Icon = layer.type === "text" ? Type : Square;
  return (
    <span className="flex h-7 w-7 shrink-0 items-center justify-center rounded border border-border bg-muted text-muted-foreground">
      <Icon className="h-3.5 w-3.5" />
    </span>
  );
}
