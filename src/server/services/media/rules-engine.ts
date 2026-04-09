export interface PlatformRule {
  key: string;
  label: string;
  platform: "instagram" | "youtube" | "linkedin" | "facebook" | "tiktok" | "twitter" | "snapchat";
  acceptsImage: boolean;
  acceptsVideo: boolean;
  maxDuration: number | null;
  targetRatios: string[];
  preferredSize: { w: number; h: number };
  requiresMultipleFiles?: boolean;
}

export const PLATFORM_RULES: Record<string, PlatformRule> = {
  ig_post:     { key: "ig_post",     label: "Instagram Post",     platform: "instagram", acceptsImage: true,  acceptsVideo: true,  maxDuration: 3600,  targetRatios: ["1:1","4:5","191:100"], preferredSize: {w:1080,h:1080} },
  ig_reel:     { key: "ig_reel",     label: "Instagram Reel",     platform: "instagram", acceptsImage: false, acceptsVideo: true,  maxDuration: 90,    targetRatios: ["9:16"],                preferredSize: {w:1080,h:1920} },
  ig_story:    { key: "ig_story",    label: "Instagram Story",    platform: "instagram", acceptsImage: true,  acceptsVideo: true,  maxDuration: 60,    targetRatios: ["9:16"],                preferredSize: {w:1080,h:1920} },
  ig_carousel: { key: "ig_carousel", label: "Instagram Carousel", platform: "instagram", acceptsImage: true,  acceptsVideo: true,  maxDuration: 60,    targetRatios: ["1:1","4:5"],           preferredSize: {w:1080,h:1080}, requiresMultipleFiles: true },
  yt_video:    { key: "yt_video",    label: "YouTube Video",      platform: "youtube",   acceptsImage: false, acceptsVideo: true,  maxDuration: 43200, targetRatios: ["16:9"],                preferredSize: {w:1920,h:1080} },
  yt_short:    { key: "yt_short",    label: "YouTube Short",      platform: "youtube",   acceptsImage: false, acceptsVideo: true,  maxDuration: 60,    targetRatios: ["9:16"],                preferredSize: {w:1080,h:1920} },
  li_post:     { key: "li_post",     label: "LinkedIn Post",      platform: "linkedin",  acceptsImage: true,  acceptsVideo: true,  maxDuration: 600,   targetRatios: ["1:1","191:100","4:5"], preferredSize: {w:1200,h:1200} },
  li_article:  { key: "li_article",  label: "LinkedIn Article",   platform: "linkedin",  acceptsImage: true,  acceptsVideo: false, maxDuration: null,  targetRatios: ["191:100"],             preferredSize: {w:1200,h:627} },
  // Facebook
  fb_post:     { key: "fb_post",     label: "Facebook Post",      platform: "facebook",  acceptsImage: true,  acceptsVideo: true,  maxDuration: 7200,  targetRatios: ["1:1","4:5","191:100","16:9"], preferredSize: {w:1080,h:1080} },
  fb_reel:     { key: "fb_reel",     label: "Facebook Reel",      platform: "facebook",  acceptsImage: false, acceptsVideo: true,  maxDuration: 90,    targetRatios: ["9:16"],                preferredSize: {w:1080,h:1920} },
  fb_story:    { key: "fb_story",    label: "Facebook Story",     platform: "facebook",  acceptsImage: true,  acceptsVideo: true,  maxDuration: 60,    targetRatios: ["9:16"],                preferredSize: {w:1080,h:1920} },
  // TikTok
  tt_video:    { key: "tt_video",    label: "TikTok Video",       platform: "tiktok",    acceptsImage: false, acceptsVideo: true,  maxDuration: 600,   targetRatios: ["9:16"],                preferredSize: {w:1080,h:1920} },
  // Twitter/X
  tw_post:     { key: "tw_post",     label: "Tweet",              platform: "twitter",   acceptsImage: true,  acceptsVideo: true,  maxDuration: 140,   targetRatios: ["16:9","1:1"],          preferredSize: {w:1200,h:675} },
  // Snapchat
  sc_story:    { key: "sc_story",    label: "Snap Story",         platform: "snapchat",  acceptsImage: true,  acceptsVideo: true,  maxDuration: 60,    targetRatios: ["9:16"],                preferredSize: {w:1080,h:1920} },
};

export type ResizeOption = "auto_crop" | "blur_bg" | "custom_crop" | "keep_original";

export interface ActionAvailability {
  key: string;
  label: string;
  platform: string;
  available: boolean;
  reason?: string;
  needsResize: boolean;
  resizeOptions: ResizeOption[];
  targetRatios: string[];
  preferredSize: { w: number; h: number };
}

export function getValidActions(asset: {
  file_type: string;
  duration_seconds?: number | null;
  aspect_ratio?: string | null;
  width?: number | null;
  height?: number | null;
}, variantCount: number = 1): ActionAvailability[] {
  const isImage = asset.file_type?.startsWith("image/");
  const isVideo = asset.file_type?.startsWith("video/");
  const duration = asset.duration_seconds || 0;
  const ratio = asset.aspect_ratio || "";

  return Object.values(PLATFORM_RULES).map((rule) => {
    const result: ActionAvailability = {
      key: rule.key,
      label: rule.label,
      platform: rule.platform,
      available: true,
      needsResize: false,
      resizeOptions: [],
      targetRatios: rule.targetRatios,
      preferredSize: rule.preferredSize,
    };

    // File type check
    if (isImage && !rule.acceptsImage) {
      result.available = false;
      result.reason = "This action requires video";
      return result;
    }
    if (isVideo && !rule.acceptsVideo) {
      result.available = false;
      result.reason = "This action requires an image";
      return result;
    }
    if (!isImage && !isVideo) {
      result.available = false;
      result.reason = "Unsupported file type";
      return result;
    }

    // Duration check (video only)
    if (isVideo && rule.maxDuration !== null && duration > rule.maxDuration) {
      result.available = false;
      result.reason = `Video too long (${duration}s, max ${rule.maxDuration}s)`;
      return result;
    }

    // Multiple files check (carousel)
    if (rule.requiresMultipleFiles && variantCount < 2) {
      result.available = false;
      result.reason = "Requires 2+ files for carousel";
      return result;
    }

    // Ratio check
    if (ratio && rule.targetRatios.length > 0) {
      const ratioMatches = rule.targetRatios.includes(ratio);
      if (!ratioMatches) {
        result.needsResize = true;
        result.resizeOptions = ["auto_crop", "blur_bg", "custom_crop", "keep_original"];
      }
    }

    return result;
  });
}

export function getResizeOptions(needsResize: boolean): ResizeOption[] {
  if (!needsResize) return [];
  return ["auto_crop", "blur_bg", "custom_crop", "keep_original"];
}

// Platform-aware metadata for publish jobs
// captionOverrides keys from frontend: `${action}_${accountId}_caption`, `${action}_${accountId}_title`, etc.
export function getPlatformMetadata(
  action: string,
  caption: string,
  tags: string[],
  title?: string,
  description?: string,
  captionOverrides?: Record<string, string>,
  socialAccountId?: string
): Record<string, string | string[] | null> {
  const hashTags = tags.map((t) => `#${t.replace(/^#/, "")}`).join(" ");
  const fullCaption = caption ? `${caption}\n\n${hashTags}`.trim() : hashTags;

  // Resolve override for this specific job (action + account)
  const ov = (field: string): string | undefined => {
    if (!captionOverrides || !socialAccountId) return undefined;
    // Try exact key: ig_post_accountId_caption
    return captionOverrides[`${action}_${socialAccountId}_${field}`];
  };

  switch (action) {
    case "ig_post":
    case "ig_reel":
    case "ig_carousel":
      return {
        caption: ov("caption") || fullCaption,
        hashtags: hashTags,
      };
    case "ig_story":
      return { caption: null, hashtags: null }; // Stories skip captions
    case "yt_video":
      return {
        title: ov("title") || title || caption?.slice(0, 100) || "Untitled",
        description: ov("description") || description || caption || "",
        tags: tags.join(","),
      };
    case "yt_short":
      return {
        title: ov("title") || caption?.slice(0, 100) || "Untitled",
        tags: tags.join(","),
      };
    case "li_post":
      return { caption: ov("caption") || fullCaption };
    case "li_article":
      return {
        title: ov("title") || title || caption?.slice(0, 200) || "Untitled",
        description: ov("description") || description || caption || "",
      };
    case "fb_post":
    case "fb_reel":
      return {
        caption: ov("caption") || fullCaption,
      };
    case "fb_story":
      return { caption: null }; // Stories skip captions
    case "tt_video":
      return {
        caption: ov("caption") || fullCaption,
      };
    case "tw_post":
      return {
        caption: ov("caption") || (caption ? `${caption}\n\n${hashTags}`.trim() : hashTags).slice(0, 280),
      };
    case "sc_story":
      return {
        caption: ov("caption") || fullCaption,
      };
    default:
      return { caption: fullCaption };
  }
}
