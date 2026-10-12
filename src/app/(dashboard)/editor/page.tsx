"use client";

import { useBrand } from "@/lib/hooks/use-brand";
import { DraftsGallery } from "@/components/editor/DraftsGallery";

export default function EditorPage() {
  const { activeBrandId, loading } = useBrand();

  if (loading) {
    return (
      <div className="flex items-center justify-center h-64">
        <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-primary" />
      </div>
    );
  }

  if (!activeBrandId) {
    return (
      <div className="space-y-6">
        <h1 className="text-2xl font-bold">Editor</h1>
        <p className="text-muted-foreground">Create a brand first to start editing media.</p>
      </div>
    );
  }

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-bold">Editor</h1>
        <p className="text-muted-foreground">Crop, filter and caption media before you publish it</p>
      </div>
      <DraftsGallery brandId={activeBrandId} />
    </div>
  );
}
