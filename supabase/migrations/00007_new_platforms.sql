-- Migration: Add Facebook, TikTok, Twitter/X, and Snapchat platform support
-- Safe to run on existing databases with data

-- Update platform_credentials CHECK constraint
ALTER TABLE platform_credentials DROP CONSTRAINT IF EXISTS platform_credentials_platform_check;
ALTER TABLE platform_credentials ADD CONSTRAINT platform_credentials_platform_check
  CHECK (platform IN ('instagram', 'youtube', 'linkedin', 'google_drive', 'email_smtp',
    'llm_provider', 'llm_openrouter', 'llm_anthropic', 'llm_openai', 'llm_google',
    'facebook', 'tiktok', 'twitter', 'snapchat'));

-- Update social_accounts CHECK constraint
ALTER TABLE social_accounts DROP CONSTRAINT IF EXISTS social_accounts_platform_check;
ALTER TABLE social_accounts ADD CONSTRAINT social_accounts_platform_check
  CHECK (platform IN ('instagram', 'youtube', 'linkedin', 'facebook', 'tiktok', 'twitter', 'snapchat'));

-- Update media_assets tagged_platform CHECK constraint
ALTER TABLE media_assets DROP CONSTRAINT IF EXISTS media_assets_tagged_platform_check;
ALTER TABLE media_assets ADD CONSTRAINT media_assets_tagged_platform_check
  CHECK (tagged_platform IN ('instagram', 'youtube', 'linkedin', 'facebook', 'tiktok', 'twitter', 'snapchat'));

-- Update platform_comments CHECK constraint (if table exists)
DO $$ BEGIN
  ALTER TABLE platform_comments DROP CONSTRAINT IF EXISTS platform_comments_platform_check;
  ALTER TABLE platform_comments ADD CONSTRAINT platform_comments_platform_check
    CHECK (platform IN ('instagram', 'youtube', 'linkedin', 'facebook', 'tiktok', 'twitter', 'snapchat'));
EXCEPTION WHEN undefined_table THEN NULL;
END $$;
