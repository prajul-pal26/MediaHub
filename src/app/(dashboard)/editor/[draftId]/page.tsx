"use client";

import { use } from "react";
import { EditorWorkspace } from "@/components/editor/EditorWorkspace";

export default function EditorDraftPage({
  params,
}: {
  params: Promise<{ draftId: string }>;
}) {
  const { draftId } = use(params);

  return <EditorWorkspace draftId={draftId} />;
}
