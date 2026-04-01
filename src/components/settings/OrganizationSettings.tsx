"use client";

import { useState, useEffect } from "react";
import { useRouter } from "next/navigation";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Separator } from "@/components/ui/separator";
import { trpc } from "@/lib/trpc/client";
import { createClient } from "@/lib/supabase/client";
import { toast } from "sonner";
import { Building2, Save, AlertTriangle, Trash2 } from "lucide-react";
import type { UserProfile } from "@/lib/types";

interface OrganizationSettingsProps {
  profile: UserProfile;
}

const planBadges: Record<string, string> = {
  free: "bg-gray-100 text-gray-700",
  pro: "bg-blue-100 text-blue-700",
  enterprise: "bg-purple-100 text-purple-700",
};

export function OrganizationSettings({ profile }: OrganizationSettingsProps) {
  const router = useRouter();
  const [orgName, setOrgName] = useState("");
  const [saving, setSaving] = useState(false);

  const { data: org } = trpc.users.getOrg.useQuery();

  const updateMutation = trpc.users.updateOrg.useMutation({
    onSuccess: () => {
      toast.success("Organization updated");
      setSaving(false);
    },
    onError: (error) => {
      toast.error(error.message);
      setSaving(false);
    },
  });

  const deleteMutation = trpc.users.deleteOrg.useMutation({
    onSuccess: async () => {
      toast.success("Organization deleted");
      const supabase = createClient();
      await supabase.auth.signOut();
      router.push("/login");
    },
    onError: (error) => toast.error(error.message),
  });

  useEffect(() => {
    if (org?.name) setOrgName(org.name);
  }, [org]);

  function handleSave() {
    if (!orgName.trim()) {
      toast.error("Organization name is required");
      return;
    }
    setSaving(true);
    updateMutation.mutate({ name: orgName.trim() });
  }

  function handleDeleteOrg() {
    const typed = prompt(
      `This will PERMANENTLY delete your entire organization, all brands, all media, all users, and all data.\n\nType "${org?.name}" to confirm:`
    );
    if (typed === org?.name) {
      deleteMutation.mutate();
    } else if (typed !== null) {
      toast.error("Name didn't match. Deletion cancelled.");
    }
  }

  const isSuperAdmin = profile.role === "super_admin";

  return (
    <div className="space-y-6">
      <div className="flex items-center gap-2">
        <Building2 className="h-5 w-5" />
        <h2 className="text-lg font-semibold">Organization</h2>
      </div>

      {/* General Settings */}
      <Card>
        <CardHeader>
          <CardTitle className="text-base">General</CardTitle>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="space-y-2">
            <Label>Organization Name</Label>
            <div className="flex gap-2">
              <Input
                value={orgName}
                onChange={(e) => setOrgName(e.target.value)}
                placeholder="Your organization"
                disabled={!isSuperAdmin}
              />
              {isSuperAdmin && (
                <Button onClick={handleSave} disabled={saving || orgName === org?.name}>
                  <Save className="h-4 w-4 mr-2" />
                  {saving ? "Saving..." : "Save"}
                </Button>
              )}
            </div>
          </div>

          <div className="space-y-2">
            <Label>Plan</Label>
            <div className="flex items-center gap-2">
              <Badge variant="secondary" className={planBadges[org?.plan || "free"] || ""}>
                {(org?.plan || "free").toUpperCase()}
              </Badge>
              <span className="text-xs text-muted-foreground">
                Contact support to change your plan
              </span>
            </div>
          </div>

          <div className="space-y-2">
            <Label>Organization ID</Label>
            <p className="text-xs font-mono text-muted-foreground">{profile.org_id}</p>
          </div>
        </CardContent>
      </Card>

      {/* Danger Zone */}
      {isSuperAdmin && (
        <Card className="border-red-200">
          <CardHeader>
            <CardTitle className="text-base text-red-600 flex items-center gap-2">
              <AlertTriangle className="h-4 w-4" />
              Danger Zone
            </CardTitle>
            <CardDescription>
              Irreversible actions. Proceed with caution.
            </CardDescription>
          </CardHeader>
          <CardContent>
            <div className="flex items-center justify-between p-4 border border-red-200 rounded-lg">
              <div>
                <p className="text-sm font-medium">Delete Organization</p>
                <p className="text-xs text-muted-foreground">
                  Permanently deletes all brands, media, accounts, posts, analytics, and users.
                </p>
              </div>
              <Button
                variant="outline"
                className="border-red-300 text-red-600 hover:bg-red-50"
                onClick={handleDeleteOrg}
                disabled={deleteMutation.isPending}
              >
                <Trash2 className="h-4 w-4 mr-2" />
                {deleteMutation.isPending ? "Deleting..." : "Delete Organization"}
              </Button>
            </div>
          </CardContent>
        </Card>
      )}
    </div>
  );
}
