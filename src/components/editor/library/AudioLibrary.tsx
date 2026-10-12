"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { trpc } from "@/lib/trpc/client";
import { toast } from "sonner";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Slider } from "@/components/ui/slider";
import { Switch } from "@/components/ui/switch";
import { cn } from "@/lib/utils";
import type { EditDoc } from "@/lib/editor/doc";
import {
  MAX_INSTAGRAM_URL_LENGTH,
  parseInstagramMediaUrl,
} from "@/lib/editor/instagram-audio";
import {
  Check,
  Clapperboard,
  Loader2,
  Music2,
  Pause,
  Play,
  Trash2,
  TriangleAlert,
  Upload,
  VolumeX,
} from "lucide-react";
import {
  DropZone,
  PanelBusy,
  PanelEmpty,
  PanelError,
  PanelGroup,
  PanelHeader,
  PanelLoading,
} from "./panel-chrome";
import {
  AUDIO_ACCEPT,
  editorAssetUrl,
  fileLabel,
  formatDuration,
  formatSeconds,
  isAudioFile,
  isTrackPlayable,
  measureAudioDurationMs,
  normalizeAudioTrack,
  normalizeList,
  uploadEditorAsset,
  type EditorAudioTrack,
} from "./types";

/**
 * The reusable audio library.
 *
 * Tracks are saved to the brand once and then picked from this list on every
 * later edit — adding one is the exception, not the flow. The controls below the
 * list are bound straight to `doc.audio`, including "mute original video audio",
 * which applies to both posts and reels.
 *
 * Two ways in: upload a file, or paste an Instagram reel/post link and have its
 * audio extracted. The second is asynchronous and visibly so — ffmpeg lives in
 * the worker image, not the `app` one, so the row arrives `importing` and this
 * panel polls until it is `ready` or `failed`. A failed row keeps its reason
 * instead of disappearing, because "Instagram refused this" is something the
 * user has to be told rather than something to retry silently.
 */

type AudioSettings = EditDoc["audio"];

interface AudioLibraryProps {
  brandId: string;
  selectedTrackId: string | null;
  onSelect: (track: { id: string; name: string; durationMs: number } | null) => void;
  audio: AudioSettings;
  onAudioChange: (next: AudioSettings) => void;
}

/** Longest fade the UI offers. Anything longer is better expressed as a trim. */
const MAX_FADE_SECONDS = 10;
/** Offset ceiling when the track's duration could not be decoded. */
const FALLBACK_OFFSET_SECONDS = 60;

export function AudioLibrary({
  brandId,
  selectedTrackId,
  onSelect,
  audio,
  onAudioChange,
}: AudioLibraryProps) {
  const utils = trpc.useUtils();

  const [upload, setUpload] = useState<{ done: number; total: number } | null>(null);
  const [deletingId, setDeletingId] = useState<string | null>(null);
  const [playingId, setPlayingId] = useState<string | null>(null);
  const [importUrl, setImportUrl] = useState("");
  const [importUrlError, setImportUrlError] = useState<string | null>(null);

  // One element for every preview. A per-row <audio> would let two tracks play
  // over each other and would hold a Drive stream open per row.
  const playerRef = useRef<HTMLAudioElement | null>(null);
  const loadedIdRef = useRef<string | null>(null);

  const tracksQuery = trpc.editor.listAudio.useQuery(
    { brandId },
    {
      enabled: Boolean(brandId),
      // Keep polling only while an import is in flight; the interval option is
      // re-read each render, so it stops on its own once nothing is importing.
      refetchInterval: (query: any) =>
        normalizeList(query?.state?.data, normalizeAudioTrack).some(
          (track) => track.importStatus === "importing"
        )
          ? 3000
          : false,
    }
  );

  const tracks = useMemo<EditorAudioTrack[]>(
    () => normalizeList(tracksQuery.data, normalizeAudioTrack),
    [tracksQuery.data]
  );

  // The shell owns the selection, but the document carries `audio.trackId` too;
  // reading both means the panel shows the right row whichever one was set.
  const activeTrackId = selectedTrackId ?? audio.trackId ?? null;
  // Only ever a finished track: the Mix controls below are meaningless for a row
  // whose bytes have not arrived, and its duration is not yet known.
  const activeTrack =
    tracks.find((track) => track.id === activeTrackId && isTrackPlayable(track)) ?? null;

  const deleteAudio = trpc.editor.deleteAudio.useMutation({
    onSuccess: async (_result, variables) => {
      if (variables.id === activeTrackId) onSelect(null);
      await utils.editor.listAudio.invalidate();
    },
    onError: (error) => toast.error(error.message),
    onSettled: () => setDeletingId(null),
  });

  const importAudio = trpc.editor.importAudioFromUrl.useMutation({
    onSuccess: async (row: any) => {
      // The mutation only queues the job, so there is nothing to celebrate yet
      // — and it can come back already failed if the queue itself was
      // unreachable, which is the one case worth a toast.
      if (row?.import_status === "failed") {
        toast.error(row.import_error || "Could not start the import");
      } else {
        setImportUrl("");
        setImportUrlError(null);
      }
      await utils.editor.listAudio.invalidate();
    },
    onError: (error) => setImportUrlError(error.message),
  });

  function validateImportUrl(value: string): string | null {
    const parsed = parseInstagramMediaUrl(value);
    return parsed.ok ? null : parsed.reason;
  }

  function submitImport() {
    if (importAudio.isPending) return;
    const value = importUrl.trim();
    // Validated here as well as on the server so an obvious typo costs no round
    // trip and leaves no failed row behind. The server check is the real gate.
    const reason = validateImportUrl(value);
    if (reason) {
      setImportUrlError(reason);
      return;
    }
    setImportUrlError(null);
    importAudio.mutate({ brandId, url: value });
  }

  // ── Preview ────────────────────────────────────────────────────────────────
  function stopPreview() {
    playerRef.current?.pause();
    setPlayingId(null);
  }

  useEffect(() => {
    // Never leave a stream playing behind a closed panel. The element is
    // rendered unconditionally, so the ref is stable for this component's
    // lifetime and can safely be captured here.
    const player = playerRef.current;
    return () => {
      player?.pause();
    };
  }, []);

  // Keep the preview honest about the volume the user is setting.
  useEffect(() => {
    const player = playerRef.current;
    if (!player) return;
    // doc.audio.volume goes to 2 for a boost the renderer applies; the media
    // element only accepts 0-1 and throws outside it.
    player.volume = Math.min(1, Math.max(0, audio.volume));
  }, [audio.volume]);

  async function togglePreview(track: EditorAudioTrack) {
    const player = playerRef.current;
    if (!player) return;
    // An importing or failed row has no Drive file: /api/editor/asset/<id>
    // answers 404 for it, which would only surface as a failed <audio> load.
    if (!isTrackPlayable(track)) return;

    if (playingId === track.id) {
      stopPreview();
      return;
    }

    if (loadedIdRef.current !== track.id) {
      player.src = editorAssetUrl(track.id);
      loadedIdRef.current = track.id;
    }

    player.volume = Math.min(1, Math.max(0, audio.volume));
    try {
      // Preview from the start offset, so what you hear is what the render
      // will use. With a freshly assigned src this only sets the default
      // playback start position; a few browsers throw instead of accepting it,
      // and a rejected seek must not cost the user the preview.
      player.currentTime = Math.max(0, audio.startOffset);
    } catch {
      // Falls back to playing from the beginning.
    }

    try {
      await player.play();
      setPlayingId(track.id);
    } catch {
      setPlayingId(null);
      toast.error(`Could not play "${track.name}"`);
    }
  }

  // ── Upload ─────────────────────────────────────────────────────────────────
  async function handleFiles(files: File[]) {
    const accepted = files.filter(isAudioFile);
    const skipped = files.length - accepted.length;
    if (skipped > 0) {
      toast.error(`${skipped} file${skipped === 1 ? "" : "s"} skipped — use MP3, M4A, AAC or WAV`);
    }
    if (!accepted.length) return;

    setUpload({ done: 0, total: accepted.length });
    let succeeded = 0;

    try {
      for (const file of accepted) {
        // Milliseconds, measured here: media_assets.duration_seconds is an
        // already-rounded INTEGER, so trim and fade points can never be
        // recovered from it. An undecodable duration stays unknown.
        const durationMs = await measureAudioDurationMs(file);

        try {
          await uploadEditorAsset({
            file,
            brandId,
            kind: "audio",
            name: fileLabel(file.name),
            ...(durationMs != null ? { durationMs } : {}),
          });
          succeeded += 1;
        } catch (error) {
          toast.error(error instanceof Error ? error.message : `Could not upload ${file.name}`);
        }

        setUpload((current) => (current ? { ...current, done: current.done + 1 } : current));
      }
    } finally {
      setUpload(null);
      await utils.editor.listAudio.invalidate();
    }

    if (succeeded > 0) {
      toast.success(`${succeeded} track${succeeded === 1 ? "" : "s"} saved to the library`);
    }
  }

  // ── Settings ───────────────────────────────────────────────────────────────
  function patch(next: Partial<AudioSettings>) {
    // Always a new object: the shell keeps an undo stack keyed on identity.
    onAudioChange({ ...audio, ...next });
  }

  function selectTrack(track: EditorAudioTrack | null) {
    stopPreview();
    if (!track) {
      onSelect(null);
      return;
    }
    // Never put an unfinished track into the document: the render would resolve
    // `doc.audio.trackId` to a row with no Drive file and fail there instead of
    // here.
    if (!isTrackPlayable(track)) return;
    // `durationMs` is 0 when the duration could not be decoded; the row shows
    // "--:--" in that case rather than claiming a length.
    onSelect({ id: track.id, name: track.name, durationMs: track.durationMs ?? 0 });
  }

  const durationSeconds = activeTrack?.durationMs ? activeTrack.durationMs / 1000 : null;
  const offsetMax = Math.max(
    1,
    Math.floor(durationSeconds ?? FALLBACK_OFFSET_SECONDS)
  );
  const fadeMax = Math.max(1, Math.min(MAX_FADE_SECONDS, Math.floor(durationSeconds ?? MAX_FADE_SECONDS)));

  return (
    <div className="space-y-4">
      <PanelHeader icon={Music2} title="Audio" hint="Saved to this brand and reusable on any edit" />

      {/* Applies to the base clip whether or not a track is chosen, so it sits
          outside the track settings. */}
      <div className="flex items-start justify-between gap-3 rounded-lg border bg-card px-3 py-2.5">
        <div className="min-w-0">
          <Label
            htmlFor="editor-mute-original"
            className="cursor-pointer text-xs font-medium"
          >
            <VolumeX className="h-3.5 w-3.5 text-muted-foreground" />
            Mute original video audio
          </Label>
          <p className="mt-1 text-[11px] leading-snug text-muted-foreground">
            Applies to posts and reels. Images are unaffected.
          </p>
        </div>
        <Switch
          id="editor-mute-original"
          checked={audio.muteOriginal}
          onCheckedChange={(checked) => patch({ muteOriginal: checked })}
        />
      </div>

      <PanelGroup label="Track">
        {tracksQuery.isLoading ? (
          <PanelLoading label="Loading tracks..." />
        ) : tracksQuery.error ? (
          <PanelError
            message={tracksQuery.error.message}
            onRetry={() => tracksQuery.refetch()}
            retrying={tracksQuery.isFetching}
          />
        ) : tracks.length === 0 ? (
          <PanelEmpty
            icon={Music2}
            title="No saved tracks"
            hint="Upload a track or import one from an Instagram reel — either way it stays in this brand's library."
          />
        ) : (
          <div className="space-y-1.5">
            <button
              type="button"
              aria-pressed={!activeTrackId}
              onClick={() => selectTrack(null)}
              className={cn(
                "flex w-full items-center gap-2 rounded-lg border px-2.5 py-2 text-left transition-colors outline-none",
                "focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50",
                activeTrackId
                  ? "bg-card hover:bg-muted/40"
                  : "border-primary bg-primary/5"
              )}
            >
              <span className="min-w-0 flex-1 truncate text-xs font-medium">No added track</span>
              {!activeTrackId && <Check className="h-3.5 w-3.5 shrink-0 text-primary" />}
            </button>

            {tracks.map((track) => (
              <TrackRow
                key={track.id}
                track={track}
                selected={track.id === activeTrackId}
                playing={playingId === track.id}
                deleting={deletingId === track.id}
                onTogglePreview={() => togglePreview(track)}
                onSelect={() => selectTrack(track)}
                onDelete={() => {
                  if (playingId === track.id) stopPreview();
                  setDeletingId(track.id);
                  deleteAudio.mutate({ id: track.id });
                }}
              />
            ))}
          </div>
        )}

        {upload ? (
          <PanelBusy label={`Uploading ${upload.done + 1} of ${upload.total}...`} />
        ) : (
          <DropZone
            accept={AUDIO_ACCEPT}
            icon={Upload}
            title="Add a track"
            hint="MP3, M4A, AAC or WAV"
            onFiles={handleFiles}
          />
        )}

        {/* The second way in, beside the upload control rather than hidden
            behind it: paste a reel and keep the audio. */}
        <div className="space-y-2 rounded-lg border bg-card px-2.5 py-2">
          <div className="flex items-center gap-1.5">
            <Clapperboard className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
            <span className="text-xs font-medium">Import from Instagram</span>
          </div>

          <div className="flex items-center gap-1.5">
            <Input
              value={importUrl}
              maxLength={MAX_INSTAGRAM_URL_LENGTH}
              placeholder="instagram.com/reel/..."
              aria-label="Instagram reel or post link"
              aria-invalid={importUrlError ? true : undefined}
              aria-describedby={importUrlError ? "editor-audio-import-error" : undefined}
              disabled={importAudio.isPending}
              onChange={(event) => {
                setImportUrl(event.target.value);
                // Clear as they type: keeping a stale reason under a field they
                // are mid-way through fixing reads as a live rejection.
                if (importUrlError) setImportUrlError(null);
              }}
              onBlur={() => {
                const value = importUrl.trim();
                setImportUrlError(value ? validateImportUrl(value) : null);
              }}
              onKeyDown={(event) => {
                if (event.key === "Enter") {
                  event.preventDefault();
                  submitImport();
                }
              }}
              className="h-7 text-xs"
            />
            {/* Deliberately not disabled on an invalid link — clicking is how
                the user finds out why it is invalid. */}
            <Button
              type="button"
              size="xs"
              disabled={!importUrl.trim() || importAudio.isPending}
              onClick={submitImport}
            >
              {importAudio.isPending && <Loader2 className="animate-spin" />}
              Import
            </Button>
          </div>

          {importUrlError && (
            <p
              id="editor-audio-import-error"
              className="text-[11px] leading-snug break-words text-destructive"
            >
              {importUrlError}
            </p>
          )}

          <p className="text-[11px] leading-snug text-muted-foreground">
            The audio is extracted in the background. You are responsible for the rights to audio
            you import.
          </p>
        </div>
      </PanelGroup>

      {/* Mixing controls only exist in relation to a chosen track. */}
      {activeTrack && (
        <PanelGroup label="Mix">
          <Slider
            label="Volume"
            value={audio.volume}
            onValueChange={(value) => patch({ volume: value })}
            min={0}
            max={2}
            step={0.01}
            formatValue={(value) => `${Math.round(value * 100)}%`}
          />
          <Slider
            label="Start offset"
            value={Math.min(audio.startOffset, offsetMax)}
            onValueChange={(value) => patch({ startOffset: value })}
            min={0}
            max={offsetMax}
            step={0.1}
            formatValue={formatSeconds}
          />
          <Slider
            label="Fade in"
            value={Math.min(audio.fadeIn, fadeMax)}
            onValueChange={(value) => patch({ fadeIn: value })}
            min={0}
            max={fadeMax}
            step={0.1}
            formatValue={formatSeconds}
          />
          <Slider
            label="Fade out"
            value={Math.min(audio.fadeOut, fadeMax)}
            onValueChange={(value) => patch({ fadeOut: value })}
            min={0}
            max={fadeMax}
            step={0.1}
            formatValue={formatSeconds}
          />

          <div className="flex items-center justify-between gap-3 pt-0.5">
            <Label htmlFor="editor-audio-loop" className="cursor-pointer text-sm font-medium">
              Loop to fill the clip
            </Label>
            <Switch
              id="editor-audio-loop"
              checked={audio.loop}
              onCheckedChange={(checked) => patch({ loop: checked })}
            />
          </div>
        </PanelGroup>
      )}

      {/* The single shared player. */}
      <audio
        ref={playerRef}
        preload="none"
        className="hidden"
        onEnded={() => setPlayingId(null)}
        onError={() => {
          // Forget the failed source so pressing play again really retries it.
          loadedIdRef.current = null;
          setPlayingId(null);
        }}
      />
    </div>
  );
}

function TrackRow({
  track,
  selected,
  playing,
  deleting,
  onTogglePreview,
  onSelect,
  onDelete,
}: {
  track: EditorAudioTrack;
  selected: boolean;
  playing: boolean;
  deleting: boolean;
  onTogglePreview: () => void;
  onSelect: () => void;
  onDelete: () => void;
}) {
  const importing = track.importStatus === "importing";
  const failed = track.importStatus === "failed";
  // Playability, not status alone: a 'ready' row with no Drive file would 404
  // on preview, and the check constraint added in 00043 is the only thing
  // ruling that out server-side.
  const playable = isTrackPlayable(track);

  return (
    <div
      className={cn(
        "group flex items-center gap-1 rounded-lg border py-1 pr-1 pl-0.5 transition-colors",
        failed
          ? "border-destructive/30 bg-destructive/5"
          : selected
            ? "border-primary bg-primary/5"
            : "bg-card hover:bg-muted/40",
        deleting && "opacity-50"
      )}
    >
      <Button
        type="button"
        size="icon-sm"
        variant="ghost"
        disabled={deleting || !playable}
        onClick={onTogglePreview}
        aria-label={playing ? `Pause ${track.name}` : `Preview ${track.name}`}
        title={importing ? "Still importing" : failed ? "Import failed" : playing ? "Pause" : "Preview"}
      >
        {importing ? (
          <Loader2 className="animate-spin" />
        ) : failed ? (
          <TriangleAlert className="text-destructive" />
        ) : playing ? (
          <Pause />
        ) : (
          <Play />
        )}
      </Button>

      <button
        type="button"
        aria-pressed={selected}
        disabled={deleting || !playable}
        onClick={onSelect}
        className={cn(
          "min-w-0 flex-1 rounded px-0.5 py-0.5 text-left outline-none focus-visible:ring-3 focus-visible:ring-ring/50",
          !playable && "cursor-default"
        )}
      >
        <span className="flex items-center gap-1.5">
          <span
            className={cn(
              "min-w-0 truncate text-xs font-medium",
              !playable && "text-muted-foreground"
            )}
          >
            {track.name}
          </span>
          {track.isDefault && (
            <Badge variant="secondary" className="h-4 shrink-0 px-1.5 text-[10px]">
              Default
            </Badge>
          )}
        </span>

        {/* One line, three meanings — a length, a progress note, or the actual
            reason it failed. Never a length it does not have. */}
        {importing ? (
          <span className="mt-0.5 block text-[11px] text-muted-foreground">
            Importing audio from Instagram...
          </span>
        ) : failed ? (
          <span className="mt-0.5 block text-[11px] leading-snug break-words text-destructive">
            {track.importError || "The import failed."}
          </span>
        ) : (
          <span className="mt-0.5 block text-[11px] tabular-nums text-muted-foreground">
            {formatDuration(track.durationMs)}
          </span>
        )}
      </button>

      {selected && playable && <Check className="h-3.5 w-3.5 shrink-0 text-primary" />}

      <Button
        type="button"
        size="icon-sm"
        variant="ghost"
        disabled={deleting}
        onClick={onDelete}
        aria-label={failed ? `Remove ${track.name}` : `Delete ${track.name}`}
        title={failed ? "Remove" : "Delete"}
        className={cn(
          "transition-opacity hover:text-destructive",
          // A failed row's only useful action must not be behind a hover, and on
          // a touch screen there is no hover to find it with.
          failed
            ? "text-destructive"
            : "opacity-0 group-hover:opacity-100 focus-visible:opacity-100"
        )}
      >
        {deleting ? <Loader2 className="animate-spin" /> : <Trash2 />}
      </Button>
    </div>
  );
}
