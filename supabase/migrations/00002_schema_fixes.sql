-- Schema fixes migration
-- Fixes: platform_credentials CHECK, missing FKs, missing indexes, status constraints

-- Fix platform_credentials CHECK constraint
ALTER TABLE platform_credentials DROP CONSTRAINT IF EXISTS platform_credentials_platform_check;
ALTER TABLE platform_credentials ADD CONSTRAINT platform_credentials_platform_check
  CHECK (platform IN ('instagram', 'youtube', 'linkedin', 'google_drive', 'email_smtp', 'llm_provider', 'llm_openrouter', 'llm_anthropic', 'llm_openai', 'llm_google'));

-- Add missing FK for media_assets.tagged_account_id
DO $$ BEGIN
  ALTER TABLE media_assets ADD CONSTRAINT media_assets_tagged_account_fkey
    FOREIGN KEY (tagged_account_id) REFERENCES social_accounts(id) ON DELETE SET NULL;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

-- Add missing FKs for audit_log
DO $$ BEGIN
  ALTER TABLE audit_log ADD CONSTRAINT audit_log_org_id_fkey
    FOREIGN KEY (org_id) REFERENCES organizations(id) ON DELETE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
  ALTER TABLE audit_log ADD CONSTRAINT audit_log_user_id_fkey
    FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE SET NULL;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

-- Add performance indexes
CREATE EXTENSION IF NOT EXISTS pg_trgm;
CREATE INDEX IF NOT EXISTS idx_media_groups_title_trgm ON media_groups USING gin(title gin_trgm_ops);
CREATE INDEX IF NOT EXISTS idx_media_groups_caption_trgm ON media_groups USING gin(caption gin_trgm_ops);
CREATE INDEX IF NOT EXISTS idx_publish_jobs_asset_id ON publish_jobs(asset_id);
CREATE INDEX IF NOT EXISTS idx_publish_jobs_social_account_id ON publish_jobs(social_account_id);
CREATE INDEX IF NOT EXISTS idx_post_analytics_social_account_id ON post_analytics(social_account_id);
CREATE INDEX IF NOT EXISTS idx_audit_log_user_id ON audit_log(user_id);
CREATE INDEX IF NOT EXISTS idx_audit_log_org_id ON audit_log(org_id);
CREATE INDEX IF NOT EXISTS idx_social_accounts_platform_user_id ON social_accounts(platform_user_id);
CREATE INDEX IF NOT EXISTS idx_api_keys_key_hash ON api_keys(key_hash);
CREATE INDEX IF NOT EXISTS idx_content_posts_brand_status ON content_posts(brand_id, status);
CREATE INDEX IF NOT EXISTS idx_media_assets_group_id ON media_assets(group_id);
CREATE INDEX IF NOT EXISTS idx_media_groups_brand_id ON media_groups(brand_id);

-- Fix media_groups.status to include all needed states (if not already)
ALTER TABLE media_groups DROP CONSTRAINT IF EXISTS media_groups_status_check;
ALTER TABLE media_groups ADD CONSTRAINT media_groups_status_check
  CHECK (status IN ('available', 'scheduled', 'published', 'archived'));

-- Fix publish_jobs.status to include 'cancelled'
ALTER TABLE publish_jobs DROP CONSTRAINT IF EXISTS publish_jobs_status_check;
ALTER TABLE publish_jobs ADD CONSTRAINT publish_jobs_status_check
  CHECK (status IN ('queued', 'processing', 'completed', 'failed', 'dead', 'cancelled'));

-- Fix content_posts.status to include 'partial_published'
ALTER TABLE content_posts DROP CONSTRAINT IF EXISTS content_posts_status_check;
ALTER TABLE content_posts ADD CONSTRAINT content_posts_status_check
  CHECK (status IN ('draft', 'pending_approval', 'scheduled', 'publishing', 'published', 'partial_published', 'failed'));

-- Additional indexes for worker queries
CREATE INDEX IF NOT EXISTS idx_publish_jobs_post_id ON publish_jobs(post_id);
CREATE INDEX IF NOT EXISTS idx_publish_jobs_status ON publish_jobs(status);
CREATE INDEX IF NOT EXISTS idx_content_posts_group_id ON content_posts(group_id);
