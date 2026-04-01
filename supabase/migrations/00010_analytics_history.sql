-- ============================================
-- Migration: Analytics history for progress tracking
-- Appends a snapshot every 6h so we can show growth charts
-- ============================================

CREATE TABLE IF NOT EXISTS post_analytics_history (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  post_id UUID REFERENCES content_posts(id) ON DELETE CASCADE NOT NULL,
  social_account_id UUID REFERENCES social_accounts(id) ON DELETE SET NULL,
  views INTEGER DEFAULT 0,
  likes INTEGER DEFAULT 0,
  comments INTEGER DEFAULT 0,
  shares INTEGER DEFAULT 0,
  saves INTEGER DEFAULT 0,
  clicks INTEGER DEFAULT 0,
  reach INTEGER DEFAULT 0,
  impressions INTEGER DEFAULT 0,
  engagement_rate FLOAT DEFAULT 0,
  retention_rate FLOAT DEFAULT 0,
  watch_time_seconds INTEGER DEFAULT 0,
  snapshot_at TIMESTAMPTZ DEFAULT now() NOT NULL
);

CREATE INDEX idx_pah_post_id ON post_analytics_history(post_id);
CREATE INDEX idx_pah_post_snapshot ON post_analytics_history(post_id, snapshot_at);
CREATE INDEX idx_pah_social_account ON post_analytics_history(social_account_id);

-- RLS
ALTER TABLE post_analytics_history ENABLE ROW LEVEL SECURITY;

CREATE POLICY "analytics_history_via_post" ON post_analytics_history FOR ALL USING (
  post_id IN (
    SELECT cp.id FROM content_posts cp
    JOIN brands b ON cp.brand_id = b.id
    WHERE b.org_id = (SELECT org_id FROM auth_user_profile())
  )
);
