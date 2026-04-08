-- ============================================
-- Analytics RPC functions
-- ============================================
-- These functions do JOINs server-side to avoid
-- passing large lists of IDs via URL (414 URI Too Long).

-- Get all analytics for a brand's published posts (with platform info)
CREATE OR REPLACE FUNCTION get_brand_analytics(p_brand_id uuid)
RETURNS TABLE (
  post_id uuid,
  views bigint,
  likes bigint,
  comments bigint,
  shares bigint,
  saves bigint,
  reach bigint,
  impressions bigint,
  clicks bigint,
  retention_rate float,
  watch_time_seconds float,
  engagement_rate float,
  social_account_id uuid,
  platform text,
  action text
) LANGUAGE sql STABLE SECURITY DEFINER AS $$
  SELECT
    pa.post_id,
    pa.views,
    pa.likes,
    pa.comments,
    pa.shares,
    pa.saves,
    pa.reach,
    pa.impressions,
    pa.clicks,
    pa.retention_rate,
    pa.watch_time_seconds,
    pa.engagement_rate,
    pa.social_account_id,
    COALESCE(sa.platform,
      CASE
        WHEN pj.action LIKE 'ig_%' THEN 'instagram'
        WHEN pj.action LIKE 'yt_%' THEN 'youtube'
        WHEN pj.action LIKE 'li_%' THEN 'linkedin'
        WHEN pj.action LIKE 'fb_%' THEN 'facebook'
        WHEN pj.action LIKE 'tt_%' THEN 'tiktok'
        WHEN pj.action LIKE 'tw_%' THEN 'twitter'
        WHEN pj.action LIKE 'sc_%' THEN 'snapchat'
        ELSE 'unknown'
      END
    ) as platform,
    pj.action
  FROM post_analytics pa
  JOIN content_posts cp ON cp.id = pa.post_id
  LEFT JOIN social_accounts sa ON sa.id = pa.social_account_id
  LEFT JOIN LATERAL (
    SELECT action FROM publish_jobs WHERE post_id = pa.post_id LIMIT 1
  ) pj ON true
  WHERE cp.brand_id = p_brand_id
    AND cp.status = 'published';
$$;

-- Get analytics time series for a brand
CREATE OR REPLACE FUNCTION get_brand_analytics_history(p_brand_id uuid, p_since timestamptz)
RETURNS TABLE (
  post_id uuid,
  social_account_id uuid,
  views bigint,
  likes bigint,
  comments bigint,
  shares bigint,
  saves bigint,
  reach bigint,
  impressions bigint,
  engagement_rate float,
  snapshot_at timestamptz,
  platform text
) LANGUAGE sql STABLE SECURITY DEFINER AS $$
  SELECT
    pah.post_id,
    pah.social_account_id,
    pah.views,
    pah.likes,
    pah.comments,
    pah.shares,
    pah.saves,
    pah.reach,
    pah.impressions,
    pah.engagement_rate,
    pah.snapshot_at,
    COALESCE(sa.platform,
      CASE
        WHEN pj.action LIKE 'ig_%' THEN 'instagram'
        WHEN pj.action LIKE 'yt_%' THEN 'youtube'
        WHEN pj.action LIKE 'li_%' THEN 'linkedin'
        ELSE 'unknown'
      END
    ) as platform
  FROM post_analytics_history pah
  JOIN content_posts cp ON cp.id = pah.post_id
  LEFT JOIN social_accounts sa ON sa.id = pah.social_account_id
  LEFT JOIN LATERAL (
    SELECT action FROM publish_jobs WHERE post_id = pah.post_id LIMIT 1
  ) pj ON true
  WHERE cp.brand_id = p_brand_id
    AND cp.status = 'published'
    AND pah.snapshot_at >= p_since
  ORDER BY pah.snapshot_at ASC;
$$;

-- Get post analytics for the post list page
CREATE OR REPLACE FUNCTION get_brand_post_analytics(p_brand_id uuid, p_offset int, p_limit int, p_platform text DEFAULT NULL)
RETURNS TABLE (
  post_id uuid,
  published_at timestamptz,
  caption_overrides jsonb,
  source text,
  views bigint,
  likes bigint,
  comments bigint,
  shares bigint,
  saves bigint,
  reach bigint,
  impressions bigint,
  clicks bigint,
  engagement_rate float,
  retention_rate float,
  watch_time_seconds float,
  fetched_at timestamptz,
  social_account_id uuid,
  platform text,
  action text,
  platform_post_id text,
  platform_username text
) LANGUAGE sql STABLE SECURITY DEFINER AS $$
  SELECT
    cp.id as post_id,
    cp.published_at,
    cp.caption_overrides,
    cp.source,
    pa.views,
    pa.likes,
    pa.comments,
    pa.shares,
    pa.saves,
    pa.reach,
    pa.impressions,
    pa.clicks,
    pa.engagement_rate,
    pa.retention_rate,
    pa.watch_time_seconds,
    pa.fetched_at,
    pa.social_account_id,
    COALESCE(sa.platform, 'unknown') as platform,
    pj.action,
    pj.platform_post_id,
    sa.platform_username
  FROM content_posts cp
  LEFT JOIN post_analytics pa ON pa.post_id = cp.id
  LEFT JOIN social_accounts sa ON sa.id = pa.social_account_id
  LEFT JOIN LATERAL (
    SELECT action, platform_post_id FROM publish_jobs WHERE post_id = cp.id LIMIT 1
  ) pj ON true
  WHERE cp.brand_id = p_brand_id
    AND cp.status = 'published'
    AND (p_platform IS NULL OR COALESCE(sa.platform, '') = p_platform)
  ORDER BY cp.published_at DESC NULLS LAST
  OFFSET p_offset
  LIMIT p_limit;
$$;

-- Count published posts for a brand (with optional platform filter)
CREATE OR REPLACE FUNCTION count_brand_posts(p_brand_id uuid, p_platform text DEFAULT NULL)
RETURNS bigint LANGUAGE sql STABLE SECURITY DEFINER AS $$
  SELECT count(DISTINCT cp.id)
  FROM content_posts cp
  LEFT JOIN post_analytics pa ON pa.post_id = cp.id
  LEFT JOIN social_accounts sa ON sa.id = pa.social_account_id
  WHERE cp.brand_id = p_brand_id
    AND cp.status = 'published'
    AND (p_platform IS NULL OR COALESCE(sa.platform, '') = p_platform);
$$;
