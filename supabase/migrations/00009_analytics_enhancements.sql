-- ============================================
-- Migration: Analytics enhancements
-- 1. Add unique constraint on comment_sentiments.post_id for upsert
-- 2. Add best_posting_times column to trend_snapshots
-- ============================================

-- comment_sentiments: allow only one sentiment record per post (for upsert)
ALTER TABLE comment_sentiments
  ADD CONSTRAINT comment_sentiments_post_id_unique UNIQUE (post_id);

-- trend_snapshots: store best posting time recommendations
ALTER TABLE trend_snapshots
  ADD COLUMN IF NOT EXISTS best_posting_times JSONB DEFAULT '[]';
