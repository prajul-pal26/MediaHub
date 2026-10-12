"use client";

import type { EditorApi } from "../api";
import { EffectsPanel as EffectsLibraryPanel } from "../library/EffectsPanel";

/**
 * Colour adjustments.
 *
 * The panel itself owns the catalog and the controls; the shell's only job is to
 * fold the new effect list into the document. One coalesce key covers the whole
 * run of dialling, so a session at the sliders is a single undo step rather than
 * one per pointer move.
 */
export function EffectsPanel({ api }: { api: EditorApi }) {
  return (
    <EffectsLibraryPanel
      effects={api.doc.effects}
      onChange={(effects) => api.commit({ ...api.doc, effects }, { coalesce: "effects" })}
    />
  );
}
