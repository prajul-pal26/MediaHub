-- ============================================
-- Migration: Fix get_brand_analytics_history RPC
-- 1. Add missing platform fallbacks (fb_, tt_, tw_, sc_)
-- 2. Include partial_published posts
-- ============================================

DROP FUNCTION IF EXISTS get_brand_analytics_history(uuid, timestamptz);

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
        WHEN pj.action LIKE 'fb_%' THEN 'facebook'
        WHEN pj.action LIKE 'tt_%' THEN 'tiktok'
        WHEN pj.action LIKE 'tw_%' THEN 'twitter'
        WHEN pj.action LIKE 'sc_%' THEN 'snapchat'
        ELSE 'unknown'
      END
    ) as platform
  FROM post_analytics_history pah
  JOIN content_posts cp ON cp.id = pah.post_id
  LEFT JOIN social_accounts sa ON sa.id = pah.social_account_id
  LEFT JOIN LATERAL (
    SELECT action FROM publish_jobs WHERE post_id = pah.post_id AND action NOT LIKE '%_story' LIMIT 1
  ) pj ON true
  WHERE cp.brand_id = p_brand_id
    AND cp.status IN ('published', 'partial_published')
    AND pah.snapshot_at >= p_since
  ORDER BY pah.snapshot_at ASC;
$$;
