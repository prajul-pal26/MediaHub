-- Facebook scraper sessions: persist a user's FB cookie bundle (encrypted) with
-- active/dead status. Used by the session-based Facebook page fetcher.

create table if not exists fb_sessions (
  id uuid primary key default gen_random_uuid(),
  org_id uuid references organizations(id) on delete cascade,
  user_id uuid references users(id) on delete set null,
  label text,
  cookie_encrypted text not null,           -- AES-256-GCM encrypted "c_user=..; xs=..;" bundle
  c_user text,                              -- the numeric FB user id (non-secret)
  status text not null default 'active' check (status in ('active', 'dead')),
  last_checked_at timestamptz,
  last_error text,
  created_at timestamptz not null default now()
);

create index if not exists idx_fb_sessions_org on fb_sessions(org_id);
create index if not exists idx_fb_sessions_status on fb_sessions(org_id, status);

alter table fb_sessions enable row level security;
