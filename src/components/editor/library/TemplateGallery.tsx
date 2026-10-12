"use client";

import { useMemo, useState } from "react";
import { trpc } from "@/lib/trpc/client";
import { toast } from "sonner";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import {
  LayoutTemplate,
  Loader2,
  Save,
  Trash2,
  TriangleAlert,
} from "lucide-react";
import {
  InlineNameForm,
  PanelEmpty,
  PanelError,
  PanelHeader,
  PanelLoading,
} from "./panel-chrome";
import {
  normalizeList,
  normalizeTemplate,
  type EditorTemplate,
} from "./types";

/**
 * Saved templates for the brand.
 *
 * Applying one replaces the layers, effects and audio of the open draft, so the
 * Apply button never fires on the first click: it turns into an inline warning
 * first. Templates get reused constantly, and silently overwriting half an hour
 * of in-progress work is not recoverable from this panel.
 */

interface TemplateGalleryProps {
  brandId: string;
  currentEditId?: string | null;
  onApply: (templateId: string) => void;
}

const KIND_LABELS: Record<string, string> = {
  image: "Image",
  video: "Video",
  any: "Any",
};

export function TemplateGallery({ brandId, currentEditId, onApply }: TemplateGalleryProps) {
  const utils = trpc.useUtils();

  const [saving, setSaving] = useState(false);
  const [confirmingId, setConfirmingId] = useState<string | null>(null);
  const [deletingId, setDeletingId] = useState<string | null>(null);

  const templatesQuery = trpc.editor.listTemplates.useQuery(
    { brandId },
    { enabled: Boolean(brandId) }
  );

  const templates = useMemo<EditorTemplate[]>(
    () => normalizeList(templatesQuery.data, normalizeTemplate),
    [templatesQuery.data]
  );

  const saveTemplate = trpc.editor.saveTemplate.useMutation({
    onSuccess: async () => {
      setSaving(false);
      await utils.editor.listTemplates.invalidate();
      toast.success("Template saved");
    },
    onError: (error) => toast.error(error.message),
  });

  const deleteTemplate = trpc.editor.deleteTemplate.useMutation({
    onSuccess: async () => {
      await utils.editor.listTemplates.invalidate();
    },
    onError: (error) => toast.error(error.message),
    onSettled: () => setDeletingId(null),
  });

  function handleApply(templateId: string) {
    setConfirmingId(null);
    onApply(templateId);
  }

  return (
    <div className="space-y-3">
      <PanelHeader
        icon={LayoutTemplate}
        title="Templates"
        hint="A saved look you can drop onto any media"
      >
        {/* Saving needs a draft to copy the document from, so the control only
            exists when there is one. */}
        {currentEditId && !saving && (
          <Button
            type="button"
            size="xs"
            variant="outline"
            onClick={() => setSaving(true)}
            disabled={saveTemplate.isPending}
          >
            <Save />
            Save current
          </Button>
        )}
      </PanelHeader>

      {saving && currentEditId && (
        <InlineNameForm
          placeholder="Template name"
          submitLabel="Save template"
          busy={saveTemplate.isPending}
          onSubmit={(name) =>
            saveTemplate.mutate({ brandId, name, docFromEditId: currentEditId })
          }
          onCancel={() => setSaving(false)}
        />
      )}

      {templatesQuery.isLoading ? (
        <PanelLoading label="Loading templates..." />
      ) : templatesQuery.error ? (
        <PanelError
          message={templatesQuery.error.message}
          onRetry={() => templatesQuery.refetch()}
          retrying={templatesQuery.isFetching}
        />
      ) : templates.length === 0 ? (
        <PanelEmpty
          icon={LayoutTemplate}
          title="No templates yet"
          hint={
            currentEditId
              ? "Save this edit as a template to reuse its layers, effects and audio."
              : "Open an edit and save it as a template to reuse its layers, effects and audio."
          }
        />
      ) : (
        <div className="grid grid-cols-2 gap-2">
          {templates.map((template) => (
            <TemplateCard
              key={template.id}
              template={template}
              confirming={confirmingId === template.id}
              deleting={deletingId === template.id}
              onRequestApply={() => setConfirmingId(template.id)}
              onCancelApply={() => setConfirmingId(null)}
              onConfirmApply={() => handleApply(template.id)}
              onDelete={() => {
                setConfirmingId((current) => (current === template.id ? null : current));
                setDeletingId(template.id);
                deleteTemplate.mutate({ id: template.id });
              }}
            />
          ))}
        </div>
      )}
    </div>
  );
}

function TemplateCard({
  template,
  confirming,
  deleting,
  onRequestApply,
  onCancelApply,
  onConfirmApply,
  onDelete,
}: {
  template: EditorTemplate;
  confirming: boolean;
  deleting: boolean;
  onRequestApply: () => void;
  onCancelApply: () => void;
  onConfirmApply: () => void;
  onDelete: () => void;
}) {
  const [thumbFailed, setThumbFailed] = useState(false);
  const showThumb = Boolean(template.thumb) && !thumbFailed;

  return (
    <div
      className={cn(
        "group flex flex-col overflow-hidden rounded-lg border bg-card transition-colors",
        confirming ? "border-destructive/40" : "hover:border-muted-foreground/40",
        deleting && "opacity-50"
      )}
    >
      <div className="relative flex aspect-square items-center justify-center bg-muted/50">
        {showThumb ? (
          // eslint-disable-next-line @next/next/no-img-element
          <img
            src={template.thumb as string}
            alt=""
            loading="lazy"
            draggable={false}
            onError={() => setThumbFailed(true)}
            className="h-full w-full object-cover"
          />
        ) : (
          <LayoutTemplate className="h-6 w-6 text-muted-foreground opacity-40" />
        )}

        <Button
          type="button"
          size="icon-xs"
          variant="ghost"
          disabled={deleting}
          onClick={onDelete}
          aria-label={`Delete ${template.name}`}
          title="Delete"
          className="absolute top-1 right-1 bg-background/85 opacity-0 transition-opacity group-hover:opacity-100 focus-visible:opacity-100 hover:text-destructive"
        >
          {deleting ? <Loader2 className="animate-spin" /> : <Trash2 />}
        </Button>
      </div>

      <div className="flex min-w-0 flex-1 flex-col gap-2 p-2">
        <div className="min-w-0 space-y-1">
          <p className="truncate text-xs font-medium" title={template.name}>
            {template.name}
          </p>
          <Badge variant="secondary" className="h-4 px-1.5 text-[10px]">
            {KIND_LABELS[template.kind] ?? template.kind}
          </Badge>
        </div>

        {confirming ? (
          <div className="space-y-1.5">
            <p className="flex gap-1.5 text-[11px] leading-snug text-destructive">
              <TriangleAlert className="mt-px h-3 w-3 shrink-0" />
              <span>Replaces the current layers, effects and audio.</span>
            </p>
            <div className="flex gap-1">
              <Button
                type="button"
                size="xs"
                variant="destructive"
                className="flex-1"
                onClick={onConfirmApply}
              >
                Replace
              </Button>
              <Button type="button" size="xs" variant="ghost" onClick={onCancelApply}>
                Cancel
              </Button>
            </div>
          </div>
        ) : (
          <Button
            type="button"
            size="xs"
            variant="outline"
            className="mt-auto w-full"
            disabled={deleting}
            onClick={onRequestApply}
          >
            Apply
          </Button>
        )}
      </div>
    </div>
  );
}
