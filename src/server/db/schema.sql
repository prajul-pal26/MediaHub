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
  platform TEXT NOT NULL CHECK (platform IN ('instagram', 'youtube', 'linkedin', 'google_drive', 'email_smtp', 'llm_provider', 'llm_openrouter', 'llm_anthropic', 'llm_openai', 'llm_google')),
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
  uploaded_by UUID REFERENCES users(id) ON DELETE SET NULL,
  title TEXT NOT NULL,
  caption TEXT,
  description TEXT,
  tags TEXT[] DEFAULT '{}',
  notes TEXT,
  variant_count INTEGER DEFAULT 1,
  status TEXT DEFAULT 'available' CHECK (status IN ('available', 'scheduled', 'published', 'archived')),
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
  tagged_account_id UUID REFERENCES social_accounts(id) ON DELETE SET NULL,
  tagged_action TEXT CHECK (tagged_action IN ('post', 'reel', 'short', 'story', 'video', 'carousel', 'article')),
  metadata JSONB DEFAULT '{}',
  sort_order INTEGER DEFAULT 0,
  created_at TIMESTAMPTZ DEFAULT now()
);

-- Content posts
CREATE TABLE content_posts (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  group_id UUID REFERENCES media_groups(id) ON DELETE CASCADE NOT NULL,
  brand_id UUID REFERENCES brands(id) ON DELETE CASCADE NOT NULL,
  scheduled_by UUID REFERENCES users(id) ON DELETE SET NULL,
  status TEXT CHECK (status IN ('draft', 'pending_approval', 'scheduled', 'publishing', 'published', 'partial_published', 'failed')) DEFAULT 'draft',
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
  asset_id UUID REFERENCES media_assets(id) ON DELETE CASCADE NOT NULL,
  social_account_id UUID REFERENCES social_accounts(id) ON DELETE CASCADE NOT NULL,
  action TEXT NOT NULL,
  resize_option TEXT CHECK (resize_option IN ('auto_crop', 'blur_bg', 'custom_crop', 'keep_original')),
  status TEXT CHECK (status IN ('queued', 'processing', 'completed', 'failed', 'dead', 'cancelled')) DEFAULT 'queued',
  attempt_count INTEGER DEFAULT 0,
  error_message TEXT,
  platform_post_id TEXT,
  completed_at TIMESTAMPTZ,
  next_retry_at TIMESTAMPTZ,
  updated_at TIMESTAMPTZ DEFAULT now(),
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
  org_id UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  user_id UUID REFERENCES users(id) ON DELETE SET NULL,
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
  brand_id UUID REFERENCES brands(id) ON DELETE CASCADE,
  invited_by UUID REFERENCES users(id) ON DELETE SET NULL,
  token_hash TEXT NOT NULL,
  method TEXT DEFAULT 'email_invite' CHECK (method IN ('email_invite', 'direct_add')),
  status TEXT DEFAULT 'pending' CHECK (status IN ('pending', 'accepted', 'expired', 'cancelled')),
  expires_at TIMESTAMPTZ NOT NULL,
  created_at TIMESTAMPTZ DEFAULT now()
);

-- ─── LLM Configurations (multi-level) ───
CREATE TABLE llm_configurations (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  scope TEXT NOT NULL CHECK (scope IN ('org', 'brand', 'user')),
  org_id UUID REFERENCES organizations(id) ON DELETE CASCADE NOT NULL,
  brand_id UUID REFERENCES brands(id) ON DELETE CASCADE,
  user_id UUID REFERENCES users(id) ON DELETE CASCADE,
  provider TEXT NOT NULL CHECK (provider IN ('openrouter', 'openai', 'anthropic', 'google', 'custom')),
  label TEXT NOT NULL DEFAULT 'Default',
  api_key_encrypted TEXT NOT NULL,
  base_url TEXT, -- for custom providers
  default_model TEXT,
  is_active BOOLEAN DEFAULT true,
  created_at TIMESTAMPTZ DEFAULT now(),
  updated_at TIMESTAMPTZ DEFAULT now(),
  UNIQUE(org_id, scope, brand_id, user_id, provider) -- one config per scope+entity+provider
);

-- ─── LLM Brand Access (org shares LLM with brands) ───
CREATE TABLE llm_brand_access (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id UUID REFERENCES organizations(id) ON DELETE CASCADE NOT NULL,
  brand_id UUID REFERENCES brands(id) ON DELETE CASCADE NOT NULL,
  provider TEXT NOT NULL, -- e.g. 'llm_openrouter', 'llm_anthropic', etc.
  granted_by UUID REFERENCES users(id) ON DELETE SET NULL,
  is_active BOOLEAN DEFAULT true,
  created_at TIMESTAMPTZ DEFAULT now(),
  UNIQUE(org_id, brand_id) -- one access grant per brand
);

-- ─── LLM Usage Limits ───
CREATE TABLE llm_limits (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id UUID REFERENCES organizations(id) ON DELETE CASCADE NOT NULL,
  brand_id UUID REFERENCES brands(id) ON DELETE CASCADE,
  user_id UUID REFERENCES users(id) ON DELETE CASCADE,
  daily_requests INT DEFAULT 100,
  monthly_requests INT DEFAULT 3000,
  max_tokens_per_request INT DEFAULT 4096,
  is_active BOOLEAN DEFAULT true,
  created_at TIMESTAMPTZ DEFAULT now(),
  updated_at TIMESTAMPTZ DEFAULT now()
);

-- ─── LLM Usage Logs ───
CREATE TABLE llm_usage_logs (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id UUID REFERENCES organizations(id) ON DELETE CASCADE NOT NULL,
  brand_id UUID,
  user_id UUID REFERENCES users(id) ON DELETE SET NULL,
  config_id UUID REFERENCES llm_configurations(id) ON DELETE SET NULL,
  scope_used TEXT CHECK (scope_used IN ('org', 'brand', 'user')),
  provider TEXT NOT NULL,
  model TEXT,
  input_tokens INT DEFAULT 0,
  output_tokens INT DEFAULT 0,
  total_tokens INT DEFAULT 0,
  cost_estimate NUMERIC(10,6) DEFAULT 0,
  created_at TIMESTAMPTZ DEFAULT now()
);

-- ─── Content Categories (AI-analyzed) ───
CREATE TABLE content_categories (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  group_id UUID REFERENCES media_groups(id) ON DELETE CASCADE NOT NULL,
  brand_id UUID REFERENCES brands(id) ON DELETE CASCADE NOT NULL,
  primary_category TEXT NOT NULL,
  secondary_category TEXT,
  tone TEXT,
  topics TEXT[] DEFAULT '{}',
  sentiment_score FLOAT,
  predicted_engagement_score FLOAT,
  actual_engagement_rate FLOAT,
  prediction_accuracy FLOAT,
  analyzed_at TIMESTAMPTZ DEFAULT now(),
  created_at TIMESTAMPTZ DEFAULT now()
);

-- ─── Trend Snapshots (weekly AI analysis) ───
CREATE TABLE trend_snapshots (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  brand_id UUID REFERENCES brands(id) ON DELETE CASCADE NOT NULL,
  platform TEXT NOT NULL,
  snapshot_date DATE NOT NULL,
  trending_categories JSONB DEFAULT '[]',
  trending_topics JSONB DEFAULT '[]',
  trending_formats JSONB DEFAULT '[]',
  content_recommendations JSONB DEFAULT '[]',
  content_gaps JSONB DEFAULT '[]',
  weekly_plan JSONB DEFAULT '[]',
  generated_by TEXT DEFAULT 'ai',
  created_at TIMESTAMPTZ DEFAULT now(),
  UNIQUE(brand_id, platform, snapshot_date)
);

-- ─── Performance Predictions ───
CREATE TABLE performance_predictions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  group_id UUID REFERENCES media_groups(id) ON DELETE CASCADE NOT NULL,
  brand_id UUID REFERENCES brands(id) ON DELETE CASCADE NOT NULL,
  platform TEXT NOT NULL,
  action TEXT NOT NULL,
  predicted_views_min INTEGER,
  predicted_views_max INTEGER,
  predicted_engagement_rate FLOAT,
  predicted_best_time TIMESTAMPTZ,
  confidence_score FLOAT,
  reasoning TEXT,
  suggestions JSONB DEFAULT '[]',
  actual_views INTEGER,
  actual_engagement_rate FLOAT,
  created_at TIMESTAMPTZ DEFAULT now()
);

-- ─── Comment Sentiment ───
CREATE TABLE comment_sentiments (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  post_id UUID REFERENCES content_posts(id) ON DELETE CASCADE NOT NULL,
  brand_id UUID REFERENCES brands(id) ON DELETE CASCADE NOT NULL,
  overall_sentiment TEXT,
  sentiment_score FLOAT,
  positive_count INTEGER DEFAULT 0,
  negative_count INTEGER DEFAULT 0,
  neutral_count INTEGER DEFAULT 0,
  top_positive_themes JSONB DEFAULT '[]',
  top_negative_themes JSONB DEFAULT '[]',
  purchase_intent_signals INTEGER DEFAULT 0,
  questions_count INTEGER DEFAULT 0,
  summary TEXT,
  analyzed_at TIMESTAMPTZ DEFAULT now(),
  created_at TIMESTAMPTZ DEFAULT now()
);

-- ─── Competitor Metrics ───
CREATE TABLE competitor_metrics (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  brand_id UUID REFERENCES brands(id) ON DELETE CASCADE NOT NULL,
  competitor_handle TEXT NOT NULL,
  platform TEXT NOT NULL,
  followers INTEGER,
  posts_count INTEGER,
  avg_engagement_rate FLOAT,
  avg_views_recent FLOAT,
  fetched_at TIMESTAMPTZ DEFAULT now()
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

-- ---- LLM CONFIGURATIONS ----
ALTER TABLE llm_configurations ENABLE ROW LEVEL SECURITY;
CREATE POLICY "llm_config_user_own" ON llm_configurations FOR ALL USING (
  user_id = auth.uid() OR
  (SELECT role FROM auth_user_profile()) IN ('super_admin', 'agency_admin')
);

-- ---- LLM BRAND ACCESS ----
ALTER TABLE llm_brand_access ENABLE ROW LEVEL SECURITY;
CREATE POLICY "llm_brand_access_policy" ON llm_brand_access FOR ALL USING (
  org_id = (SELECT org_id FROM auth_user_profile()) AND (
    (SELECT role FROM auth_user_profile()) IN ('super_admin', 'agency_admin') OR
    brand_id = (SELECT brand_id FROM auth_user_profile())
  )
);

-- ---- LLM LIMITS ----
ALTER TABLE llm_limits ENABLE ROW LEVEL SECURITY;
CREATE POLICY "llm_limits_policy" ON llm_limits FOR ALL USING (
  org_id = (SELECT org_id FROM auth_user_profile()) AND (
    (SELECT role FROM auth_user_profile()) IN ('super_admin', 'agency_admin') OR
    brand_id = (SELECT brand_id FROM auth_user_profile()) OR
    user_id = auth.uid()
  )
);

-- ---- LLM USAGE LOGS ----
ALTER TABLE llm_usage_logs ENABLE ROW LEVEL SECURITY;
CREATE POLICY "llm_usage_logs_policy" ON llm_usage_logs FOR ALL USING (
  org_id = (SELECT org_id FROM auth_user_profile()) AND (
    (SELECT role FROM auth_user_profile()) IN ('super_admin', 'agency_admin') OR
    user_id = auth.uid()
  )
);

-- ---- CONTENT CATEGORIES ----
ALTER TABLE content_categories ENABLE ROW LEVEL SECURITY;
CREATE POLICY "content_categories_brand_access" ON content_categories FOR ALL USING (
  brand_id IN (
    SELECT b.id FROM brands b
    WHERE b.org_id = (SELECT org_id FROM auth_user_profile())
    AND (
      (SELECT role FROM auth_user_profile()) IN ('super_admin', 'agency_admin')
      OR (
        (SELECT role FROM auth_user_profile()) = 'agency_editor'
        AND b.id = ANY(COALESCE((SELECT assigned_brands FROM users WHERE users.id = auth.uid()), '{}'))
      )
      OR b.id = (SELECT brand_id FROM auth_user_profile())
    )
  )
);

-- ---- TREND SNAPSHOTS ----
ALTER TABLE trend_snapshots ENABLE ROW LEVEL SECURITY;
CREATE POLICY "trend_snapshots_brand_access" ON trend_snapshots FOR ALL USING (
  brand_id IN (
    SELECT b.id FROM brands b
    WHERE b.org_id = (SELECT org_id FROM auth_user_profile())
    AND (
      (SELECT role FROM auth_user_profile()) IN ('super_admin', 'agency_admin')
      OR (
        (SELECT role FROM auth_user_profile()) = 'agency_editor'
        AND b.id = ANY(COALESCE((SELECT assigned_brands FROM users WHERE users.id = auth.uid()), '{}'))
      )
      OR b.id = (SELECT brand_id FROM auth_user_profile())
    )
  )
);

-- ---- PERFORMANCE PREDICTIONS ----
ALTER TABLE performance_predictions ENABLE ROW LEVEL SECURITY;
CREATE POLICY "performance_predictions_brand_access" ON performance_predictions FOR ALL USING (
  brand_id IN (
    SELECT b.id FROM brands b
    WHERE b.org_id = (SELECT org_id FROM auth_user_profile())
    AND (
      (SELECT role FROM auth_user_profile()) IN ('super_admin', 'agency_admin')
      OR (
        (SELECT role FROM auth_user_profile()) = 'agency_editor'
        AND b.id = ANY(COALESCE((SELECT assigned_brands FROM users WHERE users.id = auth.uid()), '{}'))
      )
      OR b.id = (SELECT brand_id FROM auth_user_profile())
    )
  )
);

-- ---- COMMENT SENTIMENTS ----
ALTER TABLE comment_sentiments ENABLE ROW LEVEL SECURITY;
CREATE POLICY "comment_sentiments_brand_access" ON comment_sentiments FOR ALL USING (
  brand_id IN (
    SELECT b.id FROM brands b
    WHERE b.org_id = (SELECT org_id FROM auth_user_profile())
    AND (
      (SELECT role FROM auth_user_profile()) IN ('super_admin', 'agency_admin')
      OR (
        (SELECT role FROM auth_user_profile()) = 'agency_editor'
        AND b.id = ANY(COALESCE((SELECT assigned_brands FROM users WHERE users.id = auth.uid()), '{}'))
      )
      OR b.id = (SELECT brand_id FROM auth_user_profile())
    )
  )
);

-- ---- COMPETITOR METRICS ----
ALTER TABLE competitor_metrics ENABLE ROW LEVEL SECURITY;
CREATE POLICY "competitor_metrics_brand_access" ON competitor_metrics FOR ALL USING (
  brand_id IN (
    SELECT b.id FROM brands b
    WHERE b.org_id = (SELECT org_id FROM auth_user_profile())
    AND (
      (SELECT role FROM auth_user_profile()) IN ('super_admin', 'agency_admin')
      OR (
        (SELECT role FROM auth_user_profile()) = 'agency_editor'
        AND b.id = ANY(COALESCE((SELECT assigned_brands FROM users WHERE users.id = auth.uid()), '{}'))
      )
      OR b.id = (SELECT brand_id FROM auth_user_profile())
    )
  )
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

-- Text search
CREATE EXTENSION IF NOT EXISTS pg_trgm;
CREATE INDEX idx_media_groups_title_trgm ON media_groups USING gin(title gin_trgm_ops);
CREATE INDEX idx_media_groups_caption_trgm ON media_groups USING gin(caption gin_trgm_ops);

-- FK column indexes
CREATE INDEX idx_publish_jobs_asset_id ON publish_jobs(asset_id);
CREATE INDEX idx_publish_jobs_social_account_id ON publish_jobs(social_account_id);
CREATE INDEX idx_post_analytics_social_account_id ON post_analytics(social_account_id);
CREATE INDEX idx_audit_log_user_id ON audit_log(user_id);
CREATE INDEX idx_social_accounts_platform_user_id ON social_accounts(platform_user_id);
CREATE INDEX idx_api_keys_key_hash ON api_keys(key_hash);

-- Composite indexes
CREATE INDEX idx_content_posts_brand_status ON content_posts(brand_id, status);

-- LLM indexes
CREATE INDEX idx_llm_usage_logs_org_id ON llm_usage_logs(org_id);
CREATE INDEX idx_llm_usage_logs_brand_id ON llm_usage_logs(brand_id);
CREATE INDEX idx_llm_usage_logs_user_id ON llm_usage_logs(user_id);
CREATE INDEX idx_llm_usage_logs_created_at ON llm_usage_logs(created_at);
CREATE INDEX idx_llm_configurations_scope ON llm_configurations(scope, org_id);
CREATE INDEX idx_llm_configurations_user ON llm_configurations(user_id);
CREATE INDEX idx_llm_brand_access_brand ON llm_brand_access(brand_id);

-- Analytics indexes
CREATE INDEX idx_content_categories_brand_id ON content_categories(brand_id);
CREATE INDEX idx_content_categories_group_id ON content_categories(group_id);
CREATE INDEX idx_trend_snapshots_brand_id ON trend_snapshots(brand_id);
CREATE INDEX idx_trend_snapshots_date ON trend_snapshots(brand_id, platform, snapshot_date);
CREATE INDEX idx_performance_predictions_brand_id ON performance_predictions(brand_id);
CREATE INDEX idx_performance_predictions_group_id ON performance_predictions(group_id);
CREATE INDEX idx_comment_sentiments_brand_id ON comment_sentiments(brand_id);
CREATE INDEX idx_comment_sentiments_post_id ON comment_sentiments(post_id);
CREATE INDEX idx_competitor_metrics_brand_id ON competitor_metrics(brand_id);

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
