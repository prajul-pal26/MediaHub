"use client";

import { useState, useMemo } from "react";
import { useRouter } from "next/navigation";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Badge } from "@/components/ui/badge";
import { Separator } from "@/components/ui/separator";
import { SchedulePicker } from "./SchedulePicker";
import { trpc } from "@/lib/trpc/client";
import { toast } from "sonner";
import { PLATFORM_RULES } from "@/server/services/media/rules-engine";
import {
  ChevronRight, ChevronLeft, Send, CalendarDays, Save, Loader2,
  CheckCircle2, Lock, Circle, AlertCircle, Check,
} from "lucide-react";
import { cn } from "@/lib/utils";
import type { ActionAvailability } from "@/server/services/media/rules-engine";

interface PreviousJob {
  assetId: string;
  socialAccountId: string;
  action: string;
  status: string;
  platformPostId?: string;
}

interface PublishPanelProps {
  group: any;
  accounts: Record<string, any[]>;
  previousJobs?: PreviousJob[];
}

type ResizeOption = "auto_crop" | "blur_bg" | "custom_crop" | "keep_original";

type ActionKey = "ig_post" | "ig_reel" | "ig_story" | "ig_carousel" | "yt_video" | "yt_short" | "li_post" | "li_article";

// Each publish job = one action + one account + customized content
interface PublishJob {
  assetId: string;
  accountId: string;
  accountName: string;
  action: ActionKey;
  actionLabel: string;
  platform: string;
  resizeOption: ResizeOption | null;
  title: string;
  caption: string;
  description: string;
  tags: string[];
  fileName: string;
  isBlocked: boolean;
}

export function PublishPanel({ group, accounts, previousJobs = [] }: PublishPanelProps) {
  const router = useRouter();
  const assets = group.media_assets || [];
  const asset = assets[0]; // For single variant — extend for multi later

  const [step, setStep] = useState(1);
  const [selectedActions, setSelectedActions] = useState<string[]>([]);
  const [selectedAccountsByAction, setSelectedAccountsByAction] = useState<Record<string, string[]>>({});
  const [jobContents, setJobContents] = useState<Record<string, { title: string; caption: string; description: string }>>({});
  const [showScheduler, setShowScheduler] = useState(false);

  const validActions: ActionAvailability[] = asset?.validActions || [];

  const scheduleMutation = trpc.publish.schedule.useMutation({
    onSuccess: (data) => {
      toast.success(`${data.jobCount} job${data.jobCount > 1 ? "s" : ""} scheduled`);
      router.push("/queue");
    },
    onError: (error) => toast.error(error.message),
  });

  const draftMutation = trpc.publish.saveDraft.useMutation({
    onSuccess: () => { toast.success("Draft saved"); router.push("/library"); },
    onError: (error) => toast.error(error.message),
  });

  // Check if action+account was already published
  function isAlreadyDone(action: string, accountId: string): boolean {
    return previousJobs.some(
      (pj) => pj.assetId === asset?.id && pj.action === action && pj.socialAccountId === accountId &&
        ["completed", "processing", "queued"].includes(pj.status)
    );
  }

  // Build the final jobs list
  const jobs: PublishJob[] = useMemo(() => {
    const result: PublishJob[] = [];
    for (const action of selectedActions) {
      const rule = PLATFORM_RULES[action];
      if (!rule) continue;
      const accountIds = selectedAccountsByAction[action] || [];
      for (const accId of accountIds) {
        const acc = Object.values(accounts).flat().find((a: any) => a.id === accId);
        if (!acc) continue;
        const blocked = isAlreadyDone(action, accId);
        const key = `${action}::${accId}`;
        const custom = jobContents[key];
        result.push({
          assetId: asset?.id,
          accountId: accId,
          accountName: acc.platform_username || "unknown",
          action: action as ActionKey,
          actionLabel: rule.label,
          platform: rule.platform,
          resizeOption: null,
          title: custom?.title ?? group.title ?? "",
          caption: custom?.caption ?? group.caption ?? "",
          description: custom?.description ?? group.description ?? "",
          tags: group.tags || [],
          fileName: asset?.file_name || "",
          isBlocked: blocked,
        });
      }
    }
    return result;
  }, [selectedActions, selectedAccountsByAction, jobContents, asset, group, accounts, previousJobs]);

  const publishableJobs = jobs.filter((j) => !j.isBlocked);
  const blockedJobs = jobs.filter((j) => j.isBlocked);

  function toggleAction(key: string) {
    setSelectedActions((prev) =>
      prev.includes(key) ? prev.filter((a) => a !== key) : [...prev, key]
    );
  }

  function toggleAccountForAction(action: string, accountId: string) {
    setSelectedAccountsByAction((prev) => {
      const current = prev[action] || [];
      return {
        ...prev,
        [action]: current.includes(accountId)
          ? current.filter((id) => id !== accountId)
          : [...current, accountId],
      };
    });
  }

  function updateJobContent(action: string, accountId: string, field: string, value: string) {
    const key = `${action}::${accountId}`;
    setJobContents((prev) => ({
      ...prev,
      [key]: { ...prev[key], title: prev[key]?.title ?? group.title ?? "", caption: prev[key]?.caption ?? group.caption ?? "", description: prev[key]?.description ?? group.description ?? "", [field]: value },
    }));
  }

  function handlePublish(scheduledAt: string | null) {
    if (publishableJobs.length === 0) {
      toast.error("No new jobs to publish");
      return;
    }
    const captionOverrides: Record<string, string> = {};
    for (const j of publishableJobs) {
      const key = `${j.action}::${j.accountId}`;
      if (jobContents[key]?.caption) captionOverrides[`${j.action}_${j.accountId}_caption`] = jobContents[key].caption;
      if (jobContents[key]?.title) captionOverrides[`${j.action}_${j.accountId}_title`] = jobContents[key].title;
      if (jobContents[key]?.description) captionOverrides[`${j.action}_${j.accountId}_description`] = jobContents[key].description;
    }

    scheduleMutation.mutate({
      groupId: group.id,
      scheduledAt,
      jobs: publishableJobs.map((j) => ({
        assetId: j.assetId,
        socialAccountId: j.accountId,
        action: j.action,
        resizeOption: j.resizeOption,
      })),
      captionOverrides: Object.keys(captionOverrides).length > 0 ? captionOverrides : undefined,
    });
  }

  function handleSaveDraft() {
    draftMutation.mutate({
      groupId: group.id,
      jobs: publishableJobs.map((j) => ({
        assetId: j.assetId,
        socialAccountId: j.accountId,
        action: j.action,
        resizeOption: j.resizeOption,
      })),
    });
  }

  // Total steps
  const totalSteps = 4;
  const canGoNext = step === 1 ? selectedActions.length > 0
    : step === 2 ? publishableJobs.length > 0
    : step === 3 ? true
    : true;

  return (
    <div className="max-w-3xl mx-auto space-y-6">
      {/* Header */}
      <div>
        <h1 className="text-2xl font-bold">Publish: {group.title}</h1>
        <p className="text-muted-foreground text-sm">
          {asset?.file_name} &middot; {asset?.width}x{asset?.height} &middot; {asset?.aspect_ratio}
          {asset?.duration_seconds ? ` &middot; ${asset.duration_seconds}s` : ""}
        </p>
      </div>

      {/* Step indicator */}
      <div className="flex items-center gap-2">
        {["Actions", "Accounts", "Content", "Review"].map((label, i) => {
          const stepNum = i + 1;
          const isActive = step === stepNum;
          const isDone = step > stepNum;
          return (
            <div key={label} className="flex items-center gap-2 flex-1">
              <button
                onClick={() => stepNum < step && setStep(stepNum)}
                className={cn(
                  "flex items-center gap-1.5 text-sm font-medium transition-colors",
                  isActive ? "text-foreground" : isDone ? "text-green-600 cursor-pointer" : "text-muted-foreground"
                )}
              >
                <div className={cn(
                  "h-6 w-6 rounded-full flex items-center justify-center text-xs border-2",
                  isActive ? "border-primary text-primary bg-primary/10"
                    : isDone ? "border-green-500 bg-green-500 text-white"
                    : "border-muted text-muted-foreground"
                )}>
                  {isDone ? <Check className="h-3 w-3" /> : stepNum}
                </div>
                <span className="hidden sm:inline">{label}</span>
              </button>
              {i < 3 && <div className={cn("flex-1 h-px", isDone ? "bg-green-300" : "bg-muted")} />}
            </div>
          );
        })}
      </div>

      {/* Previously published banner */}
      {previousJobs.length > 0 && step === 1 && (
        <div className="flex items-start gap-2 p-3 bg-blue-50 text-blue-800 rounded-lg text-sm">
          <CheckCircle2 className="h-4 w-4 mt-0.5 shrink-0" />
          <div>
            <p className="font-medium">Previously published</p>
            <div className="flex flex-wrap gap-1 mt-1">
              {previousJobs.map((pj, i) => {
                const rule = PLATFORM_RULES[pj.action];
                const acc = Object.values(accounts).flat().find((a: any) => a.id === pj.socialAccountId);
                return (
                  <Badge key={i} variant="secondary" className="text-xs bg-white">
                    {rule?.label} → @{(acc as any)?.platform_username || "?"}
                  </Badge>
                );
              })}
            </div>
          </div>
        </div>
      )}

      {/* ─── STEP 1: Select Actions ─── */}
      {step === 1 && (
        <Card>
          <CardHeader>
            <CardTitle className="text-lg">What do you want to publish as?</CardTitle>
          </CardHeader>
          <CardContent>
            <div className="grid grid-cols-2 gap-3">
              {validActions.map((action) => {
                const isSelected = selectedActions.includes(action.key);
                const platformAccounts = accounts[action.platform] || [];
                const hasAccounts = platformAccounts.length > 0;
                const allAccountsDone = hasAccounts && platformAccounts.every(
                  (acc: any) => isAlreadyDone(action.key, acc.id)
                );

                // No accounts connected for this platform — don't show
                if (!hasAccounts) return null;

                // Action not available (wrong file type, duration, etc.)
                if (!action.available) {
                  return (
                    <div
                      key={action.key}
                      className="flex items-center gap-3 p-4 rounded-lg border border-dashed border-muted opacity-40"
                    >
                      <Circle className="h-5 w-5 text-muted-foreground" />
                      <div>
                        <p className="text-sm font-medium line-through">{action.label}</p>
                        <p className="text-xs text-muted-foreground">{action.reason}</p>
                      </div>
                    </div>
                  );
                }

                // All accounts already published for this action
                if (allAccountsDone) {
                  return (
                    <div
                      key={action.key}
                      className="flex items-center gap-3 p-4 rounded-lg border border-green-200 bg-green-50/50 opacity-60"
                    >
                      <CheckCircle2 className="h-5 w-5 text-green-500" />
                      <div>
                        <p className="text-sm font-medium">{action.label}</p>
                        <p className="text-xs text-green-600">Published to all {platformAccounts.length} account{platformAccounts.length !== 1 ? "s" : ""}</p>
                      </div>
                    </div>
                  );
                }

                return (
                  <button
                    key={action.key}
                    onClick={() => toggleAction(action.key)}
                    className={cn(
                      "flex items-center gap-3 p-4 rounded-lg border-2 text-left transition-all",
                      isSelected
                        ? "border-primary bg-primary/5"
                        : "border-input hover:border-primary/50"
                    )}
                  >
                    {isSelected ? (
                      <CheckCircle2 className="h-5 w-5 text-primary shrink-0" />
                    ) : (
                      <Circle className="h-5 w-5 text-muted-foreground shrink-0" />
                    )}
                    <div>
                      <p className="text-sm font-medium">{action.label}</p>
                      <p className="text-xs text-muted-foreground">
                        {(accounts[action.platform] || []).length} account{(accounts[action.platform] || []).length !== 1 ? "s" : ""} available
                      </p>
                    </div>
                  </button>
                );
              })}
            </div>

            {/* No accounts connected at all */}
            {Object.values(accounts).every((arr: any) => arr.length === 0) && (
              <div className="mt-4 p-4 bg-amber-50 text-amber-800 rounded-lg text-sm flex items-start gap-2">
                <AlertCircle className="h-4 w-4 mt-0.5 shrink-0" />
                <div>
                  <p className="font-medium">No social accounts connected</p>
                  <p className="text-xs mt-1">Connect your Instagram, YouTube, or LinkedIn accounts in the Accounts page first, then come back to publish.</p>
                </div>
              </div>
            )}
          </CardContent>
        </Card>
      )}

      {/* ─── STEP 2: Select Accounts per Action ─── */}
      {step === 2 && (
        <div className="space-y-4">
          {selectedActions.map((actionKey) => {
            const rule = PLATFORM_RULES[actionKey];
            if (!rule) return null;
            const actionAccounts = accounts[rule.platform] || [];
            const selected = selectedAccountsByAction[actionKey] || [];

            return (
              <Card key={actionKey}>
                <CardHeader className="pb-3">
                  <CardTitle className="text-base">{rule.label}</CardTitle>
                </CardHeader>
                <CardContent>
                  <p className="text-xs text-muted-foreground mb-3">Select accounts to publish to:</p>
                  <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
                    {actionAccounts.map((acc: any) => {
                      const done = isAlreadyDone(actionKey, acc.id);
                      const isSelected = selected.includes(acc.id);

                      if (done) {
                        return (
                          <div key={acc.id} className="flex items-center gap-2 p-3 rounded-lg border border-green-200 bg-green-50 opacity-60">
                            <Lock className="h-4 w-4 text-green-500" />
                            <span className="text-sm">@{acc.platform_username}</span>
                            <span className="text-xs text-green-600 ml-auto">already published</span>
                          </div>
                        );
                      }

                      return (
                        <button
                          key={acc.id}
                          onClick={() => toggleAccountForAction(actionKey, acc.id)}
                          className={cn(
                            "flex items-center gap-2 p-3 rounded-lg border-2 text-left transition-all",
                            isSelected ? "border-primary bg-primary/5" : "border-input hover:border-primary/50"
                          )}
                        >
                          {isSelected ? (
                            <CheckCircle2 className="h-4 w-4 text-primary" />
                          ) : (
                            <Circle className="h-4 w-4 text-muted-foreground" />
                          )}
                          <span className="text-sm font-medium">@{acc.platform_username}</span>
                        </button>
                      );
                    })}
                  </div>
                </CardContent>
              </Card>
            );
          })}
        </div>
      )}

      {/* ─── STEP 3: Customize Content per Job ─── */}
      {step === 3 && (
        <div className="space-y-4">
          <p className="text-sm text-muted-foreground">
            Customize title and description for each publish job. Changes here only affect that specific post.
          </p>
          {publishableJobs.map((job, i) => {
            const key = `${job.action}::${job.accountId}`;
            const custom = jobContents[key];
            const showTitle = job.action.startsWith("yt_") || job.action === "li_article";
            const showDescription = job.action.startsWith("yt_") || job.action === "li_article" || job.action === "li_post";
            const isStory = job.action === "ig_story";

            return (
              <Card key={key}>
                <CardHeader className="pb-2">
                  <div className="flex items-center justify-between">
                    <CardTitle className="text-sm font-medium">
                      {job.actionLabel} → @{job.accountName}
                    </CardTitle>
                    <Badge variant="outline" className="text-xs">{i + 1} of {publishableJobs.length}</Badge>
                  </div>
                </CardHeader>
                <CardContent className="space-y-3">
                  {isStory && (
                    <p className="text-xs text-amber-600 bg-amber-50 p-2 rounded">
                      Stories don&apos;t support captions or tags — content will be published as-is.
                    </p>
                  )}

                  {showTitle && (
                    <div className="space-y-1.5">
                      <Label className="text-sm">Title</Label>
                      <Input
                        value={custom?.title ?? job.title}
                        onChange={(e) => updateJobContent(job.action, job.accountId, "title", e.target.value)}
                        placeholder="Video title"
                      />
                    </div>
                  )}

                  {!isStory && (
                    <div className="space-y-1.5">
                      <Label className="text-sm">Caption</Label>
                      <Textarea
                        value={custom?.caption ?? job.caption}
                        onChange={(e) => updateJobContent(job.action, job.accountId, "caption", e.target.value)}
                        placeholder="Caption text"
                        rows={3}
                      />
                    </div>
                  )}

                  {showDescription && (
                    <div className="space-y-1.5">
                      <Label className="text-sm">Description</Label>
                      <Textarea
                        value={custom?.description ?? job.description}
                        onChange={(e) => updateJobContent(job.action, job.accountId, "description", e.target.value)}
                        placeholder="Longer description"
                        rows={2}
                      />
                    </div>
                  )}

                  {!isStory && job.tags.length > 0 && (
                    <div className="flex flex-wrap gap-1">
                      {job.tags.map((tag: string) => (
                        <Badge key={tag} variant="secondary" className="text-xs">#{tag}</Badge>
                      ))}
                    </div>
                  )}
                </CardContent>
              </Card>
            );
          })}
        </div>
      )}

      {/* ─── STEP 4: Review & Publish ─── */}
      {step === 4 && (
        <div className="space-y-4">
          <Card>
            <CardHeader>
              <CardTitle className="text-lg">Review — {publishableJobs.length} job{publishableJobs.length !== 1 ? "s" : ""}</CardTitle>
            </CardHeader>
            <CardContent className="space-y-2">
              {publishableJobs.map((job, i) => (
                <div key={i} className="flex items-center justify-between p-3 bg-muted/50 rounded-lg">
                  <div>
                    <p className="text-sm font-medium">{job.actionLabel} → @{job.accountName}</p>
                    <p className="text-xs text-muted-foreground truncate max-w-md">
                      {job.action.startsWith("yt_") ? `"${jobContents[`${job.action}::${job.accountId}`]?.title || job.title}"` : (jobContents[`${job.action}::${job.accountId}`]?.caption || job.caption || "No caption").slice(0, 80)}
                    </p>
                  </div>
                  <Badge variant="secondary" className="text-xs shrink-0">{job.fileName}</Badge>
                </div>
              ))}
            </CardContent>
          </Card>

          {blockedJobs.length > 0 && (
            <div className="flex items-start gap-2 p-3 bg-amber-50 text-amber-800 rounded-lg text-xs">
              <AlertCircle className="h-4 w-4 mt-0.5 shrink-0" />
              <div>
                <p className="font-medium">{blockedJobs.length} skipped (already published):</p>
                {blockedJobs.map((j, i) => (
                  <p key={i}>{j.actionLabel} → @{j.accountName}</p>
                ))}
              </div>
            </div>
          )}
        </div>
      )}

      {/* Navigation */}
      <div className="flex items-center gap-3 pt-2">
        {step > 1 && (
          <Button variant="ghost" onClick={() => setStep(step - 1)}>
            <ChevronLeft className="h-4 w-4 mr-1" />
            Back
          </Button>
        )}

        <div className="flex-1" />

        {step < 4 && (
          <Button onClick={() => setStep(step + 1)} disabled={!canGoNext}>
            Next
            <ChevronRight className="h-4 w-4 ml-1" />
          </Button>
        )}

        {step === 4 && (
          <>
            <Button variant="outline" onClick={handleSaveDraft} disabled={draftMutation.isPending}>
              <Save className="h-4 w-4 mr-2" />
              Save draft
            </Button>
            <Button variant="outline" onClick={() => setShowScheduler(true)} disabled={publishableJobs.length === 0 || scheduleMutation.isPending}>
              <CalendarDays className="h-4 w-4 mr-2" />
              Schedule
            </Button>
            <Button onClick={() => handlePublish(null)} disabled={publishableJobs.length === 0 || scheduleMutation.isPending}>
              {scheduleMutation.isPending ? <Loader2 className="h-4 w-4 mr-2 animate-spin" /> : <Send className="h-4 w-4 mr-2" />}
              Publish now ({publishableJobs.length})
            </Button>
          </>
        )}
      </div>

      <SchedulePicker
        open={showScheduler}
        onClose={() => setShowScheduler(false)}
        onSchedule={(date) => { setShowScheduler(false); handlePublish(date.toISOString()); }}
        onPublishNow={() => { setShowScheduler(false); handlePublish(null); }}
      />
    </div>
  );
}
