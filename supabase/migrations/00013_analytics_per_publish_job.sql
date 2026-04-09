-- ============================================
-- Migration: Track analytics per publish_job (not per post+account)
-- This allows separate analytics for ig_post vs ig_story on the same account.
-- ============================================

-- Step 1: Add publish_job_id column
ALTER TABLE post_analytics
  ADD COLUMN IF NOT EXISTS publish_job_id UUID REFERENCES publish_jobs(id) ON DELETE CASCADE;

-- Step 2: Backfill publish_job_id from existing data
-- For each post_analytics row, find the matching publish_job
UPDATE post_analytics pa
SET publish_job_id = (
  SELECT pj.id FROM publish_jobs pj
  WHERE pj.post_id = pa.post_id
    AND pj.social_account_id = pa.social_account_id
    AND pj.status = 'completed'
  ORDER BY pj.completed_at DESC
  LIMIT 1
)
WHERE pa.publish_job_id IS NULL;

-- Step 3: Drop the old unique constraint and add new one
ALTER TABLE post_analytics
  DROP CONSTRAINT IF EXISTS uq_post_analytics_post_account;

-- New unique: one analytics entry per publish_job
-- (publish_job_id can be null for legacy/imported data, so also keep post+account uniqueness as fallback)
CREATE UNIQUE INDEX IF NOT EXISTS uq_post_analytics_job
  ON post_analytics (publish_job_id) WHERE publish_job_id IS NOT NULL;

CREATE UNIQUE INDEX IF NOT EXISTS uq_post_analytics_post_account_legacy
  ON post_analytics (post_id, social_account_id) WHERE publish_job_id IS NULL;

-- Step 4: Add index for faster lookups
CREATE INDEX IF NOT EXISTS idx_post_analytics_publish_job ON post_analytics(publish_job_id);

-- Step 5: Same for post_analytics_history
ALTER TABLE post_analytics_history
  ADD COLUMN IF NOT EXISTS publish_job_id UUID REFERENCES publish_jobs(id) ON DELETE CASCADE;

CREATE INDEX IF NOT EXISTS idx_pah_publish_job ON post_analytics_history(publish_job_id);

-- Step 6: Now split any collapsed rows (e.g., ig_post + ig_story on same account were in 1 row)
-- For each publish_job that doesn't have its own analytics entry, create one
INSERT INTO post_analytics (post_id, social_account_id, publish_job_id, views, likes, comments, shares, saves, clicks, reach, impressions, engagement_rate, retention_rate, watch_time_seconds, fetched_at)
SELECT pj.post_id, pj.social_account_id, pj.id, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, NULL
FROM publish_jobs pj
WHERE pj.status = 'completed'
  AND NOT EXISTS (
    SELECT 1 FROM post_analytics pa WHERE pa.publish_job_id = pj.id
  )
ON CONFLICT DO NOTHING;
