-- Advanced Analytics tables
-- Migration: 00004_advanced_analytics

-- ─── Content Categories (AI-analyzed) ───
CREATE TABLE IF NOT EXISTS content_categories (
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
CREATE TABLE IF NOT EXISTS trend_snapshots (
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
CREATE TABLE IF NOT EXISTS performance_predictions (
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
CREATE TABLE IF NOT EXISTS comment_sentiments (
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
CREATE TABLE IF NOT EXISTS competitor_metrics (
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

-- ─── RLS Policies ───

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

-- ─── Indexes ───

CREATE INDEX IF NOT EXISTS idx_content_categories_brand_id ON content_categories(brand_id);
CREATE INDEX IF NOT EXISTS idx_content_categories_group_id ON content_categories(group_id);
CREATE INDEX IF NOT EXISTS idx_trend_snapshots_brand_id ON trend_snapshots(brand_id);
CREATE INDEX IF NOT EXISTS idx_trend_snapshots_date ON trend_snapshots(brand_id, platform, snapshot_date);
CREATE INDEX IF NOT EXISTS idx_performance_predictions_brand_id ON performance_predictions(brand_id);
CREATE INDEX IF NOT EXISTS idx_performance_predictions_group_id ON performance_predictions(group_id);
CREATE INDEX IF NOT EXISTS idx_comment_sentiments_brand_id ON comment_sentiments(brand_id);
CREATE INDEX IF NOT EXISTS idx_comment_sentiments_post_id ON comment_sentiments(post_id);
CREATE INDEX IF NOT EXISTS idx_competitor_metrics_brand_id ON competitor_metrics(brand_id);
