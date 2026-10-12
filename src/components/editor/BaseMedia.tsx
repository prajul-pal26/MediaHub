"use client";

import * as React from "react";
import type { EditDoc } from "@/lib/editor/doc";
import { effectsToCss, unitOf } from "@/lib/editor/doc";
import { cn } from "@/lib/utils";
import { Image as ImageIcon } from "lucide-react";
import type { SourceInfo } from "./api";

interface BaseMediaProps {
  doc: EditDoc;
  /**
   * Where the source bytes come from. Resolved by the workspace, not here,
   * because the two source models live in different places: a Media Library
   * asset is addressed by `doc.base.assetId`, while a file uploaded straight
   * into the Editor has NO asset id at all and is addressed by the draft id.
   * Computing it from `doc.base.assetId` alone renders "No source media" for
   * every Editor upload.
   */
  sourceUrl: string | null;
  /** Stage pixels — canvas pixels times the letterbox scale. */
  stage: { w: number; h: number };
  scale: number;
  onSourceLoad: (info: SourceInfo) => void;
  videoRef?: React.RefObject<HTMLVideoElement | null>;
  onVideoTime?: (seconds: number) => void;
}

/**
 * The base image or video, cropped and filtered exactly the way the server will
 * render it.
 *
 * `base.crop` is normalised to the SOURCE, so the preview lays the whole source
 * out at `stage / crop` and slides it so the crop window lands on the stage.
 * `coverCrop` always produces a window with the canvas' aspect, which is what
 * lets the source be stretched to that box without distortion.
 */
export function BaseMedia({
  doc,
  sourceUrl,
  stage,
  scale,
  onSourceLoad,
  videoRef,
  onVideoTime,
}: BaseMediaProps) {
  const { base, canvas } = doc;
  // A byte-proxy failure (an expired Drive token, say) must read as a message
  // rather than as a canvas that is silently and inexplicably empty. A draft's
  // source never changes, so this never needs resetting.
  const [failed, setFailed] = React.useState(false);
  const src = sourceUrl;
  const filter = effectsToCss(doc.effects);
  const unit = unitOf(canvas);

  const transform = React.useMemo(() => {
    const t = base.transform;
    // Offsets are `unit` fractions like every other length in the document.
    const ox = t.offsetX * unit * scale;
    const oy = t.offsetY * unit * scale;
    const sx = t.scale * (t.flipH ? -1 : 1);
    const sy = t.scale * (t.flipV ? -1 : 1);
    return `translate(${ox}px, ${oy}px) rotate(${t.rotate}deg) scale(${sx}, ${sy})`;
  }, [base.transform, unit, scale]);

  const contained = base.fit !== "cover";

  // The crop window, expressed as a box holding the full source.
  const cropBox = React.useMemo(() => {
    const w = Math.max(base.crop.w, 1e-4);
    const h = Math.max(base.crop.h, 1e-4);
    const fullW = stage.w / w;
    const fullH = stage.h / h;
    return {
      width: fullW,
      height: fullH,
      left: -base.crop.x * fullW,
      top: -base.crop.y * fullH,
    };
  }, [base.crop, stage.w, stage.h]);

  function handleImageLoad(event: React.SyntheticEvent<HTMLImageElement>) {
    const el = event.currentTarget;
    if (el.naturalWidth && el.naturalHeight) {
      onSourceLoad({ w: el.naturalWidth, h: el.naturalHeight, durationSeconds: null });
    }
  }

  function handleVideoMeta(event: React.SyntheticEvent<HTMLVideoElement>) {
    const el = event.currentTarget;
    if (el.videoWidth && el.videoHeight) {
      onSourceLoad({
        w: el.videoWidth,
        h: el.videoHeight,
        durationSeconds: Number.isFinite(el.duration) ? el.duration : null,
      });
    }
  }

  function handleTimeUpdate(event: React.SyntheticEvent<HTMLVideoElement>) {
    const el = event.currentTarget;
    const trim = base.trim;
    if (trim && trim.end > trim.start) {
      // Keep playback inside the trim so the preview matches the rendered clip.
      if (el.currentTime >= trim.end) el.currentTime = trim.start;
      else if (el.currentTime < trim.start - 0.25) el.currentTime = trim.start;
    }
    onVideoTime?.(el.currentTime);
  }

  const mediaClass = contained ? "h-full w-full object-contain" : "h-full w-full object-fill";
  const mediaStyle: React.CSSProperties = { transform, transformOrigin: "center" };

  const media = !src ? null : base.kind === "video" ? (
    <video
      ref={videoRef}
      src={src}
      className={mediaClass}
      style={mediaStyle}
      playsInline
      loop
      muted={doc.audio.muteOriginal}
      onLoadedMetadata={handleVideoMeta}
      onTimeUpdate={handleTimeUpdate}
      onError={() => setFailed(true)}
    />
  ) : (
    <img
      src={src}
      alt=""
      className={mediaClass}
      style={mediaStyle}
      draggable={false}
      onLoad={handleImageLoad}
      onError={() => setFailed(true)}
    />
  );

  return (
    <div
      className="absolute inset-0 overflow-hidden"
      style={{ backgroundColor: canvas.background.color }}
    >
      {/* A blurred, over-scanned copy fills the letterbox bars for both the
          "contain-blur" fit and a blur canvas background. */}
      {src && (base.fit === "contain-blur" || canvas.background.type === "blur") && (
        <div className="absolute inset-0 overflow-hidden" aria-hidden>
          {base.kind === "video" ? (
            // `metadata` only: this is a blurred backdrop, so the first frame is
            // enough and a second full download of the clip is not worth it.
            <video
              src={src}
              preload="metadata"
              className="h-full w-full scale-125 object-cover blur-2xl saturate-150"
              playsInline
              muted
            />
          ) : (
            <img src={src} alt="" className="h-full w-full scale-125 object-cover blur-2xl saturate-150" draggable={false} />
          )}
        </div>
      )}

      <div className="absolute inset-0" style={{ filter }}>
        {contained ? (
          <div className="absolute inset-0">{media}</div>
        ) : (
          <div
            className="absolute"
            style={{
              width: cropBox.width,
              height: cropBox.height,
              left: cropBox.left,
              top: cropBox.top,
            }}
          >
            {media}
          </div>
        )}
      </div>

      {(!src || failed) && (
        <div
          className={cn(
            "absolute inset-0 flex flex-col items-center justify-center gap-2 px-6 text-center text-white/40"
          )}
        >
          <ImageIcon className="h-10 w-10" />
          <p className="text-xs font-medium">
            {src ? "The source file could not be loaded" : "No source media"}
          </p>
        </div>
      )}
    </div>
  );
}
