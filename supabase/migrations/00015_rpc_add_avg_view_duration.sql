-- ============================================
-- Migration: Add avg_view_duration_seconds to analytics RPC
-- YouTube avg duration data exists in table but was not returned
-- ============================================

DROP FUNCTION IF EXISTS get_brand_analytics(uuid);

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
  avg_view_duration_seconds float,
  engagement_rate float,
  social_account_id uuid,
  platform text,
  platform_username text,
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
    pa.avg_view_duration_seconds,
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
    COALESCE(sa.platform_username, 'unknown') as platform_username,
    pj.action
  FROM post_analytics pa
  JOIN content_posts cp ON cp.id = pa.post_id
  LEFT JOIN social_accounts sa ON sa.id = pa.social_account_id
  LEFT JOIN LATERAL (
    SELECT action FROM publish_jobs WHERE post_id = pa.post_id AND action NOT LIKE '%_story' LIMIT 1
  ) pj ON true
  WHERE cp.brand_id = p_brand_id
    AND cp.status IN ('published', 'partial_published');
$$;
