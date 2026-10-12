"use client";

import { Film } from "lucide-react";
import type { EditorApi } from "../api";
import { AudioLibrary } from "../library/AudioLibrary";

/**
 * Music for the edit — a reusable, brand-wide library, not a per-edit upload.
 *
 * Available for photos as well as video. Attaching a track to a photo makes the
 * render an MP4: the still frame is produced by the same sharp pipeline as a
 * photo-only edit, then ffmpeg wraps that one frame with the audio. The output
 * therefore publishes as a reel or a video post rather than a photo post, so
 * the panel says that out loud instead of letting it be a surprise at publish
 * time.
 */
export function AudioPanel({ api }: { api: EditorApi }) {
  const { doc } = api;
  const willBecomeVideo = doc.base.kind === "image" && Boolean(doc.audio.trackId);

  return (
    <div className="space-y-4">
      <AudioLibrary
        brandId={api.brandId}
        selectedTrackId={doc.audio.trackId}
        onSelect={(track) =>
          api.commit({ ...doc, audio: { ...doc.audio, trackId: track?.id ?? null } })
        }
        audio={doc.audio}
        onAudioChange={(audio) => api.commit({ ...doc, audio }, { coalesce: "audio" })}
      />

      {willBecomeVideo && (
        <div className="flex gap-2 rounded-lg border border-primary/30 bg-primary/5 p-3 text-xs">
          <Film className="mt-px h-4 w-4 shrink-0 text-primary" />
          <p className="text-muted-foreground">
            <span className="font-medium text-foreground">This photo will render as a video.</span>{" "}
            Its length comes from the track, and it publishes as a reel or video post rather than a
            photo post.
          </p>
        </div>
      )}
    </div>
  );
}
