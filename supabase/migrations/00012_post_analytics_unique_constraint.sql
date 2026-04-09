-- ============================================
-- Migration: Add UNIQUE constraint on post_analytics(post_id, social_account_id)
-- Prevents duplicate analytics rows for the same post + account pair.
-- Deduplicates existing rows first (keeps the most recently fetched one).
-- ============================================

-- Step 1: Remove duplicates if any exist (keep the row with the latest fetched_at)
DELETE FROM post_analytics pa
WHERE pa.id NOT IN (
  SELECT DISTINCT ON (post_id, social_account_id) id
  FROM post_analytics
  ORDER BY post_id, social_account_id, fetched_at DESC NULLS LAST
);

-- Step 2: Add the unique constraint
ALTER TABLE post_analytics
  ADD CONSTRAINT uq_post_analytics_post_account
  UNIQUE (post_id, social_account_id);
