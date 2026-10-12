"use client";

import { toast } from "sonner";
import { trpc } from "@/lib/trpc/client";
import type { EditorApi } from "../api";
import { TemplateGallery } from "../library/TemplateGallery";

/**
 * Applying a saved template.
 *
 * `applyTemplateToDraft` rewrites the document on the server — it re-solves the
 * crop and every length for this source and ratio — so the editor reloads the
 * draft afterwards rather than guessing at the result locally.
 */
export function TemplatesSection({ api }: { api: EditorApi }) {
  const applyTemplate = trpc.editor.applyTemplateToDraft.useMutation({
    onSuccess: async () => {
      await api.reload();
      toast.success("Template applied");
    },
    onError: (error) => toast.error(error.message),
  });

  return (
    <TemplateGallery
      brandId={api.brandId}
      currentEditId={api.draftId}
      onApply={(templateId) =>
        applyTemplate.mutate({
          templateId,
          draftId: api.draftId,
          ratio: api.doc.canvas.ratio,
        })
      }
    />
  );
}
