"use client";

import { useState } from "react";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Badge } from "@/components/ui/badge";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription } from "@/components/ui/dialog";
import { Separator } from "@/components/ui/separator";
import { trpc } from "@/lib/trpc/client";
import { toast } from "sonner";
import { Plus, UserPlus, Trash2, Pencil, Clock, X, Mail, Users } from "lucide-react";
import type { UserProfile } from "@/lib/types";

const AGENCY_ROLES = ["super_admin", "agency_admin", "agency_editor"] as const;
const BRAND_ROLES = ["brand_owner", "brand_editor", "brand_viewer"] as const;
const ALL_ROLES = [...AGENCY_ROLES, ...BRAND_ROLES];

const roleLabels: Record<string, string> = {
  super_admin: "Super Admin",
  agency_admin: "Agency Admin",
  agency_editor: "Agency Editor",
  brand_owner: "Brand Owner",
  brand_editor: "Brand Editor",
  brand_viewer: "Brand Viewer",
};

const roleColors: Record<string, string> = {
  super_admin: "bg-red-100 text-red-700",
  agency_admin: "bg-orange-100 text-orange-700",
  agency_editor: "bg-yellow-100 text-yellow-700",
  brand_owner: "bg-blue-100 text-blue-700",
  brand_editor: "bg-green-100 text-green-700",
  brand_viewer: "bg-gray-100 text-gray-700",
};

interface UserManagementProps {
  profile: UserProfile;
}

export function UserManagement({ profile }: UserManagementProps) {
  const [showInviteDialog, setShowInviteDialog] = useState(false);
  const [editingUser, setEditingUser] = useState<any>(null);
  const [inviteName, setInviteName] = useState("");
  const [inviteEmail, setInviteEmail] = useState("");
  const [inviteRole, setInviteRole] = useState("");
  const [inviteBrandId, setInviteBrandId] = useState("");
  const [editRole, setEditRole] = useState("");
  const [editBrandId, setEditBrandId] = useState("");
  const [editAssignedBrands, setEditAssignedBrands] = useState<string[]>([]);

  const utils = trpc.useUtils();
  const { data: users = [] } = trpc.users.list.useQuery();
  const { data: invitations = [] } = trpc.invitations.list.useQuery();
  const { data: brands = [] } = trpc.brands.list.useQuery();
  const { data: emailStatus } = trpc.invitations.emailStatus.useQuery();

  const pendingInvitations = invitations.filter(
    (inv: any) => inv.status === "pending" && new Date(inv.expires_at) > new Date()
  );

  const inviteMutation = trpc.invitations.send.useMutation({
    onSuccess: (data) => {
      if (data.emailSent) {
        if (data.method === "direct_add") {
          toast.success("Account created! Welcome email sent with password setup link.");
        } else {
          toast.success("Invitation email sent!", {
            action: {
              label: "Copy Link",
              onClick: () => {
                navigator.clipboard.writeText(data.inviteLink);
                toast.info("Invite link copied");
              },
            },
            duration: 8000,
          });
        }
      } else {
        // Email not configured or failed — show link to copy
        toast.success("Invitation created — copy and share the link manually.", {
          description: data.inviteLink,
          action: {
            label: "Copy Link",
            onClick: () => {
              navigator.clipboard.writeText(data.inviteLink);
              toast.info("Invite link copied to clipboard");
            },
          },
          duration: 15000,
        });
      }
      setShowInviteDialog(false);
      setInviteName("");
      setInviteEmail("");
      setInviteRole("");
      setInviteBrandId("");
      utils.invitations.list.invalidate();
      utils.users.list.invalidate();
    },
    onError: (error) => toast.error(error.message),
  });

  const cancelInviteMutation = trpc.invitations.cancel.useMutation({
    onSuccess: () => { toast.success("Invitation cancelled"); utils.invitations.list.invalidate(); },
    onError: (error) => toast.error(error.message),
  });

  const updateRoleMutation = trpc.users.updateRole.useMutation({
    onSuccess: () => {
      toast.success("User updated");
      setEditingUser(null);
      utils.users.list.invalidate();
    },
    onError: (error) => toast.error(error.message),
  });

  const removeMutation = trpc.users.remove.useMutation({
    onSuccess: () => { toast.success("User removed"); utils.users.list.invalidate(); },
    onError: (error) => toast.error(error.message),
  });

  // What roles can this user assign?
  function getAssignableRoles(): string[] {
    if (profile.role === "super_admin") return [...ALL_ROLES]; // super_admin can create any role including other super_admins
    if (profile.role === "agency_admin") return ["agency_editor", ...BRAND_ROLES];
    if (profile.role === "brand_owner") return ["brand_editor", "brand_viewer"];
    return [];
  }

  // Can this user manage a target user?
  function canManage(targetRole: string, targetId: string): boolean {
    if (targetId === profile.id) return false;
    if (profile.role === "super_admin") return true;
    if (profile.role === "agency_admin") return !["super_admin", "agency_admin"].includes(targetRole);
    if (profile.role === "brand_owner") return ["brand_editor", "brand_viewer"].includes(targetRole);
    return false;
  }

  const needsBrand = BRAND_ROLES.includes(inviteRole as any);
  const inviteNeedsAssigned = inviteRole === "agency_editor";

  function handleInvite() {
    const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
    if (!emailRegex.test(inviteEmail)) {
      toast.error("Please enter a valid email address");
      return;
    }
    inviteMutation.mutate({
      email: inviteEmail,
      role: inviteRole as any,
      brandId: needsBrand ? inviteBrandId : undefined,
      name: inviteName || undefined,
    });
  }

  function startEdit(user: any) {
    setEditingUser(user);
    setEditRole(user.role);
    setEditBrandId(user.brand_id || "");
    setEditAssignedBrands(user.assigned_brands || []);
  }

  function handleSaveEdit() {
    if (!editingUser) return;
    updateRoleMutation.mutate({
      userId: editingUser.id,
      role: editRole as any,
      brand_id: BRAND_ROLES.includes(editRole as any) ? editBrandId || null : null,
      assigned_brands: editRole === "agency_editor" ? editAssignedBrands : undefined,
    });
  }

  function handleRemove(userId: string, userName: string) {
    if (confirm(`Remove ${userName} from this organization? This cannot be undone.`)) {
      removeMutation.mutate({ userId });
    }
  }

  function daysUntil(dateStr: string): string {
    const diff = Math.ceil((new Date(dateStr).getTime() - Date.now()) / (1000 * 60 * 60 * 24));
    if (diff <= 0) return "expired";
    return `${diff}d left`;
  }

  return (
    <div className="space-y-6">
      {/* Email not configured banner */}
      {emailStatus && !emailStatus.configured && getAssignableRoles().length > 0 && (
        <div className="flex items-center gap-3 p-3 bg-yellow-50 border border-yellow-200 rounded-lg text-yellow-800 text-sm">
          <Mail className="h-4 w-4 shrink-0" />
          <span>
            Email service not configured — invite links must be copied and shared manually.{" "}
            {profile.role === "super_admin" && (
              <span>Configure Resend in Settings &rarr; Platform Credentials.</span>
            )}
          </span>
        </div>
      )}

      {/* Header */}
      <div className="flex items-center justify-between">
        <div>
          <h2 className="text-lg font-semibold flex items-center gap-2">
            <Users className="h-5 w-5" />
            Team Members
          </h2>
          <p className="text-sm text-muted-foreground">{users.length} member{users.length !== 1 ? "s" : ""}</p>
        </div>
        {getAssignableRoles().length > 0 && (
          <Button onClick={() => setShowInviteDialog(true)} size="sm">
            <UserPlus className="h-4 w-4 mr-2" />
            Invite User
          </Button>
        )}
      </div>

      {/* User list */}
      <Card>
        <CardContent className="pt-4 divide-y">
          {users.map((user: any) => (
            <div key={user.id} className="flex items-center justify-between py-3 first:pt-0 last:pb-0">
              <div className="flex items-center gap-3 min-w-0">
                <div className="h-9 w-9 rounded-full bg-muted flex items-center justify-center text-sm font-medium shrink-0">
                  {user.name?.[0]?.toUpperCase() || "?"}
                </div>
                <div className="min-w-0">
                  <div className="flex items-center gap-2">
                    <p className="text-sm font-medium truncate">{user.name}</p>
                    {user.id === profile.id && (
                      <Badge variant="outline" className="text-[10px]">you</Badge>
                    )}
                  </div>
                  <p className="text-xs text-muted-foreground truncate">{user.email}</p>
                </div>
              </div>

              <div className="flex items-center gap-2 shrink-0">
                <Badge variant="secondary" className={`text-xs ${roleColors[user.role] || ""}`}>
                  {roleLabels[user.role] || user.role}
                </Badge>

                {user.role === "agency_editor" && user.assigned_brands?.length > 0 && (
                  <span className="text-xs text-muted-foreground">
                    {user.assigned_brands.length} brand{user.assigned_brands.length !== 1 ? "s" : ""}
                  </span>
                )}

                <span className="text-xs text-muted-foreground">
                  {new Date(user.created_at).toLocaleDateString()}
                </span>

                {canManage(user.role, user.id) && (
                  <>
                    <Button variant="ghost" size="sm" className="h-7 w-7 p-0" onClick={() => startEdit(user)}>
                      <Pencil className="h-3.5 w-3.5" />
                    </Button>
                    <Button
                      variant="ghost"
                      size="sm"
                      className="h-7 w-7 p-0 text-red-500 hover:text-red-700"
                      onClick={() => handleRemove(user.id, user.name)}
                    >
                      <Trash2 className="h-3.5 w-3.5" />
                    </Button>
                  </>
                )}
              </div>
            </div>
          ))}
        </CardContent>
      </Card>

      {/* Pending Invitations */}
      {pendingInvitations.length > 0 && (
        <Card>
          <CardHeader className="pb-3">
            <CardTitle className="text-sm flex items-center gap-2">
              <Mail className="h-4 w-4" />
              Pending Invitations ({pendingInvitations.length})
            </CardTitle>
          </CardHeader>
          <CardContent className="divide-y">
            {pendingInvitations.map((inv: any) => (
              <div key={inv.id} className="flex items-center justify-between py-2.5 first:pt-0 last:pb-0">
                <div className="min-w-0">
                  <p className="text-sm font-medium">{inv.email}</p>
                  <p className="text-xs text-muted-foreground">
                    {roleLabels[inv.role] || inv.role} &middot; {daysUntil(inv.expires_at)}
                  </p>
                </div>
                <Button
                  variant="ghost"
                  size="sm"
                  className="h-7 text-xs text-muted-foreground"
                  onClick={() => cancelInviteMutation.mutate({ invitationId: inv.id })}
                >
                  <X className="h-3 w-3 mr-1" />
                  Cancel
                </Button>
              </div>
            ))}
          </CardContent>
        </Card>
      )}

      {/* Invite Dialog */}
      <Dialog open={showInviteDialog} onOpenChange={setShowInviteDialog}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Invite User</DialogTitle>
            <DialogDescription>
              {needsBrand
                ? "Send an email invitation. They must click the link to join."
                : "Add a team member directly. They'll receive a welcome email."}
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-4 pt-2">
            <div className="space-y-2">
              <Label>Name</Label>
              <Input
                value={inviteName}
                onChange={(e) => setInviteName(e.target.value)}
                placeholder="John Doe"
                disabled={inviteMutation.isPending}
              />
            </div>

            <div className="space-y-2">
              <Label>Email</Label>
              <Input
                type="email"
                value={inviteEmail}
                onChange={(e) => setInviteEmail(e.target.value)}
                placeholder="user@example.com"
                disabled={inviteMutation.isPending}
              />
            </div>

            <div className="space-y-2">
              <Label>Role</Label>
              <Select value={inviteRole} onValueChange={(v) => setInviteRole(v || "")} disabled={inviteMutation.isPending}>
                <SelectTrigger>
                  <SelectValue placeholder="Select role" />
                </SelectTrigger>
                <SelectContent>
                  {getAssignableRoles().map((role) => (
                    <SelectItem key={role} value={role}>
                      {roleLabels[role]}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>

            {needsBrand && (
              <div className="space-y-2">
                <Label>Brand</Label>
                <Select value={inviteBrandId} onValueChange={(v) => setInviteBrandId(v || "")} disabled={inviteMutation.isPending}>
                  <SelectTrigger>
                    <SelectValue placeholder="Select brand" />
                  </SelectTrigger>
                  <SelectContent>
                    {brands.map((brand: any) => (
                      <SelectItem key={brand.id} value={brand.id}>
                        {brand.name}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
            )}

            <Separator />

            <div className="flex justify-end gap-2">
              <Button variant="ghost" onClick={() => setShowInviteDialog(false)}>
                Cancel
              </Button>
              <Button
                onClick={handleInvite}
                disabled={!inviteEmail || !inviteRole || (needsBrand && !inviteBrandId) || inviteMutation.isPending}
              >
                {inviteMutation.isPending ? "Sending..." : needsBrand ? "Send Invitation" : "Add Member"}
              </Button>
            </div>
          </div>
        </DialogContent>
      </Dialog>

      {/* Edit Role Dialog */}
      <Dialog open={!!editingUser} onOpenChange={(open) => !open && setEditingUser(null)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Edit User: {editingUser?.name}</DialogTitle>
            <DialogDescription>{editingUser?.email}</DialogDescription>
          </DialogHeader>
          <div className="space-y-4 pt-2">
            <div className="space-y-2">
              <Label>Role</Label>
              <Select value={editRole} onValueChange={(v) => setEditRole(v || "")}>
                <SelectTrigger>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {getAssignableRoles().map((role) => (
                    <SelectItem key={role} value={role}>
                      {roleLabels[role]}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>

            {editRole === "agency_editor" && (
              <div className="space-y-2">
                <Label>Assigned Brands</Label>
                <div className="space-y-1.5 max-h-40 overflow-y-auto border rounded-md p-2">
                  {brands.map((brand: any) => (
                    <label key={brand.id} className="flex items-center gap-2 text-sm cursor-pointer">
                      <input
                        type="checkbox"
                        checked={editAssignedBrands.includes(brand.id)}
                        onChange={(e) => {
                          setEditAssignedBrands(
                            e.target.checked
                              ? [...editAssignedBrands, brand.id]
                              : editAssignedBrands.filter((id) => id !== brand.id)
                          );
                        }}
                        className="rounded"
                      />
                      {brand.name}
                    </label>
                  ))}
                </div>
              </div>
            )}

            {BRAND_ROLES.includes(editRole as any) && (
              <div className="space-y-2">
                <Label>Brand</Label>
                <Select value={editBrandId} onValueChange={(v) => setEditBrandId(v || "")}>
                  <SelectTrigger>
                    <SelectValue placeholder="Select brand" />
                  </SelectTrigger>
                  <SelectContent>
                    {brands.map((brand: any) => (
                      <SelectItem key={brand.id} value={brand.id}>
                        {brand.name}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
            )}

            <Separator />
            <div className="flex justify-end gap-2">
              <Button variant="ghost" onClick={() => setEditingUser(null)}>Cancel</Button>
              <Button onClick={handleSaveEdit} disabled={updateRoleMutation.isPending}>
                {updateRoleMutation.isPending ? "Saving..." : "Save Changes"}
              </Button>
            </div>
          </div>
        </DialogContent>
      </Dialog>
    </div>
  );
}
