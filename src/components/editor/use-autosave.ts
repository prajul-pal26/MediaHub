"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import type { EditDoc } from "@/lib/editor/doc";
import { trpc } from "@/lib/trpc/client";

export type SaveStatus = "idle" | "dirty" | "saving" | "saved" | "error";

const AUTOSAVE_DELAY_MS = 1500;

interface UseAutosaveOptions {
  draftId: string;
  doc: EditDoc;
  /** Monotonic counter from the reducer — the only thing that marks work dirty. */
  revision: number;
  title: string;
  enabled: boolean;
}

export interface Autosave {
  status: SaveStatus;
  error: string | null;
  /** Flush immediately (the Save button, and before rendering). */
  saveNow: () => Promise<void>;
}

/**
 * Debounced autosave for the open draft.
 *
 * Saves are keyed off the reducer's `revision`, never off document identity: a
 * poll of `getDraft` hands back a structurally new document object every few
 * seconds and must not be mistaken for an edit.
 */
export function useAutosave({ draftId, doc, revision, title, enabled }: UseAutosaveOptions): Autosave {
  const [status, setStatus] = useState<SaveStatus>("idle");
  const [error, setError] = useState<string | null>(null);

  const updateDraft = trpc.editor.updateDraft.useMutation();

  /**
   * Everything the debounced save needs, refreshed after every render: a timer
   * armed several edits ago must still write the newest document.
   *
   * This effect is declared first on purpose — effects run in order, so the ref
   * is current before the timer below is armed.
   */
  const latest = useRef({ doc, title, revision, mutate: updateDraft.mutateAsync });
  useEffect(() => {
    latest.current = { doc, title, revision, mutate: updateDraft.mutateAsync };
  });

  const savedRevisionRef = useRef(revision);
  const inFlightRef = useRef(false);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const flush = useCallback(async () => {
    if (!enabled) return;
    const { doc: pendingDoc, title: pendingTitle, revision: pendingRevision, mutate } = latest.current;
    if (pendingRevision === savedRevisionRef.current) return;
    if (inFlightRef.current) return;

    inFlightRef.current = true;
    setStatus("saving");
    try {
      // The server requires a non-empty title, so an emptied field keeps the
      // stored one rather than failing a save the user did not ask about.
      const trimmed = pendingTitle.trim();
      await mutate({ id: draftId, doc: pendingDoc, ...(trimmed ? { title: trimmed } : {}) });
      savedRevisionRef.current = pendingRevision;
      setError(null);
      // Edits that landed mid-flight leave the draft dirty again.
      setStatus(latest.current.revision === pendingRevision ? "saved" : "dirty");
    } catch (e) {
      setStatus("error");
      setError(e instanceof Error ? e.message : "Could not save");
    } finally {
      inFlightRef.current = false;
    }
  }, [draftId, enabled]);

  const flushRef = useRef(flush);
  useEffect(() => {
    flushRef.current = flush;
  });

  useEffect(() => {
    if (!enabled) return;
    if (revision === savedRevisionRef.current) return;

    setStatus("dirty");
    if (timerRef.current) clearTimeout(timerRef.current);
    timerRef.current = setTimeout(() => {
      timerRef.current = null;
      void flushRef.current();
    }, AUTOSAVE_DELAY_MS);

    return () => {
      if (timerRef.current) clearTimeout(timerRef.current);
    };
  }, [revision, enabled]);

  // Leaving the page mid-debounce would otherwise drop the edit silently.
  // Client-side navigation unmounts us, so send the pending save on the way out;
  // deliberately without `setStatus`, since nothing is left to render it.
  useEffect(() => {
    return () => {
      const { doc: pendingDoc, title: pendingTitle, revision: pendingRevision, mutate } = latest.current;
      if (pendingRevision === savedRevisionRef.current || inFlightRef.current) return;
      const trimmed = pendingTitle.trim();
      void mutate({
        id: draftId,
        doc: pendingDoc,
        ...(trimmed ? { title: trimmed } : {}),
      }).catch(() => {});
    };
  }, [draftId]);

  // A full reload cannot be awaited, so the browser prompt is the only guard.
  useEffect(() => {
    if (status !== "dirty" && status !== "saving") return;
    function warn(event: BeforeUnloadEvent) {
      event.preventDefault();
    }
    window.addEventListener("beforeunload", warn);
    return () => window.removeEventListener("beforeunload", warn);
  }, [status]);

  const saveNow = useCallback(async () => {
    if (timerRef.current) {
      clearTimeout(timerRef.current);
      timerRef.current = null;
    }
    await flushRef.current();
  }, []);

  return { status, error, saveNow };
}
