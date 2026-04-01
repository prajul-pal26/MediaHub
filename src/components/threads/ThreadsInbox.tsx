"use client";

import { useState, useCallback, useRef, useEffect } from "react";
import { trpc } from "@/lib/trpc/client";
import { useBrand } from "@/lib/hooks/use-brand";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import { Textarea } from "@/components/ui/textarea";
import { Separator } from "@/components/ui/separator";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Switch } from "@/components/ui/switch";
import { Label } from "@/components/ui/label";
import { toast } from "sonner";
import {
  MessageCircle,
  Search,
  Send,
  RefreshCw,
  Camera,
  Play,
  Briefcase,
  Filter,
  Archive,
  Flag,
  CheckCheck,
  Eye,
  GripVertical,
  Plus,
  Trash2,
  X,
  ChevronRight,
  Clock,
  Heart,
  ThumbsUp,
  ThumbsDown,
  HelpCircle,
  Loader2,
  Inbox,
  Star,
  CornerDownRight,
  Pencil,
  Copy,
  Bot,
  Settings2,
  Zap,
  ExternalLink,
} from "lucide-react";
import { cn } from "@/lib/utils";
import Link from "next/link";

// ─── Helpers ───
function getPlatformPostUrl(platform: string, platformPostId: string, accountUsername?: string): string | null {
  if (!platformPostId) return null;
  switch (platform) {
    case "instagram": return `https://www.instagram.com/p/${platformPostId}/`;
    case "youtube": return `https://www.youtube.com/watch?v=${platformPostId}`;
    case "linkedin": return `https://www.linkedin.com/feed/update/${platformPostId}/`;
    case "facebook": return `https://www.facebook.com/${platformPostId}`;
    case "tiktok": return accountUsername ? `https://www.tiktok.com/@${accountUsername}/video/${platformPostId}` : `https://www.tiktok.com/video/${platformPostId}`;
    case "twitter": return `https://x.com/i/status/${platformPostId}`;
    default: return null;
  }
}

// ─── Platform Icons ───
const PlatformIcon = ({ platform, className }: { platform: string; className?: string }) => {
  switch (platform) {
    case "instagram": return <Camera className={cn("text-pink-500", className)} />;
    case "youtube": return <Play className={cn("text-red-500", className)} />;
    case "linkedin": return <Briefcase className={cn("text-blue-600", className)} />;
    case "facebook": return <MessageCircle className={cn("text-blue-500", className)} />;
    case "tiktok": return <Play className={cn("text-gray-900 dark:text-white", className)} />;
    case "twitter": return <MessageCircle className={cn("text-sky-500", className)} />;
    case "snapchat": return <Camera className={cn("text-yellow-400", className)} />;
    default: return <MessageCircle className={className} />;
  }
};

const SentimentIcon = ({ sentiment }: { sentiment: string | null }) => {
  switch (sentiment) {
    case "positive": return <ThumbsUp className="h-3 w-3 text-green-500" />;
    case "negative": return <ThumbsDown className="h-3 w-3 text-red-500" />;
    case "question": return <HelpCircle className="h-3 w-3 text-yellow-500" />;
    default: return null;
  }
};

// ─── Draggable Template Card ───
function DraggableTemplate({
  template,
  onEdit,
  onDelete,
}: {
  template: any;
  onEdit: (t: any) => void;
  onDelete: (id: string) => void;
}) {
  const handleDragStart = (e: React.DragEvent) => {
    e.dataTransfer.setData("text/plain", template.body);
    e.dataTransfer.setData("application/template-id", template.id);
    e.dataTransfer.effectAllowed = "copy";
  };

  return (
    <div
      draggable
      onDragStart={handleDragStart}
      className="group border rounded-lg p-3 bg-card hover:bg-accent/50 cursor-grab active:cursor-grabbing transition-all hover:shadow-sm"
    >
      <div className="flex items-start gap-2">
        <GripVertical className="h-4 w-4 mt-0.5 text-muted-foreground/50 group-hover:text-muted-foreground" />
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2 mb-1">
            <span className="text-xs font-medium truncate">{template.name}</span>
            <Badge variant="outline" className="text-[10px] px-1.5 py-0">
              {template.category}
            </Badge>
          </div>
          <p className="text-xs text-muted-foreground line-clamp-2">{template.body}</p>
          {template.use_count > 0 && (
            <span className="text-[10px] text-muted-foreground mt-1 block">
              Used {template.use_count}x
            </span>
          )}
        </div>
        <div className="flex gap-1 opacity-0 group-hover:opacity-100 transition-opacity">
          <button onClick={() => onEdit(template)} className="p-1 hover:bg-muted rounded">
            <Pencil className="h-3 w-3 text-muted-foreground" />
          </button>
          <button onClick={() => onDelete(template.id)} className="p-1 hover:bg-destructive/10 rounded">
            <Trash2 className="h-3 w-3 text-destructive" />
          </button>
        </div>
      </div>
    </div>
  );
}

// ─── Comment Card (droppable) ───
function CommentCard({
  comment,
  isSelected,
  onSelect,
  onReply,
  onDrop,
  isActive,
  onClick,
}: {
  comment: any;
  isSelected: boolean;
  onSelect: (id: string) => void;
  onReply: (id: string, text: string, templateId?: string) => void;
  onDrop: (commentId: string, text: string, templateId?: string) => void;
  isActive: boolean;
  onClick: () => void;
}) {
  const [isDragOver, setIsDragOver] = useState(false);
  const [inlineReply, setInlineReply] = useState("");
  const [showInlineReply, setShowInlineReply] = useState(false);

  const handleDragOver = (e: React.DragEvent) => {
    e.preventDefault();
    e.dataTransfer.dropEffect = "copy";
    setIsDragOver(true);
  };

  const handleDragLeave = () => setIsDragOver(false);

  const handleDrop = (e: React.DragEvent) => {
    e.preventDefault();
    setIsDragOver(false);
    const text = e.dataTransfer.getData("text/plain");
    const templateId = e.dataTransfer.getData("application/template-id");
    if (text) {
      onDrop(comment.id, text, templateId || undefined);
    }
  };

  const handleInlineSubmit = () => {
    if (!inlineReply.trim()) return;
    onReply(comment.id, inlineReply.trim());
    setInlineReply("");
    setShowInlineReply(false);
  };

  const timeAgo = (timestamp: string) => {
    const diff = Date.now() - new Date(timestamp).getTime();
    const mins = Math.floor(diff / 60000);
    if (mins < 60) return `${mins}m`;
    const hours = Math.floor(mins / 60);
    if (hours < 24) return `${hours}h`;
    const days = Math.floor(hours / 24);
    return `${days}d`;
  };

  const hasReplies = comment.comment_replies && comment.comment_replies.length > 0;
  const latestReply = hasReplies
    ? comment.comment_replies.sort((a: any, b: any) => new Date(b.sent_at || b.created_at).getTime() - new Date(a.sent_at || a.created_at).getTime())[0]
    : null;

  return (
    <div
      onDragOver={handleDragOver}
      onDragLeave={handleDragLeave}
      onDrop={handleDrop}
      onClick={onClick}
      className={cn(
        "border rounded-lg p-3 transition-all cursor-pointer",
        isDragOver && "ring-2 ring-primary bg-primary/5 border-primary",
        isActive && "bg-accent border-primary/50",
        !isActive && "hover:bg-accent/50",
        comment.status === "unread" && "border-l-4 border-l-blue-500",
        comment.status === "flagged" && "border-l-4 border-l-red-500",
      )}
    >
      <div className="flex items-start gap-2">
        {/* Selection checkbox */}
        <input
          type="checkbox"
          checked={isSelected}
          onChange={(e) => {
            e.stopPropagation();
            onSelect(comment.id);
          }}
          className="mt-1 rounded border-muted-foreground/30"
          onClick={(e) => e.stopPropagation()}
        />

        {/* Avatar */}
        <div className="h-8 w-8 rounded-full bg-muted flex items-center justify-center flex-shrink-0">
          {comment.author_avatar_url ? (
            <img src={comment.author_avatar_url} alt="" className="h-8 w-8 rounded-full" />
          ) : (
            <span className="text-xs font-medium">
              {comment.author_username?.[0]?.toUpperCase() || "?"}
            </span>
          )}
        </div>

        {/* Content */}
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2 mb-0.5">
            <PlatformIcon platform={comment.platform} className="h-3.5 w-3.5" />
            <span className="text-sm font-medium truncate">{comment.author_username}</span>
            <SentimentIcon sentiment={comment.sentiment} />
            <span className="text-[10px] text-muted-foreground ml-auto flex items-center gap-1">
              <Clock className="h-2.5 w-2.5" />
              {timeAgo(comment.comment_timestamp)}
            </span>
          </div>

          <p className="text-sm text-foreground line-clamp-2 mb-1">{comment.comment_text}</p>

          {/* Post context */}
          {comment.post_title && (
            <p className="text-[10px] text-muted-foreground mb-1 truncate">
              On: <span className="font-medium text-foreground/70">{comment.post_title}</span>
            </p>
          )}

          <div className="flex items-center gap-3 text-[10px] text-muted-foreground">
            {comment.like_count > 0 && (
              <span className="flex items-center gap-0.5">
                <Heart className="h-2.5 w-2.5" /> {comment.like_count}
              </span>
            )}
            {comment.reply_count > 0 && (
              <span className="flex items-center gap-0.5">
                <MessageCircle className="h-2.5 w-2.5" /> {comment.reply_count}
              </span>
            )}
            {comment.status === "replied" && (
              <Badge variant="outline" className="text-[10px] px-1 py-0 text-green-600 border-green-300">
                <CheckCheck className="h-2.5 w-2.5 mr-0.5" /> Replied
              </Badge>
            )}
            {comment.platform_parent_comment_id && (
              <Badge variant="outline" className="text-[10px] px-1 py-0">
                <CornerDownRight className="h-2.5 w-2.5 mr-0.5" /> Reply
              </Badge>
            )}
          </div>

          {/* Latest reply preview */}
          {latestReply && (
            <div className="mt-2 pl-3 border-l-2 border-primary/30">
              <p className="text-xs text-muted-foreground line-clamp-1">
                <span className="font-medium text-foreground">You:</span> {latestReply.reply_text}
              </p>
              <span className="text-[10px] text-muted-foreground">
                {latestReply.status === "sent" ? "Sent" : latestReply.status === "failed" ? "Failed" : "Pending"}
              </span>
            </div>
          )}

          {/* Inline reply */}
          {showInlineReply && (
            <div className="mt-2 flex gap-1" onClick={(e) => e.stopPropagation()}>
              <Input
                value={inlineReply}
                onChange={(e) => setInlineReply(e.target.value)}
                placeholder="Type a reply..."
                className="text-xs h-8"
                onKeyDown={(e) => {
                  if (e.key === "Enter" && !e.shiftKey) {
                    e.preventDefault();
                    handleInlineSubmit();
                  }
                }}
                autoFocus
              />
              <Button size="sm" className="h-8 px-2" onClick={handleInlineSubmit} disabled={!inlineReply.trim()}>
                <Send className="h-3 w-3" />
              </Button>
              <Button size="sm" variant="ghost" className="h-8 px-2" onClick={() => setShowInlineReply(false)}>
                <X className="h-3 w-3" />
              </Button>
            </div>
          )}
        </div>

        {/* Quick actions */}
        <div className="flex flex-col gap-1 opacity-0 group-hover:opacity-100 transition-opacity">
          <button
            className="p-1 hover:bg-muted rounded"
            title="Quick reply"
            onClick={(e) => {
              e.stopPropagation();
              setShowInlineReply(!showInlineReply);
            }}
          >
            <Send className="h-3 w-3 text-muted-foreground" />
          </button>
        </div>
      </div>
    </div>
  );
}

// ─── Main Threads Inbox ───
export function ThreadsInbox() {
  const { activeBrandId } = useBrand();
  const brandId = activeBrandId;

  // State
  const [platform, setPlatform] = useState<string>("all");
  const [status, setStatus] = useState<string>("all");
  const [sentiment, setSentiment] = useState<string>("all");
  const [search, setSearch] = useState("");
  const [page, setPage] = useState(1);
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
  const [activeCommentId, setActiveCommentId] = useState<string | null>(null);
  const [draftReply, setDraftReply] = useState("");
  const [showTemplateEditor, setShowTemplateEditor] = useState(false);
  const [editingTemplate, setEditingTemplate] = useState<any>(null);
  const [newTemplateName, setNewTemplateName] = useState("");
  const [newTemplateBody, setNewTemplateBody] = useState("");
  const [newTemplateCategory, setNewTemplateCategory] = useState("general");
  const [showAutoReplySettings, setShowAutoReplySettings] = useState(false);
  const draftRef = useRef<HTMLTextAreaElement>(null);

  // Queries
  const commentsQuery = trpc.threads.listComments.useQuery(
    {
      brandId: brandId!,
      platform: platform as any,
      status: status as any,
      sentiment: sentiment as any,
      search: search || undefined,
      page,
      limit: 30,
    },
    { enabled: !!brandId, refetchInterval: 5000 }
  );

  const statsQuery = trpc.threads.getStats.useQuery(
    { brandId: brandId! },
    { enabled: !!brandId, refetchInterval: 5000 }
  );

  const threadQuery = trpc.threads.getThread.useQuery(
    { commentId: activeCommentId! },
    { enabled: !!activeCommentId }
  );

  const templatesQuery = trpc.threads.listTemplates.useQuery(
    { brandId: brandId! },
    { enabled: !!brandId }
  );

  // Mutations
  const replyMutation = trpc.threads.replyToComment.useMutation({
    onSuccess: () => {
      toast.success("Reply queued for sending");
      commentsQuery.refetch();
      threadQuery.refetch();
      setDraftReply("");
    },
    onError: (err) => toast.error(err.message),
  });

  const bulkReplyMutation = trpc.threads.bulkReply.useMutation({
    onSuccess: (data) => {
      toast.success(`${data.count} replies queued`);
      commentsQuery.refetch();
      setSelectedIds(new Set());
      setDraftReply("");
    },
    onError: (err) => toast.error(err.message),
  });

  const updateStatusMutation = trpc.threads.updateStatus.useMutation({
    onSuccess: () => {
      commentsQuery.refetch();
      statsQuery.refetch();
    },
    onError: (err) => toast.error(err.message),
  });

  const generateReplyMutation = trpc.threads.generateReply.useMutation({
    onSuccess: (data) => {
      setDraftReply(data.generatedText);
      toast.success("AI reply generated - review and edit before sending");
    },
    onError: (err) => toast.error(`AI generation failed: ${err.message}`),
  });

  const syncMutation = trpc.threads.syncComments.useMutation({
    onSuccess: () => {
      toast.success("Comment sync started");
      setTimeout(() => commentsQuery.refetch(), 5000);
    },
    onError: (err) => toast.error(err.message),
  });

  const createTemplateMutation = trpc.threads.createTemplate.useMutation({
    onSuccess: () => {
      toast.success("Template created");
      templatesQuery.refetch();
      setNewTemplateName("");
      setNewTemplateBody("");
      setShowTemplateEditor(false);
    },
    onError: (err) => toast.error(err.message),
  });

  const updateTemplateMutation = trpc.threads.updateTemplate.useMutation({
    onSuccess: () => {
      toast.success("Template updated");
      templatesQuery.refetch();
      setEditingTemplate(null);
      setNewTemplateName("");
      setNewTemplateBody("");
    },
    onError: (err) => toast.error(err.message),
  });

  const deleteTemplateMutation = trpc.threads.deleteTemplate.useMutation({
    onSuccess: () => {
      toast.success("Template deleted");
      templatesQuery.refetch();
    },
    onError: (err) => toast.error(err.message),
  });

  // Auto-reply
  const autoReplyQuery = trpc.threads.getAutoReplySettings.useQuery(
    { brandId: brandId! },
    { enabled: !!brandId }
  );

  const updateAutoReplyMutation = trpc.threads.updateAutoReplySettings.useMutation({
    onSuccess: () => {
      toast.success("Auto-reply settings updated");
      autoReplyQuery.refetch();
    },
    onError: (err) => toast.error(err.message),
  });

  // Handlers
  const handleSelect = useCallback((id: string) => {
    setSelectedIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }, []);

  const handleReply = useCallback(
    (commentId: string, text: string, templateId?: string) => {
      replyMutation.mutate({ commentId, replyText: text, templateId });
    },
    [replyMutation]
  );

  const handleDrop = useCallback(
    (commentId: string, text: string, templateId?: string) => {
      replyMutation.mutate({ commentId, replyText: text, templateId });
    },
    [replyMutation]
  );

  const handleBulkReply = () => {
    if (!draftReply.trim() || selectedIds.size === 0) return;
    bulkReplyMutation.mutate({
      commentIds: [...selectedIds],
      replyText: draftReply.trim(),
    });
  };

  const handleSendActiveReply = () => {
    if (!draftReply.trim() || !activeCommentId) return;
    replyMutation.mutate({ commentId: activeCommentId, replyText: draftReply.trim() });
  };

  const handleBulkAction = (action: string) => {
    if (selectedIds.size === 0) return;
    updateStatusMutation.mutate({
      commentIds: [...selectedIds],
      status: action as any,
    });
    setSelectedIds(new Set());
  };

  const selectAll = () => {
    const ids = commentsQuery.data?.comments.map((c: any) => c.id) || [];
    setSelectedIds(new Set(ids));
  };

  const handleDraftDragOver = (e: React.DragEvent) => {
    e.preventDefault();
    e.dataTransfer.dropEffect = "copy";
  };

  const handleDraftDrop = (e: React.DragEvent) => {
    e.preventDefault();
    const text = e.dataTransfer.getData("text/plain");
    if (text) setDraftReply(text);
  };

  const handleTemplateSubmit = () => {
    if (!brandId || !newTemplateName.trim() || !newTemplateBody.trim()) return;
    if (editingTemplate) {
      updateTemplateMutation.mutate({
        id: editingTemplate.id,
        name: newTemplateName.trim(),
        body: newTemplateBody.trim(),
        category: newTemplateCategory as any,
      });
    } else {
      createTemplateMutation.mutate({
        brandId,
        name: newTemplateName.trim(),
        body: newTemplateBody.trim(),
        category: newTemplateCategory as any,
      });
    }
  };

  if (!brandId) {
    return (
      <div className="flex items-center justify-center h-[60vh] text-muted-foreground">
        <p>Select a brand to view comment threads</p>
      </div>
    );
  }

  const stats = statsQuery.data;
  const comments = commentsQuery.data?.comments || [];
  const activeThread = threadQuery.data;
  const templates = templatesQuery.data || [];

  return (
    <div className="h-[calc(100vh-6rem)] flex gap-0 overflow-hidden">
      {/* ━━━ LEFT: Comment List ━━━ */}
      <div className="w-[420px] flex flex-col border-r flex-shrink-0">
        {/* Stats bar */}
        <div className="p-3 border-b bg-card">
          <div className="flex items-center justify-between mb-2">
            <h2 className="font-semibold text-lg flex items-center gap-2">
              <Inbox className="h-5 w-5" />
              Threads
              <span className="relative flex h-2 w-2">
                <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-green-400 opacity-75"></span>
                <span className="relative inline-flex rounded-full h-2 w-2 bg-green-500"></span>
              </span>
              <span className="text-[10px] font-normal text-muted-foreground">Live</span>
            </h2>
            <div className="flex items-center gap-1">
              {/* Auto-reply toggle */}
              <div className="flex items-center gap-1.5 mr-2">
                <Bot className={cn("h-3.5 w-3.5", autoReplyQuery.data?.enabled ? "text-green-500" : "text-muted-foreground")} />
                <Switch
                  checked={autoReplyQuery.data?.enabled || false}
                  onCheckedChange={(checked) => {
                    if (brandId) updateAutoReplyMutation.mutate({ brandId, enabled: checked });
                  }}
                  className="scale-75"
                />
                <button
                  onClick={() => setShowAutoReplySettings(!showAutoReplySettings)}
                  className="p-0.5 hover:bg-muted rounded"
                  title="Auto-reply settings"
                >
                  <Settings2 className="h-3 w-3 text-muted-foreground" />
                </button>
              </div>
              <Button
                size="sm"
                variant="outline"
                className="h-7 text-xs"
                onClick={() => brandId && syncMutation.mutate({ brandId })}
                disabled={syncMutation.isPending}
              >
                <RefreshCw className={cn("h-3 w-3 mr-1", syncMutation.isPending && "animate-spin")} />
                Sync
              </Button>
            </div>
          </div>

          {/* Quick stats */}
          {stats && (
            <div className="flex gap-2 text-xs">
              <button
                onClick={() => setStatus("all")}
                className={cn(
                  "px-2 py-1 rounded-full transition-colors",
                  status === "all" ? "bg-primary text-primary-foreground" : "bg-muted hover:bg-muted/80"
                )}
              >
                All {stats.total}
              </button>
              <button
                onClick={() => setStatus("unread")}
                className={cn(
                  "px-2 py-1 rounded-full transition-colors",
                  status === "unread" ? "bg-blue-500 text-white" : "bg-muted hover:bg-muted/80"
                )}
              >
                Unread {stats.unread}
              </button>
              <button
                onClick={() => setStatus("flagged")}
                className={cn(
                  "px-2 py-1 rounded-full transition-colors",
                  status === "flagged" ? "bg-red-500 text-white" : "bg-muted hover:bg-muted/80"
                )}
              >
                Flagged {stats.flagged}
              </button>
              <button
                onClick={() => setStatus("replied")}
                className={cn(
                  "px-2 py-1 rounded-full transition-colors",
                  status === "replied" ? "bg-green-500 text-white" : "bg-muted hover:bg-muted/80"
                )}
              >
                Replied {stats.replied}
              </button>
            </div>
          )}
        </div>

        {/* Auto-reply settings panel */}
        {showAutoReplySettings && autoReplyQuery.data && (
          <div className="p-3 border-b bg-muted/30 space-y-3">
            <div className="flex items-center gap-2">
              <Zap className="h-4 w-4 text-yellow-500" />
              <span className="text-sm font-medium">Auto-Reply Settings</span>
            </div>
            <div className="space-y-2">
              <div>
                <Label className="text-xs">Tone</Label>
                <Select
                  value={autoReplyQuery.data.tone}
                  onValueChange={(v) => { if (v && brandId) updateAutoReplyMutation.mutate({ brandId, enabled: autoReplyQuery.data!.enabled, tone: v as any }); }}
                >
                  <SelectTrigger className="h-8 text-xs">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="friendly">Friendly</SelectItem>
                    <SelectItem value="professional">Professional</SelectItem>
                    <SelectItem value="casual">Casual</SelectItem>
                    <SelectItem value="witty">Witty</SelectItem>
                    <SelectItem value="empathetic">Empathetic</SelectItem>
                  </SelectContent>
                </Select>
              </div>
              <div>
                <Label className="text-xs">Max replies/hour</Label>
                <Input
                  type="number"
                  min={1}
                  max={100}
                  className="h-8 text-xs"
                  defaultValue={autoReplyQuery.data.maxRepliesPerHour}
                  onBlur={(e) => {
                    const val = parseInt(e.target.value);
                    if (val && brandId) updateAutoReplyMutation.mutate({ brandId, enabled: autoReplyQuery.data!.enabled, maxRepliesPerHour: val });
                  }}
                />
              </div>
              <div>
                <Label className="text-xs">Custom instructions (optional)</Label>
                <Textarea
                  className="text-xs min-h-[50px] resize-none"
                  placeholder="e.g., Always mention our sale ends Friday, respond in Hindi if commented in Hindi..."
                  defaultValue={autoReplyQuery.data.customInstructions}
                  onBlur={(e) => {
                    if (brandId) updateAutoReplyMutation.mutate({ brandId, enabled: autoReplyQuery.data!.enabled, customInstructions: e.target.value });
                  }}
                />
              </div>
              <p className="text-[10px] text-muted-foreground">
                AI analyzes each comment's context, the original post content, and generates personalized replies using your configured LLM.
              </p>
            </div>
          </div>
        )}

        {/* Filters */}
        <div className="p-2 border-b flex gap-2 items-center">
          <div className="relative flex-1">
            <Search className="absolute left-2 top-1/2 -translate-y-1/2 h-3.5 w-3.5 text-muted-foreground" />
            <Input
              placeholder="Search comments..."
              value={search}
              onChange={(e) => {
                setSearch(e.target.value);
                setPage(1);
              }}
              className="pl-8 h-8 text-xs"
            />
          </div>
          <Select value={platform} onValueChange={(v) => { if (v) { setPlatform(v); setPage(1); } }}>
            <SelectTrigger className="w-[100px] h-8 text-xs">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all">All</SelectItem>
              <SelectItem value="instagram">Instagram</SelectItem>
              <SelectItem value="youtube">YouTube</SelectItem>
              <SelectItem value="linkedin">LinkedIn</SelectItem>
              <SelectItem value="facebook">Facebook</SelectItem>
              <SelectItem value="tiktok">TikTok</SelectItem>
              <SelectItem value="twitter">Twitter</SelectItem>
              <SelectItem value="snapchat">Snapchat</SelectItem>
            </SelectContent>
          </Select>
          <Select value={sentiment} onValueChange={(v) => { if (v) { setSentiment(v); setPage(1); } }}>
            <SelectTrigger className="w-[90px] h-8 text-xs">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all">Sentiment</SelectItem>
              <SelectItem value="positive">Positive</SelectItem>
              <SelectItem value="negative">Negative</SelectItem>
              <SelectItem value="neutral">Neutral</SelectItem>
              <SelectItem value="question">Questions</SelectItem>
            </SelectContent>
          </Select>
        </div>

        {/* Bulk actions bar */}
        {selectedIds.size > 0 && (
          <div className="p-2 border-b bg-muted/50 flex items-center gap-2">
            <span className="text-xs font-medium">{selectedIds.size} selected</span>
            <div className="flex gap-1 ml-auto">
              <Button size="sm" variant="ghost" className="h-6 text-[10px] px-2" onClick={() => handleBulkAction("read")}>
                <Eye className="h-3 w-3 mr-1" /> Read
              </Button>
              <Button size="sm" variant="ghost" className="h-6 text-[10px] px-2" onClick={() => handleBulkAction("flagged")}>
                <Flag className="h-3 w-3 mr-1" /> Flag
              </Button>
              <Button size="sm" variant="ghost" className="h-6 text-[10px] px-2" onClick={() => handleBulkAction("archived")}>
                <Archive className="h-3 w-3 mr-1" /> Archive
              </Button>
              <Button size="sm" variant="ghost" className="h-6 text-[10px] px-2" onClick={() => setSelectedIds(new Set())}>
                <X className="h-3 w-3" />
              </Button>
            </div>
          </div>
        )}

        {/* Comment list */}
        <ScrollArea className="flex-1">
          <div className="p-2 space-y-1.5">
            {commentsQuery.isLoading ? (
              <div className="flex items-center justify-center py-12">
                <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
              </div>
            ) : comments.length === 0 ? (
              <div className="flex flex-col items-center justify-center py-12 text-muted-foreground">
                <MessageCircle className="h-8 w-8 mb-2" />
                <p className="text-sm">No comments found</p>
                <p className="text-xs">Click Sync to fetch latest comments</p>
              </div>
            ) : (
              <>
                <div className="flex items-center justify-between px-1 mb-1">
                  <button onClick={selectAll} className="text-[10px] text-muted-foreground hover:text-foreground">
                    Select all
                  </button>
                  <span className="text-[10px] text-muted-foreground">
                    {commentsQuery.data?.total || 0} total
                  </span>
                </div>
                {comments.map((comment: any) => (
                  <div key={comment.id} className="group">
                    <CommentCard
                      comment={comment}
                      isSelected={selectedIds.has(comment.id)}
                      onSelect={handleSelect}
                      onReply={handleReply}
                      onDrop={handleDrop}
                      isActive={activeCommentId === comment.id}
                      onClick={() => setActiveCommentId(comment.id)}
                    />
                  </div>
                ))}
                {/* Pagination */}
                {(commentsQuery.data?.totalPages || 1) > 1 && (
                  <div className="flex items-center justify-center gap-2 py-3">
                    <Button
                      size="sm"
                      variant="outline"
                      className="h-7 text-xs"
                      disabled={page === 1}
                      onClick={() => setPage(page - 1)}
                    >
                      Previous
                    </Button>
                    <span className="text-xs text-muted-foreground">
                      {page} / {commentsQuery.data?.totalPages}
                    </span>
                    <Button
                      size="sm"
                      variant="outline"
                      className="h-7 text-xs"
                      disabled={page >= (commentsQuery.data?.totalPages || 1)}
                      onClick={() => setPage(page + 1)}
                    >
                      Next
                    </Button>
                  </div>
                )}
              </>
            )}
          </div>
        </ScrollArea>
      </div>

      {/* ━━━ CENTER: Thread Detail + Reply Composer ━━━ */}
      <div className="flex-1 flex flex-col min-w-0">
        {activeCommentId && activeThread ? (
          <>
            {/* Thread header */}
            <div className="p-4 border-b bg-card">
              <div className="flex items-center gap-3">
                <div className="h-10 w-10 rounded-full bg-muted flex items-center justify-center">
                  {activeThread.author_avatar_url ? (
                    <img src={activeThread.author_avatar_url} alt="" className="h-10 w-10 rounded-full" />
                  ) : (
                    <span className="font-medium">
                      {activeThread.author_username?.[0]?.toUpperCase()}
                    </span>
                  )}
                </div>
                <div className="flex-1">
                  <div className="flex items-center gap-2">
                    <PlatformIcon platform={activeThread.platform} className="h-4 w-4" />
                    <span className="font-semibold">{activeThread.author_username}</span>
                    <Badge variant="outline" className="text-xs">
                      {activeThread.platform}
                    </Badge>
                    {activeThread.sentiment && (
                      <Badge
                        variant="outline"
                        className={cn(
                          "text-xs",
                          activeThread.sentiment === "positive" && "text-green-600 border-green-300",
                          activeThread.sentiment === "negative" && "text-red-600 border-red-300",
                          activeThread.sentiment === "question" && "text-yellow-600 border-yellow-300"
                        )}
                      >
                        {activeThread.sentiment}
                      </Badge>
                    )}
                  </div>
                  {activeThread.postInfo && (
                    <p className="text-xs text-muted-foreground mt-0.5">
                      On:{" "}
                      {activeThread.postInfo.group_id ? (
                        <Link
                          href={`/publish/${activeThread.postInfo.group_id}`}
                          className="text-primary hover:underline"
                          onClick={(e) => e.stopPropagation()}
                        >
                          {activeThread.postInfo.title}
                        </Link>
                      ) : (
                        activeThread.postInfo.title
                      )}
                    </p>
                  )}
                </div>
                <div className="flex gap-1">
                  {activeThread.platform_post_id && (() => {
                    const url = getPlatformPostUrl(
                      activeThread.platform,
                      activeThread.platform_post_id,
                      activeThread.social_accounts?.platform_username
                    );
                    return url ? (
                      <a
                        href={url}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="inline-flex items-center gap-1 h-8 px-3 text-xs border rounded-md hover:bg-accent transition-colors"
                      >
                        <ExternalLink className="h-3 w-3" />
                        Open on {activeThread.platform.charAt(0).toUpperCase() + activeThread.platform.slice(1)}
                      </a>
                    ) : null;
                  })()}
                  <Button
                    size="sm"
                    variant="ghost"
                    onClick={() =>
                      updateStatusMutation.mutate({ commentIds: [activeCommentId], status: "flagged" })
                    }
                  >
                    <Flag className="h-4 w-4" />
                  </Button>
                  <Button
                    size="sm"
                    variant="ghost"
                    onClick={() =>
                      updateStatusMutation.mutate({ commentIds: [activeCommentId], status: "archived" })
                    }
                  >
                    <Archive className="h-4 w-4" />
                  </Button>
                </div>
              </div>
            </div>

            {/* Comment + replies */}
            <ScrollArea className="flex-1 p-4">
              {/* Original comment */}
              <div className="mb-4">
                <div className="bg-muted/50 rounded-lg p-4">
                  <p className="text-sm whitespace-pre-wrap">{activeThread.comment_text}</p>
                  <div className="flex items-center gap-3 mt-2 text-xs text-muted-foreground">
                    <span className="flex items-center gap-1">
                      <Heart className="h-3 w-3" /> {activeThread.like_count} likes
                    </span>
                    <span>{new Date(activeThread.comment_timestamp).toLocaleString()}</span>
                    {activeThread.platform_post_id && (
                      <span className="text-[10px] font-mono">
                        Post: {activeThread.platform_post_id.slice(0, 16)}...
                      </span>
                    )}
                  </div>
                </div>
              </div>

              {/* Platform replies (other users' replies to this comment) */}
              {activeThread.platformReplies && activeThread.platformReplies.length > 0 && (
                <div className="space-y-3">
                  <Separator />
                  <h4 className="text-xs font-medium text-muted-foreground uppercase tracking-wider">
                    Platform Replies
                  </h4>
                  {activeThread.platformReplies.map((pr: any) => (
                    <div key={pr.id} className="flex gap-3">
                      <div className="h-6 w-6 rounded-full bg-muted flex items-center justify-center flex-shrink-0 mt-1">
                        {pr.author_avatar_url ? (
                          <img src={pr.author_avatar_url} alt="" className="h-6 w-6 rounded-full" />
                        ) : (
                          <span className="text-[10px] font-medium">
                            {pr.author_username?.[0]?.toUpperCase() || "?"}
                          </span>
                        )}
                      </div>
                      <div className="flex-1 bg-muted/30 border rounded-lg p-3">
                        <div className="flex items-center gap-2 mb-1">
                          <span className="text-xs font-medium">{pr.author_username}</span>
                          {pr.sentiment && <SentimentIcon sentiment={pr.sentiment} />}
                        </div>
                        <p className="text-sm">{pr.comment_text}</p>
                        <div className="flex items-center gap-2 mt-1 text-xs text-muted-foreground">
                          {pr.like_count > 0 && (
                            <span className="flex items-center gap-0.5">
                              <Heart className="h-2.5 w-2.5" /> {pr.like_count}
                            </span>
                          )}
                          <span>{new Date(pr.comment_timestamp).toLocaleString()}</span>
                        </div>
                      </div>
                    </div>
                  ))}
                </div>
              )}

              {/* Our replies */}
              {activeThread.comment_replies && activeThread.comment_replies.length > 0 && (
                <div className="space-y-3">
                  <Separator />
                  <h4 className="text-xs font-medium text-muted-foreground uppercase tracking-wider">
                    Your Replies
                  </h4>
                  {activeThread.comment_replies.map((reply: any) => (
                    <div key={reply.id} className="flex gap-3">
                      <CornerDownRight className="h-4 w-4 text-primary mt-1 flex-shrink-0" />
                      <div className="flex-1 bg-primary/5 border border-primary/20 rounded-lg p-3">
                        <p className="text-sm">{reply.reply_text}</p>
                        <div className="flex items-center gap-2 mt-1 text-xs text-muted-foreground">
                          <Badge
                            variant="outline"
                            className={cn(
                              "text-[10px] px-1.5",
                              reply.status === "sent" && "text-green-600 border-green-300",
                              reply.status === "failed" && "text-red-600 border-red-300",
                              reply.status === "pending" && "text-yellow-600 border-yellow-300",
                              reply.status === "sending" && "text-blue-600 border-blue-300"
                            )}
                          >
                            {reply.status}
                          </Badge>
                          <span>
                            {new Date(reply.sent_at || reply.created_at).toLocaleString()}
                          </span>
                          {reply.error_message && (
                            <span className="text-red-500">{reply.error_message}</span>
                          )}
                        </div>
                      </div>
                    </div>
                  ))}
                </div>
              )}
            </ScrollArea>

            {/* Reply composer */}
            <div
              className="border-t p-4 bg-card"
              onDragOver={handleDraftDragOver}
              onDrop={handleDraftDrop}
            >
              {selectedIds.size > 1 && (
                <div className="mb-2 p-2 bg-blue-50 dark:bg-blue-950 rounded-md text-xs text-blue-700 dark:text-blue-300 flex items-center gap-2">
                  <CheckCheck className="h-3.5 w-3.5" />
                  Replying to {selectedIds.size} selected comments at once
                </div>
              )}
              <div className="flex gap-2">
                <Textarea
                  ref={draftRef}
                  value={draftReply}
                  onChange={(e) => setDraftReply(e.target.value)}
                  placeholder={
                    selectedIds.size > 1
                      ? `Type a reply for ${selectedIds.size} comments... (or drag a template here)`
                      : "Type your reply... (or drag a template here)"
                  }
                  className="min-h-[60px] max-h-[120px] text-sm resize-none"
                  onKeyDown={(e) => {
                    if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
                      e.preventDefault();
                      if (selectedIds.size > 1) handleBulkReply();
                      else handleSendActiveReply();
                    }
                  }}
                />
                <div className="flex flex-col gap-1">
                  <Button
                    onClick={selectedIds.size > 1 ? handleBulkReply : handleSendActiveReply}
                    disabled={
                      !draftReply.trim() ||
                      replyMutation.isPending ||
                      bulkReplyMutation.isPending
                    }
                    className="flex-1"
                  >
                    {replyMutation.isPending || bulkReplyMutation.isPending ? (
                      <Loader2 className="h-4 w-4 animate-spin" />
                    ) : (
                      <Send className="h-4 w-4" />
                    )}
                  </Button>
                  <Button
                    variant="outline"
                    onClick={() => {
                      if (activeCommentId) {
                        generateReplyMutation.mutate({ commentId: activeCommentId });
                      }
                    }}
                    disabled={!activeCommentId || generateReplyMutation.isPending}
                    title="Generate reply with AI"
                    className="flex-1"
                  >
                    {generateReplyMutation.isPending ? (
                      <Loader2 className="h-4 w-4 animate-spin" />
                    ) : (
                      <Bot className="h-4 w-4" />
                    )}
                  </Button>
                </div>
              </div>
              <p className="text-[10px] text-muted-foreground mt-1">
                {selectedIds.size > 1 ? "Ctrl+Enter to send to all selected" : "Ctrl+Enter to send"} | Drag templates from the right panel
              </p>
            </div>
          </>
        ) : (
          <div className="flex-1 flex items-center justify-center text-muted-foreground">
            <div className="text-center">
              <MessageCircle className="h-12 w-12 mx-auto mb-3 opacity-30" />
              <p className="text-sm font-medium">Select a comment to view the thread</p>
              <p className="text-xs mt-1">Or drag a template onto any comment to quick-reply</p>
            </div>
          </div>
        )}
      </div>

      {/* ━━━ RIGHT: Reply Templates ━━━ */}
      <div className="w-[280px] border-l flex flex-col flex-shrink-0">
        <div className="p-3 border-b bg-card">
          <div className="flex items-center justify-between">
            <h3 className="font-semibold text-sm flex items-center gap-2">
              <Copy className="h-4 w-4" />
              Quick Replies
            </h3>
            <Button
              size="sm"
              variant="ghost"
              className="h-7 w-7 p-0"
              onClick={() => {
                setEditingTemplate(null);
                setNewTemplateName("");
                setNewTemplateBody("");
                setNewTemplateCategory("general");
                setShowTemplateEditor(!showTemplateEditor);
              }}
            >
              <Plus className="h-4 w-4" />
            </Button>
          </div>
        </div>

        {/* Template editor */}
        {(showTemplateEditor || editingTemplate) && (
          <div className="p-3 border-b bg-muted/30 space-y-2">
            <Input
              placeholder="Template name"
              value={newTemplateName}
              onChange={(e) => setNewTemplateName(e.target.value)}
              className="h-8 text-xs"
            />
            <Textarea
              placeholder="Reply text... Use {{author}} for personalization"
              value={newTemplateBody}
              onChange={(e) => setNewTemplateBody(e.target.value)}
              className="min-h-[60px] text-xs resize-none"
            />
            <Select value={newTemplateCategory} onValueChange={(v) => { if (v) setNewTemplateCategory(v); }}>
              <SelectTrigger className="h-8 text-xs">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="general">General</SelectItem>
                <SelectItem value="thanks">Thanks</SelectItem>
                <SelectItem value="question">Question</SelectItem>
                <SelectItem value="promotion">Promotion</SelectItem>
                <SelectItem value="support">Support</SelectItem>
                <SelectItem value="custom">Custom</SelectItem>
              </SelectContent>
            </Select>
            <div className="flex gap-2">
              <Button
                size="sm"
                className="h-7 text-xs flex-1"
                onClick={handleTemplateSubmit}
                disabled={
                  !newTemplateName.trim() ||
                  !newTemplateBody.trim() ||
                  createTemplateMutation.isPending ||
                  updateTemplateMutation.isPending
                }
              >
                {editingTemplate ? "Update" : "Create"}
              </Button>
              <Button
                size="sm"
                variant="ghost"
                className="h-7 text-xs"
                onClick={() => {
                  setShowTemplateEditor(false);
                  setEditingTemplate(null);
                  setNewTemplateName("");
                  setNewTemplateBody("");
                }}
              >
                Cancel
              </Button>
            </div>
          </div>
        )}

        {/* Template list */}
        <ScrollArea className="flex-1 p-2">
          <div className="space-y-2">
            {templates.length === 0 ? (
              <div className="text-center py-8 text-muted-foreground">
                <GripVertical className="h-6 w-6 mx-auto mb-2 opacity-30" />
                <p className="text-xs">No templates yet</p>
                <p className="text-[10px]">Create templates for quick drag-and-drop replies</p>
              </div>
            ) : (
              templates.map((template: any) => (
                <DraggableTemplate
                  key={template.id}
                  template={template}
                  onEdit={(t) => {
                    setEditingTemplate(t);
                    setNewTemplateName(t.name);
                    setNewTemplateBody(t.body);
                    setNewTemplateCategory(t.category);
                    setShowTemplateEditor(true);
                  }}
                  onDelete={(id) => deleteTemplateMutation.mutate({ id })}
                />
              ))
            )}
          </div>
        </ScrollArea>

        {/* Template tips */}
        <div className="p-3 border-t bg-muted/30">
          <p className="text-[10px] text-muted-foreground leading-relaxed">
            <strong>Drag & drop</strong> templates onto comments to reply instantly.
            Use <code className="bg-muted px-1 rounded">{"{{author}}"}</code> for personalization.
          </p>
        </div>
      </div>
    </div>
  );
}
