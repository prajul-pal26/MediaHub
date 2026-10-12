"use client";

import * as React from "react";
import type { EditDoc, Layer } from "@/lib/editor/doc";
import { RATIO_PRESETS } from "@/lib/editor/doc";
import { cn } from "@/lib/utils";
import { Pause, Play, Volume2, VolumeX } from "lucide-react";
import type { SourceInfo } from "./api";
import { BaseMedia } from "./BaseMedia";
import { LayerView, type LayerGeometryChange } from "./LayerView";
import { paintOrder } from "./doc-ops";

interface CanvasStageProps {
  doc: EditDoc;
  /** Resolved by the workspace — see BaseMedia's `sourceUrl`. */
  sourceUrl: string | null;
  selectedLayerId: string | null;
  onSelect: (layerId: string | null) => void;
  onLayerGeometry: (layerId: string, change: LayerGeometryChange) => void;
  onSourceLoad: (info: SourceInfo) => void;
  resolveLayerSrc: (layer: Layer) => string | null;
  /** Video only — the footer's mute button edits `audio.muteOriginal`. */
  onToggleMuteOriginal: () => void;
}

/** Breathing room around the canvas so selection handles never clip. */
const STAGE_PADDING = 32;

/**
 * Letterboxes the canvas into whatever space is left between the tool rail and
 * the inspector, and keeps the single `scale` factor every layer is drawn with.
 */
export function CanvasStage({
  doc,
  sourceUrl,
  selectedLayerId,
  onSelect,
  onLayerGeometry,
  onSourceLoad,
  resolveLayerSrc,
  onToggleMuteOriginal,
}: CanvasStageProps) {
  const frameRef = React.useRef<HTMLDivElement | null>(null);
  const videoRef = React.useRef<HTMLVideoElement | null>(null);
  const [available, setAvailable] = React.useState({ w: 0, h: 0 });
  const [playing, setPlaying] = React.useState(false);
  const [videoTime, setVideoTime] = React.useState(0);
  // Read from the loaded element, but kept in state: element properties are not
  // reactive, and reading `videoRef.current` while rendering would go stale.
  const [duration, setDuration] = React.useState<number | null>(null);

  React.useEffect(() => {
    const frame = frameRef.current;
    if (!frame) return;
    // contentRect excludes padding, so the measurement is the usable box.
    const observer = new ResizeObserver(([entry]) => {
      if (!entry) return;
      setAvailable({ w: entry.contentRect.width, h: entry.contentRect.height });
    });
    observer.observe(frame);
    return () => observer.disconnect();
  }, []);

  const scale = React.useMemo(() => {
    if (available.w <= 0 || available.h <= 0) return 0;
    return Math.min(available.w / doc.canvas.w, available.h / doc.canvas.h);
  }, [available, doc.canvas.w, doc.canvas.h]);

  const stage = { w: doc.canvas.w * scale, h: doc.canvas.h * scale };
  const isVideo = doc.base.kind === "video";
  const ratioLabel = RATIO_PRESETS[doc.canvas.ratio]?.label ?? doc.canvas.ratio;

  function togglePlay() {
    const video = videoRef.current;
    if (!video) return;
    if (video.paused) {
      const trim = doc.base.trim;
      if (trim && (video.currentTime < trim.start || video.currentTime >= trim.end)) {
        video.currentTime = trim.start;
      }
      void video.play();
      setPlaying(true);
    } else {
      video.pause();
      setPlaying(false);
    }
  }

  /** A layer with video timing is dimmed outside its window. */
  function isOutOfTime(layer: Layer): boolean {
    if (!layer.timing || !isVideo) return false;
    const { start, end, mode } = layer.timing;
    if (mode === "relative") {
      if (!duration) return false;
      return videoTime < start * duration || videoTime > end * duration;
    }
    return videoTime < start || videoTime > end;
  }

  function handleSourceLoad(info: SourceInfo) {
    setDuration(info.durationSeconds && info.durationSeconds > 0 ? info.durationSeconds : null);
    onSourceLoad(info);
  }

  return (
    <div className="flex min-w-0 flex-1 flex-col bg-zinc-900">
      <div
        ref={frameRef}
        onPointerDown={() => onSelect(null)}
        className="relative flex min-h-0 flex-1 items-center justify-center"
        style={{ padding: STAGE_PADDING }}
      >
        {scale > 0 && (
          <div
            className="relative shadow-2xl ring-1 ring-white/10"
            style={{ width: stage.w, height: stage.h }}
          >
            <BaseMedia
              doc={doc}
              sourceUrl={sourceUrl}
              stage={stage}
              scale={scale}
              onSourceLoad={handleSourceLoad}
              videoRef={videoRef}
              onVideoTime={setVideoTime}
            />

            {paintOrder(doc).map((layer) => (
              <LayerView
                key={layer.id}
                layer={layer}
                canvas={doc.canvas}
                scale={scale}
                selected={layer.id === selectedLayerId}
                src={resolveLayerSrc(layer)}
                outOfTime={isOutOfTime(layer)}
                onSelect={() => onSelect(layer.id)}
                onGeometry={(change) => onLayerGeometry(layer.id, change)}
              />
            ))}
          </div>
        )}
      </div>

      <footer className="flex h-9 shrink-0 items-center gap-3 border-t border-white/10 px-3 text-[11px] text-white/50">
        {isVideo && (
          <div className="flex items-center gap-1">
            <StageButton onClick={togglePlay} label={playing ? "Pause" : "Play"}>
              {playing ? <Pause className="h-3.5 w-3.5" /> : <Play className="h-3.5 w-3.5" />}
            </StageButton>
            {/* Mute edits the document (the Adjust panel shows the same switch),
                so the preview and the rendered file never disagree. */}
            <StageButton
              onClick={onToggleMuteOriginal}
              label={doc.audio.muteOriginal ? "Unmute the source track" : "Mute the source track"}
            >
              {doc.audio.muteOriginal ? (
                <VolumeX className="h-3.5 w-3.5" />
              ) : (
                <Volume2 className="h-3.5 w-3.5" />
              )}
            </StageButton>
            <span className="ml-1 font-mono tabular-nums">
              {formatSeconds(videoTime)}
              {duration ? ` / ${formatSeconds(duration)}` : ""}
            </span>
          </div>
        )}
        <span className="font-medium text-white/70">{ratioLabel}</span>
        <span className="font-mono tabular-nums">
          {doc.canvas.w} × {doc.canvas.h}
        </span>
        <span className="ml-auto font-mono tabular-nums">
          {scale > 0 ? `${Math.round(scale * 100)}%` : "—"}
        </span>
        <span>
          {doc.layers.length} layer{doc.layers.length === 1 ? "" : "s"}
        </span>
      </footer>
    </div>
  );
}

function StageButton({
  onClick,
  label,
  children,
}: {
  onClick: () => void;
  label: string;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      title={label}
      aria-label={label}
      className={cn(
        "flex h-6 w-6 items-center justify-center rounded text-white/70 transition-colors hover:bg-white/10 hover:text-white"
      )}
    >
      {children}
    </button>
  );
}

function formatSeconds(seconds: number): string {
  const whole = Math.max(0, Math.floor(seconds));
  const minutes = Math.floor(whole / 60);
  return `${minutes}:${String(whole % 60).padStart(2, "0")}`;
}
