-- Preserve analytics data when social accounts or media are deleted
-- Published content analytics should survive platform disconnection and media cleanup

-- social_accounts → publish_jobs: SET NULL (keep job records when account removed)
ALTER TABLE publish_jobs DROP CONSTRAINT IF EXISTS publish_jobs_social_account_id_fkey;
ALTER TABLE publish_jobs ADD CONSTRAINT publish_jobs_social_account_id_fkey
  FOREIGN KEY (social_account_id) REFERENCES social_accounts(id) ON DELETE SET NULL;
ALTER TABLE publish_jobs ALTER COLUMN social_account_id DROP NOT NULL;

-- social_accounts → post_analytics: SET NULL (keep analytics when account removed)
ALTER TABLE post_analytics DROP CONSTRAINT IF EXISTS post_analytics_social_account_id_fkey;
ALTER TABLE post_analytics ADD CONSTRAINT post_analytics_social_account_id_fkey
  FOREIGN KEY (social_account_id) REFERENCES social_accounts(id) ON DELETE SET NULL;
ALTER TABLE post_analytics ALTER COLUMN social_account_id DROP NOT NULL;

-- media_groups → content_posts: SET NULL (keep published posts when media deleted from library)
ALTER TABLE content_posts DROP CONSTRAINT IF EXISTS content_posts_group_id_fkey;
ALTER TABLE content_posts ADD CONSTRAINT content_posts_group_id_fkey
  FOREIGN KEY (group_id) REFERENCES media_groups(id) ON DELETE SET NULL;
