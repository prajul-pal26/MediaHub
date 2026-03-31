-- Media Publication Platform — Database Schema
-- Run against Supabase PostgreSQL

-- Enable required extensions
CREATE EXTENSION IF NOT EXISTS "uuid-ossp";

-- ============================================
-- TABLES
-- ============================================

-- Organizations (agencies)
CREATE TABLE organizations (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name TEXT NOT NULL,
  plan TEXT DEFAULT 'free',
  settings JSONB DEFAULT '{}',
  created_at TIMESTAMPTZ DEFAULT now()
);

-- Users (all roles)
CREATE TABLE users (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id UUID REFERENCES organizations(id) ON DELETE CASCADE NOT NULL,
  brand_id UUID,  -- FK added after brands table
  email TEXT UNIQUE NOT NULL,
  name TEXT NOT NULL,
  role TEXT CHECK (role IN ('super_admin', 'agency_admin', 'agency_editor', 'brand_owner', 'brand_editor', 'brand_viewer')) DEFAULT 'brand_viewer',
  assigned_brands UUID[] DEFAULT '{}',
  created_at TIMESTAMPTZ DEFAULT now()
);

-- Brands (clients)
CREATE TABLE brands (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id UUID REFERENCES organizations(id) ON DELETE CASCADE NOT NULL,
  name TEXT NOT NULL,
  logo_url TEXT,
  settings JSONB DEFAULT '{}',
  setup_status TEXT DEFAULT 'incomplete' CHECK (setup_status IN ('incomplete', 'active')),
  created_at TIMESTAMPTZ DEFAULT now()
);

-- Add brand FK to users
ALTER TABLE users ADD CONSTRAINT users_brand_id_fkey FOREIGN KEY (brand_id) REFERENCES brands(id) ON DELETE SET NULL;

-- Platform credentials (org-level, super_admin managed)
CREATE TABLE platform_credentials (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id UUID REFERENCES organizations(id) ON DELETE CASCADE NOT NULL,
  platform TEXT NOT NULL CHECK (platform IN ('instagram', 'youtube', 'linkedin', 'google_drive')),
  client_id_encrypted TEXT NOT NULL,
  client_secret_encrypted TEXT NOT NULL,
  redirect_uri TEXT NOT NULL,
  status TEXT DEFAULT 'development' CHECK (status IN ('development', 'in_review', 'approved')),
  metadata JSONB DEFAULT '{}',
  updated_at TIMESTAMPTZ DEFAULT now(),
  created_at TIMESTAMPTZ DEFAULT now(),
  UNIQUE(org_id, platform)
);

-- Social accounts (per brand)
CREATE TABLE social_accounts (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  brand_id UUID REFERENCES brands(id) ON DELETE CASCADE NOT NULL,
  platform TEXT CHECK (platform IN ('instagram', 'youtube', 'linkedin')) NOT NULL,
  platform_user_id TEXT NOT NULL,
  platform_username TEXT,
  access_token_encrypted TEXT NOT NULL,
  refresh_token_encrypted TEXT,
  token_expires_at TIMESTAMPTZ,
  connection_method TEXT DEFAULT 'oauth' CHECK (connection_method IN ('oauth', 'manual_token')),
  platform_metadata JSONB DEFAULT '{}',
  is_active BOOLEAN DEFAULT true,
  created_at TIMESTAMPTZ DEFAULT now()
);

-- Drive connections (one per brand)
CREATE TABLE drive_connections (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  brand_id UUID REFERENCES brands(id) ON DELETE CASCADE NOT NULL UNIQUE,
  google_account_email TEXT NOT NULL,
  access_token_encrypted TEXT NOT NULL,
  refresh_token_encrypted TEXT,
  token_expires_at TIMESTAMPTZ,
  root_folder_id TEXT NOT NULL,
  folder_ids JSONB DEFAULT '{}',
  is_active BOOLEAN DEFAULT true,
  created_at TIMESTAMPTZ DEFAULT now()
);

-- Media groups
CREATE TABLE media_groups (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  brand_id UUID REFERENCES brands(id) ON DELETE CASCADE NOT NULL,
  uploaded_by UUID REFERENCES users(id),
  title TEXT NOT NULL,
  caption TEXT,
  description TEXT,
  tags TEXT[] DEFAULT '{}',
  notes TEXT,
  variant_count INTEGER DEFAULT 1,
  status TEXT DEFAULT 'available' CHECK (status IN ('available', 'archived')),
  created_at TIMESTAMPTZ DEFAULT now()
);

-- Media assets (variants within a group)
CREATE TABLE media_assets (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  group_id UUID REFERENCES media_groups(id) ON DELETE CASCADE NOT NULL,
  drive_file_id TEXT NOT NULL,
  processed_drive_file_id TEXT,
  file_name TEXT NOT NULL,
  file_type TEXT NOT NULL,
  file_size INTEGER,
  width INTEGER,
  height INTEGER,
  aspect_ratio TEXT,
  duration_seconds INTEGER,
  tagged_platform TEXT CHECK (tagged_platform IN ('instagram', 'youtube', 'linkedin')),
  tagged_account_id UUID REFERENCES social_accounts(id),
  tagged_action TEXT CHECK (tagged_action IN ('post', 'reel', 'short', 'story', 'video', 'carousel', 'article')),
  metadata JSONB DEFAULT '{}',
  sort_order INTEGER DEFAULT 0,
  created_at TIMESTAMPTZ DEFAULT now()
);

-- Content posts
CREATE TABLE content_posts (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  group_id UUID REFERENCES media_groups(id) ON DELETE CASCADE,
  brand_id UUID REFERENCES brands(id) ON DELETE CASCADE NOT NULL,
  scheduled_by UUID REFERENCES users(id),
  status TEXT CHECK (status IN ('draft', 'pending_approval', 'scheduled', 'publishing', 'published', 'failed')) DEFAULT 'draft',
  caption_overrides JSONB DEFAULT '{}',
  scheduled_at TIMESTAMPTZ,
  published_at TIMESTAMPTZ,
  source TEXT CHECK (source IN ('chat', 'click', 'api')) DEFAULT 'click',
  created_at TIMESTAMPTZ DEFAULT now()
);

-- Publish jobs (one per variant-account pair)
CREATE TABLE publish_jobs (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  post_id UUID REFERENCES content_posts(id) ON DELETE CASCADE NOT NULL,
  asset_id UUID REFERENCES media_assets(id) ON DELETE CASCADE,
  social_account_id UUID REFERENCES social_accounts(id) ON DELETE CASCADE NOT NULL,
  action TEXT NOT NULL,
  resize_option TEXT CHECK (resize_option IN ('auto_crop', 'blur_bg', 'custom_crop', 'keep_original')),
  status TEXT CHECK (status IN ('queued', 'processing', 'completed', 'failed', 'dead')) DEFAULT 'queued',
  attempt_count INTEGER DEFAULT 0,
  error_message TEXT,
  platform_post_id TEXT,
  completed_at TIMESTAMPTZ,
  next_retry_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ DEFAULT now()
);

-- Post analytics
CREATE TABLE post_analytics (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  post_id UUID REFERENCES content_posts(id) ON DELETE CASCADE NOT NULL,
  social_account_id UUID REFERENCES social_accounts(id) ON DELETE CASCADE NOT NULL,
  views INTEGER DEFAULT 0,
  likes INTEGER DEFAULT 0,
  comments INTEGER DEFAULT 0,
  shares INTEGER DEFAULT 0,
  saves INTEGER DEFAULT 0,
  clicks INTEGER DEFAULT 0,
  engagement_rate FLOAT DEFAULT 0,
  reach INTEGER DEFAULT 0,
  impressions INTEGER DEFAULT 0,
  platform_specific JSONB DEFAULT '{}',
  fetched_at TIMESTAMPTZ DEFAULT now()
);

-- API keys
CREATE TABLE api_keys (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id UUID REFERENCES organizations(id) ON DELETE CASCADE NOT NULL,
  key_hash TEXT NOT NULL,
  name TEXT NOT NULL,
  permissions JSONB DEFAULT '[]',
  expires_at TIMESTAMPTZ,
  last_used_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ DEFAULT now()
);

-- Audit log
CREATE TABLE audit_log (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id UUID NOT NULL,
  user_id UUID,
  action TEXT NOT NULL,
  resource_type TEXT NOT NULL,
  resource_id UUID,
  source TEXT CHECK (source IN ('chat', 'click', 'api')),
  metadata JSONB DEFAULT '{}',
  created_at TIMESTAMPTZ DEFAULT now()
);

-- Invitations
CREATE TABLE invitations (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id UUID REFERENCES organizations(id) ON DELETE CASCADE NOT NULL,
  email TEXT NOT NULL,
  role TEXT NOT NULL,
  brand_id UUID REFERENCES brands(id),
  invited_by UUID REFERENCES users(id) NOT NULL,
  token_hash TEXT NOT NULL,
  method TEXT DEFAULT 'email_invite' CHECK (method IN ('email_invite', 'direct_add')),
  status TEXT DEFAULT 'pending' CHECK (status IN ('pending', 'accepted', 'expired', 'cancelled')),
  expires_at TIMESTAMPTZ NOT NULL,
  created_at TIMESTAMPTZ DEFAULT now()
);

-- ============================================
-- ROW LEVEL SECURITY
-- ============================================

-- Helper function: get current user's profile
CREATE OR REPLACE FUNCTION auth_user_profile()
RETURNS TABLE(id UUID, org_id UUID, brand_id UUID, role TEXT, assigned_brands UUID[])
LANGUAGE sql STABLE SECURITY DEFINER
AS $$
  SELECT u.id, u.org_id, u.brand_id, u.role, u.assigned_brands
  FROM users u
  WHERE u.id = auth.uid()
  LIMIT 1;
$$;

-- ---- ORGANIZATIONS ----
ALTER TABLE organizations ENABLE ROW LEVEL SECURITY;

CREATE POLICY "users_see_own_org" ON organizations FOR SELECT USING (
  id = (SELECT org_id FROM auth_user_profile())
);

CREATE POLICY "super_admin_manage_org" ON organizations FOR ALL USING (
  id = (SELECT org_id FROM auth_user_profile())
  AND (SELECT role FROM auth_user_profile()) = 'super_admin'
);

-- ---- BRANDS ----
ALTER TABLE brands ENABLE ROW LEVEL SECURITY;

CREATE POLICY "agency_full_access_brands" ON brands FOR ALL USING (
  org_id = (SELECT org_id FROM auth_user_profile())
  AND (SELECT role FROM auth_user_profile()) IN ('super_admin', 'agency_admin')
);

CREATE POLICY "agency_editor_assigned_brands" ON brands FOR SELECT USING (
  org_id = (SELECT org_id FROM auth_user_profile())
  AND (SELECT role FROM auth_user_profile()) = 'agency_editor'
  AND id = ANY(COALESCE((SELECT assigned_brands FROM users WHERE users.id = auth.uid()), '{}'))
);

CREATE POLICY "brand_users_own_brand" ON brands FOR SELECT USING (
  id = (SELECT brand_id FROM auth_user_profile())
  AND (SELECT role FROM auth_user_profile()) IN ('brand_owner', 'brand_editor', 'brand_viewer')
);

-- ---- USERS ----
ALTER TABLE users ENABLE ROW LEVEL SECURITY;

-- Allow users to read their own row (bootstraps profile for RLS)
CREATE POLICY "users_read_own" ON users FOR SELECT USING (
  id = auth.uid()
);

CREATE POLICY "users_see_org_members" ON users FOR SELECT USING (
  org_id = (SELECT org_id FROM auth_user_profile())
);

CREATE POLICY "admin_manage_users" ON users FOR ALL USING (
  org_id = (SELECT org_id FROM auth_user_profile())
  AND (SELECT role FROM auth_user_profile()) IN ('super_admin', 'agency_admin')
);

-- ---- PLATFORM CREDENTIALS ----
ALTER TABLE platform_credentials ENABLE ROW LEVEL SECURITY;

CREATE POLICY "super_admin_manage_credentials" ON platform_credentials FOR ALL USING (
  org_id = (SELECT org_id FROM auth_user_profile())
  AND (SELECT role FROM auth_user_profile()) = 'super_admin'
);

CREATE POLICY "org_users_read_credentials" ON platform_credentials FOR SELECT USING (
  org_id = (SELECT org_id FROM auth_user_profile())
);

-- ---- SOCIAL ACCOUNTS ----
ALTER TABLE social_accounts ENABLE ROW LEVEL SECURITY;

CREATE POLICY "agency_manage_social_accounts" ON social_accounts FOR ALL USING (
  brand_id IN (
    SELECT b.id FROM brands b
    WHERE b.org_id = (SELECT org_id FROM auth_user_profile())
    AND (
      (SELECT role FROM auth_user_profile()) IN ('super_admin', 'agency_admin')
      OR (
        (SELECT role FROM auth_user_profile()) = 'agency_editor'
        AND b.id = ANY(COALESCE((SELECT assigned_brands FROM users WHERE users.id = auth.uid()), '{}'))
      )
    )
  )
);

CREATE POLICY "brand_users_view_social_accounts" ON social_accounts FOR SELECT USING (
  brand_id = (SELECT brand_id FROM auth_user_profile())
  AND (SELECT role FROM auth_user_profile()) IN ('brand_owner', 'brand_editor', 'brand_viewer')
);

-- ---- DRIVE CONNECTIONS ----
ALTER TABLE drive_connections ENABLE ROW LEVEL SECURITY;

CREATE POLICY "agency_manage_drive" ON drive_connections FOR ALL USING (
  brand_id IN (
    SELECT b.id FROM brands b
    WHERE b.org_id = (SELECT org_id FROM auth_user_profile())
    AND (SELECT role FROM auth_user_profile()) IN ('super_admin', 'agency_admin')
  )
);

CREATE POLICY "brand_owner_manage_drive" ON drive_connections FOR ALL USING (
  brand_id = (SELECT brand_id FROM auth_user_profile())
  AND (SELECT role FROM auth_user_profile()) = 'brand_owner'
);

CREATE POLICY "brand_users_view_drive" ON drive_connections FOR SELECT USING (
  brand_id = (SELECT brand_id FROM auth_user_profile())
  AND (SELECT role FROM auth_user_profile()) IN ('brand_editor', 'brand_viewer')
);

-- ---- MEDIA GROUPS ----
ALTER TABLE media_groups ENABLE ROW LEVEL SECURITY;

CREATE POLICY "agency_manage_media_groups" ON media_groups FOR ALL USING (
  brand_id IN (
    SELECT b.id FROM brands b
    WHERE b.org_id = (SELECT org_id FROM auth_user_profile())
    AND (
      (SELECT role FROM auth_user_profile()) IN ('super_admin', 'agency_admin')
      OR (
        (SELECT role FROM auth_user_profile()) = 'agency_editor'
        AND b.id = ANY(COALESCE((SELECT assigned_brands FROM users WHERE users.id = auth.uid()), '{}'))
      )
    )
  )
);

CREATE POLICY "brand_editors_manage_media" ON media_groups FOR ALL USING (
  brand_id = (SELECT brand_id FROM auth_user_profile())
  AND (SELECT role FROM auth_user_profile()) IN ('brand_owner', 'brand_editor')
);

CREATE POLICY "brand_viewers_read_media" ON media_groups FOR SELECT USING (
  brand_id = (SELECT brand_id FROM auth_user_profile())
  AND (SELECT role FROM auth_user_profile()) = 'brand_viewer'
);

-- ---- MEDIA ASSETS ----
ALTER TABLE media_assets ENABLE ROW LEVEL SECURITY;

CREATE POLICY "media_assets_follow_groups" ON media_assets FOR ALL USING (
  group_id IN (SELECT id FROM media_groups)
);

-- ---- CONTENT POSTS ----
ALTER TABLE content_posts ENABLE ROW LEVEL SECURITY;

CREATE POLICY "agency_manage_posts" ON content_posts FOR ALL USING (
  brand_id IN (
    SELECT b.id FROM brands b
    WHERE b.org_id = (SELECT org_id FROM auth_user_profile())
    AND (
      (SELECT role FROM auth_user_profile()) IN ('super_admin', 'agency_admin')
      OR (
        (SELECT role FROM auth_user_profile()) = 'agency_editor'
        AND b.id = ANY(COALESCE((SELECT assigned_brands FROM users WHERE users.id = auth.uid()), '{}'))
      )
    )
  )
);

CREATE POLICY "brand_editors_manage_posts" ON content_posts FOR ALL USING (
  brand_id = (SELECT brand_id FROM auth_user_profile())
  AND (SELECT role FROM auth_user_profile()) IN ('brand_owner', 'brand_editor')
);

CREATE POLICY "brand_viewers_read_posts" ON content_posts FOR SELECT USING (
  brand_id = (SELECT brand_id FROM auth_user_profile())
  AND (SELECT role FROM auth_user_profile()) = 'brand_viewer'
);

-- ---- PUBLISH JOBS ----
ALTER TABLE publish_jobs ENABLE ROW LEVEL SECURITY;

CREATE POLICY "publish_jobs_follow_posts" ON publish_jobs FOR ALL USING (
  post_id IN (SELECT id FROM content_posts)
);

-- ---- POST ANALYTICS ----
ALTER TABLE post_analytics ENABLE ROW LEVEL SECURITY;

CREATE POLICY "analytics_follow_posts" ON post_analytics FOR ALL USING (
  post_id IN (SELECT id FROM content_posts)
);

-- ---- API KEYS ----
ALTER TABLE api_keys ENABLE ROW LEVEL SECURITY;

CREATE POLICY "super_admin_manage_api_keys" ON api_keys FOR ALL USING (
  org_id = (SELECT org_id FROM auth_user_profile())
  AND (SELECT role FROM auth_user_profile()) = 'super_admin'
);

-- ---- AUDIT LOG ----
ALTER TABLE audit_log ENABLE ROW LEVEL SECURITY;

CREATE POLICY "admin_read_audit_log" ON audit_log FOR SELECT USING (
  org_id = (SELECT org_id FROM auth_user_profile())
  AND (SELECT role FROM auth_user_profile()) IN ('super_admin', 'agency_admin')
);

CREATE POLICY "system_insert_audit_log" ON audit_log FOR INSERT WITH CHECK (
  org_id = (SELECT org_id FROM auth_user_profile())
);

-- ---- INVITATIONS ----
ALTER TABLE invitations ENABLE ROW LEVEL SECURITY;

CREATE POLICY "admin_manage_invitations" ON invitations FOR ALL USING (
  org_id = (SELECT org_id FROM auth_user_profile())
  AND (SELECT role FROM auth_user_profile()) IN ('super_admin', 'agency_admin')
);

CREATE POLICY "brand_owner_manage_invitations" ON invitations FOR ALL USING (
  org_id = (SELECT org_id FROM auth_user_profile())
  AND (SELECT role FROM auth_user_profile()) = 'brand_owner'
  AND brand_id = (SELECT brand_id FROM auth_user_profile())
);

-- ============================================
-- INDEXES
-- ============================================

CREATE INDEX idx_users_org_id ON users(org_id);
CREATE INDEX idx_users_brand_id ON users(brand_id);
CREATE INDEX idx_brands_org_id ON brands(org_id);
CREATE INDEX idx_social_accounts_brand_id ON social_accounts(brand_id);
CREATE INDEX idx_media_groups_brand_id ON media_groups(brand_id);
CREATE INDEX idx_media_assets_group_id ON media_assets(group_id);
CREATE INDEX idx_content_posts_brand_id ON content_posts(brand_id);
CREATE INDEX idx_content_posts_status ON content_posts(status);
CREATE INDEX idx_content_posts_scheduled_at ON content_posts(scheduled_at);
CREATE INDEX idx_publish_jobs_post_id ON publish_jobs(post_id);
CREATE INDEX idx_publish_jobs_status ON publish_jobs(status);
CREATE INDEX idx_post_analytics_post_id ON post_analytics(post_id);
CREATE INDEX idx_audit_log_org_id ON audit_log(org_id);
CREATE INDEX idx_invitations_org_id ON invitations(org_id);
CREATE INDEX idx_invitations_email ON invitations(email);

-- ============================================
-- TRIGGER: auto-create user profile on auth signup
-- ============================================

CREATE OR REPLACE FUNCTION handle_new_user()
RETURNS TRIGGER
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_org_id UUID;
  v_role TEXT;
  v_brand_id UUID;
  v_name TEXT;
BEGIN
  -- Check if user was invited
  -- Raw metadata from signup contains org info
  v_name := COALESCE(NEW.raw_user_meta_data->>'name', split_part(NEW.email, '@', 1));

  -- Check for pending invitation
  SELECT i.org_id, i.role, i.brand_id INTO v_org_id, v_role, v_brand_id
  FROM invitations i
  WHERE i.email = NEW.email
    AND i.status = 'pending'
    AND i.expires_at > now()
  ORDER BY i.created_at DESC
  LIMIT 1;

  IF v_org_id IS NOT NULL THEN
    -- Invited user: use invitation details
    INSERT INTO users (id, org_id, email, name, role, brand_id)
    VALUES (NEW.id, v_org_id, NEW.email, v_name, v_role, v_brand_id);

    -- Mark invitation as accepted
    UPDATE invitations SET status = 'accepted' WHERE email = NEW.email AND status = 'pending';
  ELSE
    -- New user: create org and make them super_admin
    INSERT INTO organizations (name) VALUES (v_name || '''s Organization') RETURNING id INTO v_org_id;

    INSERT INTO users (id, org_id, email, name, role)
    VALUES (NEW.id, v_org_id, NEW.email, v_name, 'super_admin');
  END IF;

  RETURN NEW;
END;
$$;

CREATE TRIGGER on_auth_user_created
  AFTER INSERT ON auth.users
  FOR EACH ROW
  EXECUTE FUNCTION handle_new_user();
