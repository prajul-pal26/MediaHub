-- Instagram scraper sessions: persist session ids (encrypted) with active/dead status.
-- Used by the Insta Page Fetcher tool.

create table if not exists insta_sessions (
  id uuid primary key default gen_random_uuid(),
  org_id uuid references organizations(id) on delete cascade,
  user_id uuid references users(id) on delete set null,
  label text,                                  -- typically the IG username the session belongs to
  session_id_encrypted text not null,          -- AES-256-GCM encrypted sessionid cookie
  status text not null default 'active' check (status in ('active', 'dead')),
  last_checked_at timestamptz,
  last_error text,
  created_at timestamptz not null default now()
);

create index if not exists idx_insta_sessions_org on insta_sessions(org_id);
create index if not exists idx_insta_sessions_status on insta_sessions(org_id, status);

alter table insta_sessions enable row level security;
