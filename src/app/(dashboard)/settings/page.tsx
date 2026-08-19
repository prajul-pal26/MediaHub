"use client";

import { useUser } from "@/lib/hooks/use-user";
import { PlatformCredentials } from "@/components/settings/PlatformCredentials";
import { UserManagement } from "@/components/settings/UserManagement";
import { OrganizationSettings } from "@/components/settings/OrganizationSettings";
import { LlmManagement } from "@/components/settings/LlmManagement";
import { PersonalLlmKey } from "@/components/settings/PersonalLlmKey";
import { AuditLog } from "@/components/settings/AuditLog";
import { InstagramSessions, InstagramGlyph } from "@/components/settings/InstagramSessions";
import { FacebookSessions, FacebookGlyph } from "@/components/settings/FacebookSessions";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Shield, Users, Building2, Brain, Key, ScrollText } from "lucide-react";
import { isGodUser } from "@/lib/god";

export default function SettingsPage() {
  const { profile, loading } = useUser();

  if (loading) {
    return (
      <div className="flex items-center justify-center h-64">
        <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-primary" />
      </div>
    );
  }

  if (!profile) return null;

  const isSuperAdmin = profile.role === "super_admin";
  const isAdmin = isSuperAdmin || profile.role === "agency_admin";
  const canManageUsers = isAdmin || profile.role === "brand_owner";
  // God (single-user) mode: hide Users / Organization / LLM-Access tabs.
  const god = isGodUser(profile);

  // Non-admin users can still access settings for personal LLM key
  if (!canManageUsers) {
    return (
      <div className="space-y-6">
        <div>
          <h1 className="text-2xl font-bold">Settings</h1>
          <p className="text-muted-foreground">Manage your preferences</p>
        </div>

        <Tabs defaultValue="personal-llm">
          <TabsList>
            <TabsTrigger value="personal-llm" className="gap-2">
              <Key className="h-4 w-4" />
              Personal LLM Key
            </TabsTrigger>
          </TabsList>

          <TabsContent value="personal-llm" className="mt-6">
            <PersonalLlmKey />
          </TabsContent>
        </Tabs>
      </div>
    );
  }

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-bold">Settings</h1>
        <p className="text-muted-foreground">Manage your organization and team</p>
      </div>

      <Tabs defaultValue={god ? "credentials" : "users"}>
        <TabsList>
          {!god && (
            <TabsTrigger value="users" className="gap-2">
              <Users className="h-4 w-4" />
              Users
            </TabsTrigger>
          )}
          {isSuperAdmin && (
            <TabsTrigger value="credentials" className="gap-2">
              <Shield className="h-4 w-4" />
              Platform Credentials
            </TabsTrigger>
          )}
          <TabsTrigger value="instagram" className="gap-2">
            <InstagramGlyph className="h-4 w-4" />
            Instagram
          </TabsTrigger>
          <TabsTrigger value="facebook" className="gap-2">
            <FacebookGlyph className="h-4 w-4" />
            Facebook
          </TabsTrigger>
          {isAdmin && !god && (
            <TabsTrigger value="organization" className="gap-2">
              <Building2 className="h-4 w-4" />
              Organization
            </TabsTrigger>
          )}
          {isSuperAdmin && !god && (
            <TabsTrigger value="llm" className="gap-2">
              <Brain className="h-4 w-4" />
              LLM Access
            </TabsTrigger>
          )}
          {isSuperAdmin && (
            <TabsTrigger value="audit" className="gap-2">
              <ScrollText className="h-4 w-4" />
              Audit Log
            </TabsTrigger>
          )}
          <TabsTrigger value="personal-llm" className="gap-2">
            <Key className="h-4 w-4" />
            Personal LLM Key
          </TabsTrigger>
        </TabsList>

        {!god && (
          <TabsContent value="users" className="mt-6">
            <UserManagement profile={profile} />
          </TabsContent>
        )}

        {isSuperAdmin && (
          <TabsContent value="credentials" className="mt-6">
            <PlatformCredentials />
          </TabsContent>
        )}

        <TabsContent value="instagram" className="mt-6">
          <InstagramSessions />
        </TabsContent>

        <TabsContent value="facebook" className="mt-6">
          <FacebookSessions />
        </TabsContent>

        {isAdmin && !god && (
          <TabsContent value="organization" className="mt-6">
            <OrganizationSettings profile={profile} />
          </TabsContent>
        )}

        {isSuperAdmin && !god && (
          <TabsContent value="llm" className="mt-6">
            <LlmManagement />
          </TabsContent>
        )}

        {isSuperAdmin && (
          <TabsContent value="audit" className="mt-6">
            <AuditLog />
          </TabsContent>
        )}

        <TabsContent value="personal-llm" className="mt-6">
          <PersonalLlmKey />
        </TabsContent>
      </Tabs>
    </div>
  );
}
