"use client";

import { useEffect, useMemo, useState } from "react";
import {
  BadgeCheck,
  Check,
  Copy,
  Download,
  FileVideo,
  Image as ImageIcon,
  Layers,
  Move,
  Upload,
  Wand2,
  X,
} from "lucide-react";
import { toast } from "sonner";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
} from "@/components/ui/sheet";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { cn } from "@/lib/utils";

export type EditableMediaAsset = {
  id: string;
  file_name: string;
  file_type: string;
  width?: number;
  height?: number;
  aspect_ratio?: string;
  duration_seconds?: number;
  metadata?: { thumbnail?: string };
};

export type EditableMediaGroup = {
  id: string;
  title: string;
  caption?: string;
  media_assets?: EditableMediaAsset[];
};

type LogoPosition =
  | "top-left"
  | "top-right"
  | "bottom-left"
  | "bottom-right"
  | "center"
  | "custom";

type TemplateId = "clean-reel" | "headline-bar" | "story-frame" | "corner-bug";

const templates: Array<{
  id: TemplateId;
  name: string;
  format: string;
  description: string;
  position: LogoPosition;
  logoScale: number;
  opacity: number;
  accent: string;
  frameClass: string;
  overlayClass: string;
}> = [
  {
    id: "clean-reel",
    name: "Clean Reel",
    format: "9:16",
    description: "Small logo, high-safe bottom caption space.",
    position: "bottom-right",
    logoScale: 18,
    opacity: 88,
    accent: "#00A3FF",
    frameClass: "aspect-[9/16]",
    overlayClass: "bg-gradient-to-t from-black/55 via-transparent to-transparent",
  },
  {
    id: "headline-bar",
    name: "Headline Bar",
    format: "4:5",
    description: "Top label band for launches and offers.",
    position: "top-left",
    logoScale: 20,
    opacity: 92,
    accent: "#F97316",
    frameClass: "aspect-[4/5]",
    overlayClass: "bg-gradient-to-b from-black/55 via-transparent to-black/20",
  },
  {
    id: "story-frame",
    name: "Story Frame",
    format: "9:16",
    description: "Branded side rail for stories and reposts.",
    position: "top-right",
    logoScale: 16,
    opacity: 85,
    accent: "#22C55E",
    frameClass: "aspect-[9/16]",
    overlayClass: "bg-[linear-gradient(90deg,rgba(0,0,0,.45),transparent_28%,transparent)]",
  },
  {
    id: "corner-bug",
    name: "Corner Bug",
    format: "1:1",
    description: "Square feed treatment with persistent mark.",
    position: "bottom-left",
    logoScale: 14,
    opacity: 78,
    accent: "#A855F7",
    frameClass: "aspect-square",
    overlayClass: "bg-gradient-to-tr from-black/45 via-transparent to-transparent",
  },
];

const positions: Array<{ id: LogoPosition; label: string }> = [
  { id: "top-left", label: "Top left" },
  { id: "top-right", label: "Top right" },
  { id: "bottom-left", label: "Bottom left" },
  { id: "bottom-right", label: "Bottom right" },
  { id: "center", label: "Center" },
  { id: "custom", label: "Custom" },
];

export function MediaEditorPanel({
  group,
  open,
  onOpenChange,
}: {
  group: EditableMediaGroup | null;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const firstAsset = group?.media_assets?.[0];
  const [templateId, setTemplateId] = useState<TemplateId>("clean-reel");
  const [position, setPosition] = useState<LogoPosition>("bottom-right");
  const [logoScale, setLogoScale] = useState(18);
  const [opacity, setOpacity] = useState(88);
  const [padding, setPadding] = useState(28);
  const [customX, setCustomX] = useState(76);
  const [customY, setCustomY] = useState(82);
  const [headline, setHeadline] = useState("");
  const [logoPreview, setLogoPreview] = useState<string | null>(null);
  const [mediaPreviewFailed, setMediaPreviewFailed] = useState(false);

  const selectedTemplate = templates.find((template) => template.id === templateId) ?? templates[0];
  const isVideo = firstAsset?.file_type.startsWith("video/");
  const previewUrl = logoPreview || null;
  // The group comes from `media.list`, which no longer ships the base64
  // `metadata.thumbnail`; real pixels come from the authenticated byte proxy.
  const mediaPreviewSrc =
    firstAsset?.metadata?.thumbnail ||
    (firstAsset && !isVideo ? `/api/media/${firstAsset.id}` : undefined);

  function applyTemplate(nextTemplateId: TemplateId) {
    const template = templates.find((item) => item.id === nextTemplateId) ?? templates[0];
    setTemplateId(template.id);
    setPosition(template.position);
    setLogoScale(template.logoScale);
    setOpacity(template.opacity);
  }

  function handleLogoFile(file: File | null) {
    if (!file) return;
    const objectUrl = URL.createObjectURL(file);
    setLogoPreview((current) => {
      if (current) URL.revokeObjectURL(current);
      return objectUrl;
    });
  }

  useEffect(() => {
    return () => {
      if (logoPreview) URL.revokeObjectURL(logoPreview);
    };
  }, [logoPreview]);

  const logoStyle = useMemo(() => {
    const base = {
      width: `${logoScale}%`,
      opacity: opacity / 100,
    };
    if (position === "custom") {
      return {
        ...base,
        left: `${customX}%`,
        top: `${customY}%`,
        transform: "translate(-50%, -50%)",
      };
    }
    if (position === "center") {
      return {
        ...base,
        left: "50%",
        top: "50%",
        transform: "translate(-50%, -50%)",
      };
    }
    return {
      ...base,
      top: position.startsWith("top") ? padding : undefined,
      bottom: position.startsWith("bottom") ? padding : undefined,
      left: position.endsWith("left") ? padding : undefined,
      right: position.endsWith("right") ? padding : undefined,
    };
  }, [customX, customY, logoScale, opacity, padding, position]);

  const exportRecipe = [
    `Template: ${selectedTemplate.name} (${selectedTemplate.format})`,
    `Watermark: ${position}, ${logoScale}% width, ${opacity}% opacity, ${padding}px padding`,
    position === "custom" ? `Custom position: x ${customX}%, y ${customY}%` : null,
    `Caption safe text: ${headline || group?.title || "New reel ready"}`,
  ]
    .filter(Boolean)
    .join("\n");

  async function copyRecipe() {
    await navigator.clipboard.writeText(exportRecipe);
    toast.success("Editor recipe copied");
  }

  if (!group || !firstAsset) return null;

  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent className="w-full overflow-y-auto p-0 sm:max-w-5xl" side="right">
        <SheetHeader className="border-b px-5 py-4">
          <div className="flex items-start justify-between gap-4 pr-10">
            <div>
              <SheetTitle className="flex items-center gap-2">
                <Wand2 className="h-4 w-4" />
                Media editor
              </SheetTitle>
              <SheetDescription>
                Add reusable brand context before publishing {isVideo ? "a reel or video" : "an image"}.
              </SheetDescription>
            </div>
            <Badge variant="outline" className="shrink-0">
              {firstAsset.file_type}
            </Badge>
          </div>
        </SheetHeader>

        <div className="grid gap-0 lg:grid-cols-[minmax(0,1fr)_380px]">
          <div className="min-h-[620px] bg-zinc-950 p-5 lg:p-8">
            <div className="mx-auto flex max-w-[430px] flex-col gap-4">
              <div
                className={cn(
                  "relative overflow-hidden rounded-lg border border-white/10 bg-zinc-900 shadow-2xl",
                  selectedTemplate.frameClass
                )}
              >
                {mediaPreviewSrc && !mediaPreviewFailed ? (
                  <img
                    src={mediaPreviewSrc}
                    alt={group.title}
                    className="h-full w-full object-cover"
                    onError={() => setMediaPreviewFailed(true)}
                  />
                ) : (
                  <div className="flex h-full w-full items-center justify-center bg-zinc-900">
                    {isVideo ? (
                      <FileVideo className="h-16 w-16 text-white/25" />
                    ) : (
                      <ImageIcon className="h-16 w-16 text-white/25" />
                    )}
                  </div>
                )}

                <div className={cn("absolute inset-0", selectedTemplate.overlayClass)} />
                {selectedTemplate.id === "headline-bar" && (
                  <div
                    className="absolute left-0 right-0 top-0 px-5 py-4 text-sm font-semibold uppercase tracking-[0.18em] text-white"
                    style={{ backgroundColor: `${selectedTemplate.accent}DD` }}
                  >
                    {headline || group.title || "Brand update"}
                  </div>
                )}
                {selectedTemplate.id === "story-frame" && (
                  <div className="absolute bottom-0 left-0 top-0 w-2" style={{ backgroundColor: selectedTemplate.accent }} />
                )}
                {selectedTemplate.id === "clean-reel" && (
                  <div className="absolute bottom-5 left-5 right-20 text-balance text-lg font-semibold leading-tight text-white drop-shadow">
                    {headline || group.title}
                  </div>
                )}

                <div className="absolute" style={logoStyle}>
                  {previewUrl ? (
                    <img src={previewUrl} alt="Logo preview" className="h-auto w-full object-contain drop-shadow-lg" />
                  ) : (
                    <div
                      className="grid aspect-square w-full place-items-center rounded-md border border-white/40 bg-white/90 text-center text-[10px] font-bold uppercase text-zinc-900 shadow-lg"
                    >
                      Logo
                    </div>
                  )}
                </div>
              </div>

              <div className="grid grid-cols-3 gap-2 text-xs text-zinc-300">
                <div className="rounded-md border border-white/10 bg-white/5 p-3">
                  <p className="text-zinc-500">Format</p>
                  <p className="font-medium text-white">{selectedTemplate.format}</p>
                </div>
                <div className="rounded-md border border-white/10 bg-white/5 p-3">
                  <p className="text-zinc-500">Asset</p>
                  <p className="truncate font-medium text-white">{firstAsset.file_name}</p>
                </div>
                <div className="rounded-md border border-white/10 bg-white/5 p-3">
                  <p className="text-zinc-500">Mode</p>
                  <p className="font-medium text-white">{isVideo ? "Video" : "Image"}</p>
                </div>
              </div>
            </div>
          </div>

          <div className="border-l bg-background p-5">
            <Tabs defaultValue="template" className="gap-5">
              <TabsList className="grid w-full grid-cols-3">
                <TabsTrigger value="template">
                  <Layers className="h-4 w-4" />
                  Template
                </TabsTrigger>
                <TabsTrigger value="logo">
                  <BadgeCheck className="h-4 w-4" />
                  Logo
                </TabsTrigger>
                <TabsTrigger value="export">
                  <Download className="h-4 w-4" />
                  Export
                </TabsTrigger>
              </TabsList>

              <TabsContent value="template" className="space-y-4">
                <div className="space-y-2">
                  <Label htmlFor="editor-headline">Overlay text</Label>
                  <Input
                    id="editor-headline"
                    value={headline}
                    onChange={(event) => setHeadline(event.target.value)}
                    placeholder={group.title || "Campaign headline"}
                  />
                </div>

                <div className="grid gap-3">
                  {templates.map((template) => (
                    <button
                      key={template.id}
                      type="button"
                      onClick={() => applyTemplate(template.id)}
                      className={cn(
                        "rounded-lg border p-3 text-left transition-colors hover:border-foreground/30",
                        template.id === templateId ? "border-primary bg-primary/5" : "border-border"
                      )}
                    >
                      <div className="flex items-center justify-between gap-3">
                        <div>
                          <p className="font-medium">{template.name}</p>
                          <p className="text-xs text-muted-foreground">{template.description}</p>
                        </div>
                        <Badge variant="outline">{template.format}</Badge>
                      </div>
                    </button>
                  ))}
                </div>
              </TabsContent>

              <TabsContent value="logo" className="space-y-4">
                <div className="space-y-2">
                  <Label htmlFor="logo-file">Logo image</Label>
                  <label className="flex cursor-pointer items-center justify-center gap-2 rounded-lg border border-dashed p-4 text-sm text-muted-foreground hover:bg-muted">
                    <Upload className="h-4 w-4" />
                    Upload PNG or SVG logo
                    <input
                      id="logo-file"
                      type="file"
                      accept="image/png,image/jpeg,image/svg+xml,image/webp"
                      className="sr-only"
                      onChange={(event) => handleLogoFile(event.target.files?.[0] ?? null)}
                    />
                  </label>
                </div>

                <div className="space-y-2">
                  <Label>Position</Label>
                  <Select value={position} onValueChange={(value) => setPosition(value as LogoPosition)}>
                    <SelectTrigger className="w-full">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      {positions.map((item) => (
                        <SelectItem key={item.id} value={item.id}>
                          {item.label}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>

                <EditorRange label="Logo size" value={logoScale} min={8} max={36} suffix="%" onChange={setLogoScale} />
                <EditorRange label="Opacity" value={opacity} min={20} max={100} suffix="%" onChange={setOpacity} />
                <EditorRange label="Padding" value={padding} min={8} max={80} suffix="px" onChange={setPadding} />

                {position === "custom" && (
                  <Card>
                    <CardContent className="space-y-4 pt-5">
                      <div className="flex items-center gap-2 text-sm font-medium">
                        <Move className="h-4 w-4" />
                        Custom placement
                      </div>
                      <EditorRange label="X position" value={customX} min={0} max={100} suffix="%" onChange={setCustomX} />
                      <EditorRange label="Y position" value={customY} min={0} max={100} suffix="%" onChange={setCustomY} />
                    </CardContent>
                  </Card>
                )}
              </TabsContent>

              <TabsContent value="export" className="space-y-4">
                <div className="rounded-lg border bg-muted/40 p-4">
                  <p className="mb-3 text-sm font-medium">Render recipe</p>
                  <pre className="whitespace-pre-wrap text-xs leading-relaxed text-muted-foreground">{exportRecipe}</pre>
                </div>
                <Button className="w-full" onClick={copyRecipe} variant="outline">
                  <Copy className="h-4 w-4 mr-2" />
                  Copy recipe
                </Button>
                <Button
                  className="w-full"
                  onClick={() => toast.info("Server render queue is ready for the next implementation step.")}
                >
                  <Check className="h-4 w-4 mr-2" />
                  Save as edited variant
                </Button>
                <Button className="w-full" variant="ghost" onClick={() => onOpenChange(false)}>
                  <X className="h-4 w-4 mr-2" />
                  Close editor
                </Button>
              </TabsContent>
            </Tabs>
          </div>
        </div>
      </SheetContent>
    </Sheet>
  );
}

function EditorRange({
  label,
  value,
  min,
  max,
  suffix,
  onChange,
}: {
  label: string;
  value: number;
  min: number;
  max: number;
  suffix: string;
  onChange: (value: number) => void;
}) {
  return (
    <div className="space-y-2">
      <div className="flex items-center justify-between gap-3">
        <Label>{label}</Label>
        <span className="text-xs tabular-nums text-muted-foreground">
          {value}
          {suffix}
        </span>
      </div>
      <input
        type="range"
        min={min}
        max={max}
        value={value}
        onChange={(event) => onChange(Number(event.target.value))}
        className="w-full accent-primary"
      />
    </div>
  );
}
