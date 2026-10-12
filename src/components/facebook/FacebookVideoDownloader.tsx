"use client";

import { useState } from "react";
import { trpc } from "@/lib/trpc/client";
import { Loader2, Download, Video, X, AlertCircle, Link2 } from "lucide-react";

// Proxy FB CDN media through the app's media route (fbcdn.net is whitelisted).
// ref=fb makes the proxy send a facebook.com referer. dl= forces a download.
function fbProxy(url: string | null | undefined, dl?: string) {
  if (!url) return "";
  const base = `/api/insta-media?url=${encodeURIComponent(url)}&ref=fb`;
  return dl ? `${base}&dl=${encodeURIComponent(dl)}` : base;
}

export function FacebookVideoDownloader() {
  const [urlInput, setUrlInput] = useState("");
  const download = trpc.fbSession.downloadVideo.useMutation();
  const result = download.data;

  function handleFetch() {
    const raw = urlInput.trim();
    if (!raw) return;
    download.mutate({ url: raw });
  }

  const baseName = `facebook_${result?.videoId || "video"}`;

  return (
    <div className="space-y-5">
      {/* Intro */}
      <div className="rounded-xl border border-zinc-200 bg-white p-5">
        <div className="flex items-center gap-3 mb-1">
          <div className="h-10 w-10 rounded-lg bg-blue-500/10 text-blue-600 flex items-center justify-center shrink-0">
            <Video className="h-5 w-5" />
          </div>
          <div>
            <h2 className="text-base font-semibold">Download Facebook Video</h2>
            <p className="text-sm text-muted-foreground">
              Paste any public Facebook video, reel or watch link to fetch and download the MP4.
            </p>
          </div>
        </div>

        {/* Input */}
        <div className="mt-4 flex flex-col sm:flex-row gap-2">
          <div className="relative flex-1">
            <Link2 className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
            <input
              type="url"
              value={urlInput}
              onChange={(e) => setUrlInput(e.target.value)}
              onKeyDown={(e) => e.key === "Enter" && handleFetch()}
              placeholder="https://www.facebook.com/watch/?v=…  or  https://fb.watch/…"
              className="w-full h-10 rounded-lg border border-zinc-300 bg-white pl-9 pr-9 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500/40"
            />
            {urlInput && (
              <button
                onClick={() => setUrlInput("")}
                className="absolute right-3 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground"
                aria-label="Clear"
              >
                <X className="h-4 w-4" />
              </button>
            )}
          </div>
          <button
            onClick={handleFetch}
            disabled={download.isPending || !urlInput.trim()}
            className="inline-flex items-center justify-center gap-2 h-10 px-4 rounded-lg bg-blue-600 text-white text-sm font-medium hover:bg-blue-700 disabled:opacity-50 shrink-0"
          >
            {download.isPending ? <Loader2 className="h-4 w-4 animate-spin" /> : <Video className="h-4 w-4" />}
            Fetch &amp; Download
          </button>
        </div>
      </div>

      {/* Error */}
      {download.isError && (
        <div className="rounded-xl border border-red-200 bg-red-50 p-4 flex items-start gap-3">
          <AlertCircle className="h-5 w-5 text-red-500 shrink-0 mt-0.5" />
          <div className="text-sm text-red-700">
            {download.error.message || "Please check the URL and ensure the video is public."}
          </div>
        </div>
      )}

      {/* Loading */}
      {download.isPending && (
        <div className="rounded-xl border border-zinc-200 bg-white p-6">
          <div className="grid grid-cols-1 md:grid-cols-12 gap-6 animate-pulse">
            <div className="md:col-span-5 aspect-video bg-zinc-200 rounded-xl" />
            <div className="md:col-span-7 space-y-4">
              <div className="h-5 w-40 bg-zinc-200 rounded" />
              <div className="h-16 bg-zinc-200 rounded-xl" />
              <div className="h-11 bg-zinc-200 rounded-lg" />
            </div>
          </div>
        </div>
      )}

      {/* Result */}
      {!download.isPending && result?.ok && (
        <div className="rounded-xl border border-zinc-200 bg-white p-6">
          <div className="grid grid-cols-1 md:grid-cols-12 gap-7">
            {/* Player */}
            <div className="md:col-span-5">
              <div className="relative w-full rounded-xl overflow-hidden bg-black shadow-inner flex items-center justify-center">
                <video
                  key={result.videoUrl}
                  src={fbProxy(result.videoUrl)}
                  poster={fbProxy(result.thumbnailUrl)}
                  controls
                  playsInline
                  className="w-full max-h-[460px] object-contain"
                />
              </div>
            </div>

            {/* Info + actions */}
            <div className="md:col-span-7 flex flex-col justify-between gap-5">
              <div className="space-y-2">
                {result.title && <h3 className="font-semibold text-sm leading-snug">{result.title}</h3>}
                {result.ownerName && (
                  <p className="text-sm text-muted-foreground">by {result.ownerName}</p>
                )}
                <div className="flex flex-wrap gap-1.5 pt-1">
                  {result.videoVersions.map((v) => (
                    <span key={v.url} className="text-[11px] font-medium px-1.5 py-0.5 rounded border bg-zinc-50 text-zinc-600">
                      {v.quality}
                    </span>
                  ))}
                </div>
              </div>

              <div className="space-y-2">
                {/* Primary HD/best download */}
                {result.videoUrl && (
                  <a
                    href={fbProxy(result.videoUrl, baseName)}
                    download
                    className="flex items-center justify-center gap-2 h-11 rounded-lg bg-blue-600 text-white text-sm font-medium hover:bg-blue-700"
                  >
                    <Download className="h-4 w-4" />
                    Download MP4 Video
                  </a>
                )}

                {/* Per-resolution */}
                {result.videoVersions.length > 1 && (
                  <div className="flex flex-wrap gap-2">
                    {result.videoVersions.map((v) => (
                      <a
                        key={v.url}
                        href={fbProxy(v.url, `${baseName}_${v.quality}`)}
                        download
                        className="inline-flex items-center gap-1.5 text-xs font-medium px-2.5 py-1.5 rounded-lg border border-zinc-300 hover:bg-zinc-50"
                      >
                        <Download className="h-3 w-3 text-blue-600" /> {v.quality}
                      </a>
                    ))}
                  </div>
                )}

                {/* Thumbnail */}
                {result.thumbnailUrl && (
                  <a
                    href={fbProxy(result.thumbnailUrl, `${baseName}_thumb`)}
                    download
                    className="inline-flex items-center gap-1.5 text-xs font-medium px-2.5 py-1.5 rounded-lg border border-zinc-300 hover:bg-zinc-50"
                  >
                    <Download className="h-3 w-3 text-zinc-500" /> Download Thumbnail
                  </a>
                )}
              </div>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
