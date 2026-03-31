export type Role =
  | "super_admin"
  | "agency_admin"
  | "agency_editor"
  | "brand_owner"
  | "brand_editor"
  | "brand_viewer";

export type Mode = "chat" | "click" | "analytics";

export interface UserProfile {
  id: string;
  org_id: string;
  brand_id: string | null;
  email: string;
  name: string;
  role: Role;
  assigned_brands: string[];
  created_at: string;
}

export interface Brand {
  id: string;
  org_id: string;
  name: string;
  logo_url: string | null;
  settings: Record<string, unknown>;
  setup_status: "incomplete" | "active";
  created_at: string;
}

export interface PlatformCredential {
  id: string;
  org_id: string;
  platform: "instagram" | "youtube" | "linkedin" | "google_drive" | "facebook" | "tiktok" | "twitter" | "snapchat";
  client_id: string;
  client_secret_masked: string;
  redirect_uri: string;
  status: "development" | "in_review" | "approved";
}

export const AGENCY_ROLES: Role[] = ["super_admin", "agency_admin", "agency_editor"];
export const BRAND_ROLES: Role[] = ["brand_owner", "brand_editor", "brand_viewer"];

export function isAgencyRole(role: Role): boolean {
  return AGENCY_ROLES.includes(role);
}

export function isBrandRole(role: Role): boolean {
  return BRAND_ROLES.includes(role);
}

export function canManageBrands(role: Role): boolean {
  return role === "super_admin" || role === "agency_admin";
}

export function canEditContent(role: Role): boolean {
  return ["super_admin", "agency_admin", "agency_editor", "brand_owner", "brand_editor"].includes(role);
}
