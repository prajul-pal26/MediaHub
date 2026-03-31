-- ============================================
-- Migration: Threads & Comment Management System
-- Adds unified comment inbox with reply capabilities
-- ============================================

-- ─── Platform Comments (synced from Instagram/YouTube/LinkedIn) ───
CREATE TABLE IF NOT EXISTS platform_comments (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  brand_id UUID REFERENCES brands(id) ON DELETE CASCADE NOT NULL,
  post_id UUID REFERENCES content_posts(id) ON DELETE CASCADE,
  publish_job_id UUID REFERENCES publish_jobs(id) ON DELETE SET NULL,
  social_account_id UUID REFERENCES social_accounts(id) ON DELETE SET NULL,

  -- Platform identifiers
  platform TEXT NOT NULL CHECK (platform IN ('instagram', 'youtube', 'linkedin')),
  platform_comment_id TEXT NOT NULL,
  platform_post_id TEXT,
  platform_parent_comment_id TEXT, -- for nested replies on the platform

  -- Comment content
  author_username TEXT NOT NULL,
  author_profile_url TEXT,
  author_avatar_url TEXT,
  comment_text TEXT NOT NULL,
  comment_timestamp TIMESTAMPTZ NOT NULL,

  -- Engagement
  like_count INTEGER DEFAULT 0,
  reply_count INTEGER DEFAULT 0,

  -- Management
  status TEXT DEFAULT 'unread' CHECK (status IN ('unread', 'read', 'replied', 'archived', 'flagged')),
  sentiment TEXT CHECK (sentiment IN ('positive', 'negative', 'neutral', 'question')),
  is_hidden BOOLEAN DEFAULT false,

  -- Metadata
  metadata JSONB DEFAULT '{}',
  synced_at TIMESTAMPTZ DEFAULT now(),
  created_at TIMESTAMPTZ DEFAULT now(),

  UNIQUE(platform, platform_comment_id)
);

-- ─── Comment Replies (our replies sent back to platforms) ───
CREATE TABLE IF NOT EXISTS comment_replies (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  comment_id UUID REFERENCES platform_comments(id) ON DELETE CASCADE NOT NULL,
  brand_id UUID REFERENCES brands(id) ON DELETE CASCADE NOT NULL,
  replied_by UUID REFERENCES users(id) ON DELETE SET NULL,

  -- Reply content
  reply_text TEXT NOT NULL,
  template_id UUID, -- FK added after reply_templates table

  -- Platform state
  platform_reply_id TEXT, -- ID returned by platform after posting
  status TEXT DEFAULT 'pending' CHECK (status IN ('pending', 'sending', 'sent', 'failed')),
  error_message TEXT,

  -- Timestamps
  sent_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ DEFAULT now()
);

-- ─── Reply Templates (predefined quick replies) ───
CREATE TABLE IF NOT EXISTS reply_templates (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  brand_id UUID REFERENCES brands(id) ON DELETE CASCADE NOT NULL,
  created_by UUID REFERENCES users(id) ON DELETE SET NULL,

  -- Template content
  name TEXT NOT NULL,
  body TEXT NOT NULL,
  category TEXT DEFAULT 'general' CHECK (category IN ('general', 'thanks', 'question', 'promotion', 'support', 'custom')),
  variables TEXT[] DEFAULT '{}', -- e.g., ['{{author}}', '{{product}}']

  -- Usage tracking
  use_count INTEGER DEFAULT 0,
  is_active BOOLEAN DEFAULT true,
  sort_order INTEGER DEFAULT 0,

  created_at TIMESTAMPTZ DEFAULT now(),
  updated_at TIMESTAMPTZ DEFAULT now()
);

-- Add FK from comment_replies to reply_templates
ALTER TABLE comment_replies
  ADD CONSTRAINT comment_replies_template_id_fkey
  FOREIGN KEY (template_id) REFERENCES reply_templates(id) ON DELETE SET NULL;

-- ============================================
-- INDEXES
-- ============================================

CREATE INDEX idx_platform_comments_brand_id ON platform_comments(brand_id);
CREATE INDEX idx_platform_comments_post_id ON platform_comments(post_id);
CREATE INDEX idx_platform_comments_status ON platform_comments(status);
CREATE INDEX idx_platform_comments_platform ON platform_comments(platform);
CREATE INDEX idx_platform_comments_timestamp ON platform_comments(comment_timestamp DESC);
CREATE INDEX idx_platform_comments_social_account ON platform_comments(social_account_id);
CREATE INDEX idx_platform_comments_brand_status ON platform_comments(brand_id, status);
CREATE INDEX idx_platform_comments_brand_platform ON platform_comments(brand_id, platform);

CREATE INDEX idx_comment_replies_comment_id ON comment_replies(comment_id);
CREATE INDEX idx_comment_replies_brand_id ON comment_replies(brand_id);
CREATE INDEX idx_comment_replies_status ON comment_replies(status);

CREATE INDEX idx_reply_templates_brand_id ON reply_templates(brand_id);
CREATE INDEX idx_reply_templates_category ON reply_templates(category);

-- ============================================
-- ROW LEVEL SECURITY
-- ============================================

-- ─── Platform Comments ───
ALTER TABLE platform_comments ENABLE ROW LEVEL SECURITY;

CREATE POLICY "agency_manage_comments" ON platform_comments FOR ALL USING (
  brand_id IN (
    SELECT b.id FROM brands b
    WHERE b.org_id = (SELECT org_id FROM auth_user_profile())
    AND (
      (SELECT role FROM auth_user_profile()) IN ('super_admin', 'agency_admin')
      OR (
        (SELECT role FROM auth_user_profile()) = 'agency_editor'
        AND b.id = ANY(COALESCE((SELECT assigned_brands FROM users WHERE users.id = auth.uid()), '{}'))
      )
    )
  )
);

CREATE POLICY "brand_editors_manage_comments" ON platform_comments FOR ALL USING (
  brand_id = (SELECT brand_id FROM auth_user_profile())
  AND (SELECT role FROM auth_user_profile()) IN ('brand_owner', 'brand_editor')
);

CREATE POLICY "brand_viewers_read_comments" ON platform_comments FOR SELECT USING (
  brand_id = (SELECT brand_id FROM auth_user_profile())
  AND (SELECT role FROM auth_user_profile()) = 'brand_viewer'
);

-- ─── Comment Replies ───
ALTER TABLE comment_replies ENABLE ROW LEVEL SECURITY;

CREATE POLICY "agency_manage_replies" ON comment_replies FOR ALL USING (
  brand_id IN (
    SELECT b.id FROM brands b
    WHERE b.org_id = (SELECT org_id FROM auth_user_profile())
    AND (
      (SELECT role FROM auth_user_profile()) IN ('super_admin', 'agency_admin')
      OR (
        (SELECT role FROM auth_user_profile()) = 'agency_editor'
        AND b.id = ANY(COALESCE((SELECT assigned_brands FROM users WHERE users.id = auth.uid()), '{}'))
      )
    )
  )
);

CREATE POLICY "brand_editors_manage_replies" ON comment_replies FOR ALL USING (
  brand_id = (SELECT brand_id FROM auth_user_profile())
  AND (SELECT role FROM auth_user_profile()) IN ('brand_owner', 'brand_editor')
);

-- ─── Reply Templates ───
ALTER TABLE reply_templates ENABLE ROW LEVEL SECURITY;

CREATE POLICY "agency_manage_templates" ON reply_templates FOR ALL USING (
  brand_id IN (
    SELECT b.id FROM brands b
    WHERE b.org_id = (SELECT org_id FROM auth_user_profile())
    AND (
      (SELECT role FROM auth_user_profile()) IN ('super_admin', 'agency_admin')
      OR (
        (SELECT role FROM auth_user_profile()) = 'agency_editor'
        AND b.id = ANY(COALESCE((SELECT assigned_brands FROM users WHERE users.id = auth.uid()), '{}'))
      )
    )
  )
);

CREATE POLICY "brand_users_manage_templates" ON reply_templates FOR ALL USING (
  brand_id = (SELECT brand_id FROM auth_user_profile())
  AND (SELECT role FROM auth_user_profile()) IN ('brand_owner', 'brand_editor')
);

CREATE POLICY "brand_viewers_read_templates" ON reply_templates FOR SELECT USING (
  brand_id = (SELECT brand_id FROM auth_user_profile())
  AND (SELECT role FROM auth_user_profile()) = 'brand_viewer'
);
