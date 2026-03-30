"use client";

import { useState, useCallback, useRef } from "react";
import { useRouter } from "next/navigation";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { VariantCard } from "./VariantCard";
import { trpc } from "@/lib/trpc/client";
import { toast } from "sonner";
import { Upload, X, Loader2 } from "lucide-react";

interface FileWithMeta {
  file: File;
  metadata: { width?: number; height?: number; aspectRatio?: string; duration?: number; thumbnail?: string };
  tagging: { platform?: string; accountId?: string; action?: string };
}

interface UploadFormProps {
  brandId: string;
}

function calculateAspectRatio(w: number, h: number): string {
  const gcd = (a: number, b: number): number => (b === 0 ? a : gcd(b, a % b));
  const d = gcd(w, h);
  return `${w / d}:${h / d}`;
}

function fileToBase64(file: File): Promise<string> {
  return new Promise((resolve) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result as string);
    reader.onerror = () => resolve("");
    reader.readAsDataURL(file);
  });
}

function captureVideoFrame(video: HTMLVideoElement): string {
  const canvas = document.createElement("canvas");
  canvas.width = video.videoWidth;
  canvas.height = video.videoHeight;
  const ctx = canvas.getContext("2d");
  if (ctx) {
    ctx.drawImage(video, 0, 0);
  }
  return canvas.toDataURL("image/jpeg", 0.85);
}

async function readImageMeta(file: File): Promise<{ width: number; height: number; aspectRatio: string; thumbnail?: string }> {
  const thumbnail = await fileToBase64(file);
  return new Promise((resolve) => {
    const img = new window.Image();
    img.onload = () => {
      URL.revokeObjectURL(img.src);
      resolve({
        width: img.naturalWidth,
        height: img.naturalHeight,
        aspectRatio: calculateAspectRatio(img.naturalWidth, img.naturalHeight),
        thumbnail,
      });
    };
    img.onerror = () => resolve({ width: 0, height: 0, aspectRatio: "", thumbnail });
    img.src = URL.createObjectURL(file);
  });
}

async function readVideoMeta(file: File): Promise<{ width: number; height: number; aspectRatio: string; duration: number; thumbnail?: string }> {
  return new Promise((resolve) => {
    const video = document.createElement("video");
    video.preload = "auto";
    video.muted = true;

    video.onloadeddata = () => {
      video.currentTime = Math.min(1, video.duration / 2);
    };

    video.onseeked = () => {
      const thumbnail = captureVideoFrame(video);
      URL.revokeObjectURL(video.src);
      resolve({
        width: video.videoWidth,
        height: video.videoHeight,
        aspectRatio: video.videoWidth && video.videoHeight
          ? calculateAspectRatio(video.videoWidth, video.videoHeight)
          : "",
        duration: Math.round(video.duration),
        thumbnail,
      });
    };

    video.onloadedmetadata = () => {
      if (video.duration === Infinity || isNaN(video.duration)) {
        URL.revokeObjectURL(video.src);
        resolve({ width: video.videoWidth, height: video.videoHeight, aspectRatio: "", duration: 0 });
      }
    };

    video.onerror = () => resolve({ width: 0, height: 0, aspectRatio: "", duration: 0 });
    video.src = URL.createObjectURL(file);
  });
}

export function UploadForm({ brandId }: UploadFormProps) {
  const router = useRouter();
  const fileInputRef = useRef<HTMLInputElement>(null);
  const [files, setFiles] = useState<FileWithMeta[]>([]);
  const [uploading, setUploading] = useState(false);
  const [dragOver, setDragOver] = useState(false);

  // Shared details
  const [title, setTitle] = useState("");
  const [caption, setCaption] = useState("");
  const [description, setDescription] = useState("");
  const [notes, setNotes] = useState("");
  const [tags, setTags] = useState<string[]>([]);
  const [tagInput, setTagInput] = useState("");

  const createGroupMutation = trpc.media.createGroup.useMutation();

  // Auto-detect: multi-variant if more than 1 file
  const isMultiVariant = files.length > 1;

  const addFiles = useCallback(async (newFiles: FileList | File[]) => {
    const fileArray = Array.from(newFiles);
    const withMeta: FileWithMeta[] = [];

    for (const file of fileArray) {
      let metadata: FileWithMeta["metadata"] = {};

      if (file.type.startsWith("image/")) {
        metadata = await readImageMeta(file);
      } else if (file.type.startsWith("video/")) {
        metadata = await readVideoMeta(file);
      }

      withMeta.push({ file, metadata, tagging: {} });
    }

    setFiles((prev) => [...prev, ...withMeta]);
  }, []);

  function handleDrop(e: React.DragEvent) {
    e.preventDefault();
    setDragOver(false);
    if (e.dataTransfer.files.length) {
      addFiles(e.dataTransfer.files);
    }
  }

  function handleAddTag(e: React.KeyboardEvent<HTMLInputElement>) {
    if ((e.key === "Enter" || e.key === ",") && tagInput.trim()) {
      e.preventDefault();
      const tag = tagInput.trim().replace(/^#/, "");
      if (tag && !tags.includes(tag)) {
        setTags([...tags, tag]);
      }
      setTagInput("");
    }
  }

  function removeFile(index: number) {
    setFiles((prev) => prev.filter((_, i) => i !== index));
  }

  async function handleUpload() {
    if (!title.trim()) {
      toast.error("Title is required");
      return;
    }
    if (files.length === 0) {
      toast.error("Add at least one file");
      return;
    }

    setUploading(true);

    try {
      const group = await createGroupMutation.mutateAsync({
        brandId,
        title: title.trim(),
        caption: caption || undefined,
        description: description || undefined,
        tags: tags.length > 0 ? tags : undefined,
        notes: notes || undefined,
      });

      for (let i = 0; i < files.length; i++) {
        const { file, tagging, metadata } = files[i];

        const formData = new FormData();
        formData.append("file", file);
        formData.append("brandId", brandId);
        formData.append("groupId", group.id);
        formData.append("sortOrder", String(i));
        if (metadata.thumbnail) formData.append("thumbnail", metadata.thumbnail);
        if (tagging.platform) formData.append("taggedPlatform", tagging.platform);
        if (tagging.accountId) formData.append("taggedAccountId", tagging.accountId);
        if (tagging.action) formData.append("taggedAction", tagging.action);

        const res = await fetch("/api/upload", { method: "POST", body: formData });

        if (!res.ok) {
          const err = await res.json();
          throw new Error(err.error || `Upload failed for ${file.name}`);
        }
      }

      toast.success(`Uploaded ${files.length} file${files.length > 1 ? "s" : ""} to library`);
      router.push("/library");
    } catch (e: any) {
      toast.error(e.message);
    } finally {
      setUploading(false);
    }
  }

  return (
    <div className="max-w-3xl mx-auto space-y-6">
      {/* Drop zone */}
      <Card>
        <CardContent className="pt-6">
          <div
            className={`flex items-center justify-center h-40 border-2 border-dashed rounded-lg transition-colors cursor-pointer ${
              dragOver ? "border-primary bg-primary/5" : "border-muted hover:border-muted-foreground/50"
            }`}
            onDragOver={(e) => { e.preventDefault(); setDragOver(true); }}
            onDragLeave={() => setDragOver(false)}
            onDrop={handleDrop}
            onClick={() => fileInputRef.current?.click()}
          >
            <div className="text-center text-muted-foreground">
              <Upload className="h-8 w-8 mx-auto mb-2 opacity-50" />
              <p className="font-medium">Drop files here or click to browse</p>
              <p className="text-sm">Drop one file or multiple files at once</p>
            </div>
          </div>
          <input
            ref={fileInputRef}
            type="file"
            multiple
            className="hidden"
            onChange={(e) => e.target.files && addFiles(e.target.files)}
          />
        </CardContent>
      </Card>

      {/* File list */}
      {files.length > 0 && (
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-lg flex items-center justify-between">
              <span>
                {files.length} file{files.length > 1 ? "s" : ""}
                {isMultiVariant && (
                  <Badge variant="secondary" className="ml-2 text-xs">Multi-variant group</Badge>
                )}
              </span>
            </CardTitle>
          </CardHeader>
          <CardContent className="space-y-3">
            {files.map((f, i) => (
              <VariantCard
                key={`${f.file.name}-${i}`}
                file={f.file}
                index={i}
                metadata={f.metadata}
                tagging={f.tagging}
                showTagger={isMultiVariant}
                onRemove={() => removeFile(i)}
                onTagChange={(tags) => {
                  setFiles((prev) =>
                    prev.map((item, idx) =>
                      idx === i ? { ...item, tagging: tags } : item
                    )
                  );
                }}
                brandId={brandId}
              />
            ))}
          </CardContent>
        </Card>
      )}

      {/* Details */}
      {files.length > 0 && (
        <Card>
          <CardHeader>
            <CardTitle className="text-lg">Details</CardTitle>
          </CardHeader>
          <CardContent className="space-y-4">
            <div className="space-y-2">
              <Label htmlFor="title">Title *</Label>
              <Input
                id="title"
                value={title}
                onChange={(e) => setTitle(e.target.value)}
                placeholder="e.g., Spring Campaign Hero"
              />
            </div>

            <div className="space-y-2">
              <Label htmlFor="caption">Caption</Label>
              <Textarea
                id="caption"
                value={caption}
                onChange={(e) => setCaption(e.target.value)}
                placeholder="Caption text for social platforms"
                rows={3}
              />
            </div>

            <div className="space-y-2">
              <Label>Tags</Label>
              <div className="flex flex-wrap gap-1.5 mb-2">
                {tags.map((tag) => (
                  <Badge key={tag} variant="secondary" className="gap-1">
                    #{tag}
                    <button onClick={() => setTags(tags.filter((t) => t !== tag))}>
                      <X className="h-3 w-3" />
                    </button>
                  </Badge>
                ))}
              </div>
              <Input
                value={tagInput}
                onChange={(e) => setTagInput(e.target.value)}
                onKeyDown={handleAddTag}
                placeholder="Type tag and press Enter"
              />
            </div>

            <div className="space-y-2">
              <Label htmlFor="description">Description (for YouTube/LinkedIn)</Label>
              <Textarea
                id="description"
                value={description}
                onChange={(e) => setDescription(e.target.value)}
                placeholder="Longer description for video platforms"
                rows={2}
              />
            </div>

            <div className="space-y-2">
              <Label htmlFor="notes">Internal notes (visible only to your team)</Label>
              <Input
                id="notes"
                value={notes}
                onChange={(e) => setNotes(e.target.value)}
                placeholder="Optional"
              />
            </div>
          </CardContent>
        </Card>
      )}

      {/* Upload button */}
      {files.length > 0 && (
        <div className="flex justify-end">
          <Button
            onClick={handleUpload}
            disabled={uploading || files.length === 0 || !title.trim()}
            size="lg"
          >
            {uploading ? (
              <>
                <Loader2 className="h-4 w-4 mr-2 animate-spin" />
                Uploading...
              </>
            ) : (
              <>
                <Upload className="h-4 w-4 mr-2" />
                Upload {files.length > 1 ? `group (${files.length} files)` : "to library"}
              </>
            )}
          </Button>
        </div>
      )}
    </div>
  );
}
