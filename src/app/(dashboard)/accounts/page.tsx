"use client";

import { useState, useEffect } from "react";
import { useSearchParams, useRouter } from "next/navigation";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { StatusBadge } from "@/components/common/StatusBadge";
import { useUser } from "@/lib/hooks/use-user";
import { useBrand } from "@/lib/hooks/use-brand";
import { trpc } from "@/lib/trpc/client";
import { toast } from "sonner";
import {
  HardDrive, Link2, CheckCircle2, AlertCircle, Loader2, XCircle,
  ChevronDown, ChevronRight, Plus, Trash2,
} from "lucide-react";
import { canManageBrands } from "@/lib/types";
import { ChannelPickerDialog } from "@/components/accounts/ChannelPickerDialog";

export default function AccountsPage() {
  const { profile, loading: profileLoading } = useUser();
  const { activeBrandId } = useBrand();
  const searchParams = useSearchParams();
  const router = useRouter();
  const [showAdvanced, setShowAdvanced] = useState(false);
  const [manualPlatform, setManualPlatform] = useState<string>("instagram");
  const [manualToken, setManualToken] = useState("");
  const [manualUserId, setManualUserId] = useState("");
  const [manualUsername, setManualUsername] = useState("");

  // Channel picker state
  const [pendingChannelsId, setPendingChannelsId] = useState<string | null>(null);
  const [pendingPlatform, setPendingPlatform] = useState<string>("");

  // Handle OAuth redirect query params
  useEffect(() => {
    const pendingId = searchParams.get("pending_channels");
    const platform = searchParams.get("platform");
    if (pendingId && platform) {
      setPendingChannelsId(pendingId);
      setPendingPlatform(platform);
    }

    // Drive connection feedback
    const driveConnected = searchParams.get("drive_connected");
    const driveError = searchParams.get("drive_error");
    const connected = searchParams.get("connected");
    const updated = searchParams.get("updated");

    if (driveConnected === "true") {
      toast.success("Google Drive connected successfully");
    }
    if (driveError) {
      toast.error(`Drive connection failed: ${decodeURIComponent(driveError)}`);
    }
    // Social account connection feedback
    if (connected) {
      const label = connected.charAt(0).toUpperCase() + connected.slice(1);
      toast.success(updated === "true" ? `${label} account updated` : `${label} connected`);
    }

    // Clean up URL
    if (pendingId || driveConnected || driveError || connected) {
      router.replace("/accounts", { scroll: false });
    }
  }, [searchParams, router]);

  const { data: driveStatus, refetch: refetchDrive } = trpc.drive.status.useQuery(
    { brandId: activeBrandId! },
    { enabled: !!activeBrandId }
  );

  const { data: socialAccounts = [], refetch: refetchAccounts } = trpc.socialAccounts.list.useQuery(
    { brandId: activeBrandId! },
    { enabled: !!activeBrandId }
  );

  const connectDriveMutation = trpc.drive.connect.useMutation({
    onSuccess: (data) => { window.location.href = data.url; },
    onError: (error) => toast.error(error.message),
  });

  const disconnectDriveMutation = trpc.drive.disconnect.useMutation({
    onSuccess: () => { toast.success("Drive disconnected"); refetchDrive(); },
    onError: (error) => toast.error(error.message),
  });

  const connectOAuthMutation = trpc.socialAccounts.initiateOAuth.useMutation({
    onSuccess: (data) => { window.location.href = data.url; },
    onError: (error) => toast.error(error.message),
  });

  const disconnectAccountMutation = trpc.socialAccounts.disconnect.useMutation({
    onSuccess: () => { toast.success("Account disconnected"); refetchAccounts(); },
    onError: (error) => toast.error(error.message),
  });

  const connectManualMutation = trpc.socialAccounts.connectManual.useMutation({
    onSuccess: () => {
      toast.success("Account connected");
      refetchAccounts();
      setManualToken("");
      setManualUserId("");
      setManualUsername("");
      setShowAdvanced(false);
    },
    onError: (error) => toast.error(error.message),
  });

  if (profileLoading) {
    return (
      <div className="flex items-center justify-center h-64">
        <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-primary" />
      </div>
    );
  }

  const isAdmin = profile && canManageBrands(profile.role);
  const canManageAccounts = profile && ["super_admin", "agency_admin", "brand_owner"].includes(profile.role);
  const canConnectAccounts = profile?.role === "brand_owner";
  const canManageDrive = canManageAccounts;

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-bold">Connected Accounts</h1>
        <p className="text-muted-foreground">Manage social accounts and Google Drive</p>
      </div>

      {/* Google Drive Card */}
      <Card>
        <CardHeader>
          <div className="flex items-center gap-3">
            <div className="h-10 w-10 rounded-lg bg-green-100 flex items-center justify-center">
              <HardDrive className="h-5 w-5 text-green-600" />
            </div>
            <div className="flex-1">
              <CardTitle className="text-lg">Google Drive</CardTitle>
              <CardDescription>Media storage</CardDescription>
            </div>
            {driveStatus?.connected && (
              <StatusBadge status={driveStatus.isActive ? "active" : "incomplete"} />
            )}
          </div>
        </CardHeader>
        <CardContent>
          {!driveStatus?.connected ? (
            <div className="flex items-center justify-between p-4 border rounded-lg">
              <div className="flex items-center gap-3">
                <XCircle className="h-5 w-5 text-muted-foreground" />
                <span className="text-sm">Not connected</span>
              </div>
              {canManageDrive && activeBrandId && (
                <Button size="sm" onClick={() => connectDriveMutation.mutate({ brandId: activeBrandId })} disabled={connectDriveMutation.isPending}>
                  {connectDriveMutation.isPending ? <Loader2 className="h-4 w-4 animate-spin" /> : <HardDrive className="h-4 w-4 mr-1" />}
                  Connect
                </Button>
              )}
            </div>
          ) : (
            <div className="flex items-center justify-between p-4 border rounded-lg">
              <div className="flex items-center gap-3">
                <CheckCircle2 className="h-5 w-5 text-green-500" />
                <div>
                  <p className="text-sm font-medium">{driveStatus.email}</p>
                  <p className="text-xs text-muted-foreground">
                    {driveStatus.isActive ? "Connected" : "Inactive — reconnect required"}
                  </p>
                </div>
              </div>
              {canManageDrive && activeBrandId && (
                <Button size="sm" variant="outline" onClick={() => disconnectDriveMutation.mutate({ brandId: activeBrandId })}>
                  Disconnect
                </Button>
              )}
            </div>
          )}
        </CardContent>
      </Card>

      {/* Social Accounts — Platform Tiles */}
      <div>
        <h2 className="text-lg font-semibold mb-4">Social Accounts</h2>
        <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
          {([
            {
              key: "instagram" as const,
              label: "Instagram",
              hint: "Requires Business or Creator account connected to a Facebook Page",
              logo: (
                <svg className="h-10 w-10" viewBox="0 0 24 24" fill="url(#ig-acc)">
                  <defs><radialGradient id="ig-acc" cx="30%" cy="107%" r="150%"><stop offset="0%" stopColor="#fdf497" /><stop offset="5%" stopColor="#fdf497" /><stop offset="45%" stopColor="#fd5949" /><stop offset="60%" stopColor="#d6249f" /><stop offset="90%" stopColor="#285AEB" /></radialGradient></defs>
                  <path d="M12 2.163c3.204 0 3.584.012 4.85.07 3.252.148 4.771 1.691 4.919 4.919.058 1.265.069 1.645.069 4.849 0 3.205-.012 3.584-.069 4.849-.149 3.225-1.664 4.771-4.919 4.919-1.266.058-1.644.07-4.85.07-3.204 0-3.584-.012-4.849-.07-3.26-.149-4.771-1.699-4.919-4.92-.058-1.265-.07-1.644-.07-4.849 0-3.204.013-3.583.07-4.849.149-3.227 1.664-4.771 4.919-4.919 1.266-.057 1.645-.069 4.849-.069zM12 0C8.741 0 8.333.014 7.053.072 2.695.272.273 2.69.073 7.052.014 8.333 0 8.741 0 12c0 3.259.014 3.668.072 4.948.2 4.358 2.618 6.78 6.98 6.98C8.333 23.986 8.741 24 12 24c3.259 0 3.668-.014 4.948-.072 4.354-.2 6.782-2.618 6.979-6.98.059-1.28.073-1.689.073-4.948 0-3.259-.014-3.667-.072-4.947-.196-4.354-2.617-6.78-6.979-6.98C15.668.014 15.259 0 12 0zm0 5.838a6.162 6.162 0 100 12.324 6.162 6.162 0 000-12.324zM12 16a4 4 0 110-8 4 4 0 010 8zm6.406-11.845a1.44 1.44 0 100 2.881 1.44 1.44 0 000-2.881z" />
                </svg>
              ),
            },
            {
              key: "youtube" as const,
              label: "YouTube",
              hint: "Any YouTube channel works",
              logo: (
                <svg className="h-10 w-10" viewBox="0 0 24 24" fill="#FF0000">
                  <path d="M23.498 6.186a3.016 3.016 0 00-2.122-2.136C19.505 3.545 12 3.545 12 3.545s-7.505 0-9.377.505A3.017 3.017 0 00.502 6.186C0 8.07 0 12 0 12s0 3.93.502 5.814a3.016 3.016 0 002.122 2.136c1.871.505 9.376.505 9.376.505s7.505 0 9.377-.505a3.015 3.015 0 002.122-2.136C24 15.93 24 12 24 12s0-3.93-.502-5.814zM9.545 15.568V8.432L15.818 12l-6.273 3.568z" />
                </svg>
              ),
            },
            {
              key: "linkedin" as const,
              label: "LinkedIn",
              hint: "Personal profile or company page (admin access needed)",
              note: "To add a different LinkedIn account, disconnect the current one first and log out of LinkedIn in your browser.",
              logo: (
                <svg className="h-10 w-10" viewBox="0 0 24 24" fill="#0A66C2">
                  <path d="M20.447 20.452h-3.554v-5.569c0-1.328-.027-3.037-1.852-3.037-1.853 0-2.136 1.445-2.136 2.939v5.667H9.351V9h3.414v1.561h.046c.477-.9 1.637-1.85 3.37-1.85 3.601 0 4.267 2.37 4.267 5.455v6.286zM5.337 7.433a2.062 2.062 0 01-2.063-2.065 2.064 2.064 0 112.063 2.065zm1.782 13.019H3.555V9h3.564v11.452zM22.225 0H1.771C.792 0 0 .774 0 1.729v20.542C0 23.227.792 24 1.771 24h20.451C23.2 24 24 23.227 24 22.271V1.729C24 .774 23.2 0 22.222 0h.003z" />
                </svg>
              ),
            },
          ]).map((p) => {
            const connected = socialAccounts.filter((a: any) => a.platform === p.key);
            const hasAccounts = connected.length > 0;

            return (
              <div key={p.key}>
                <p className="text-[10px] text-muted-foreground mb-1 truncate">{p.hint}</p>
                <Card className="overflow-hidden">
                <CardContent className="pt-5 space-y-4">
                  {/* Platform header */}
                  <div className="flex items-center gap-3">
                    {p.logo}
                    <div>
                      <p className="font-semibold text-sm">{p.label}</p>
                      <p className="text-xs text-muted-foreground">
                        {hasAccounts ? `${connected.length} connected` : "Not connected"}
                      </p>
                    </div>
                  </div>

                  {/* Connected accounts */}
                  {hasAccounts && (
                    <div className="space-y-2">
                      {connected.map((account: any) => (
                        <div key={account.id} className="flex items-center justify-between p-2.5 bg-zinc-50 rounded-lg">
                          <div className="min-w-0">
                            <p className="text-sm font-medium truncate">
                              @{account.platform_username || account.platform_user_id}
                            </p>
                            <p className="text-[11px] text-muted-foreground">
                              {account.is_active ? "Active" : "Inactive"}
                              {account.token_expires_at && ` · Expires ${new Date(account.token_expires_at).toLocaleDateString()}`}
                            </p>
                          </div>
                          {canConnectAccounts && (
                            <Button
                              size="sm"
                              variant="ghost"
                              className="h-7 w-7 p-0 text-muted-foreground hover:text-red-600"
                              onClick={() => {
                                if (confirm(`Disconnect @${account.platform_username}?`)) {
                                  disconnectAccountMutation.mutate({ accountId: account.id });
                                }
                              }}
                            >
                              <Trash2 className="h-3.5 w-3.5" />
                            </Button>
                          )}
                        </div>
                      ))}
                    </div>
                  )}

                  {/* Connect button or hint */}
                  {canConnectAccounts && activeBrandId ? (
                    <Button
                      variant={hasAccounts ? "outline" : "default"}
                      size="sm"
                      className="w-full"
                      onClick={() => connectOAuthMutation.mutate({ brandId: activeBrandId, platform: p.key })}
                      disabled={connectOAuthMutation.isPending}
                    >
                      {connectOAuthMutation.isPending ? (
                        <Loader2 className="h-3.5 w-3.5 mr-1.5 animate-spin" />
                      ) : (
                        <Plus className="h-3.5 w-3.5 mr-1.5" />
                      )}
                      {hasAccounts ? "Add another" : "Connect"}
                    </Button>
                  ) : null}

                  {hasAccounts && (p as any).note && (
                    <p className="text-[10px] text-muted-foreground leading-snug">{(p as any).note}</p>
                  )}
                </CardContent>
              </Card>
              </div>
            );
          })}
        </div>
      </div>

      {/* Advanced: Manual Token Entry */}
      {canConnectAccounts && (
        <Card>
          <CardContent className="pt-4">
            <button
              onClick={() => setShowAdvanced(!showAdvanced)}
              className="flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground"
            >
              {showAdvanced ? <ChevronDown className="h-3 w-3" /> : <ChevronRight className="h-3 w-3" />}
              Advanced: connect with access token
            </button>

            {showAdvanced && activeBrandId && (
              <div className="mt-3 space-y-3 p-4 border rounded-lg bg-muted/30">
                <div className="grid grid-cols-3 gap-2">
                  {(["instagram", "youtube", "linkedin", "facebook", "tiktok", "twitter", "snapchat"] as const).map((p) => (
                    <Button
                      key={p}
                      size="sm"
                      variant={manualPlatform === p ? "default" : "outline"}
                      onClick={() => setManualPlatform(p)}
                      className="capitalize text-xs"
                    >
                      {p}
                    </Button>
                  ))}
                </div>
                <div className="space-y-2">
                  <Label className="text-xs">Access Token</Label>
                  <Input value={manualToken} onChange={(e) => setManualToken(e.target.value)} placeholder="Paste access token" className="text-xs" />
                </div>
                <div className="space-y-2">
                  <Label className="text-xs">Platform User/Page ID</Label>
                  <Input value={manualUserId} onChange={(e) => setManualUserId(e.target.value)} placeholder="e.g., 17841400123456" className="text-xs" />
                </div>
                <div className="space-y-2">
                  <Label className="text-xs">Username (optional)</Label>
                  <Input value={manualUsername} onChange={(e) => setManualUsername(e.target.value)} placeholder="@username" className="text-xs" />
                </div>
                <Button
                  size="sm"
                  onClick={() => connectManualMutation.mutate({
                    brandId: activeBrandId,
                    platform: manualPlatform as any,
                    accessToken: manualToken,
                    platformUserId: manualUserId,
                    platformUsername: manualUsername || undefined,
                  })}
                  disabled={!manualToken || !manualUserId || connectManualMutation.isPending}
                >
                  {connectManualMutation.isPending ? <Loader2 className="h-3 w-3 mr-1 animate-spin" /> : null}
                  Connect
                </Button>
              </div>
            )}
          </CardContent>
        </Card>
      )}

      {/* Channel Picker Dialog — shown when OAuth found multiple pages/channels */}
      {pendingChannelsId && (
        <ChannelPickerDialog
          pendingId={pendingChannelsId}
          platform={pendingPlatform}
          open={!!pendingChannelsId}
          onClose={() => setPendingChannelsId(null)}
          onConnected={() => {
            setPendingChannelsId(null);
            refetchAccounts();
          }}
        />
      )}
    </div>
  );
}
