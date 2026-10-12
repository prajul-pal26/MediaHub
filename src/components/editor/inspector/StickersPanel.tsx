"use client";

import type { EditorApi } from "../api";
import { StickerLibrary } from "../library/StickerLibrary";
import { addLayer, createStickerLayer } from "../doc-ops";

/**
 * The brand's sticker packs. The library panel owns browsing and uploading; the
 * shell turns whatever is picked into a layer and selects it, so the user lands
 * straight on its controls.
 */
export function StickersPanel({ api }: { api: EditorApi }) {
  return (
    <StickerLibrary
      brandId={api.brandId}
      onPick={(sticker) => {
        const layer = createStickerLayer(api.doc, sticker);
        api.commit(addLayer(api.doc, layer), { select: layer.id });
      }}
    />
  );
}
