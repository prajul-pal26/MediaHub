"use client";

import { useEffect, useMemo, useState } from "react";
import {
  Search,
  RefreshCw,
  ExternalLink,
  CheckCircle2,
  Clock,
  Sparkles,
  Camera,
  Check,
  Layers,
  FolderOpen,
  Globe,
  Trash2,
} from "lucide-react";
import { toast } from "sonner";
import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { trpc } from "@/lib/trpc/client";

interface DistrictProfileItem {
  id: string;
  district: string;
  instaName: string;
  logoFileName: string;
  logoUrl: string;
  hasLogo: boolean;
  hasSafariSession: boolean;
  safariUuid?: string;
  safariUsername?: string;
  status: "pending" | "synced";
  photoSyncedAt?: string | null;
  sourceRowNumber?: number;
  updatedAt?: string;
}

export function InstagramProfilePhotoSync() {
  const [search, setSearch] = useState("");
  const [filterTab, setFilterTab] = useState<"all" | "safari" | "pending" | "synced">("all");
  const [previewProfile, setPreviewProfile] = useState<DistrictProfileItem | null>(null);
  const [syncingId, setSyncingId] = useState<string | null>(null);
  const [syncStateMap, setSyncStateMap] = useState<
    Record<string, { status: "uploading" | "done" | "error"; message?: string }>
  >({});

  const utils = trpc.useUtils();
  const listQuery = trpc.instaProfilePhoto.list.useQuery(undefined, {
    refetchInterval: 5000,
    refetchOnWindowFocus: true,
  });
  const setStatusMutation = trpc.instaProfilePhoto.setStatus.useMutation({
    onMutate: async ({ id, status }) => {
      await utils.instaProfilePhoto.list.cancel();
      const prev = utils.instaProfilePhoto.list.getData();
      utils.instaProfilePhoto.list.setData(undefined, (old) => {
        if (!old) return old;
        return old.map((p) =>
          p.id === id
            ? {
                ...p,
                status,
                photoSyncedAt: status === "synced" ? new Date().toISOString() : null,
              }
            : p
        );
      });
      return { prev };
    },
    onError: (err, _vars, context) => {
      if (context?.prev) {
        utils.instaProfilePhoto.list.setData(undefined, context.prev);
      }
      toast.error(err.message);
    },
    onSettled: () => {
      utils.instaProfilePhoto.list.invalidate();
    },
  });

  const syncFromDriveMutation = trpc.instaProfilePhoto.syncFromDrive.useMutation({
    onSuccess: (data) => {
      toast.success(data.message || "Updated district photos from Google Drive!");
      utils.instaProfilePhoto.list.invalidate();
    },
    onError: (err) => {
      toast.error(err.message || "Failed to update photos from Google Drive.");
    },
  });

  const deleteLogoMutation = trpc.instaProfilePhoto.deleteLogo.useMutation({
    onSuccess: (data) => {
      toast.success(`Deleted logo file (${data.fileName})`);
      utils.instaProfilePhoto.list.invalidate();
    },
    onError: (err) => {
      toast.error(err.message || "Failed to delete logo file.");
    },
  });

  const triggerSafariSyncMutation = trpc.instaProfilePhoto.triggerSafariSync.useMutation();

  const setSafariSessionMutation = trpc.instaProfilePhoto.setSafariSession.useMutation({
    onError: (err) => {
      toast.error(err.message || "Failed to update Safari session");
      utils.instaProfilePhoto.list.invalidate();
    },
    onSettled: () => {
      utils.instaProfilePhoto.list.invalidate();
    },
  });

  const scanSessionsMutation = trpc.instaProfilePhoto.scanSessions.useMutation({
    onSuccess: (data) => {
      if (data?.detected && data.detected.length > 0) {
        utils.instaProfilePhoto.list.invalidate();
      }
    },
  });

  // Automatically scan open Safari windows on component mount
  useEffect(() => {
    scanSessionsMutation.mutate(undefined, {
      onSuccess: () => {
        utils.instaProfilePhoto.list.invalidate();
      },
    });
  }, []);

  const profiles = (listQuery.data ?? []) as DistrictProfileItem[];

  function handleToggleSafariSession(profile: DistrictProfileItem) {
    const nextHasSession = !profile.hasSafariSession;
    // Optimistic update so UI, stats cards, and filters react instantly
    utils.instaProfilePhoto.list.setData(undefined, (old) => {
      if (!old) return old;
      return old.map((p) =>
        p.id === profile.id || p.instaName.toLowerCase() === profile.instaName.toLowerCase()
          ? { ...p, hasSafariSession: nextHasSession }
          : p
      );
    });

    if (previewProfile?.id === profile.id || previewProfile?.instaName.toLowerCase() === profile.instaName.toLowerCase()) {
      setPreviewProfile((prev) => (prev ? { ...prev, hasSafariSession: nextHasSession } : null));
    }

    setSafariSessionMutation.mutate(
      {
        district: profile.district,
        username: profile.instaName,
        hasSession: nextHasSession,
      },
      {
        onSuccess: () => {
          toast.success(
            `${profile.district} (@${profile.instaName}): marked ${nextHasSession ? "Safari Active" : "No Session"}`
          );
        },
      }
    );
  }

  async function handleDeletePhoto(profile: DistrictProfileItem) {
    if (!window.confirm(`Delete local photo for ${profile.district} (@${profile.instaName})?`)) {
      return;
    }
    // Optimistic update
    utils.instaProfilePhoto.list.setData(undefined, (old) => {
      if (!old) return old;
      return old.map((p) =>
        p.id === profile.id || p.instaName.toLowerCase() === profile.instaName.toLowerCase()
          ? { ...p, hasLogo: false }
          : p
      );
    });
    if (previewProfile?.id === profile.id || previewProfile?.instaName.toLowerCase() === profile.instaName.toLowerCase()) {
      setPreviewProfile((prev) => (prev ? { ...prev, hasLogo: false } : null));
    }
    try {
      await deleteLogoMutation.mutateAsync({ username: profile.instaName });
    } catch {
      utils.instaProfilePhoto.list.invalidate();
    }
  }

  function handleToggleStatus(profile: DistrictProfileItem) {
    const nextStatus = profile.status === "synced" ? "pending" : "synced";
    setStatusMutation.mutate({ id: profile.id, status: nextStatus });
    toast.success(`Marked @${profile.instaName} as ${nextStatus === "synced" ? "Synced" : "Not Synced"}`);
  }

  // Ping extension on mount & listen for replies
  useEffect(() => {
    function receive(event: MessageEvent) {
      if (event.source !== window || event.origin !== window.location.origin) return;
      const data = event.data;
      if (data?.source === "mediahub-photo-sync-extension") {
        if (data.state === "upload-complete") {
          toast.success(`Profile photo updated for @${data.data?.username || "account"}!`);
          if (data.data?.profileId) {
            setStatusMutation.mutate({ id: data.data.profileId, status: "synced" });
          } else {
            const matched = profiles.find(
              (p) => p.instaName.toLowerCase() === (data.data?.username || "").toLowerCase()
            );
            if (matched) {
              setStatusMutation.mutate({ id: matched.id, status: "synced" });
            }
          }
          utils.instaProfilePhoto.list.invalidate();
        } else if (data.state === "error") {
          toast.error(data.message || "Extension reported an error.");
        }
      }
    }

    window.addEventListener("message", receive);

    // Initial ping
    window.postMessage(
      { source: "mediahub-instagram-photo-sync", action: "ping" },
      window.location.origin
    );

    const interval = setInterval(() => {
      window.postMessage(
        { source: "mediahub-instagram-photo-sync", action: "ping" },
        window.location.origin
      );
    }, 4000);

    return () => {
      window.removeEventListener("message", receive);
      clearInterval(interval);
    };
  }, [utils, profiles, setStatusMutation]);

  const filteredProfiles = useMemo(() => {
    return profiles.filter((profile) => {
      // Tab filter
      if (filterTab === "safari" && !profile.hasSafariSession) return false;
      if (filterTab === "pending" && profile.status === "synced") return false;
      if (filterTab === "synced" && profile.status !== "synced") return false;

      // Search filter
      const q = search.trim().toLowerCase();
      if (!q) return true;
      return (
        profile.district.toLowerCase().includes(q) ||
        profile.instaName.toLowerCase().includes(q)
      );
    });
  }, [profiles, filterTab, search]);

  const stats = useMemo(() => {
    const total = profiles.length;
    const safariActive = profiles.filter((p) => p.hasSafariSession).length;
    const synced = profiles.filter((p) => p.status === "synced").length;
    const pending = total - synced;
    return { total, safariActive, synced, pending };
  }, [profiles]);

  async function handleSyncPhoto(profile: DistrictProfileItem) {
    setSyncingId(profile.id);
    setSyncStateMap((prev) => ({
      ...prev,
      [profile.id]: { status: "uploading", message: "Saving photo..." },
    }));

    try {
      // 1. Send command to Safari Host Bridge via server-side tRPC mutation
      let result: { success: boolean; message?: string } | null = null;
      try {
        result = await triggerSafariSyncMutation.mutateAsync({
          district: profile.district,
          username: profile.instaName,
        });
      } catch (trpcErr: any) {
        console.warn("tRPC bridge proxy error, trying direct browser fetch:", trpcErr);
        try {
          const directRes = await fetch("http://localhost:3012/sync-photo", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              district: profile.district,
              username: profile.instaName,
            }),
          });
          result = await directRes.json();
        } catch {
          throw new Error(trpcErr.message || "Safari Bridge offline. Run 'npm run safari:bridge'");
        }
      }

      if (result && result.success) {
        // Keep buffering animation running while flipping status in DB & query cache!
        setSyncStateMap((prev) => ({
          ...prev,
          [profile.id]: { status: "uploading", message: "Updating status & session..." },
        }));

        // Immediately update BOTH status: "synced" and hasSafariSession: true in local React Query cache!
        utils.instaProfilePhoto.list.setData(undefined, (old) => {
          if (!old) return old;
          return old.map((p) =>
            p.id === profile.id || p.instaName.toLowerCase() === profile.instaName.toLowerCase()
              ? {
                  ...p,
                  status: "synced",
                  hasSafariSession: true,
                  photoSyncedAt: new Date().toISOString(),
                }
              : p
          );
        });

        await Promise.allSettled([
          setStatusMutation.mutateAsync({ id: profile.id, status: "synced" }),
          setSafariSessionMutation.mutateAsync({
            district: profile.district,
            username: profile.instaName,
            hasSession: true,
          }),
        ]);

        setSyncStateMap((prev) => ({
          ...prev,
          [profile.id]: { status: "done", message: "Photo Saved!" },
        }));
        toast.success(`✅ Uploaded photo for @${profile.instaName} (Safari Active)!`);
        setTimeout(() => {
          setSyncStateMap((prev) => {
            const next = { ...prev };
            delete next[profile.id];
            return next;
          });
          setSyncingId(null);
        }, 2500);
      } else {
        const err = result?.message || "Upload failed in Safari";
        setSyncStateMap((prev) => ({
          ...prev,
          [profile.id]: { status: "error", message: err },
        }));
        toast.error(`❌ ${err}`);
        setTimeout(() => {
          setSyncStateMap((prev) => {
            const next = { ...prev };
            delete next[profile.id];
            return next;
          });
          setSyncingId(null);
        }, 4000);
      }
    } catch (err: any) {
      setSyncStateMap((prev) => ({
        ...prev,
        [profile.id]: { status: "error", message: err.message || "Failed" },
      }));
      toast.error(err.message || "Failed to sync photo.");
      setTimeout(() => {
        setSyncStateMap((prev) => {
          const next = { ...prev };
          delete next[profile.id];
          return next;
        });
        setSyncingId(null);
      }, 4000);
    }
  }

  return (
    <div className="w-full space-y-5">
      {/* Top Header */}
      <div className="flex flex-col gap-1">
        <h2 className="text-xl font-bold tracking-tight text-foreground">
          Instagram Profile Photo Sync
        </h2>
        <p className="text-xs text-muted-foreground">
          Pick and upload official district logos from Google Drive into Instagram via Safari profiles.
        </p>
      </div>

      {/* Stats Cards */}
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
        <Card className="p-4 bg-sidebar/50">
          <div className="flex items-center gap-3">
            <div className="p-2.5 rounded-lg bg-primary/10 text-primary">
              <Layers className="h-5 w-5" />
            </div>
            <div>
              <p className="text-xs font-medium text-muted-foreground">Total Profiles</p>
              <p className="text-xl font-bold text-foreground">{stats.total}</p>
            </div>
          </div>
        </Card>

        <Card className="p-4 bg-sidebar/50">
          <div className="flex items-center gap-3">
            <div className="p-2.5 rounded-lg bg-emerald-500/10 text-emerald-500">
              <Globe className="h-5 w-5" />
            </div>
            <div>
              <p className="text-xs font-medium text-muted-foreground">Safari Active</p>
              <p className="text-xl font-bold text-foreground">{stats.safariActive}</p>
            </div>
          </div>
        </Card>

        <Card className="p-4 bg-sidebar/50">
          <div className="flex items-center gap-3">
            <div className="p-2.5 rounded-lg bg-blue-500/10 text-blue-500">
              <CheckCircle2 className="h-5 w-5" />
            </div>
            <div>
              <p className="text-xs font-medium text-muted-foreground">Photos Synced</p>
              <p className="text-xl font-bold text-foreground">{stats.synced}</p>
            </div>
          </div>
        </Card>

        <Card className="p-4 bg-sidebar/50">
          <div className="flex items-center gap-3">
            <div className="p-2.5 rounded-lg bg-amber-500/10 text-amber-500">
              <Clock className="h-5 w-5" />
            </div>
            <div>
              <p className="text-xs font-medium text-muted-foreground">Not Synced</p>
              <p className="text-xl font-bold text-foreground">{stats.pending}</p>
            </div>
          </div>
        </Card>
      </div>

      {/* Main Content Card */}
      <Card>
        <CardHeader className="gap-4 pb-3 sm:flex-row sm:items-center sm:justify-between">
          <div>
            <CardTitle className="text-base font-semibold">District Logos & Safari Accounts</CardTitle>
            <CardDescription>
              Each account is paired with its district logo from Google Drive. Click &quot;Sync Photo&quot; to push via the extension.
            </CardDescription>
          </div>

          <div className="flex flex-col gap-2 sm:flex-row sm:items-center">
            {/* Filter Tabs */}
            <div className="flex items-center rounded-lg border border-border bg-muted/40 p-1 text-xs">
              <button
                type="button"
                onClick={() => setFilterTab("all")}
                className={`px-3 py-1 rounded-md font-medium transition-all ${
                  filterTab === "all"
                    ? "bg-background text-foreground shadow-xs"
                    : "text-muted-foreground hover:text-foreground"
                }`}
              >
                All ({stats.total})
              </button>
              <button
                type="button"
                onClick={() => setFilterTab("safari")}
                className={`px-3 py-1 rounded-md font-medium transition-all ${
                  filterTab === "safari"
                    ? "bg-background text-foreground shadow-xs"
                    : "text-muted-foreground hover:text-foreground"
                }`}
              >
                Safari Active ({stats.safariActive})
              </button>
              <button
                type="button"
                onClick={() => setFilterTab("pending")}
                className={`px-3 py-1 rounded-md font-medium transition-all ${
                  filterTab === "pending"
                    ? "bg-background text-foreground shadow-xs"
                    : "text-muted-foreground hover:text-foreground"
                }`}
              >
                Not Synced ({stats.pending})
              </button>
              <button
                type="button"
                onClick={() => setFilterTab("synced")}
                className={`px-3 py-1 rounded-md font-medium transition-all ${
                  filterTab === "synced"
                    ? "bg-background text-foreground shadow-xs"
                    : "text-muted-foreground hover:text-foreground"
                }`}
              >
                Synced ({stats.synced})
              </button>
            </div>

            {/* Search Input */}
            <div className="relative w-full sm:w-64">
              <Search className="absolute left-2.5 top-2.5 h-4 w-4 text-muted-foreground" />
              <Input
                placeholder="Search district or handle..."
                value={search}
                onChange={(e) => setSearch(e.target.value)}
                className="pl-8 h-9 text-xs"
              />
            </div>

            {/* Refresh Button */}
            <Button
              type="button"
              variant="outline"
              size="sm"
              onClick={() => {
                scanSessionsMutation.mutate(undefined, {
                  onSuccess: () => {
                    utils.instaProfilePhoto.list.invalidate();
                    toast.success("Scanned Safari windows & updated sessions");
                  },
                });
                utils.instaProfilePhoto.list.invalidate();
              }}
              disabled={listQuery.isFetching || scanSessionsMutation.isPending}
              className="h-9 cursor-pointer"
              title="Scan Safari windows & refresh list"
            >
              <RefreshCw
                className={`h-3.5 w-3.5 ${listQuery.isFetching || scanSessionsMutation.isPending ? "animate-spin" : ""}`}
              />
            </Button>

            {/* Google Drive Folder Link (placed directly on right side of refresh button) */}
            <a
              href="https://drive.google.com/drive/u/0/folders/1D8XvhruaFUHEiIB646UPHizEKQWtTWA1"
              target="_blank"
              rel="noreferrer"
              className="inline-flex items-center gap-1.5 h-9 px-3 rounded-md border border-border bg-background hover:bg-accent text-xs font-medium text-foreground transition-colors shrink-0 cursor-pointer shadow-xs"
              title="Open Google Drive folder with official district logos"
            >
              <FolderOpen className="h-4 w-4 text-amber-500" />
              <span className="hidden sm:inline">Google Drive Logos</span>
              <ExternalLink className="h-3 w-3 text-muted-foreground ml-0.5" />
            </a>
          </div>
        </CardHeader>

        <CardContent>
          {listQuery.isLoading ? (
            <div className="flex flex-col items-center justify-center py-16 text-muted-foreground">
              <RefreshCw className="h-8 w-8 animate-spin mb-3 text-primary" />
              <p className="text-sm font-medium">Scanning 75 district profiles & Safari sessions...</p>
            </div>
          ) : filteredProfiles.length === 0 ? (
            <div className="flex flex-col items-center justify-center py-16 text-center text-muted-foreground">
              <p className="text-sm font-medium">No matching profiles found.</p>
              <p className="text-xs mt-1">Try clearing the search query or switching tabs.</p>
            </div>
          ) : (
            <div className="max-h-[580px] overflow-auto rounded-md border border-border">
              <Table>
                <TableHeader className="sticky top-0 z-10 bg-background/95 backdrop-blur shadow-xs">
                  <TableRow className="bg-muted/70 hover:bg-muted/70">
                    <TableHead className="w-12 text-center">#</TableHead>
                    <TableHead className="w-20 text-center">Profile Photo</TableHead>
                    <TableHead>District & Handle</TableHead>
                    <TableHead className="w-40">Safari Session Status</TableHead>
                    <TableHead className="w-28 text-center">Status</TableHead>
                    <TableHead className="w-64 text-right">
                      <div className="flex items-center justify-end gap-2">
                        <span>Action</span>
                        <Button
                          type="button"
                          variant="outline"
                          size="sm"
                          onClick={() => syncFromDriveMutation.mutate()}
                          disabled={syncFromDriveMutation.isPending}
                          title="Refresh & sync latest district logos from Google Drive folder"
                          className="h-6 px-2 text-[11px] gap-1.5 border-zinc-700 bg-zinc-800/80 hover:bg-zinc-700 text-zinc-200 cursor-pointer shadow-xs"
                        >
                          <RefreshCw
                            className={cn(
                              "h-3 w-3",
                              syncFromDriveMutation.isPending && "animate-spin text-blue-400"
                            )}
                          />
                          <span>
                            {syncFromDriveMutation.isPending
                              ? "Re-downloading..."
                              : "Refresh from Drive"}
                          </span>
                        </Button>
                      </div>
                    </TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {filteredProfiles.map((profile, idx) => (
                    <TableRow key={profile.id} className="hover:bg-muted/20 transition-colors">
                      <TableCell className="text-center font-mono text-xs text-muted-foreground">
                        {profile.sourceRowNumber || idx + 1}
                      </TableCell>

                      <TableCell className="text-center">
                        {profile.status === "synced" && profile.hasLogo ? (
                          <button
                            type="button"
                            onClick={() => setPreviewProfile(profile)}
                            className="relative h-11 w-11 rounded-full overflow-hidden border-2 border-emerald-500/70 shadow-xs hover:ring-2 hover:ring-emerald-400 transition-all cursor-pointer bg-white group inline-block"
                            title="Synced & updated profile photo on Instagram (Click to preview)"
                          >
                            <img
                              src={profile.logoUrl}
                              alt={profile.instaName}
                              className="h-full w-full object-cover group-hover:scale-110 transition-transform"
                              loading="lazy"
                            />
                            <span
                              className="absolute bottom-0 right-0 h-3 w-3 rounded-full bg-emerald-500 border-2 border-background"
                              title="Synced"
                            />
                          </button>
                        ) : (
                          <button
                            type="button"
                            onClick={() => setPreviewProfile(profile)}
                            className="relative h-11 w-11 rounded-full border-2 border-dashed border-zinc-600/70 bg-zinc-900/60 inline-flex items-center justify-center text-muted-foreground/50 hover:border-primary/60 hover:text-foreground transition-all cursor-pointer group"
                            title="Profile photo not synced yet (Click to preview Drive logo)"
                          >
                            <Camera className="h-4 w-4 opacity-40 group-hover:opacity-80 transition-opacity" />
                            <span className="sr-only">Not Synced</span>
                          </button>
                        )}
                      </TableCell>

                      <TableCell>
                        <div className="font-semibold text-sm text-foreground">
                          {profile.district}
                        </div>
                        <div className="font-mono text-xs text-muted-foreground flex items-center gap-1.5 mt-0.5">
                          <span>@{profile.instaName.toLowerCase()}</span>
                          <a
                            href={`https://www.instagram.com/${profile.instaName.toLowerCase()}/`}
                            target="_blank"
                            rel="noreferrer"
                            className="text-muted-foreground hover:text-primary transition-colors"
                          >
                            <ExternalLink className="h-3 w-3" />
                          </a>
                        </div>
                      </TableCell>

                      <TableCell>
                        <button
                          type="button"
                          onClick={() => handleToggleSafariSession(profile)}
                          title={`Click to switch to ${profile.hasSafariSession ? "No Session" : "Safari Active"}`}
                          className="cursor-pointer inline-flex items-center group transition-transform active:scale-95"
                        >
                          {profile.hasSafariSession ? (
                            <Badge
                              variant="outline"
                              className="bg-emerald-500/10 text-emerald-600 dark:text-emerald-400 border-emerald-500/30 gap-1 text-[11px] font-medium group-hover:bg-emerald-500/20 transition-colors"
                            >
                              <span className="h-1.5 w-1.5 rounded-full bg-emerald-500" />
                              Safari Active
                            </Badge>
                          ) : (
                            <Badge
                              variant="outline"
                              className="bg-zinc-500/10 text-zinc-400 border-zinc-500/20 text-[11px] font-normal group-hover:bg-zinc-500/20 transition-colors"
                            >
                              No Session
                            </Badge>
                          )}
                        </button>
                      </TableCell>

                      <TableCell className="text-center">
                        {(() => {
                          const isRowSyncing = syncStateMap[profile.id]?.status === "uploading" || syncingId === profile.id;
                          if (isRowSyncing) {
                            return (
                              <Badge
                                variant="outline"
                                className="bg-blue-500/10 text-blue-600 dark:text-blue-400 border-blue-500/30 gap-1.5 text-[11px] font-medium"
                              >
                                <RefreshCw className="h-3 w-3 animate-spin text-blue-500" />
                                <span>Syncing...</span>
                              </Badge>
                            );
                          }
                          if (profile.status === "synced") {
                            return (
                              <button
                                type="button"
                                onClick={() => handleToggleStatus(profile)}
                                title="Click to toggle: currently Synced"
                                className="cursor-pointer inline-flex items-center group transition-transform active:scale-95"
                              >
                                <Badge
                                  variant="outline"
                                  className="bg-emerald-500/10 text-emerald-600 dark:text-emerald-400 border-emerald-500/30 gap-1 text-[11px] font-medium group-hover:bg-emerald-500/20"
                                >
                                  <Check className="h-3 w-3" />
                                  Synced
                                </Badge>
                              </button>
                            );
                          }
                          return (
                            <button
                              type="button"
                              onClick={() => handleToggleStatus(profile)}
                              title="Click to toggle: currently Not Synced"
                              className="cursor-pointer inline-flex items-center group transition-transform active:scale-95"
                            >
                              <Badge
                                variant="outline"
                                className="bg-amber-500/10 text-amber-600 dark:text-amber-400 border-amber-500/30 gap-1 text-[11px] font-normal group-hover:bg-amber-500/20"
                              >
                                <Clock className="h-3 w-3" />
                                Not Synced
                              </Badge>
                            </button>
                          );
                        })()}
                      </TableCell>

                      <TableCell className="text-right">
                        {(() => {
                          const state = syncStateMap[profile.id];
                          const isSyncing = state?.status === "uploading" || syncingId === profile.id;

                          if (isSyncing) {
                            return (
                              <div className="flex flex-col items-end gap-1.5 ml-auto w-36 py-1">
                                <div className="inline-flex items-center gap-1.5 px-2.5 py-0.5 rounded-full bg-blue-500/10 border border-blue-500/30 text-blue-600 dark:text-blue-400 text-[11px] font-medium">
                                  <RefreshCw className="h-3 w-3 animate-spin text-blue-500 shrink-0" />
                                  <span className="truncate">{state?.message || "Saving photo..."}</span>
                                </div>
                                <div className="relative w-full h-1.5 overflow-hidden rounded-full bg-zinc-200 dark:bg-zinc-800 border border-zinc-300 dark:border-zinc-700/60">
                                  <div className="animate-smart-bar bg-gradient-to-r from-blue-600 via-indigo-500 to-sky-400 rounded-full" />
                                </div>
                              </div>
                            );
                          }

                          if (state?.status === "done") {
                            return (
                              <div className="inline-flex items-center gap-1.5 px-3 py-1 rounded-md bg-emerald-500/10 border border-emerald-500/30 text-emerald-600 dark:text-emerald-400 text-xs font-medium ml-auto">
                                <Check className="h-3.5 w-3.5 text-emerald-500" />
                                <span>Photo Saved!</span>
                              </div>
                            );
                          }

                          if (state?.status === "error") {
                            return (
                              <div className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-md bg-rose-500/10 border border-rose-500/30 text-rose-600 dark:text-rose-400 text-[11px] font-medium ml-auto max-w-[150px] truncate" title={state.message}>
                                <span className="truncate">{state.message || "Failed"}</span>
                              </div>
                            );
                          }

                          return (
                            <div className="flex items-center justify-end gap-1.5 ml-auto">
                              {profile.hasLogo && (
                                <Button
                                  type="button"
                                  variant="ghost"
                                  size="icon"
                                  onClick={() => handleDeletePhoto(profile)}
                                  disabled={deleteLogoMutation.isPending}
                                  title={`Delete local photo for @${profile.instaName}`}
                                  className="h-8 w-8 text-muted-foreground hover:text-destructive hover:bg-destructive/10 cursor-pointer"
                                >
                                  <Trash2 className="h-3.5 w-3.5" />
                                </Button>
                              )}
                              <Button
                                type="button"
                                variant="default"
                                size="sm"
                                disabled={!profile.hasLogo}
                                onClick={() => handleSyncPhoto(profile)}
                                className="h-8 px-3 text-xs bg-blue-600 hover:bg-blue-700 text-white cursor-pointer shadow-xs gap-1 disabled:opacity-50"
                              >
                                <Sparkles className="h-3 w-3" />
                                <span>Sync Photo</span>
                              </Button>
                            </div>
                          );
                        })()}
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </div>
          )}
        </CardContent>
      </Card>

      {/* Modal: Preview High-Resolution Logo */}
      <Dialog open={Boolean(previewProfile)} onOpenChange={() => setPreviewProfile(null)}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle className="text-base font-bold flex items-center gap-2">
              <Camera className="h-4 w-4 text-primary" />
              {previewProfile?.district} Logo Preview
            </DialogTitle>
            <DialogDescription>
              Official 1080x1080 rendered logo for @{previewProfile?.instaName}
            </DialogDescription>
          </DialogHeader>

          {previewProfile && (
            <div className="flex flex-col items-center py-4 space-y-4">
              <div className="relative h-64 w-64 rounded-full overflow-hidden border-4 border-primary/30 shadow-lg bg-white flex items-center justify-center">
                {previewProfile.hasLogo ? (
                  <img
                    src={previewProfile.logoUrl}
                    alt={previewProfile.instaName}
                    className="h-full w-full object-cover"
                  />
                ) : (
                  <div className="flex flex-col items-center justify-center text-muted-foreground/60 p-4 text-center">
                    <Camera className="h-16 w-16 opacity-30 mb-2" />
                    <span className="text-xs font-mono">No local photo file</span>
                    <span className="text-[11px] text-muted-foreground/50 mt-1">
                      Click &quot;Refresh from Drive&quot; to re-download
                    </span>
                  </div>
                )}
              </div>

              <div className="text-center space-y-1">
                <p className="font-semibold text-base text-foreground">
                  {previewProfile.district}
                </p>
                <p className="font-mono text-xs text-muted-foreground">
                  @{previewProfile.instaName} · {previewProfile.logoFileName}
                </p>
                <div className="pt-1 flex items-center justify-center">
                  <button
                    type="button"
                    onClick={() => handleToggleSafariSession(previewProfile)}
                    title={`Click to switch to ${previewProfile.hasSafariSession ? "No Session" : "Safari Active"}`}
                    className="cursor-pointer inline-flex items-center group transition-transform active:scale-95"
                  >
                    {previewProfile.hasSafariSession ? (
                      <Badge
                        variant="outline"
                        className="bg-emerald-500/10 text-emerald-600 dark:text-emerald-400 border-emerald-500/30 gap-1 text-[11px] font-medium group-hover:bg-emerald-500/20 transition-colors"
                      >
                        <span className="h-1.5 w-1.5 rounded-full bg-emerald-500" />
                        Safari Active
                      </Badge>
                    ) : (
                      <Badge
                        variant="outline"
                        className="bg-zinc-500/10 text-zinc-400 border-zinc-500/20 text-[11px] font-normal group-hover:bg-zinc-500/20 transition-colors"
                      >
                        No Session
                      </Badge>
                    )}
                  </button>
                </div>
              </div>

              <div className="flex items-center gap-2 w-full pt-2">
                <Button
                  type="button"
                  variant="outline"
                  className="flex-1 cursor-pointer"
                  onClick={() => setPreviewProfile(null)}
                >
                  Close
                </Button>
                {previewProfile.hasLogo && (
                  <Button
                    type="button"
                    variant="destructive"
                    className="cursor-pointer gap-1.5"
                    disabled={deleteLogoMutation.isPending}
                    onClick={() => handleDeletePhoto(previewProfile)}
                  >
                    <Trash2 className="h-4 w-4" />
                    <span>Delete Photo</span>
                  </Button>
                )}
                <Button
                  type="button"
                  className="flex-1 bg-blue-600 hover:bg-blue-700 text-white cursor-pointer"
                  disabled={!previewProfile.hasLogo}
                  onClick={() => {
                    handleSyncPhoto(previewProfile);
                    setPreviewProfile(null);
                  }}
                >
                  <Sparkles className="mr-1.5 h-4 w-4" />
                  Sync Photo
                </Button>
              </div>
            </div>
          )}
        </DialogContent>
      </Dialog>
    </div>
  );
}
