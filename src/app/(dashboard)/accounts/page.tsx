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

  const { data: configuredPlatforms = [] } = trpc.socialAccounts.configuredPlatforms.useQuery();

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

      {/* Social Accounts — Platform Tiles (only shows platforms configured by super admin) */}
      <div>
        <h2 className="text-lg font-semibold mb-4">Social Accounts</h2>
        <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
          {([
            {
              key: "instagram",
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
              key: "youtube",
              label: "YouTube",
              hint: "Any YouTube channel works",
              logo: (
                <svg className="h-10 w-10" viewBox="0 0 24 24" fill="#FF0000">
                  <path d="M23.498 6.186a3.016 3.016 0 00-2.122-2.136C19.505 3.545 12 3.545 12 3.545s-7.505 0-9.377.505A3.017 3.017 0 00.502 6.186C0 8.07 0 12 0 12s0 3.93.502 5.814a3.016 3.016 0 002.122 2.136c1.871.505 9.376.505 9.376.505s7.505 0 9.377-.505a3.015 3.015 0 002.122-2.136C24 15.93 24 12 24 12s0-3.93-.502-5.814zM9.545 15.568V8.432L15.818 12l-6.273 3.568z" />
                </svg>
              ),
            },
            {
              key: "linkedin",
              label: "LinkedIn",
              hint: "Personal profile or company page (admin access needed)",
              note: "To add a different LinkedIn account, disconnect the current one first and log out of LinkedIn in your browser.",
              logo: (
                <svg className="h-10 w-10" viewBox="0 0 24 24" fill="#0A66C2">
                  <path d="M20.447 20.452h-3.554v-5.569c0-1.328-.027-3.037-1.852-3.037-1.853 0-2.136 1.445-2.136 2.939v5.667H9.351V9h3.414v1.561h.046c.477-.9 1.637-1.85 3.37-1.85 3.601 0 4.267 2.37 4.267 5.455v6.286zM5.337 7.433a2.062 2.062 0 01-2.063-2.065 2.064 2.064 0 112.063 2.065zm1.782 13.019H3.555V9h3.564v11.452zM22.225 0H1.771C.792 0 0 .774 0 1.729v20.542C0 23.227.792 24 1.771 24h20.451C23.2 24 24 23.227 24 22.271V1.729C24 .774 23.2 0 22.222 0h.003z" />
                </svg>
              ),
            },
            {
              key: "facebook",
              label: "Facebook",
              hint: "Requires a Facebook Page (Business or Creator)",
              logo: (
                <svg className="h-10 w-10" viewBox="0 0 24 24" fill="#1877F2">
                  <path d="M9.101 23.691v-7.98H6.627v-3.667h2.474v-1.58c0-4.085 1.848-5.978 5.858-5.978.401 0 .955.042 1.468.103a8.68 8.68 0 0 1 1.141.195v3.325a8.623 8.623 0 0 0-.653-.036 26.805 26.805 0 0 0-.733-.009c-.707 0-1.259.096-1.675.309a1.686 1.686 0 0 0-.679.622c-.258.42-.374.995-.374 1.752v1.297h3.919l-.386 2.103-.287 1.564h-3.246v8.245C19.396 23.238 24 18.179 24 12.044c0-6.627-5.373-12-12-12s-12 5.373-12 12c0 5.628 3.874 10.35 9.101 11.647Z" />
                </svg>
              ),
            },
            {
              key: "tiktok",
              label: "TikTok",
              hint: "Requires TikTok for Developers account",
              logo: (
                <svg className="h-10 w-10" viewBox="0 0 24 24" fill="#000000">
                  <path d="M12.525.02c1.31-.02 2.61-.01 3.91-.02.08 1.53.63 3.09 1.75 4.17 1.12 1.11 2.7 1.62 4.24 1.79v4.03c-1.44-.05-2.89-.35-4.2-.97-.57-.26-1.1-.59-1.62-.93-.01 2.92.01 5.84-.02 8.75-.08 1.4-.54 2.79-1.35 3.94-1.31 1.92-3.58 3.17-5.91 3.21-1.43.08-2.86-.31-4.08-1.03-2.02-1.19-3.44-3.37-3.65-5.71-.02-.5-.03-1-.01-1.49.18-1.9 1.12-3.72 2.58-4.96 1.66-1.44 3.98-2.13 6.15-1.72.02 1.48-.04 2.96-.04 4.44-.99-.32-2.15-.23-3.02.37-.63.41-1.11 1.04-1.36 1.75-.21.51-.15 1.07-.14 1.61.24 1.64 1.82 3.02 3.5 2.87 1.12-.01 2.19-.66 2.77-1.61.19-.33.4-.67.41-1.06.1-1.79.06-3.57.07-5.36.01-4.03-.01-8.05.02-12.07z" />
                </svg>
              ),
            },
            {
              key: "twitter",
              label: "X (Twitter)",
              hint: "Post tweets with images and videos",
              logo: (
                <svg className="h-10 w-10" viewBox="0 0 24 24" fill="#000000">
                  <path d="M14.234 10.162 22.977 0h-2.072l-7.591 8.824L7.251 0H.258l9.168 13.343L.258 24H2.33l8.016-9.318L16.749 24h6.993zm-2.837 3.299-.929-1.329L3.076 1.56h3.182l5.965 8.532.929 1.329 7.754 11.09h-3.182z" />
                </svg>
              ),
            },
            {
              key: "snapchat",
              label: "Snapchat",
              hint: "Share content to Snapchat Stories",
              logo: (
                <svg className="h-10 w-10" viewBox="0 0 24 24"><path d="M12.206.793c.99 0 4.347.276 5.93 3.821.529 1.193.403 3.219.299 4.847l-.003.06c-.012.18-.022.345-.03.51.075.045.203.09.401.09.3-.016.659-.12 1.033-.301.165-.088.344-.104.464-.104.182 0 .359.029.509.09.45.149.734.479.734.838.015.449-.39.839-1.213 1.168-.089.029-.209.075-.344.119-.45.135-1.139.36-1.333.81-.09.224-.061.524.12.868l.015.015c.06.136 1.526 3.475 4.791 4.014.255.044.435.27.42.509 0 .075-.015.149-.045.225-.24.569-1.273.988-3.146 1.271-.059.091-.12.375-.164.57-.029.179-.074.36-.134.553-.076.271-.27.405-.555.405h-.03c-.135 0-.313-.031-.538-.074-.36-.075-.765-.135-1.273-.135-.3 0-.599.015-.913.074-.6.104-1.123.464-1.723.884-.853.599-1.826 1.288-3.294 1.288-.06 0-.119-.015-.18-.015h-.149c-1.468 0-2.427-.675-3.279-1.288-.599-.42-1.107-.779-1.707-.884-.314-.045-.629-.074-.928-.074-.54 0-.958.089-1.272.149-.211.043-.391.074-.54.074-.374 0-.523-.224-.583-.42-.061-.192-.09-.389-.135-.567-.046-.181-.105-.494-.166-.57-1.918-.222-2.95-.642-3.189-1.226-.031-.063-.052-.15-.055-.225-.015-.243.165-.465.42-.509 3.264-.54 4.73-3.879 4.791-4.02l.016-.029c.18-.345.224-.645.119-.869-.195-.434-.884-.658-1.332-.809-.121-.029-.24-.074-.346-.119-1.107-.435-1.257-.93-1.197-1.273.09-.479.674-.793 1.168-.793.146 0 .27.029.383.074.42.194.789.3 1.104.3.234 0 .384-.06.465-.105l-.046-.569c-.098-1.626-.225-3.651.307-4.837C7.392 1.077 10.739.807 11.727.807l.419-.015h.06" fill="#FFFC00" stroke="#000000" strokeWidth="0.5"/></svg>
              ),
            },
          ] as const).filter((p) => configuredPlatforms.includes(p.key)).map((p) => {
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
                  {(["instagram", "youtube", "linkedin", "facebook", "tiktok", "twitter", "snapchat"] as const).filter((p) => configuredPlatforms.includes(p)).map((p) => (
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
