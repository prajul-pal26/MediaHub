-- ============================================
-- Migration: Threads pipeline fixes
-- 1. Ensure platform_comments allows all platforms
-- 2. Add index for filtering top-level comments
-- ============================================

-- Ensure CHECK constraint includes all platforms (idempotent)
DO $$ BEGIN
  ALTER TABLE platform_comments DROP CONSTRAINT IF EXISTS platform_comments_platform_check;
  ALTER TABLE platform_comments ADD CONSTRAINT platform_comments_platform_check
    CHECK (platform IN ('instagram', 'youtube', 'linkedin', 'facebook', 'tiktok', 'twitter', 'snapchat'));
EXCEPTION WHEN undefined_table THEN NULL;
END $$;

-- Index to efficiently filter top-level vs nested comments
CREATE INDEX IF NOT EXISTS idx_platform_comments_parent
  ON platform_comments(brand_id, platform_parent_comment_id);
