-- Migration: LLM Access Control System
-- Adds multi-level LLM configurations, brand access grants, usage limits, and usage logging.

-- ─── LLM Configurations (multi-level) ───
CREATE TABLE IF NOT EXISTS llm_configurations (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  scope TEXT NOT NULL CHECK (scope IN ('org', 'brand', 'user')),
  org_id UUID REFERENCES organizations(id) ON DELETE CASCADE NOT NULL,
  brand_id UUID REFERENCES brands(id) ON DELETE CASCADE,
  user_id UUID REFERENCES users(id) ON DELETE CASCADE,
  provider TEXT NOT NULL CHECK (provider IN ('openrouter', 'openai', 'anthropic', 'google', 'custom')),
  label TEXT NOT NULL DEFAULT 'Default',
  api_key_encrypted TEXT NOT NULL,
  base_url TEXT,
  default_model TEXT,
  is_active BOOLEAN DEFAULT true,
  created_at TIMESTAMPTZ DEFAULT now(),
  updated_at TIMESTAMPTZ DEFAULT now(),
  UNIQUE(org_id, scope, brand_id, user_id, provider)
);

-- ─── LLM Brand Access (org shares LLM with brands) ───
CREATE TABLE IF NOT EXISTS llm_brand_access (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id UUID REFERENCES organizations(id) ON DELETE CASCADE NOT NULL,
  brand_id UUID REFERENCES brands(id) ON DELETE CASCADE NOT NULL,
  provider TEXT NOT NULL,
  granted_by UUID REFERENCES users(id) ON DELETE SET NULL,
  is_active BOOLEAN DEFAULT true,
  created_at TIMESTAMPTZ DEFAULT now(),
  UNIQUE(org_id, brand_id)
);

-- ─── LLM Usage Limits ───
CREATE TABLE IF NOT EXISTS llm_limits (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id UUID REFERENCES organizations(id) ON DELETE CASCADE NOT NULL,
  brand_id UUID REFERENCES brands(id) ON DELETE CASCADE,
  user_id UUID REFERENCES users(id) ON DELETE CASCADE,
  daily_requests INT DEFAULT 100,
  monthly_requests INT DEFAULT 3000,
  max_tokens_per_request INT DEFAULT 4096,
  is_active BOOLEAN DEFAULT true,
  created_at TIMESTAMPTZ DEFAULT now(),
  updated_at TIMESTAMPTZ DEFAULT now()
);

-- ─── LLM Usage Logs ───
CREATE TABLE IF NOT EXISTS llm_usage_logs (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id UUID REFERENCES organizations(id) ON DELETE CASCADE NOT NULL,
  brand_id UUID,
  user_id UUID REFERENCES users(id) ON DELETE SET NULL,
  config_id UUID REFERENCES llm_configurations(id) ON DELETE SET NULL,
  scope_used TEXT CHECK (scope_used IN ('org', 'brand', 'user')),
  provider TEXT NOT NULL,
  model TEXT,
  input_tokens INT DEFAULT 0,
  output_tokens INT DEFAULT 0,
  total_tokens INT DEFAULT 0,
  cost_estimate NUMERIC(10,6) DEFAULT 0,
  created_at TIMESTAMPTZ DEFAULT now()
);

-- ─── Indexes ───
CREATE INDEX IF NOT EXISTS idx_llm_usage_logs_org_id ON llm_usage_logs(org_id);
CREATE INDEX IF NOT EXISTS idx_llm_usage_logs_brand_id ON llm_usage_logs(brand_id);
CREATE INDEX IF NOT EXISTS idx_llm_usage_logs_user_id ON llm_usage_logs(user_id);
CREATE INDEX IF NOT EXISTS idx_llm_usage_logs_created_at ON llm_usage_logs(created_at);
CREATE INDEX IF NOT EXISTS idx_llm_configurations_scope ON llm_configurations(scope, org_id);
CREATE INDEX IF NOT EXISTS idx_llm_configurations_user ON llm_configurations(user_id);
CREATE INDEX IF NOT EXISTS idx_llm_brand_access_brand ON llm_brand_access(brand_id);

-- ─── Row Level Security ───

ALTER TABLE llm_configurations ENABLE ROW LEVEL SECURITY;
CREATE POLICY "llm_config_user_own" ON llm_configurations FOR ALL USING (
  user_id = auth.uid() OR
  (SELECT role FROM auth_user_profile()) IN ('super_admin', 'agency_admin')
);

ALTER TABLE llm_brand_access ENABLE ROW LEVEL SECURITY;
CREATE POLICY "llm_brand_access_policy" ON llm_brand_access FOR ALL USING (
  org_id = (SELECT org_id FROM auth_user_profile()) AND (
    (SELECT role FROM auth_user_profile()) IN ('super_admin', 'agency_admin') OR
    brand_id = (SELECT brand_id FROM auth_user_profile())
  )
);

ALTER TABLE llm_limits ENABLE ROW LEVEL SECURITY;
CREATE POLICY "llm_limits_policy" ON llm_limits FOR ALL USING (
  org_id = (SELECT org_id FROM auth_user_profile()) AND (
    (SELECT role FROM auth_user_profile()) IN ('super_admin', 'agency_admin') OR
    brand_id = (SELECT brand_id FROM auth_user_profile()) OR
    user_id = auth.uid()
  )
);

ALTER TABLE llm_usage_logs ENABLE ROW LEVEL SECURITY;
CREATE POLICY "llm_usage_logs_policy" ON llm_usage_logs FOR ALL USING (
  org_id = (SELECT org_id FROM auth_user_profile()) AND (
    (SELECT role FROM auth_user_profile()) IN ('super_admin', 'agency_admin') OR
    user_id = auth.uid()
  )
);
